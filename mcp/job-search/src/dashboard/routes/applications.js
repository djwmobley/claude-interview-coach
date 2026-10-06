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
import { JobSearchError, errFields } from '../../core/errors.js';
import { withTransaction } from '../../core/db.js';
import {
  createApplication, approve, getApplication, getApplicationForListing, retry, markAppliedByHand, resume,
  listApplicationEvents, recordApplicationEvent, transitionUnwrapped, APPLICATION_STATES, checkApplicationBlockers,
  withdrawApplication, ASSISTED_ATS_TYPES,
  cleanupWithdrawnNudgeCalendar, hasAssistedNextClickEver, partialDraftSql, PARTIAL_DRAFT_WARNING, submitMarkerSql,
} from '../../core/applications.js';
import { collectSubmissions } from '../../core/report.js';
import { resumeParkedApplication, humanizeParkReason, resumeEligible } from '../../apply/resume-gate.js';
import { classifyApplyUrl } from '../../apply/ats-detect.js';
import { resolveLatestApplicationScreenshot } from '../../apply/screenshot.js';
import { appendLearnedLabel } from '../../apply/answers.js';
import { applyChoiceAnswer, updateBank, BankChangedError } from '../../apply/bank-writer.js';
import { packageRoot, loadConfig } from '../../core/config.js';
import { classifyExclusion, loadExclusionConfig, HARD_BRANCHES } from '../../apply/exclusions.js';
import { sendJson } from '../http.js';

const ANSWER_BANK_PATH = path.join(packageRoot(), 'data', 'apply-answers.md');

/** Field kinds whose parked question is a choice (answer-fallback F6). */
const CHOICE_FIELD_KINDS = Object.freeze(['select', 'radio', 'listbox']);

/**
 * A parked question is a CHOICE when it carries a non-empty captured option list and its field kind is a
 * choice kind, or unknown (an options list with no recorded kind is treated as a choice: the stricter
 * branch). A recorded non-choice kind (text, textarea, checkbox) keeps the free-text answer.
 * @param {any} pq
 */
function isChoicePending(pq) {
  if (!pq || !Array.isArray(pq.options) || pq.options.length === 0) return false;
  return pq.field_kind === undefined || pq.field_kind === null || CHOICE_FIELD_KINDS.includes(pq.field_kind);
}

/** One-click apply (PR A spec item 7): a drafting row this old is reused only after resetting its resume
 * link -- the world (the listing's own description, or the operator's data files) may well have changed
 * since a stale drafting row was first created, so a fresh draft is safer than trusting a week-old link.
 * Renamed from STALE_DRAFTING_MS (apply-chain-park fix): distinct in purpose from STALE_ACTIONABLE_MS
 * below -- this one only ever gates the resume-doc-link reset, never re-click eligibility. */
export const STALE_REUSE_RESET_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard kill for a dashboard-started linkedin_easy run: the worker's own 15-minute Easy Apply budget plus a
 * two-minute grace period to unwind and park the result. */
export const EASY_APPLY_HARD_TIMEOUT_MS = 17 * 60 * 1000;

/**
 * Apply-chain-park fix, spec item 3: the age under which the job-row Apply button renders a drafting
 * application as "Drafting in progress" (public/lib/format.js applyButtonState(), drift-tested against
 * this export). The apply-now route itself no longer uses it to decide "chain_running" (chain-park spec
 * A1): a created_at-based window refused a fresh chain for a row that had been parked and resumed within
 * 30 minutes, answering 202 with nothing running. Only the in-memory runningChains set decides that now.
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
 * Chain-park A1, client side: whether an Apply now chain for this application is in flight in this
 * process. GET /api/listings and GET /api/listings/:id expose it so the job-row Apply button keys off a
 * chain that is actually running, never the row's created_at age. Process-local, like runningChains.
 * @param {number|string|null|undefined} applicationId
 */
export function isApplyChainRunning(applicationId) {
  if (applicationId === null || applicationId === undefined) return false;
  return runningChains.has(Number(applicationId));
}

/**
 * Chain-park spec D1: park an Apply now chain's resume-phase failure into needs_human with kind
 * `resume_failed` (the kind the resume gate redrafts), error = reason, and a human label from
 * humanizeParkReason (apply/resume-gate.js, the one source the legacy `blocked` check also reads).
 *
 * Guarded (A4): one transaction, transitionUnwrapped with expectedFromState 'drafting', so the park only
 * ever moves a row that is STILL drafting under the row lock. A row another actor moved on (submitting,
 * docs_ready, already parked) is never touched.
 *
 * Narrow swallow (A5): a VALIDATION error carrying details.expected is the expected state-mismatch race,
 * logged at info and swallowed. Any other VALIDATION error is logged at error level and not rethrown (the
 * row stays drafting; the log is the signal). Every non-VALIDATION error propagates to the caller.
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>|undefined} streamHub
 * @param {number} applicationId
 * @param {string} reason
 * @param {Record<string, unknown>} [meta]
 * @returns {Promise<boolean>} true when the row was parked
 */
async function parkChainFailure(deps, streamHub, applicationId, reason, meta) {
  try {
    await deps.withClient((c) => withTransaction(c, (tx) => transitionUnwrapped(tx, applicationId, 'needs_human', {
      actor: 'apply', error: reason, note: `one-click apply parked: ${reason}`, meta,
      pending_question: { kind: 'resume_failed', label: humanizeParkReason(reason) },
    }, { expectedFromState: 'drafting', helperName: 'parkChainFailure' })));
    streamHub?.notifyChanged('events');
    return true;
  } catch (err) {
    if (err instanceof JobSearchError && err.code === 'VALIDATION') {
      const expected = /** @type {any} */ (err).details?.expected;
      if (expected !== undefined && expected !== null) {
        deps.log?.({ evt: 'apply_now_chain_park_skipped', application_id: applicationId, reason, err_message: err.message.slice(0, 300) });
      } else {
        deps.log?.({ evt: 'apply_now_chain_park_failed', severity: 'error', application_id: applicationId, reason, err_message: err.message.slice(0, 300) });
      }
      return false;
    }
    throw err;
  }
}

/**
 * Whether the dashboard's resume runner reports a run in flight. Process-local only (A2): bin/auto-apply.js
 * runs its own resume runner in another process, which this cannot see.
 * @param {import('../server.js').DashboardDeps} deps
 */
function resumeRunnerBusy(deps) {
  const runner = /** @type {any} */ (deps.resumeRunner);
  if (!runner || typeof runner.status !== 'function') return false;
  try {
    return Boolean(runner.status()?.running);
  } catch {
    return false;
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
function kickApplyRunner(deps, applicationId, row) {
  if (!deps.applyRunner) return;
  const runner = deps.applyRunner;
  // Assisted LinkedIn Easy Apply runs up to 15 minutes in the worker (src/apply/worker.js
  // EASY_APPLY_TIMEOUT_MS); the default 7-minute hard kill would cut the headless fill session off, so a
  // linkedin_easy application gets EASY_APPLY_HARD_TIMEOUT_MS instead. `row` (the application row the
  // calling route already has) decides synchronously; without it the row is read first.
  // Assisted Workday (spec v1 clause 9) runs the same 15-minute assisted budget, so it gets the same kill.
  const startFor = (/** @type {any} */ app) => (app && ASSISTED_ATS_TYPES.includes(app.ats_type) ? runner.start(applicationId, { hardTimeoutMs: EASY_APPLY_HARD_TIMEOUT_MS }) : runner.start(applicationId));
  const fail = (/** @type {unknown} */ err) => {
    deps.log?.({ evt: 'apply_runner_start_failed', application_id: applicationId, err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
  };
  if (row) {
    Promise.resolve().then(() => startFor(row)).catch(fail);
    return;
  }
  Promise.resolve(deps.withClient((c) => getApplication(c, applicationId))).then(startFor).catch(fail);
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
  const progress = async (/** @type {string} */ note) => {
    await deps.withClient((c) => recordApplicationEvent(c, { applicationId, kind: 'progress', actor: 'apply', note }));
    notify();
  };
  /** The chain phase in flight when an exception is thrown (D1): decides how the catch classifies it.
   * @type {'resume'|'review'|'approve'} */
  let phase = 'resume';
  try {
    if (!deps.resumeRunner || !deps.reviewRunner) {
      deps.log?.({ evt: 'apply_now_chain_missing_runner', application_id: applicationId });
      await parkChainFailure(deps, streamHub, applicationId, 'runner_unavailable');
      return;
    }
    await progress('one-click apply: drafting resume');
    const resumeResult = await deps.resumeRunner.run(applicationId, listingId);
    notify();
    if (!resumeResult.ok || !resumeResult.markdownPath) {
      // D1: the resume runner's own fail() usually parks the row already; park here only when it is
      // still drafting after that (the guarded park checks the state under the row lock). A failed result
      // with no reason is chain_error; an ok result with no draft path is markdown_not_found.
      const reason = !resumeResult.ok ? (resumeResult.reason ?? 'chain_error') : 'markdown_not_found';
      await parkChainFailure(deps, streamHub, applicationId, reason);
      return;
    }

    phase = 'review';
    await progress('one-click apply: reviewing draft');
    const reviewResult = await deps.reviewRunner.run(applicationId, resumeResult.markdownPath, listingId);
    notify();
    if (!reviewResult.ok || reviewResult.verdict !== 'PASS') {
      // D1: stays docs_ready with Approve visible; say so on the card.
      await progress('one-click apply: review did not pass; approve by hand');
      return;
    }

    phase = 'approve';
    await progress('one-click apply: approving');
    const approvedRow = await deps.withClient((c) => approve(c, applicationId, { outputRoot: deps.outputRoot, actor: 'apply' }));
    notify();
    kickApplyRunner(deps, applicationId, approvedRow);
  } catch (err) {
    // A3: the whole catch body is guarded; nothing in it may reject out of the fire-and-forget chain.
    try {
      const f = errFields(err);
      deps.log?.({ evt: 'apply_now_chain_failed', application_id: applicationId, phase, err_code: f.err_code, err_message: f.err_message });
      /** @type {unknown} */
      let state;
      try {
        state = (await deps.withClient((c) => getApplication(c, applicationId))).state;
      } catch (probeErr) {
        deps.log?.({ evt: 'apply_now_chain_park_failed', severity: 'error', application_id: applicationId, phase, step: 'state_probe', ...errFields(probeErr) });
        return;
      }
      // Total classification of the row's state (D1). An approve-phase failure never parks.
      if (state === 'drafting' && phase !== 'approve') {
        const reason = err instanceof JobSearchError && err.code === 'LOCKED' ? 'resume_runner_busy' : 'chain_error';
        await parkChainFailure(deps, streamHub, applicationId, reason, { phase, err_code: f.err_code });
        return;
      }
      // docs_ready (no edge to needs_human; Approve stays visible), or any other state (another actor
      // owns the row): an error event only.
      const note = state === 'docs_ready'
        ? `one-click apply ${phase} failed; the draft is still ready, approve it by hand`
        : 'one-click apply chain failed unexpectedly';
      await deps.withClient((c) => recordApplicationEvent(c, {
        applicationId, kind: 'error', actor: 'apply', note,
        meta: { phase, state: typeof state === 'string' ? state : null, err_code: f.err_code, err_message: f.err_message },
      }));
      notify();
    } catch (catchErr) {
      try {
        deps.log?.({ evt: 'apply_now_chain_park_failed', severity: 'error', application_id: applicationId, phase, ...errFields(catchErr) });
      } catch {
        /* a throwing logger must not reject the fire-and-forget chain either */
      }
    }
  }
}

/**
 * Apply-target classification for the dashboard's create routes (spec v1 F1.4, "Extra defect"). A URL
 * classifyApplyUrl labels linkedin_easy from the HOST alone (every linkedin.com/jobs/view/ URL) is never
 * trusted: the live page-state check (deps.linkedInApplyCheck, src/apply/linkedin-button-prepare.js's
 * createLinkedInLiveCheck in production) must report 'easy_apply', and the result is labeled 'inferred',
 * never 'exact'. Any other branch -- or no check wired, or a check that throws -- refuses with that branch
 * (interactive path: refuse, never park). Every non-LinkedIn URL keeps classifyApplyUrl's own result.
 * @param {import('../server.js').DashboardDeps & { linkedInApplyCheck?: (listingId: number) => Promise<{ branch: string, reason?: string }> }} deps
 * @param {number} listingId
 * @returns {Promise<{ ok: true, classification: { ats: string, tenant: string|null, confidence: string }, applyUrl: string|null } | { ok: false, branch: string, reason: string|null }>}
 */
async function classifyListingApplyTarget(deps, listingId) {
  const listingRes = await deps.withClient((c) => c.query('SELECT id, url, url_normalized FROM ic_job_listings WHERE id = $1', [listingId]));
  if (listingRes.rowCount === 0) throw new JobSearchError('NOT_FOUND', `listing ${listingId} not found`);
  const listing = listingRes.rows[0];
  const applyUrl = listing.url_normalized ?? listing.url ?? null;
  const classification = classifyApplyUrl(applyUrl);
  if (classification.ats !== 'linkedin_easy') return { ok: true, classification, applyUrl };
  if (typeof deps.linkedInApplyCheck !== 'function') return { ok: false, branch: 'check_unavailable', reason: 'no LinkedIn page-state check is wired' };
  /** @type {{ branch: string, reason?: string }} */
  let r;
  try {
    r = await deps.linkedInApplyCheck(listingId);
  } catch (err) {
    deps.log?.({ evt: 'linkedin_apply_check_failed', listing_id: listingId, ...errFields(err) });
    return { ok: false, branch: 'check_error', reason: errFields(err).err_code ?? null };
  }
  if (!r || r.branch !== 'easy_apply') return { ok: false, branch: r && typeof r.branch === 'string' ? r.branch : 'unknown', reason: r && r.reason ? String(r.reason) : null };
  return { ok: true, classification: { ...classification, confidence: 'inferred' }, applyUrl };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} listingId
 * @param {{ branch: string, reason: string|null }} target
 */
function refuseNotEasyApply(res, listingId, target) {
  return sendJson(res, 409, {
    ok: false, code: 'LINKEDIN_NOT_EASY_APPLY',
    message: `The LinkedIn job page did not show exactly one Easy Apply button (page state: ${target.branch}). No application was created.`,
    details: { listing_id: listingId, branch: target.branch, reason: target.reason },
  });
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
    const target = await classifyListingApplyTarget(deps, id);
    if (!target.ok) return refuseNotEasyApply(ctx.res, id, target);
    const { classification, applyUrl } = target;
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

    if (app && app.state !== 'drafting') {
      return sendJson(ctx.res, 409, {
        ok: false, code: 'DUPLICATE_APPLICATION',
        message: `an active application (${app.id}, state "${app.state}") already exists for listing ${listingId}`,
      });
    }
    // Chain-park spec A1: a chain counts as running ONLY when this process's runningChains has the id.
    // A drafting row with no chain in flight (for example one parked and then resumed) starts a new chain.
    if (app && runningChains.has(app.id)) {
      streamHub?.notifyChanged('events');
      return sendJson(ctx.res, 202, { ok: true, application_id: app.id, outcome: 'chain_running' });
    }
    // Chain-park spec A2: refuse while the resume runner is busy, BEFORE any row is created or reused, so a
    // 409 leaves nothing behind. The check is process-local (bin/auto-apply.js has its own runner) and
    // racy: a run starting between this check and the chain's own run() call is covered only by the
    // LOCKED -> resume_runner_busy park in runApplyNowChain.
    if (resumeRunnerBusy(deps)) {
      return sendJson(ctx.res, 409, {
        ok: false, code: 'RESUME_RUNNER_BUSY',
        message: 'Another resume is being drafted right now. Try Apply now again when it finishes.',
      });
    }

    if (app) {
      if (app.ats_type === 'linkedin_easy') {
        // A reused drafting Easy Apply row is re-checked against the live page too (spec v1 F1.4).
        const target = await classifyListingApplyTarget(deps, listingId);
        if (!target.ok) return refuseNotEasyApply(ctx.res, listingId, target);
      }
      const ageMs = Date.now() - new Date(app.created_at).getTime();
      if (ageMs > STALE_REUSE_RESET_MS) {
        await deps.withClient((c) => c.query('UPDATE ic_job_applications SET resume_doc_id = NULL, updated_at = now() WHERE id = $1', [app.id]));
        app = await deps.withClient((c) => getApplication(c, app.id));
      }
    } else {
      const target = await classifyListingApplyTarget(deps, listingId);
      if (!target.ok) return refuseNotEasyApply(ctx.res, listingId, target);
      app = await deps.withClient((c) => createApplication(c, { listingId, atsType: target.classification.ats, applyUrl: target.applyUrl, actor: 'dashboard' }));
    }

    streamHub?.notifyChanged('events');
    sendJson(ctx.res, 202, { ok: true, application_id: app.id });

    // Fire-and-forget: the route has already responded. Never awaited here. Tracked in the per-application
    // chain lock (spec item 2) for the chain's whole lifetime, regardless of outcome (success, park, or
    // unexpected failure) -- removed in the .finally() below, never left dangling.
    const applicationId = app.id;
    runningChains.add(applicationId);
    // A3: runApplyNowChain guards its own catch body; this .catch is the last line so nothing can ever
    // surface as an unhandled rejection from the fire-and-forget chain.
    runApplyNowChain(deps, streamHub, applicationId, listingId)
      .finally(() => { runningChains.delete(applicationId); })
      .catch((err) => {
        try {
          deps.log?.({ evt: 'apply_now_chain_park_failed', severity: 'error', application_id: applicationId, step: 'chain_rejected', ...errFields(err) });
        } catch {
          /* never rethrow from the last-resort handler */
        }
      });
  }, { allowEmptyBody: true });

  // Review page "Applications awaiting approval" list (review-approvals-list PR spec A1). `state` is a
  // comma-separated list of ic_job_applications.state values, validated against the state machine's own
  // APPLICATION_STATES (never an allow-list maintained separately from it); default 'docs_ready' when the
  // query param is absent, empty, or blank (the same "falsy string reads as absent" convention
  // parseListingsQuery's listParam() uses elsewhere in this dashboard). A present-but-malformed value (an
  // empty entry from e.g. "docs_ready,") or any entry outside APPLICATION_STATES is a 400 naming the
  // offending value, never silently dropped. Capped at 200 rows (ordered created_at DESC, id DESC for a
  // stable tiebreak); `total` is the FULL matching count so the UI can render "showing 200 of N".
  // Unattended submit spec item 7: submissions read from the DATABASE (submitted in the last 24 hours, any
  // path) and every unconfirmed submit in its own list, the same rows the morning report shows
  // (src/core/report.js collectSubmissions). Its own path so it never collides with /api/applications/:id.
  router.register('GET', '/api/submissions', async (ctx) => {
    const out = await deps.withClient((c) => collectSubmissions(c));
    sendJson(ctx.res, 200, { ok: true, submitted: out.submitted, unconfirmed: out.unconfirmed });
  });

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
                a.resume_doc_id, a.coverletter_doc_id, a.pending_question, a.error, a.created_at, a.updated_at,
                l.title, l.company, l.company_norm, l.title_norm, l.location_norm, l.apply_ats, l.apply_url,
                l.url, l.url_normalized, l.description, l.status AS listing_status,
                rd.rel_path AS resume_rel_path, cd.rel_path AS coverletter_rel_path,
                ${partialDraftSql('a')} AS partial_draft, ${submitMarkerSql('a')} AS submit_sent
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
          pending_kind: row.pending_question && typeof row.pending_question.kind === 'string' ? row.pending_question.kind : null,
          // Chain-park spec D2/A6: server-computed from state, the full pending_question (label) and error,
          // so a legacy blocked resume-runner park shows Resume and every other blocked park does not.
          resume_eligible: resumeEligible({ state: row.state, pending_question: row.pending_question, error: row.error }),
          partial_draft: Boolean(row.partial_draft),
          // Unattended submit spec v2 C8: a submit marker exists (any attempt): already submitted (unconfirmed).
          submit_sent: Boolean(row.submit_sent),
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
    kickApplyRunner(deps, id, row);
    sendJson(ctx.res, 200, { ok: true, row });
  }, { allowEmptyBody: true });

  // Apply pipeline slice 5: failed -> approved (Retry), incrementing attempt.
  router.register('POST', '/api/applications/:id/retry', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    // Resume gate R3: when an assisted run ever clicked Next for this application, the retry needs
    // `acknowledge_partial_draft: true` (409 RETRY_REFUSED partial_draft_ack_required otherwise), checked
    // under the row lock inside retry(); the acknowledgment is recorded on the event.
    const b = /** @type {any} */ (ctx.body) ?? {};
    const ack = b.acknowledge_partial_draft === true;
    let row;
    try {
      row = await deps.withClient((c) => retry(c, id, { actor: 'dashboard', note: 'retried from dashboard', partialDraftPolicy: 'require_ack', acknowledgePartialDraft: ack }));
    } catch (err) {
      if (err instanceof JobSearchError && /** @type {any} */ (err).details?.reason === 'partial_draft_ack_required') {
        return sendJson(ctx.res, 409, { ok: false, code: 'RETRY_REFUSED', reason: 'partial_draft_ack_required', message: `${PARTIAL_DRAFT_WARNING} Confirm you have seen this to retry.` });
      }
      throw err;
    }
    const partialDraft = await deps.withClient((c) => hasAssistedNextClickEver(c, id));
    streamHub?.notifyChanged('events');
    kickApplyRunner(deps, id, row);
    sendJson(ctx.res, 200, { ok: true, row, warning: partialDraft ? PARTIAL_DRAFT_WARNING : null });
  }, { allowEmptyBody: true });

  // Withdraw from the dashboard: closes an application parked, failed, or stuck in drafting (any state
  // where no submission can be in flight; see core/applications.js classifyWithdraw()). Body { note? }.
  // A refusal is 409 WITHDRAW_REFUSED with a closed `reason`; an already-withdrawn row is a 200 noop.
  router.register('POST', '/api/applications/:id/withdraw', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body) ?? {};
    if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') throw new JobSearchError('VALIDATION', 'note must be a string');
    const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
    const runnerStatus = typeof deps.applyRunner?.status === 'function' ? deps.applyRunner.status() : null;
    const applyRunning = Boolean(runnerStatus && runnerStatus.running && runnerStatus.applicationId === id);
    const out = await deps.withClient((c) => withdrawApplication(c, id, {
      actor: 'dashboard', note, applyRunning, chainRunning: runningChains.has(id),
    }));
    if (out.outcome === 'refused') {
      return sendJson(ctx.res, 409, { ok: false, code: 'WITHDRAW_REFUSED', reason: out.reason, state: out.state, message: out.message });
    }
    if (out.outcome === 'withdrawn') streamHub?.notifyChanged('events');
    // After the commit: delete any calendar event still linked to this application's cancelled nudge.
    // Non-fatal by design: a calendar failure (or an expired Google token) is a warning in the response
    // and the event id stays on the row for the next follow-ups pass (bin/remind.js) or a repeat
    // withdraw to retry. Never turns a committed withdraw into an error response.
    /** @type {string[]} */
    let warnings = [];
    try {
      const cleanup = await deps.withClient((c) => cleanupWithdrawnNudgeCalendar(c, deps.calendar, { applicationId: id }));
      warnings = cleanup.warnings;
      if (cleanup.deleted.length > 0) deps.calendarCache?.invalidateAll();
      if (cleanup.failed.length > 0) {
        deps.log?.({ evt: 'withdraw_calendar_cleanup_pending', application_id: id, pending: cleanup.failed.length, err_message: cleanup.failed[0].message });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      warnings = [`calendar cleanup skipped: ${msg}; will retry on the next follow-ups pass`];
      deps.log?.({ evt: 'withdraw_calendar_cleanup_failed', application_id: id, err_message: msg });
    }
    sendJson(ctx.res, 200, { ok: true, outcome: out.outcome, row: out.row, warnings });
  }, { allowEmptyBody: true });

  // Resume gate (spec v2 R1): a human Resume of a parked application, two-click confirmed on the card.
  // Total classification by pending_question.kind in src/apply/resume-gate.js; every refusal is 409
  // RESUME_REFUSED with a closed `reason`. Body { acknowledge_partial_draft? }: required (true) when an
  // assisted run ever clicked Next for this application (A10), since the site may hold a partial draft.
  // An approved result starts the apply runner; a resume_failed park goes back to drafting and waits for
  // Apply now (no runner kick).
  router.register('POST', '/api/applications/:id/resume', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body) ?? {};
    const runnerStatus = typeof deps.applyRunner?.status === 'function' ? deps.applyRunner.status() : null;
    const applyRunning = Boolean(runnerStatus && runnerStatus.running && runnerStatus.applicationId === id);
    const out = await deps.withClient((c) => resumeParkedApplication(c, id, {
      actor: 'dashboard', applyRunning, chainRunning: runningChains.has(id),
      acknowledgePartialDraft: b.acknowledge_partial_draft === true, config: deps.config ?? undefined,
    }));
    if (out.outcome === 'refused') {
      return sendJson(ctx.res, 409, { ok: false, code: 'RESUME_REFUSED', reason: out.reason, state: out.state, message: out.message });
    }
    streamHub?.notifyChanged('events');
    if (out.outcome === 'approved') kickApplyRunner(deps, id, out.row);
    sendJson(ctx.res, 200, { ok: true, outcome: out.outcome, row: out.row, warning: out.warning });
  }, { allowEmptyBody: true });

  // Apply pipeline slice 5: needs_human -> submitted ("I applied by hand"), no attempt increment, no
  // runner kick -- this is the human declaring the automated flow finished outside it.
  router.register('POST', '/api/applications/:id/applied-by-hand', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    // Assisted Easy Apply: an awaiting_submit card goes through "I submitted" (routes/easy-apply.js), which
    // checks LinkedIn's Applied badge first; the generic action never bypasses that check.
    const current = await deps.withClient((c) => getApplication(c, id));
    if (current.pending_question && current.pending_question.kind === 'awaiting_submit') {
      return sendJson(ctx.res, 409, { ok: false, code: 'USE_EASY_APPLY_SUBMITTED', message: 'Use "I submitted" on this Easy Apply card; it checks LinkedIn for the Applied badge first.' });
    }
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
  // guessed new fact. Answer-fallback F6/F7: a parked CHOICE field (captured options) is different: the
  // text must be exactly one offered option (409 not_an_offered_option otherwise) and it is written to the
  // bank (src/apply/bank-writer.js) before resuming. Every bank write is parse-validated and atomic; a
  // failed write is a visible 409 bank_write_failed and the application stays parked.
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
    const bankPath = typeof deps.answerBankPath === 'string' && deps.answerBankPath ? deps.answerBankPath : ANSWER_BANK_PATH;
    /**
     * Every bank write (F7) goes through updateBank (process-wide mutex, parse-validated, atomic, re-applied
     * once over a concurrent hand edit). Any failure is a visible 409 and nothing resumes: bank_changed_retry
     * when a hand edit got in the way, bank_write_failed otherwise.
     */
    const bankWriteFailed = (/** @type {unknown} */ err) => {
      const msg = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
      const changed = err instanceof BankChangedError;
      deps.log?.({ evt: 'apply_answer_bank_write_failed', application_id: id, err_message: msg, bank_changed: changed });
      return sendJson(ctx.res, 409, { ok: false, code: changed ? 'bank_changed_retry' : 'bank_write_failed', message: changed ? msg : `The answer bank was not changed: ${msg}` });
    };

    // Answer-fallback F6: a parked CHOICE field with captured options takes exactly one of those options,
    // and the answer is applied (written to the bank, learned for this exact label) before resuming, so
    // the resumed run fills it. Text questions keep the behavior below.
    if (isChoicePending(pq)) {
      if (!pq.options.includes(b.text)) {
        return sendJson(ctx.res, 409, { ok: false, code: 'not_an_offered_option', message: 'Pick one of the options the site offered for this question.' });
      }
      /** @type {{ key: string, created: boolean }} */
      let written = { key: '', created: false };
      try {
        await updateBank(bankPath, (text) => {
          const out = applyChoiceAnswer(text, { label: pq.label, option: b.text });
          written = out;
          return out.text;
        });
      } catch (err) {
        return bankWriteFailed(err);
      }
      const partialDraftC = await deps.withClient((c) => hasAssistedNextClickEver(c, id));
      const ackC = b.acknowledge_partial_draft === true;
      const rowC = await deps.withClient((c) => resume(c, id, {
        actor: 'dashboard',
        note: `answer applied for "${String(pq.label ?? '').slice(0, 200)}": "${b.text.slice(0, 200)}" written to bank key ${written.key}${written.created ? ' (new key)' : ''}${partialDraftC ? `; possible partial draft on the site (warning ${ackC ? 'acknowledged' : 'returned'})` : ''}`,
        meta: { bank_key: written.key, bank_key_created: written.created, ...(partialDraftC ? { partial_draft: true, partial_draft_acknowledged: ackC } : {}) },
      }));
      streamHub?.notifyChanged('events');
      kickApplyRunner(deps, id, rowC);
      return sendJson(ctx.res, 200, { ok: true, row: rowC, bank_key: written.key, warning: partialDraftC ? PARTIAL_DRAFT_WARNING : null });
    }

    const key = pq.suggestion && typeof pq.suggestion.key === 'string' ? pq.suggestion.key : null;

    if (save && key) {
      try {
        await updateBank(bankPath, (text) => appendLearnedLabel(text, key, String(pq.label ?? '')));
      } catch (err) {
        return bankWriteFailed(err);
      }
    }

    // Resume gate R3: a human path, allowed with the A10 marker set, but the response carries the
    // partial-draft warning and the event records whether the card's warning was acknowledged.
    const partialDraft = await deps.withClient((c) => hasAssistedNextClickEver(c, id));
    const ack = b.acknowledge_partial_draft === true;
    const row = await deps.withClient((c) => resume(c, id, {
      actor: 'dashboard',
      note: `answer saved for "${String(pq.label ?? '').slice(0, 200)}"${save && key ? ' (promoted to learned)' : ' (one-time)'}: ${b.text.slice(0, 500)}${partialDraft ? `; possible partial draft on the site (warning ${ack ? 'acknowledged' : 'returned'})` : ''}`,
      meta: partialDraft ? { partial_draft: true, partial_draft_acknowledged: ack } : undefined,
    }));
    streamHub?.notifyChanged('events');
    kickApplyRunner(deps, id, row);
    sendJson(ctx.res, 200, { ok: true, row, warning: partialDraft ? PARTIAL_DRAFT_WARNING : null });
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
