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
  listApplicationEvents, recordApplicationEvent, transition, APPLICATION_STATES, checkApplicationBlockers,
} from '../../core/applications.js';
import { classifyApplyUrl } from '../../apply/ats-detect.js';
import { resolveLatestApplicationScreenshot } from '../../apply/screenshot.js';
import { appendLearnedLabel } from '../../apply/answers.js';
import { packageRoot, loadConfig } from '../../core/config.js';
import { classifyExclusion, loadExclusionConfig, HARD_BRANCHES } from '../../apply/exclusions.js';
import { sendJson } from '../http.js';

const ANSWER_BANK_PATH = path.join(packageRoot(), 'data', 'apply-answers.md');

/** One-click apply (PR A spec item 7): a drafting row this old is reused only after resetting its resume
 * link -- the world (the listing's own description, or the operator's data files) may well have changed
 * since a stale drafting row was first created, so a fresh draft is safer than trusting a week-old link.
 * Renamed from STALE_DRAFTING_MS (apply-chain-park fix): distinct in purpose from STALE_ACTIONABLE_MS
 * below -- this one only ever gates the resume-doc-link reset, never re-click eligibility. */
export const STALE_REUSE_RESET_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Apply-chain-park fix, spec item 3: how long a re-clicked "Apply" on a listing's own still-drafting
 * application is treated as "the earlier click's chain is presumably still in flight" and refused a
 * second chain start, independent of the in-memory per-application chain lock below (which is the
 * precise, same-process signal -- this age-based check is the defense-in-depth backstop that also covers
 * a process restart, or any other way the in-memory lock's state could be lost or never set). Mirrored in
 * public/lib/format.js's applyButtonState() (drift-tested against this export) so the Apply button
 * itself renders as non-actionable for the same window on the client.
 */
export const STALE_ACTIONABLE_MS = 30 * 60 * 1000;

/**
 * Apply-chain-park fix, spec item 2: in-memory set of application ids with a runApplyNowChain currently
 * in flight in THIS process. A second POST /api/listings/:id/apply-now for an id already in this set
 * never starts a second chain (responds 202 with outcome 'chain_running' instead) -- the chain's own
 * resumeRunner/reviewRunner already enforce a single GLOBAL in-flight run each, but that is one shared
 * lock across every application, not scoped per application id, so two DIFFERENT applications' chains
 * would otherwise collide there instead of failing cleanly per-id at the route. Module-level (not part of
 * `deps`) because it tracks in-flight work for this one process's lifetime only, exactly like
 * resume-runner.js's own module-level `current` variable.
 * @type {Set<number>}
 */
const runningChains = new Set();

/**
 * Human-readable label for a parked application's pending_question (apply-chain-park fix, spec item 1).
 * TOTAL classification, never an allow-list: every known resume-runner failure reason gets its own
 * specific label; anything else (including an arbitrary HEADLESS_ABORT reason string from the write-resume
 * skill, an open/unbounded set) falls through to the generic default branch, never a thrown error or a
 * blank label.
 * @param {string} reason
 */
function humanizeParkReason(reason) {
  const KNOWN = /** @type {Record<string, string>} */ ({
    no_description: 'Job posting has no usable description to draft a resume from.',
    timeout: 'Resume drafting timed out.',
    spawn_failed: 'Resume drafting failed to start.',
    listing_mismatch: 'The drafted resume did not match this listing; the link was reset.',
    model_asked: 'Resume drafting stopped to ask a question instead of finishing.',
    no_docs_ready: 'Resume drafting finished without producing a resume.',
    markdown_not_found: 'Resume drafting finished but the draft file could not be found.',
    runner_unavailable: 'Resume drafting is not available on this server right now.',
  });
  if (Object.prototype.hasOwnProperty.call(KNOWN, reason)) return KNOWN[reason];
  return `Resume drafting stopped: ${reason}`;
}

/**
 * Apply-chain-park fix, spec item 1: park an application that hit a resume-runner precheck failure (or a
 * missing runner) into needs_human instead of leaving it silently stuck in drafting -- the entire point of
 * this fix is that a resume-runner failure must always be visible and actionable to the operator, not a
 * dead end. Wrapped in try/catch: if the row already moved on (parked by another actor between this
 * chain's own read and this write, or advanced past drafting some other way), the transition is rejected
 * by TRANSITIONS as a plain VALIDATION error -- that is a benign, expected race, not a chain failure, so
 * it is logged at info and swallowed here rather than surfaced as `apply_now_chain_failed` by the caller's
 * own outer catch.
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>|undefined} streamHub
 * @param {number} applicationId
 * @param {string} reason
 */
async function parkApplyChain(deps, streamHub, applicationId, reason) {
  try {
    await deps.withClient((c) => transition(c, applicationId, 'needs_human', {
      actor: 'apply', error: reason, pending_question: { kind: 'blocked', label: humanizeParkReason(reason) },
    }));
    streamHub?.notifyChanged('events');
  } catch (err) {
    if (err instanceof JobSearchError && err.code === 'VALIDATION') {
      deps.log?.({
        evt: 'apply_now_chain_park_skipped', application_id: applicationId, reason,
        err_message: err.message.slice(0, 300),
      });
      return;
    }
    throw err;
  }
}

/**
 * Full listing columns the apply exclusion gate (src/apply/exclusions.js) needs -- one-click Apply's own
 * gate check at creation/reuse time. NOT the same query GET /api/listings/:id already runs (this route
 * only needs the exclusion-relevant subset).
 * @param {import('../server.js').DashboardDeps} deps
 * @param {number} listingId
 */
async function fetchExclusionListing(deps, listingId) {
  const r = await deps.withClient((c) => c.query(
    `SELECT id, company, company_norm, title, title_norm, apply_url, url, url_normalized, description
     FROM ic_job_listings WHERE id = $1`,
    [listingId],
  ));
  if (r.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${listingId} not found`);
  const row = r.rows[0];
  return {
    id: Number(row.id), company: row.company ?? null, companyNorm: row.company_norm ?? null,
    title: row.title ?? null, titleNorm: row.title_norm ?? null, applyUrl: row.apply_url ?? null,
    sourceUrl: row.url_normalized ?? row.url ?? null, description: row.description ?? null,
  };
}

/**
 * Apply exclusion gate (one-click Apply's own entry point, spec item 4): classify the listing before any
 * application row is created or reused. Returns `null` when eligible to proceed (branch 'eligible', or a
 * NEEDS_HUMAN branch the caller explicitly overrode). Otherwise sends the 409 response itself and returns
 * `true` so the caller stops. `excludeApplicationId` is the listing's own currently-drafting application
 * (if any) being re-clicked -- see classifyExclusion's own doc comment on that field for why it must be
 * excluded from the already-applied checks here (this route's pre-existing DUPLICATE_APPLICATION handling
 * already governs re-entry into that same row).
 * @param {import('../server.js').DashboardDeps} deps
 * @param {import('http').ServerResponse} res
 * @param {number} listingId
 * @param {{ excludeApplicationId?: number|null, override?: boolean }} opts
 * @returns {Promise<boolean>} true when the route already responded and must stop
 */
export async function applyExclusionGate(deps, res, listingId, opts) {
  const configDir = deps.config?.configDir ?? loadConfig().configDir;
  let exclusionConfig;
  try {
    exclusionConfig = loadExclusionConfig(configDir);
  } catch (err) {
    if (err instanceof JobSearchError && err.code === 'CONFIG_INVALID') {
      sendJson(res, 409, { ok: false, code: 'APPLY_EXCLUDED', branch: 'config_invalid', reason: err.message, message: err.message });
      return true;
    }
    throw err;
  }
  const listing = await fetchExclusionListing(deps, listingId);
  const verdict = await deps.withClient((c) => classifyExclusion(listing, {
    client: c, config: exclusionConfig, excludeApplicationId: opts.excludeApplicationId ?? null,
  }));
  if (verdict.branch === 'eligible') return false;
  if (HARD_BRANCHES.includes(verdict.branch)) {
    sendJson(res, 409, { ok: false, code: 'APPLY_EXCLUDED', branch: verdict.branch, reason: verdict.reason, message: verdict.reason });
    return true;
  }
  // NEEDS_HUMAN branch: proceed only on an explicit override; otherwise surface it for a human decision.
  if (opts.override === true) return false;
  sendJson(res, 409, { ok: false, code: 'APPLY_NEEDS_OVERRIDE', branch: verdict.branch, reason: verdict.reason, message: verdict.reason });
  return true;
}

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
      await parkApplyChain(deps, streamHub, applicationId, 'runner_unavailable');
      return;
    }
    await progress('one-click apply: drafting resume');
    const resumeResult = await deps.resumeRunner.run(applicationId, listingId);
    notify();
    if (!resumeResult.ok || !resumeResult.markdownPath) {
      // Resume-runner failure (precheck or otherwise): park to needs_human rather than the previous
      // silent return that left the row stuck, invisible, in 'drafting' forever (apply-chain-park fix,
      // spec item 1). Review-phase failures below are unaffected -- they stay at docs_ready, out of scope.
      await parkApplyChain(deps, streamHub, applicationId, resumeResult.reason ?? 'unknown');
      return;
    }

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
    const body = /** @type {any} */ (ctx.body) ?? {};
    const override = body.override === true;

    let app = await deps.withClient((c) => getApplicationForListing(c, listingId));

    // Apply exclusion gate (spec item 4): never submit to a job already applied to, or to a blocked
    // employer. Runs before any application row is created or reused; excludes THIS listing's own
    // currently-drafting application (if any) from the already-applied checks -- see applyExclusionGate's
    // doc comment.
    // deps.applyExclusionGate is a test seam ONLY (never set by production wiring): lets a test exercising
    // unrelated apply-now behavior with a shared listing fixture across many test cases bypass the gate's
    // own cross-listing DB lookups. Defaults to the real gate.
    const gate = deps.applyExclusionGate ?? applyExclusionGate;
    const blocked = await gate(deps, ctx.res, listingId, {
      excludeApplicationId: app ? app.id : null, override,
    });
    if (blocked) return;

    if (app) {
      if (app.state !== 'drafting') {
        return sendJson(ctx.res, 409, {
          ok: false, code: 'DUPLICATE_APPLICATION',
          message: `an active application (${app.id}, state "${app.state}") already exists for listing ${listingId}`,
        });
      }
      // Apply-chain-park fix, spec items 2/3: never start a second chain for an id whose chain is already
      // known in-flight this process (the in-memory lock), and never re-kick a still-fresh drafting row
      // even if the in-memory lock's state was lost (process restart) -- both checks answer the same
      // question ("is the earlier click's chain presumably still running") from two independent angles, so
      // either one alone is enough to refuse a second chain start here.
      const ageMs = Date.now() - new Date(app.created_at).getTime();
      if (runningChains.has(app.id) || ageMs < STALE_ACTIONABLE_MS) {
        streamHub?.notifyChanged('events');
        return sendJson(ctx.res, 202, { ok: true, application_id: app.id, outcome: 'chain_running' });
      }
      if (ageMs > STALE_REUSE_RESET_MS) {
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

    // Fire-and-forget: the route has already responded. Never awaited here. Tracked in the per-application
    // chain lock (spec item 2) for the chain's whole lifetime, regardless of outcome (success, park, or
    // unexpected failure) -- removed in the .finally() below, never left dangling.
    const applicationId = app.id;
    runningChains.add(applicationId);
    runApplyNowChain(deps, streamHub, applicationId, listingId).finally(() => { runningChains.delete(applicationId); });
  }, { allowEmptyBody: true });

  // Review page "Applications awaiting approval" list (review-approvals-list PR spec A1). `state` is a
  // comma-separated list of ic_job_applications.state values, validated against the state machine's own
  // APPLICATION_STATES (never an allow-list maintained separately from it); default 'docs_ready' when the
  // query param is absent, empty, or blank (the same "falsy string reads as absent" convention
  // parseListingsQuery's listParam() uses elsewhere in this dashboard). A present-but-malformed value (an
  // empty entry from e.g. "docs_ready,") or any entry outside APPLICATION_STATES is a 400 naming the
  // offending value, never silently dropped. Capped at 200 rows (ordered created_at DESC, id DESC for a
  // stable tiebreak); `total` is the FULL matching count so the UI can render "showing 200 of N".
  router.register('GET', '/api/applications', async (ctx) => {
    const raw = typeof ctx.query.state === 'string' && ctx.query.state.trim() ? ctx.query.state : 'docs_ready';
    const parts = raw.split(',').map((s) => s.trim());
    const badEntry = parts.find((s) => !s);
    if (badEntry !== undefined) {
      throw new JobSearchError('VALIDATION', `state must not contain an empty value: "${raw}"`, { details: { state: raw } });
    }
    const states = [...new Set(parts)];
    for (const s of states) {
      if (!APPLICATION_STATES.includes(s)) {
        throw new JobSearchError('VALIDATION', `unknown application state: "${s}"`, { details: { state: s } });
      }
    }

    const configDir = deps.config?.configDir ?? loadConfig().configDir;
    const exclusionConfig = loadExclusionConfig(configDir);

    const { rows, total } = await deps.withClient(async (c) => {
      const totalRes = await c.query('SELECT count(*)::int AS n FROM ic_job_applications WHERE state = ANY($1::text[])', [states]);
      const mainRes = await c.query(
        // rel_path is joined in (never returned by any other field in this row) so the Review page's Open
        // resume/Open cover letter buttons can call POST /api/documents/open with the same {path} body
        // application-card.js's own docRow() already uses -- that route takes a rel_path, not a doc id.
        `SELECT a.id AS application_id, a.listing_id, a.state, a.review_verdict, a.review_findings,
                a.resume_doc_id, a.coverletter_doc_id, a.pending_question, a.created_at, a.updated_at,
                l.title, l.company, l.company_norm, l.title_norm, l.location_norm, l.apply_ats, l.apply_url,
                l.url, l.url_normalized, l.description, l.status AS listing_status,
                rd.rel_path AS resume_rel_path, cd.rel_path AS coverletter_rel_path
         FROM ic_job_applications a
         JOIN ic_job_listings l ON l.id = a.listing_id
         LEFT JOIN ic_job_documents rd ON rd.id = a.resume_doc_id
         LEFT JOIN ic_job_documents cd ON cd.id = a.coverletter_doc_id
         WHERE a.state = ANY($1::text[])
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 200`,
        [states],
      );
      const out = [];
      for (const row of mainRes.rows) {
        const listing = {
          company: row.company, company_norm: row.company_norm, title: row.title, title_norm: row.title_norm,
          apply_url: row.apply_url, url: row.url, url_normalized: row.url_normalized, description: row.description,
          status: row.listing_status,
        };
        const blockers = await checkApplicationBlockers(
          c, { id: Number(row.application_id), listing_id: Number(row.listing_id) }, { config: exclusionConfig, listing },
        );
        out.push({
          listing_id: Number(row.listing_id), title: row.title, company: row.company, location_norm: row.location_norm,
          apply_ats: row.apply_ats, listing_status: row.listing_status,
          application_id: Number(row.application_id), state: row.state, review_verdict: row.review_verdict,
          review_findings: row.review_findings, resume_doc_id: row.resume_doc_id, coverletter_doc_id: row.coverletter_doc_id,
          resume_rel_path: row.resume_rel_path ?? null, coverletter_rel_path: row.coverletter_rel_path ?? null,
          parked_reason: row.pending_question && typeof row.pending_question.label === 'string' ? row.pending_question.label : null,
          created_at: row.created_at, updated_at: row.updated_at,
          blocked: blockers.blocked, blocked_reason: blockers.blockedReason, sibling_active: blockers.siblingActive,
        });
      }
      return { rows: out, total: Number(totalRes.rows[0].n) };
    });
    sendJson(ctx.res, 200, { ok: true, total, rows });
  });

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
