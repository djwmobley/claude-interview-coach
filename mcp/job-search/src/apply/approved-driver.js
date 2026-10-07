// @ts-check
/**
 * Morning driver for approved applications (unblock-auto-apply Item 1, amendments A1, A4, A5, A6). Before
 * this, an application left 'approved' by a deferral (the Workday daily cap, a lock, a breaker) was never
 * re-driven: the morning run only re-drove linkedin_easy rows, and `--application` refused 'approved'.
 * bin/auto-apply.js runs runApprovedDriver AFTER the Easy Apply phase (A4), so rows rerouted or approved
 * earlier in the run are driven in the same run.
 *
 * Order per run:
 *   1. Reroute pre-pass (Item 2, src/apply/reroute.js): approved linkedin_easy rows whose listing is not
 *      Easy Apply only (apply_easy_only false), plus needs_human parks that are really external applies
 *      (kind easy_apply_unverified with branch external, app 13; kind easy_apply_stopped with
 *      no_easy_apply_button, app 9). A challenge or auth wall stops the pre-pass.
 *   2. Every approved row, oldest update first, classified exactly once (A4): under the per-application
 *      advisory lock with a fresh re-read (A1), classifyApproved below, then act.
 *
 * classifyApproved (pure, total, first match wins; A6 puts every safety row first):
 *   submit marker (any attempt)                          park submit_marker_conflict (submit_unconfirmed q)
 *   A10 marker without an acknowledging dashboard
 *     approval made after it (A5)                         park partial_draft_human_only
 *   apply exclusion not eligible                         park apply_exclusion
 *   blockers: closed status in the dedup tree / sibling   park blocked_listing / blocked_sibling_active
 *   listing expired                                      park listing_closed
 *   no linked resume                                     park missing_resume
 *   linkedin_easy, listing not marked non-Easy-Apply     easy_apply_path (the Easy Apply phase owns it)
 *   linkedin_easy, apply_easy_only false                 reroute (handled by the pre-pass)
 *   ATS outside UNATTENDED_ATS or the fresh atsAllow     park ats_not_drivable
 *   otherwise                                            drive: runApplyWorker(id, { workday: morning })
 *   the classification threw                             park classify_error
 * Parks are approved -> needs_human with expectedFromState 'approved' (A1); a refusal is
 * drove_state_changed. Worker results map through mapWorkerResult (total). The worker keeps its own drift
 * check, click-time submit gate, and caps; nothing here submits anything.
 */
import {
  getApplication, hasSubmitRequestSentEver, partialDraftDriveStatus, checkApplicationBlockers, parkApproved, isStateChangedRefusal,
  recordDeferral, submitUnconfirmedQuestion, transition, transitionUnwrapped, MORNING_DRIVER_PARK_KIND, APPLICATION_LOCK_NAMESPACE,
} from '../core/applications.js';
import { withTransaction } from '../core/db.js';
import { errFields } from '../core/errors.js';
import { classifyExclusion as defaultClassifyExclusion } from './exclusions.js';
import { UNATTENDED_ATS } from './submit-gate.js';
import { summarizeReroute } from './reroute.js';

/** classifyApproved's branches (closed). */
export const DRIVER_BRANCHES = Object.freeze(['drive', 'park', 'easy_apply_path', 'reroute']);

/** Card labels for every park reason the driver makes. */
const PARK_LABELS = Object.freeze({
  partial_draft_human_only: 'An assisted run clicked Next on this application, so the site may hold a partial draft. Check it, then use Resume on the dashboard card and acknowledge the draft.',
  apply_exclusion: 'The apply exclusion check no longer passes for this application. Nothing was submitted. Review before applying.',
  blocked_listing: 'This listing (or a duplicate of it) is closed or blocked. Nothing was submitted. Withdraw or review.',
  blocked_sibling_active: 'Another application for this same job is already approved or submitted. Nothing was submitted. Withdraw this one.',
  listing_closed: 'The listing has expired. Nothing was submitted. Withdraw this application.',
  missing_resume: 'No resume is linked to this approved application. Link one and re-approve.',
  ats_not_drivable: 'This application\'s ATS is not one the morning run submits through. Apply by hand or withdraw.',
  classify_error: 'The morning run could not check this application. Nothing was submitted. Review it.',
  worker_result_unknown: 'The morning run got an unrecognized result from the apply worker. Check the application before retrying.',
});

/**
 * @param {{ ats_type: string, apply_easy_only: boolean|null, submitMarker: boolean, partialDraft: { marked: boolean, allowed: boolean },
 *   exclusionBranch: string, blockers: { blocked: boolean, blockedReason: string|null, siblingActive: boolean }, expired: boolean, resume_doc_id: number|null }} f
 * @param {{ atsAllow: string[] }} ctx
 * @returns {{ branch: 'drive'|'park'|'easy_apply_path'|'reroute', reason: string|null }}
 */
export function classifyApproved(f, ctx) {
  if (f.submitMarker) return { branch: 'park', reason: 'submit_marker_conflict' };
  if (f.partialDraft.marked && !f.partialDraft.allowed) return { branch: 'park', reason: 'partial_draft_human_only' };
  if (f.exclusionBranch !== 'eligible') return { branch: 'park', reason: 'apply_exclusion' };
  if (f.blockers.blocked) return { branch: 'park', reason: 'blocked_listing' };
  if (f.blockers.siblingActive) return { branch: 'park', reason: 'blocked_sibling_active' };
  if (f.expired) return { branch: 'park', reason: 'listing_closed' };
  if (!f.resume_doc_id) return { branch: 'park', reason: 'missing_resume' };
  if (f.ats_type === 'linkedin_easy') {
    return f.apply_easy_only === false ? { branch: 'reroute', reason: null } : { branch: 'easy_apply_path', reason: null };
  }
  if (!UNATTENDED_ATS.includes(f.ats_type) || !ctx.atsAllow.includes(f.ats_type)) return { branch: 'park', reason: 'ats_not_drivable' };
  return { branch: 'drive', reason: null };
}

/**
 * Worker result -> driver outcome (total).
 * @param {any} r
 */
export function mapWorkerResult(r) {
  const s = r && typeof r === 'object' ? r.status : null;
  if (s === 'applied' || s === 'submitted') return 'drove_ok';
  if (s === 'needs_human' || s === 'awaiting_submit') return 'drove_parked';
  if (s === 'deferred') return 'drove_deferred';
  if (s === 'locked') return 'drove_locked';
  if (s === 'skipped') return 'drove_state_changed';
  if (s === 'failed') return 'drove_failed';
  return 'worker_result_unknown';
}

/**
 * Report counts (Item 1 line): every result in exactly one bucket.
 * @param {Array<{ outcome: string, reason?: string|null }>} results
 */
export function summarizeDriver(results) {
  /** @type {Record<string, number>} */
  const deferredReasons = {};
  /** @type {Record<string, number>} */
  const parkedReasons = {};
  /** @type {Record<string, number>} */
  const otherOutcomes = {};
  const c = { approved: results.length, drove: 0, drove_ok: 0, drove_parked: 0, drove_deferred: 0, parked: 0, reroute: 0, easy_apply_path: 0, other: 0 };
  const bump = (/** @type {Record<string, number>} */ m, /** @type {string} */ k) => { m[k] = (m[k] ?? 0) + 1; };
  for (const r of results) {
    if (r.outcome === 'drove_ok' || r.outcome === 'drove_parked' || r.outcome === 'drove_deferred') {
      c.drove++;
      c[r.outcome]++;
      if (r.outcome === 'drove_deferred') bump(deferredReasons, String(r.reason ?? 'unknown'));
    } else if (r.outcome === 'parked') {
      c.parked++;
      bump(parkedReasons, String(r.reason ?? 'unknown'));
    } else if (r.outcome === 'reroute') c.reroute++;
    else if (r.outcome === 'easy_apply_path') c.easy_apply_path++;
    else {
      c.other++;
      bump(otherOutcomes, r.outcome);
    }
  }
  return { ...c, deferred_reasons: deferredReasons, parked_reasons: parkedReasons, other_outcomes: otherOutcomes };
}

/**
 * @typedef {Object} DriverDeps
 * @property {() => Promise<import('pg').Client>} connectDedicated
 * @property {() => any} freshConfig config read fresh from disk (atsAllow)
 * @property {import('./exclusions.js').ExclusionConfig} exclusionConfig
 * @property {() => Date} now
 * @property {(f: Record<string, unknown>) => void} log
 * @property {boolean} dryRun classify only
 * @property {number} maxPerRun drives per run
 * @property {number} [onlyId] drive this one application only (the --application path)
 * @property {(id: number, opts: any) => Promise<any>} runWorker
 * @property {typeof defaultClassifyExclusion} [classifyExclusion]
 * @property {typeof checkApplicationBlockers} [checkBlockers]
 * @property {{ run: (id: number, readState: 'approved'|'needs_human') => Promise<any> }|null} [reroute] the pre-pass; null skips it
 */

/**
 * @param {DriverDeps} deps
 * @returns {Promise<{ results: any[], counts: ReturnType<typeof summarizeDriver>, reroute: ReturnType<typeof summarizeReroute>|null, rerouteResults: any[], dry_run: boolean }>}
 */
export async function runApprovedDriver(deps) {
  const meta = await deps.connectDedicated();
  /** @type {any[]} */
  const rerouteResults = [];
  try {
    // 1. Reroute pre-pass (Item 2).
    if (deps.reroute && !deps.dryRun) {
      const cand = await meta.query(
        `SELECT a.id, a.state FROM ic_job_applications a JOIN ic_job_listings l ON l.id = a.listing_id
          WHERE ($1::int IS NULL OR a.id = $1)
            AND ((a.state = 'approved' AND a.ats_type = 'linkedin_easy' AND l.apply_easy_only = false)
              OR (a.state = 'needs_human' AND a.ats_type = 'linkedin_easy' AND (
                   (a.pending_question->>'kind' = 'easy_apply_unverified' AND a.pending_question->>'branch' = 'external')
                OR (a.pending_question->>'kind' = 'easy_apply_stopped' AND a.pending_question->>'label' LIKE '%no_easy_apply_button%'))))
          ORDER BY a.updated_at ASC, a.id ASC`,
        [deps.onlyId ?? null],
      );
      for (const row of cand.rows) {
        /** @type {any} */
        let r;
        try {
          r = await deps.reroute.run(Number(row.id), row.state);
        } catch (err) {
          deps.log({ evt: 'reroute_failed', application_id: Number(row.id), ...errFields(err) });
          r = { applicationId: Number(row.id), readState: row.state, outcome: 'error', reason: errFields(err).err_code ?? 'threw' };
        }
        rerouteResults.push(r);
        deps.log({ evt: 'reroute_done', application_id: Number(row.id), outcome: r.outcome, reason: r.reason ?? null });
        if (r.outcome === 'halted') break;
      }
    }

    // 2. Every approved row, classified exactly once.
    const approved = await meta.query(
      `SELECT id FROM ic_job_applications WHERE state = 'approved' AND ($1::int IS NULL OR id = $1) ORDER BY updated_at ASC, id ASC`,
      [deps.onlyId ?? null],
    );
    const rerouteById = new Map(rerouteResults.map((r) => [Number(r.applicationId), r]));
    /** @type {any[]} */
    const results = [];
    let drives = 0;
    for (const row of approved.rows) {
      const id = Number(row.id);
      const r = await driveOne(id);
      results.push(r);
      deps.log({ evt: 'approved_driver_classified', application_id: id, branch: r.branch ?? null, reason: r.reason ?? null, outcome: r.outcome });
    }
    const counts = summarizeDriver(results);
    const reroute = deps.reroute && !deps.dryRun ? summarizeReroute(rerouteResults) : null;
    deps.log({ evt: 'approved_driver_done', approved: counts.approved, drove: counts.drove, parked: counts.parked, other: counts.other });
    return { results, counts, reroute, rerouteResults, dry_run: deps.dryRun };

    /**
     * @param {number} id
     * @returns {Promise<{ applicationId: number, branch: string|null, outcome: string, reason: string|null }>}
     */
    async function driveOne(id) {
      const out = (/** @type {string|null} */ branch, /** @type {string} */ outcome, /** @type {string|null} */ reason = null) => ({ applicationId: id, branch, outcome, reason });
      const client = await deps.connectDedicated();
      let locked = false;
      /** @type {{ branch: string, reason: string|null }} */
      let cls;
      try {
        locked = Boolean((await client.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [APPLICATION_LOCK_NAMESPACE, id])).rows[0].ok);
        if (!locked) {
          if (!deps.dryRun) await recordDeferral(client, id, 'application_lock_held', { actor: 'auto' }).catch(() => {});
          return out('locked', 'drove_locked', 'application_lock_held');
        }
        const app = await getApplication(client, id);
        if (app.state !== 'approved') return out(null, 'drove_state_changed', `state_${app.state}`);
        try {
          cls = await classifyRow(client, app);
        } catch (err) {
          deps.log({ evt: 'approved_driver_classify_failed', application_id: id, ...errFields(err) });
          cls = { branch: 'park', reason: 'classify_error' };
        }
        if (cls.branch === 'easy_apply_path') return out(cls.branch, 'easy_apply_path');
        if (cls.branch === 'reroute') {
          const rr = rerouteById.get(id);
          return out(cls.branch, 'reroute', rr ? `${rr.outcome}${rr.reason ? `:${rr.reason}` : ''}` : 'not_attempted');
        }
        if (cls.branch === 'park') {
          if (deps.dryRun) return out('park', 'would_park', cls.reason);
          try {
            if (cls.reason === 'submit_marker_conflict') {
              // The marker means a submit may already have reached the site: the unconfirmed-submit park.
              await withTransaction(client, (c) => transitionUnwrapped(c, id, 'needs_human', {
                actor: 'auto', note: 'morning driver: submit marker present on an approved row',
                pending_question: { ...submitUnconfirmedQuestion(app.apply_url ?? null, 'found approved with a submit marker'), reason: 'submit_marker_conflict' },
              }, { expectedFromState: 'approved', helperName: 'approvedDriver' }));
            } else {
              const reason = /** @type {keyof typeof PARK_LABELS} */ (cls.reason);
              await parkApproved(client, id, { reason: String(cls.reason), label: PARK_LABELS[reason] ?? 'The morning run parked this application. Review it.' });
            }
          } catch (err) {
            if (isStateChangedRefusal(err)) return out('park', 'drove_state_changed', cls.reason);
            throw err;
          }
          return out('park', 'parked', cls.reason);
        }
        // drive
        if (deps.dryRun) return out('drive', 'would_drive');
        if (drives >= deps.maxPerRun) {
          await recordDeferral(client, id, 'driver_run_cap', { actor: 'auto' }).catch(() => {});
          return out('drive', 'drive_capped', 'driver_run_cap');
        }
      } finally {
        if (locked) {
          try {
            await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, id]);
          } catch {
            /* connection gone: the lock dies with it */
          }
        }
        await client.end().catch(() => {});
      }

      // Drive, with the lock released: the worker takes the same per-application lock itself and
      // re-checks state 'approved' (a row that moved in between comes back 'skipped').
      drives++;
      /** @type {any} */
      let wr;
      try {
        wr = await deps.runWorker(id, { workday: { trigger: 'morning' } });
      } catch (err) {
        deps.log({ evt: 'approved_driver_worker_threw', application_id: id, ...errFields(err) });
        return out('drive', 'drove_failed', 'worker_threw');
      }
      const mapped = mapWorkerResult(wr);
      if (mapped === 'worker_result_unknown') {
        const c2 = await deps.connectDedicated();
        try {
          await transition(c2, id, 'needs_human', {
            actor: 'auto', note: `morning driver: unrecognized worker result ${JSON.stringify(wr ?? null).slice(0, 120)}`,
            pending_question: { kind: MORNING_DRIVER_PARK_KIND, reason: 'worker_result_unknown', label: PARK_LABELS.worker_result_unknown },
          });
        } catch (err) {
          deps.log({ evt: 'approved_driver_park_failed', application_id: id, ...errFields(err) });
        } finally {
          await c2.end().catch(() => {});
        }
        return out('drive', 'parked', 'worker_result_unknown');
      }
      if (mapped === 'drove_locked') {
        const c3 = await deps.connectDedicated();
        try {
          await recordDeferral(c3, id, 'worker_locked', { actor: 'auto' });
        } catch {
          /* visible in the report line regardless */
        } finally {
          await c3.end().catch(() => {});
        }
      }
      return out('drive', mapped, mapped === 'drove_deferred' ? String(wr.reason ?? 'unknown') : (mapped === 'drove_ok' ? null : String(wr?.status ?? '')));
    }
  } finally {
    await meta.end().catch(() => {});
  }

  /**
   * Gather the facts classifyApproved reads, under the caller's lock.
   * @param {import('pg').ClientBase} client
   * @param {any} app
   */
  async function classifyRow(client, app) {
    const l = (await client.query(
      `SELECT id, company, company_norm, title, title_norm, apply_url, url, url_normalized, description, apply_easy_only, expired_at
         FROM ic_job_listings WHERE id = $1`,
      [app.listing_id],
    )).rows[0];
    if (!l) return { branch: 'park', reason: 'listing_closed' };
    const excl = await (deps.classifyExclusion ?? defaultClassifyExclusion)({
      id: Number(l.id), company: l.company ?? null, companyNorm: l.company_norm ?? null, title: l.title ?? null, titleNorm: l.title_norm ?? null,
      applyUrl: l.apply_url ?? null, sourceUrl: l.url_normalized ?? l.url ?? null, description: l.description ?? null,
    }, { client, config: deps.exclusionConfig, excludeApplicationId: app.id });
    const blockers = await (deps.checkBlockers ?? checkApplicationBlockers)(client, { id: app.id, listing_id: app.listing_id }, { config: deps.exclusionConfig });
    return classifyApproved({
      ats_type: app.ats_type, apply_easy_only: l.apply_easy_only === null || l.apply_easy_only === undefined ? null : Boolean(l.apply_easy_only),
      submitMarker: await hasSubmitRequestSentEver(client, app.id), partialDraft: await partialDraftDriveStatus(client, app.id),
      exclusionBranch: excl.branch, blockers, expired: Boolean(l.expired_at), resume_doc_id: app.resume_doc_id ?? null,
    }, { atsAllow: Array.isArray(deps.freshConfig()?.autoApply?.atsAllow) ? deps.freshConfig().autoApply.atsAllow : [] });
  }
}
