// @ts-check
/**
 * Assisted LinkedIn Easy Apply inside the morning auto-apply run (spec B4, G9, G10). bin/auto-apply.js calls
 * runEasyApplyMorning() after its ordinary apply phase with selectCandidates' easyApplyEligible rows.
 *
 *   - Leftover 'approved' linkedin_easy applications (a previous run drafted them, then had to stop) are
 *     re-driven first, before any new draft.
 *   - Gates before every item, first refusal stops the whole phase: breaker tripped, daily Easy Apply cap
 *     exhausted, or an Easy Apply already in submitting/awaiting_submit (spec: "Auto-apply skips Easy Apply
 *     while one exists").
 *   - Nothing is drafted or run at or after the window end (19:00 America/Chicago). Drafting may happen
 *     before 09:00, but the worker never runs before the window opens: the loop sleeps until 09:00.
 *   - Consecutive attempts are spaced by a fresh 20-40 minute jitter.
 *   - Approve uses actor 'apply', so Easy Apply never consumes the ordinary auto-apply dailyCap (that cap
 *     counts actor 'auto' approvals); Easy Apply's own cap is linkedin.easyApplyDaily, enforced by the
 *     worker's start gate through reserveBudget.
 *   - A worker result of 'deferred' (any start-gate refusal) stops the phase; the application stays
 *     'approved' and is re-driven first next time.
 *   - Page-state check (spec v1 F1.4, v2 B1): src/apply/linkedin-button-prepare.js's live check classifies
 *     the LinkedIn job page right before the worker runs, for EVERY item, new or existing, and also before a
 *     new application is created. Total handling of the result:
 *       easy_apply                              proceed
 *       challenge, auth_wall                    (breaker already tripped by the check) new: skip; existing
 *                                               or created: park; then stop the phase
 *       breaker, budget_exhausted, no_browser,  the check could not run: stop the phase, park nothing (the
 *       check_error                             application stays approved and is re-checked next time)
 *       anything else                           new: skip with a warning and continue; existing or created:
 *                                               park visibly (needs_human, kind easy_apply_unverified, the
 *                                               branch in the label) and continue. Never the dialog.
 */
import { localMinutes, nextMorningSpacingMs } from './easy-apply-policy.js';
import { easyApplyConfig } from './easy-apply-flow.js';
import { breakerStatus, hasEasyApplyInFlight, lastAttemptAt, EASY_APPLY_BUDGET_SOURCE } from '../core/easy-apply-state.js';
import { remainingBudget } from '../core/budget.js';
import { createApplication, approve, transition } from '../core/applications.js';

/**
 * @typedef {Object} MorningDeps
 * @property {() => Date} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} rand
 * @property {string} timezone
 * @property {any} config
 * @property {(f: Record<string, unknown>) => void} log
 * @property {{ breakerTripped: () => Promise<boolean>, inFlight: () => Promise<boolean>, lastAttemptAt: () => Promise<Date|null>, capRemaining: () => Promise<number>, leftoverApproved: () => Promise<number[]> }} state
 * @property {(row: import('../core/auto-apply-select.js').CandidateRow) => Promise<{ id: number }>} createApplication
 * @property {(applicationId: number, row: import('../core/auto-apply-select.js').CandidateRow) => Promise<{ ok: boolean, reason?: string|null }>} draft
 * @property {(applicationId: number, actor: string) => Promise<void>} approve
 * @property {(applicationId: number, opts: { easyApply: { trigger: 'morning' } }) => Promise<{ ok: boolean, status: string, reason?: string }>} runWorker
 * @property {(target: { listingId: number|null, applicationId: number|null }) => Promise<{ branch: string, reason?: string }>} verifyEasyApply
 *   the live LinkedIn page-state check (by listing for a new row, by application for an existing one)
 * @property {(applicationId: number, branch: string) => Promise<void>} parkUnverified approved -> needs_human,
 *   kind easy_apply_unverified
 * @property {((applicationId: number) => Promise<{ outcome: string, reason?: string|null }>)|null} [reroute]
 *   unblock-auto-apply Item 2: called instead of parkUnverified when the pre-worker check says 'external'
 *   (src/apply/reroute.js rerouteApplication with read state 'approved'); absent or null keeps the park
 */

/** Kind of the visible park when the page does not show exactly one Easy Apply control (spec v2 B1). */
export const EASY_APPLY_UNVERIFIED_KIND = 'easy_apply_unverified';
/** Check results that stop the phase after handling the item (the check already tripped the breaker). */
const HALT_BRANCHES = Object.freeze(['challenge', 'auth_wall']);
/** Check results meaning the check itself could not run: stop the phase, park nothing. */
const GATE_BRANCHES = Object.freeze(['breaker', 'budget_exhausted', 'no_browser', 'check_error']);

/** @param {string} hhmm */
function hhmm(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

/**
 * @param {import('../core/auto-apply-select.js').CandidateRow[]} rows
 * @param {MorningDeps} deps
 * @returns {Promise<{ results: Array<Record<string, unknown>>, stopReason: string|null }>}
 */
export async function runEasyApplyMorning(rows, deps) {
  const cfg = easyApplyConfig(deps.config);
  const startMin = hhmm(cfg.windowStartLocal);
  const endMin = hhmm(cfg.windowEndLocal);
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  let lastRun = await deps.state.lastAttemptAt();
  const queue = [
    ...(await deps.state.leftoverApproved()).map((id) => ({ kind: /** @type {const} */ ('existing'), id, row: null })),
    ...rows.map((row) => ({ kind: /** @type {const} */ ('new'), id: 0, row })),
  ];

  const minutesNow = () => localMinutes(deps.now(), deps.timezone);
  async function gate() {
    if (await deps.state.breakerTripped()) return 'breaker';
    if ((await deps.state.capRemaining()) <= 0) return 'easy_apply_daily_cap';
    if (await deps.state.inFlight()) return 'easy_apply_in_flight';
    return null;
  }

  /** @param {{ listingId: number|null, applicationId: number|null }} target */
  async function verify(target) {
    try {
      return await deps.verifyEasyApply(target);
    } catch (err) {
      deps.log({ evt: 'easy_apply_morning_check_failed', severity: 'warning', ...target, err_message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      return { branch: 'check_error', reason: 'check_threw' };
    }
  }

  for (const item of queue) {
    let stop = await gate();
    if (stop) return { results, stopReason: stop };
    if (minutesNow() >= endMin) return { results, stopReason: 'outside_window' };

    let applicationId = item.id;
    if (item.kind === 'new' && item.row) {
      // Pre-create check (spec v1 F1.4): unattended, so a non-Easy-Apply page is skipped with a warning.
      const pre = await verify({ listingId: item.row.listingId, applicationId: null });
      if (pre.branch !== 'easy_apply') {
        deps.log({ evt: 'easy_apply_morning_not_easy_apply', severity: 'warning', listing_id: item.row.listingId, branch: pre.branch, reason: pre.reason ?? null });
        if (GATE_BRANCHES.includes(pre.branch)) return { results, stopReason: `verify_${pre.branch}` };
        results.push({ listingId: item.row.listingId, outcome: 'not_easy_apply', branch: pre.branch });
        if (HALT_BRANCHES.includes(pre.branch)) return { results, stopReason: `linkedin_${pre.branch}` };
        continue;
      }
      try {
        applicationId = (await deps.createApplication(item.row)).id;
      } catch (err) {
        results.push({ listingId: item.row.listingId, outcome: 'create_failed', reason: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        continue;
      }
      const drafted = await deps.draft(applicationId, item.row);
      if (!drafted.ok) {
        results.push({ listingId: item.row.listingId, applicationId, outcome: 'resume_failed', reason: drafted.reason ?? null });
        continue;
      }
      await deps.approve(applicationId, 'apply');
    }

    const now = deps.now();
    const nowMs = now.getTime();
    const windowStart = nowMs - (minutesNow() * 60000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds()) + startMin * 60000;
    const spaced = lastRun ? lastRun.getTime() + nextMorningSpacingMs(deps.rand, cfg) : 0;
    const earliest = Math.max(windowStart, spaced);
    if (earliest > nowMs) {
      deps.log({ evt: 'easy_apply_morning_wait', application_id: applicationId, wait_ms: earliest - nowMs });
      await deps.sleep(earliest - nowMs);
    }
    if (minutesNow() >= endMin) return { results, stopReason: 'outside_window' };
    stop = await gate();
    if (stop) return { results, stopReason: stop };

    // Pre-worker check for EVERY item (spec v2 B1): the dialog is only ever attempted on a page that shows
    // exactly one Easy Apply control right now.
    const listingId = item.row ? item.row.listingId : null;
    const v = await verify({ listingId, applicationId });
    if (v.branch !== 'easy_apply') {
      deps.log({ evt: 'easy_apply_morning_unverified', severity: 'warning', application_id: applicationId, listing_id: listingId, branch: v.branch, reason: v.reason ?? null });
      if (GATE_BRANCHES.includes(v.branch)) return { results, stopReason: `verify_${v.branch}` };
      if (v.branch === 'external' && deps.reroute) {
        // Unblock-auto-apply Item 2: the page applies on the company site, so the application is rerouted
        // to that ATS (src/apply/reroute.js) instead of parked; the approved driver later in this run
        // drives it. The Easy Apply dialog is never opened.
        const rr = await deps.reroute(applicationId);
        results.push({ listingId, applicationId, outcome: rr.outcome, branch: v.branch, reason: rr.reason ?? null });
        if (rr.outcome === 'halted') return { results, stopReason: `linkedin_${rr.reason ?? 'challenge'}` };
        continue;
      }
      await deps.parkUnverified(applicationId, v.branch);
      results.push({ listingId, applicationId, outcome: 'parked_unverified', branch: v.branch });
      if (HALT_BRANCHES.includes(v.branch)) return { results, stopReason: `linkedin_${v.branch}` };
      continue;
    }

    const r = await deps.runWorker(applicationId, { easyApply: { trigger: 'morning' } });
    lastRun = deps.now();
    results.push({ listingId: item.row ? item.row.listingId : null, applicationId, outcome: r.status, reason: r.reason ?? null });
    if (r.status === 'deferred') return { results, stopReason: 'worker_deferred' };
  }
  return { results, stopReason: null };
}

/**
 * Production wiring for bin/auto-apply.js.
 * @param {{
 *   withClientFn: <T>(fn: (c: import('pg').PoolClient) => Promise<T>) => Promise<T>,
 *   resumeRunner: { run: (applicationId: number, listingId: number) => Promise<any> },
 *   reviewRunner: { run: (applicationId: number, markdownPath: string, listingId: number) => Promise<any> },
 *   runApplyWorker: (id: number, deps: any) => Promise<any>,
 *   outputRoot: string, env: any, log: (f: any) => void, config: any, timezone: string,
 *   liveCheck: (listingId: number) => Promise<{ branch: string, reason?: string }>,
 *   reroute?: ((applicationId: number) => Promise<{ outcome: string, reason?: string|null }>)|null,
 * }} o
 *   liveCheck: src/apply/linkedin-button-prepare.js's createLinkedInLiveCheck(...) in production.
 * @returns {MorningDeps}
 */
export function defaultMorningDeps(o) {
  const cfg = easyApplyConfig(o.config);
  return {
    reroute: o.reroute ?? null,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    rand: Math.random,
    timezone: o.timezone,
    config: o.config,
    log: o.log,
    state: {
      breakerTripped: async () => (await o.withClientFn((c) => breakerStatus(c))).tripped,
      inFlight: () => o.withClientFn((c) => hasEasyApplyInFlight(c)),
      lastAttemptAt: () => o.withClientFn((c) => lastAttemptAt(c)),
      capRemaining: async () => (await o.withClientFn((c) => remainingBudget(c, EASY_APPLY_BUDGET_SOURCE, { dailyPages: cfg.easyApplyDaily, dailyDetails: 1_000_000_000 }))).pages,
      leftoverApproved: async () => (await o.withClientFn((c) => c.query(`SELECT id FROM ic_job_applications WHERE ats_type = 'linkedin_easy' AND state = 'approved' ORDER BY updated_at ASC, id ASC`))).rows.map((r) => Number(r.id)),
    },
    createApplication: (row) => o.withClientFn((c) => createApplication(c, { listingId: row.listingId, atsType: 'linkedin_easy', applyUrl: row.sourceUrl ?? null, actor: 'auto' })),
    async draft(applicationId, row) {
      const resumed = await o.resumeRunner.run(applicationId, row.listingId);
      if (!resumed.ok || !resumed.markdownPath) return { ok: false, reason: resumed.reason ?? null };
      try {
        await o.reviewRunner.run(applicationId, resumed.markdownPath, row.listingId);
      } catch (err) {
        o.log({ evt: 'easy_apply_morning_review_advisory', application_id: applicationId, err_message: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      }
      return { ok: true };
    },
    approve: async (applicationId, actor) => { await o.withClientFn((c) => approve(c, applicationId, { outputRoot: o.outputRoot, actor })); },
    runWorker: (applicationId, opts) => o.runApplyWorker(applicationId, { env: o.env, log: o.log, ...opts }),
    async verifyEasyApply({ listingId, applicationId }) {
      let id = listingId;
      if (id === null && applicationId !== null) {
        const r = await o.withClientFn((c) => c.query('SELECT listing_id FROM ic_job_applications WHERE id = $1', [applicationId]));
        id = r.rowCount ? Number(r.rows[0].listing_id) : null;
      }
      if (id === null) return { branch: 'not_found', reason: 'no_listing_for_application' };
      return o.liveCheck(id);
    },
    async parkUnverified(applicationId, branch) {
      await o.withClientFn((c) => transition(c, applicationId, 'needs_human', {
        actor: 'apply',
        note: `Easy Apply not verified on the LinkedIn page (${branch}); the dialog was not opened`,
        pending_question: {
          kind: EASY_APPLY_UNVERIFIED_KIND,
          label: `The LinkedIn job page did not show exactly one Easy Apply button (page state: ${branch}). Nothing was filled or submitted. Check the posting, then apply by hand or withdraw this application.`,
          branch,
        },
      }));
    },
  };
}
