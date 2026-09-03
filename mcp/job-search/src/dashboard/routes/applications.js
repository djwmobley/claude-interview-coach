// @ts-check
/**
 * Application routes (apply pipeline slice 3, extended by slice 4 (credentials, in routes/credentials.js)
 * and slice 5 (this file): Retry, "I applied by hand", the answer box, the screenshot route, and the
 * loopback-only internal apply-progress sink the worker posts to. Every route that lands an application in
 * 'approved' (Approve here, Retry here, credentials.js's resume, stream.js's pollCredentialResume) starts
 * the apply runner right after a successful transition, non-fatally -- a runner-start failure is logged
 * and never turns a successful HTTP response into an error, because the application row itself is already
 * correctly in 'approved' regardless; the worst case is it waits for the next tick/manual nudge instead of
 * starting immediately.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JobSearchError } from '../../core/errors.js';
import {
  createApplication, approve, getApplication, getApplicationForListing, retry, markAppliedByHand, resume,
  listApplicationEvents, recordApplicationEvent,
} from '../../core/applications.js';
import { classifyApplyUrl } from '../../apply/ats-detect.js';
import { resolveLatestApplicationScreenshot } from '../../apply/screenshot.js';
import { appendLearnedLabel } from '../../apply/answers.js';
import { packageRoot } from '../../core/config.js';
import { sendJson } from '../http.js';

const ANSWER_BANK_PATH = path.join(packageRoot(), 'data', 'apply-answers.md');

/** One-click apply (PR A spec item 7): a drafting row this old is reused only after resetting its resume
 * link -- the world (the listing's own description, or the operator's data files) may well have changed
 * since a stale drafting row was first created, so a fresh draft is safer than trusting a week-old link. */
const STALE_DRAFTING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Best-effort, non-blocking: start the apply runner for an application that just landed in 'approved'.
 * Never throws -- a caller that already sent (or is about to send) a 200 for the state transition itself
 * must not have that response turned into a 500 by a runner-start hiccup (LOCKED because another run is
 * already in progress, a spawn failure, etc.); the next tick or a manual nudge picks it up.
 * @param {import('../server.js').DashboardDeps} deps
 * @param {number} applicationId
 */
function kickApplyRunner(deps, applicationId) {
  if (!deps.applyRunner) return;
  Promise.resolve(deps.applyRunner.start(applicationId)).catch((err) => {
    deps.log?.({ evt: 'apply_runner_start_failed', application_id: applicationId, err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
  });
}

/**
 * One-click apply (PR A spec item 7): resume runner -> review runner -> approve() -> kickApplyRunner.
 * Runs entirely after the route has already sent its 202 -- never awaited by the route handler -- so a
 * multi-minute headless run never blocks the HTTP response. Every phase writes a progress application
 * event and calls streamHub.notifyChanged('events') so an open dashboard tab's SSE stream reflects each
 * step as it happens, matching the existing approved/submitting live-progress pattern (application-card.js).
 * Each runner call already records its own success/failure event and (for review) the verdict/findings
 * columns; this function's own events mark the CHAIN's phase boundaries, not the runners' internal detail.
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>|undefined} streamHub
 * @param {number} applicationId
 * @param {number} listingId
 */
async function runApplyNowChain(deps, streamHub, applicationId, listingId) {
  const notify = () => streamHub?.notifyChanged('events');
  const progress = async (note) => {
    await deps.withClient((c) => recordApplicationEvent(c, { applicationId, kind: 'progress', actor: 'apply', note }));
    notify();
  };
  try {
    if (!deps.resumeRunner || !deps.reviewRunner) {
      deps.log?.({ evt: 'apply_now_chain_missing_runner', application_id: applicationId });
      return;
    }
    await progress('one-click apply: drafting resume');
    const resumeResult = await deps.resumeRunner.run(applicationId, listingId);
    notify();
    if (!resumeResult.ok || !resumeResult.markdownPath) return;

    await progress('one-click apply: reviewing draft');
    const reviewResult = await deps.reviewRunner.run(applicationId, resumeResult.markdownPath, listingId);
    notify();
    if (!reviewResult.ok || reviewResult.verdict !== 'PASS') return;

    await progress('one-click apply: approving');
    await deps.withClient((c) => approve(c, applicationId, { outputRoot: deps.outputRoot, actor: 'apply' }));
    notify();
    kickApplyRunner(deps, applicationId);
  } catch (err) {
    deps.log?.({
      evt: 'apply_now_chain_failed', application_id: applicationId,
      err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
    try {
      await deps.withClient((c) => recordApplicationEvent(c, {
        applicationId, kind: 'error', actor: 'apply', note: 'one-click apply chain failed unexpectedly',
        meta: { err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
      }));
      notify();
    } catch {
      /* best-effort logging only; never let a failed error-log throw out of the fire-and-forget chain */
    }
  }
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  router.register('POST', '/api/listings/:id/application', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const listingRes = await deps.withClient((c) => c.query('SELECT id, url, url_normalized FROM ic_job_listings WHERE id = $1', [id]));
    if (listingRes.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${id} not found`);
    const listing = listingRes.rows[0];
    const applyUrl = listing.url_normalized ?? listing.url ?? null;
    const classification = classifyApplyUrl(applyUrl);
    let app;
    try {
      app = await deps.withClient((c) => createApplication(c, {
        listingId: id, atsType: classification.ats, applyUrl, actor: 'dashboard',
      }));
    } catch (err) {
      if (err instanceof JobSearchError && err.code === 'VALIDATION' && err.details && err.details.listing_id !== undefined) {
        return sendJson(ctx.res, 409, { ok: false, code: 'DUPLICATE_APPLICATION', message: err.message });
      }
      throw err;
    }
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 201, { ok: true, row: app, ats: classification });
  }, { allowEmptyBody: true });

  // One-click apply (PR A spec item 7): create-or-reuse the drafting application for this listing, then
  // run resume -> review -> approve -> apply asynchronously (runApplyNowChain above). Returns 202 with the
  // application id immediately; the caller polls/streams the application's own state and events for
  // progress, exactly as it already does for the pre-existing Approve/Retry flow.
  router.register('POST', '/api/listings/:id/apply-now', async (ctx) => {
    const listingId = Number(ctx.params.id);
    if (!Number.isInteger(listingId) || listingId <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');

    let app = await deps.withClient((c) => getApplicationForListing(c, listingId));
    if (app) {
      if (app.state !== 'drafting') {
        return sendJson(ctx.res, 409, {
          ok: false, code: 'DUPLICATE_APPLICATION',
          message: `an active application (${app.id}, state "${app.state}") already exists for listing ${listingId}`,
        });
      }
      const ageMs = Date.now() - new Date(app.created_at).getTime();
      if (ageMs > STALE_DRAFTING_MS) {
        await deps.withClient((c) => c.query('UPDATE ic_job_applications SET resume_doc_id = NULL, updated_at = now() WHERE id = $1', [app.id]));
        app = await deps.withClient((c) => getApplication(c, app.id));
      }
    } else {
      const listingRes = await deps.withClient((c) => c.query('SELECT id, url, url_normalized FROM ic_job_listings WHERE id = $1', [listingId]));
      if (listingRes.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${listingId} not found`);
      const listing = listingRes.rows[0];
      const applyUrl = listing.url_normalized ?? listing.url ?? null;
      const classification = classifyApplyUrl(applyUrl);
      app = await deps.withClient((c) => createApplication(c, { listingId, atsType: classification.ats, applyUrl, actor: 'dashboard' }));
    }

    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 202, { ok: true, application_id: app.id });

    // Fire-and-forget: the route has already responded. Never awaited here.
    runApplyNowChain(deps, streamHub, app.id, listingId);
  }, { allowEmptyBody: true });

  router.register('GET', '/api/applications/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => getApplication(c, id));
    sendJson(ctx.res, 200, { ok: true, row });
  });

  router.register('GET', '/api/listings/:id/application', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => getApplicationForListing(c, id));
    sendJson(ctx.res, 200, { ok: true, row });
  });

  router.register('POST', '/api/applications/:id/approve', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => approve(c, id, { outputRoot: deps.outputRoot, actor: 'dashboard' }));
    streamHub?.notifyChanged('events');
    kickApplyRunner(deps, id);
    sendJson(ctx.res, 200, { ok: true, row });
  }, { allowEmptyBody: true });

  // Apply pipeline slice 5: failed -> approved (Retry), incrementing attempt.
  router.register('POST', '/api/applications/:id/retry', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => retry(c, id, { actor: 'dashboard', note: 'retried from dashboard' }));
    streamHub?.notifyChanged('events');
    kickApplyRunner(deps, id);
    sendJson(ctx.res, 200, { ok: true, row });
  }, { allowEmptyBody: true });

  // Apply pipeline slice 5: needs_human -> submitted ("I applied by hand"), no attempt increment, no
  // runner kick -- this is the human declaring the automated flow finished outside it.
  router.register('POST', '/api/applications/:id/applied-by-hand', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const row = await deps.withClient((c) => markAppliedByHand(c, id, { actor: 'dashboard' }));
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true, row });
  }, { allowEmptyBody: true });

  // Apply pipeline slice 5: the needs_human answer box (plan section 4's "growing the bank"). `save`
  // defaults to true (durable facts save by default, spec's "save-by-default split"); the caller can pass
  // `save: false` for a one-time-only answer. Only promotes a label to `learned:` when the parked question
  // already carried a matched bank key (an alias/synonym-tier suggestion) -- a question with NO match at
  // all has no key to attach a learned label to, so `save` is a no-op for that case and the answer is
  // recorded only in the application's own event log (audit trail), never written into the bank as a
  // guessed new fact.
  router.register('POST', '/api/applications/:id/answer', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    if (typeof b.text !== 'string' || !b.text.trim()) throw new JobSearchError('VALIDATION', 'text is required');
    const save = b.save !== false;

    const app = await deps.withClient((c) => getApplication(c, id));
    if (app.state !== 'needs_human' || !app.pending_question || app.pending_question.kind !== 'question') {
      throw new JobSearchError('VALIDATION', `application ${id} is not awaiting a screening-question answer`, {
        details: { state: app.state, pending_question_kind: app.pending_question?.kind ?? null },
      });
    }
    const pq = app.pending_question;
    const key = pq.suggestion && typeof pq.suggestion.key === 'string' ? pq.suggestion.key : null;

    if (save && key) {
      let bankText = '';
      try {
        bankText = fs.readFileSync(ANSWER_BANK_PATH, 'utf8');
      } catch {
        bankText = '';
      }
      try {
        const updated = appendLearnedLabel(bankText, key, String(pq.label ?? ''));
        fs.mkdirSync(path.dirname(ANSWER_BANK_PATH), { recursive: true });
        fs.writeFileSync(ANSWER_BANK_PATH, updated);
      } catch (err) {
        deps.log?.({ evt: 'apply_answer_bank_write_failed', application_id: id, err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
      }
    }

    const row = await deps.withClient((c) => resume(c, id, {
      actor: 'dashboard',
      note: `answer saved for "${String(pq.label ?? '').slice(0, 200)}"${save && key ? ' (promoted to learned)' : ' (one-time)'}: ${b.text.slice(0, 500)}`,
    }));
    streamHub?.notifyChanged('events');
    kickApplyRunner(deps, id);
    sendJson(ctx.res, 200, { ok: true, row });
  });

  // Apply pipeline slice 5: the needs_human card's screenshot. Never accepts a caller-supplied path --
  // resolveLatestApplicationScreenshot builds and confines the path itself from the id alone.
  router.register('GET', '/api/applications/:id/screenshot', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const absPath = resolveLatestApplicationScreenshot(deps.outputRoot, id);
    if (!absPath) throw new JobSearchError('NOT_FOUND', `no screenshot for application ${id}`);
    const data = fs.readFileSync(absPath);
    ctx.res.setHeader('Content-Type', 'image/png');
    ctx.res.statusCode = 200;
    ctx.res.end(data);
  });

  router.register('GET', '/api/applications/:id/events', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const events = await deps.withClient((c) => listApplicationEvents(c, id));
    sendJson(ctx.res, 200, { ok: true, events });
  });

  // Loopback-only internal sink (like every route on this router -- server.js's Host/Origin guards apply
  // server-wide, so nothing extra is needed here) the worker POSTs live progress to (plan section 7:
  // "approved/submitting show live progress via the existing SSE stream (worker posts progress to a
  // loopback-only POST /api/internal/apply-progress)"). Stores the message as a 'progress' application
  // event (already a legal APPLICATION_EVENT_KINDS value) and broadcasts the existing 'changed'/'events'
  // SSE signal so any open dashboard tab refetches -- no new SSE event type, reusing 100% of the existing
  // plumbing (see the PR body's design note).
  router.register('POST', '/api/internal/apply-progress', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    const applicationId = Number(b.applicationId);
    if (!Number.isInteger(applicationId) || applicationId <= 0) throw new JobSearchError('VALIDATION', 'applicationId must be a positive integer');
    const message = typeof b.message === 'string' ? b.message.slice(0, 300) : 'progress';
    await deps.withClient((c) => c.query(
      `INSERT INTO ic_job_application_events (application_id, kind, actor, note) VALUES ($1, 'progress', 'apply', $2)`,
      [applicationId, message],
    ));
    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 200, { ok: true });
  });
}
