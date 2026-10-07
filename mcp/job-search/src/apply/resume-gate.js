// @ts-check
/**
 * Resume gate (resume gate spec v2, R1-R1d and R2): the human-triggered Resume of a parked (needs_human)
 * application from the dashboard, and the credential-save resume.
 *
 * classifyResume() is a TOTAL classification: every row maps to exactly one branch, and anything the
 * table below does not name (an unknown, blank, or missing pending_question.kind) is refused with
 * unknown_kind. Nothing is allowed by default.
 *
 *   kind                                                               outcome
 *   unrecognized_page, captcha, assisted_stopped, assisted_partial,    needs_human -> approved (attempt+1)
 *     email_verification, submit_gate
 *   resume_failed                                                      needs_human -> drafting (as the
 *                                                                        bin/auto-apply.js re-drive does)
 *   blocked, and isResumeRunnerPark() (legacy resume-runner park)      needs_human -> drafting (D2)
 *   blocked, anything else                                             refuse blocked_not_resume_failure
 *   question                                                           refuse use_answer
 *   credential                                                         refuse use_credential_save
 *   awaiting_submit                                                    refuse submit_or_abandon
 *   post_submit_uncertain                                              refuse may_be_submitted
 *   submit_unconfirmed, submit_error                                   refuse submit_unconfirmed (C11)
 *   anything else                                                      refuse unknown_kind
 *
 * submit_gate (unattended submit spec item 1) is a PRE-click park: nothing was clicked and no submit marker
 * was written, so a resume re-runs the whole gate at the next click. Any row that carries the durable
 * submit marker from ANY attempt (spec v2 C2, hasSubmitRequestSentEver) is refused submit_request_sent
 * whatever its kind, and a row whose kind does not already say so is re-labelled submit_unconfirmed.
 *
 * Every check runs inside ONE transaction after the row's SELECT ... FOR UPDATE (R1b), so a kind change,
 * a new lease, or a submit_request_sent event committed while this call waits on the lock is honored.
 * The in-process signals (the dashboard's apply runner and Apply now chain) are passed in by the route,
 * because only the dashboard process knows them.
 *
 * The daily budget IS charged on the run after a resume (src/apply/worker.js charges the assisted ATS's
 * cap at the start gate of every attempt: workday_assisted for Workday, linkedin_easy_apply plus the
 * LinkedIn detail budget for Easy Apply), so an exhausted budget refuses budget_exhausted here instead of
 * leaving an approved row that the worker can only defer. Non-assisted ATS types have no breaker, slot, or
 * per-attempt budget, so those three checks apply to ASSISTED_ATS_TYPES only.
 */
import { withTransaction } from '../core/db.js';
import { JobSearchError } from '../core/errors.js';
import { STATUS_GROUPS } from '../core/statuses.js';
import { loadConfig } from '../core/config.js';
import { remainingBudget } from '../core/budget.js';
import {
  transitionUnwrapped, hasSubmitRequestSentEver, hasAssistedNextClickEver, ASSISTED_ATS_TYPES, PARTIAL_DRAFT_WARNING,
  SUBMIT_UNCONFIRMED_KIND, UNCONFIRMED_SUBMIT_KINDS, submitUnconfirmedQuestion, recordApplicationEvent,
} from '../core/applications.js';
import { SUBMIT_GATE_KIND, SUBMIT_ERROR_KIND } from './submit-gate.js';
import { breakerStatus, EASY_APPLY_BUDGET_SOURCE, WORKDAY_ASSISTED_BUDGET_SOURCE } from '../core/easy-apply-state.js';
import { AWAITING_SUBMIT_KIND } from '../core/easy-apply-tabs.js';
import { workdayAssistedConfig } from './assisted/gate.js';
import { EASY_APPLY_DEFAULTS } from './easy-apply-policy.js';
import { walkDuplicateRoot, collectDuplicateTreeIds } from './exclusions.js';

/** Kinds a human Resume moves needs_human -> approved (R1). A named set; nothing else is allowed. */
export const RESUME_APPROVE_KINDS = Object.freeze(['unrecognized_page', 'captcha', 'assisted_stopped', 'assisted_partial', 'email_verification', SUBMIT_GATE_KIND]);

/**
 * Kinds that mean the final Submit was clicked (or may have been) and never go back toward another
 * submission (unattended submit spec v2 C11). Named explicitly so they are refused with their own reason,
 * not the unknown_kind default.
 */
export const RESUME_SUBMIT_UNCONFIRMED_KINDS = Object.freeze([SUBMIT_UNCONFIRMED_KIND, SUBMIT_ERROR_KIND]);

/** Kinds a human Resume moves needs_human -> drafting (R1). */
export const RESUME_REDRAFT_KINDS = Object.freeze(['resume_failed']);

/**
 * Frozen human labels for resume-runner and Apply now chain park reasons (chain-park spec D1). The route's
 * park writes these, and the legacy `blocked` park check below (D2) matches against them, so both read
 * one source.
 */
export const RESUME_RUNNER_PARK_LABELS = Object.freeze(/** @type {Record<string, string>} */ ({
  no_description: 'Job posting has no usable description to draft a resume from.',
  timeout: 'Resume drafting timed out.',
  spawn_failed: 'Resume drafting failed to start.',
  listing_mismatch: 'The drafted resume did not match this listing; the link was reset.',
  model_asked: 'Resume drafting stopped to ask a question instead of finishing.',
  no_docs_ready: 'Resume drafting finished without producing a resume.',
  markdown_not_found: 'Resume drafting finished but the draft file could not be found.',
  runner_unavailable: 'Resume drafting is not available on this server right now.',
  resume_runner_busy: 'Another resume draft was already running, so this one did not start.',
  chain_error: 'Apply now stopped on an unexpected error while drafting the resume.',
}));

/**
 * Every reason a resume-runner park can carry (D2): the frozen-label reasons plus the HEADLESS_ABORT
 * reasons the write-resume skill is known to emit. A `blocked` park whose error is outside this set is
 * never resumed.
 */
export const RESUME_RUNNER_FAILURE_REASONS = Object.freeze([
  ...Object.keys(RESUME_RUNNER_PARK_LABELS), 'docx_exists', 'docx_locked', 'role_inclusion_conflict',
]);

/** Generic label prefix for a reason with no frozen label. */
const GENERIC_PARK_LABEL_PREFIX = 'Resume drafting stopped: ';

/** Error-column prefix the resume runner's own error events use. */
const RUNNER_ERROR_PREFIX = 'resume runner failed: ';

/**
 * Human-readable label for a resume-runner or chain park reason. TOTAL: a frozen label for a known
 * reason, otherwise the generic "Resume drafting stopped: <reason>" (never a throw or a blank label).
 * @param {string} reason
 */
export function humanizeParkReason(reason) {
  if (Object.prototype.hasOwnProperty.call(RESUME_RUNNER_PARK_LABELS, reason)) return RESUME_RUNNER_PARK_LABELS[reason];
  return `${GENERIC_PARK_LABEL_PREFIX}${reason}`;
}

/**
 * D2: whether a needs_human row is a legacy `blocked` park written by a resume-runner failure (the only
 * writer of kind `blocked` was the Apply now chain's park). True only when ALL hold: kind is exactly
 * 'blocked'; the error column, with a leading "resume runner failed: " stripped, lowercased and trimmed, is
 * in RESUME_RUNNER_FAILURE_REASONS; and the label is that reason's frozen label or the generic
 * "Resume drafting stopped: <reason>". Anything else is false. Reads only the row (no event history).
 * @param {any} row
 */
export function isResumeRunnerPark(row) {
  if (!row || typeof row !== 'object') return false;
  const pq = row.pending_question;
  if (!pq || typeof pq !== 'object' || Array.isArray(pq) || pq.kind !== 'blocked') return false;
  if (typeof row.error !== 'string') return false;
  let raw = row.error.trim();
  if (raw.toLowerCase().startsWith(RUNNER_ERROR_PREFIX)) raw = raw.slice(RUNNER_ERROR_PREFIX.length);
  const reason = raw.trim().toLowerCase();
  if (!reason || !RESUME_RUNNER_FAILURE_REASONS.includes(reason)) return false;
  if (typeof pq.label !== 'string') return false;
  const label = pq.label.trim();
  if (Object.prototype.hasOwnProperty.call(RESUME_RUNNER_PARK_LABELS, reason) && label === RESUME_RUNNER_PARK_LABELS[reason]) return true;
  const lower = label.toLowerCase();
  const prefix = GENERIC_PARK_LABEL_PREFIX.toLowerCase();
  return lower.startsWith(prefix) && lower.slice(prefix.length).trim() === reason;
}

/**
 * Whether the dashboard shows Resume for a row (server-computed `resume_eligible`): needs_human parked on
 * a kind classifyResume() can resume, or a legacy `blocked` resume-runner park. In-flight and site checks
 * are not part of this; the gate itself still decides and refuses with a toast.
 * @param {any} row
 */
export function resumeEligible(row) {
  if (!row || typeof row !== 'object' || row.state !== 'needs_human') return false;
  const pq = row.pending_question;
  const kind = pq && typeof pq === 'object' && !Array.isArray(pq) && typeof pq.kind === 'string' ? pq.kind : null;
  if (kind === null) return false;
  if (RESUME_APPROVE_KINDS.includes(kind) || RESUME_REDRAFT_KINDS.includes(kind)) return true;
  return kind === 'blocked' && isResumeRunnerPark(row);
}

/**
 * Closed set of reasons a resume is refused with (409 RESUME_REFUSED). Every refusal names one.
 */
export const RESUME_REFUSAL_REASONS = Object.freeze([
  'not_parked', 'lease_held', 'apply_running', 'chain_running',
  'use_answer', 'use_credential_save', 'submit_or_abandon', 'may_be_submitted', 'unknown_kind',
  'blocked_not_resume_failure', 'submit_unconfirmed',
  'submit_request_sent', 'listing_closed', 'no_resume_doc', 'breaker_tripped', 'slot_busy', 'budget_exhausted',
  'partial_draft_ack_required',
]);

/** @type {Readonly<Record<string, string>>} */
const RESUME_REFUSAL_MESSAGES = Object.freeze({
  not_parked: 'This application is not parked for a human, so there is nothing to resume.',
  lease_held: 'An assisted session still holds this application. Wait for it to finish, then resume.',
  apply_running: 'The apply runner is working on this application right now.',
  chain_running: 'Apply now is still drafting this application.',
  use_answer: 'This application is waiting on a screening-question answer. Use the answer box on its card.',
  use_credential_save: 'This application is waiting on a login. Save the credential on its card.',
  submit_or_abandon: 'This form is filled and waiting in a browser tab. Submit it there and press "I submitted", or Abandon it.',
  may_be_submitted: 'The submit request may already have reached the site. Check the site or your email for a confirmation, then use "I applied by hand" or Withdraw.',
  unknown_kind: 'This application is parked for a reason the dashboard does not recognize, so it was not resumed. Finish it by hand or withdraw it.',
  blocked_not_resume_failure: 'This application is blocked for a reason other than a resume drafting failure, so it was not resumed. Finish it by hand or withdraw it.',
  submit_unconfirmed: 'Already submitted (unconfirmed): the final Submit was sent. It is never resubmitted; a matching confirmation email moves it to confirmed. Check the site or your email, or withdraw it.',
  submit_request_sent: 'A submit request was already sent for this application (on this or an earlier attempt), so it is never resubmitted. Check the site or your email for a confirmation.',
  listing_closed: 'The listing is closed (dead, skipped, passed, lost, or accepted), so it was not resumed.',
  no_resume_doc: 'No resume is linked to this application, so it cannot go back to approved.',
  breaker_tripped: 'The circuit breaker for this site is tripped. Wait for it to clear, then resume.',
  slot_busy: 'Another application on this site is in flight. Wait for it to finish, then resume.',
  budget_exhausted: 'Today\'s apply budget for this site is used up. Resume tomorrow.',
  partial_draft_ack_required: `${PARTIAL_DRAFT_WARNING} Confirm you have seen this to resume.`,
});

/**
 * @typedef {Object} ResumeContext
 * @property {boolean} [submitRequestSent]
 * @property {boolean} [leaseHeld]
 * @property {boolean} [applyRunning]
 * @property {boolean} [chainRunning]
 * @property {boolean} [listingClosed]
 * @property {boolean} [breakerTripped]
 * @property {boolean} [slotBusy]
 * @property {boolean} [budgetExhausted]
 * @property {boolean} [partialDraft]
 * @property {boolean} [acknowledgedPartialDraft]
 */

/**
 * Total classification of a resume request. Order: state, in-flight signals, kind, then the checks that
 * only apply once a kind is allowed (submit request, listing, resume link, breaker, slot, budget, partial
 * draft acknowledgment).
 * @param {{ state?: unknown, pending_question?: any, resume_doc_id?: unknown, error?: unknown }} row
 * @param {ResumeContext} [ctx]
 * @returns {{ action: 'approve' } | { action: 'redraft' } | { action: 'refuse', reason: string, message: string }}
 */
export function classifyResume(row, ctx = {}) {
  /** @param {string} reason */
  const refuse = (reason) => ({ action: /** @type {const} */ ('refuse'), reason, message: RESUME_REFUSAL_MESSAGES[reason] });
  if (!row || row.state !== 'needs_human') return refuse('not_parked');
  if (ctx.leaseHeld) return refuse('lease_held');
  if (ctx.applyRunning) return refuse('apply_running');
  if (ctx.chainRunning) return refuse('chain_running');
  const pq = row.pending_question;
  const kind = pq && typeof pq === 'object' && !Array.isArray(pq) && typeof pq.kind === 'string' ? pq.kind : null;

  /** @type {'approve'|'redraft'} */
  let action;
  if (kind !== null && RESUME_APPROVE_KINDS.includes(kind)) action = 'approve';
  else if (kind !== null && RESUME_REDRAFT_KINDS.includes(kind)) action = 'redraft';
  else if (kind === 'question') return refuse('use_answer');
  else if (kind === 'credential') return refuse('use_credential_save');
  else if (kind === AWAITING_SUBMIT_KIND) return refuse('submit_or_abandon');
  else if (kind === 'post_submit_uncertain') return refuse('may_be_submitted');
  else if (kind !== null && RESUME_SUBMIT_UNCONFIRMED_KINDS.includes(kind)) return refuse('submit_unconfirmed');
  else if (kind === 'blocked') {
    // D2: a legacy resume-runner park goes back to drafting, exactly like resume_failed; any other
    // blocked park (or one whose error or label does not match) is refused.
    if (!isResumeRunnerPark(row)) return refuse('blocked_not_resume_failure');
    action = 'redraft';
  } else return refuse('unknown_kind');

  if (ctx.submitRequestSent) return refuse('submit_request_sent');
  if (ctx.listingClosed) return refuse('listing_closed');
  if (action === 'approve') {
    if (!row.resume_doc_id) return refuse('no_resume_doc');
    if (ctx.breakerTripped) return refuse('breaker_tripped');
    if (ctx.slotBusy) return refuse('slot_busy');
    if (ctx.budgetExhausted) return refuse('budget_exhausted');
  }
  if (ctx.partialDraft && !ctx.acknowledgedPartialDraft) return refuse('partial_draft_ack_required');
  return { action };
}

/**
 * Whether the assisted ATS's daily budget has no attempt left today (the same caps the worker's start
 * gates charge). A non-assisted ATS is never exhausted here.
 * @param {import('pg').ClientBase} client
 * @param {string} ats
 * @param {any} config
 * @param {Date} now
 */
async function isBudgetExhausted(client, ats, config, now) {
  if (ats === 'workday') {
    const cfg = workdayAssistedConfig(config);
    const r = await remainingBudget(client, WORKDAY_ASSISTED_BUDGET_SOURCE, { dailyPages: cfg.assistedDaily, dailyDetails: 1_000_000_000 }, now);
    return r.pages < 1;
  }
  if (ats === 'linkedin_easy') {
    const cfg = { ...EASY_APPLY_DEFAULTS, ...(config?.autoApply?.linkedin ?? {}) };
    const mine = await remainingBudget(client, EASY_APPLY_BUDGET_SOURCE, { dailyPages: cfg.easyApplyDaily, dailyDetails: 1_000_000_000 }, now);
    if (mine.pages < 1) return true;
    const li = config?.adapters?.adapters?.linkedin;
    const linkedin = await remainingBudget(client, 'linkedin', { dailyPages: li?.dailyPages ?? 0, dailyDetails: li?.dailyDetails ?? 0 }, now);
    return linkedin.details < 1;
  }
  return false;
}

/**
 * Human Resume of a parked application (R1). One transaction: lock the row, gather every signal under the
 * lock, classify, and only then transition (approved with attempt+1, or drafting for resume_failed).
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ actor?: string, applyRunning?: boolean, chainRunning?: boolean, acknowledgePartialDraft?: boolean, config?: any, now?: Date }} [opts]
 * @returns {Promise<{ outcome: 'approved'|'drafting', row: any, warning: string|null } | { outcome: 'refused', reason: string, message: string, state: unknown }>}
 */
export async function resumeParkedApplication(client, id, opts = {}) {
  const actor = opts.actor ?? 'dashboard';
  const now = opts.now ?? new Date();
  return withTransaction(client, async (c) => {
    const cur = await c.query('SELECT id, listing_id, ats_type, state, pending_question, resume_doc_id, error FROM ic_job_applications WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw new JobSearchError('NOT_FOUND', `application ${id} not found`);
    const row = cur.rows[0];
    const config = opts.config ?? loadConfig();
    const ats = String(row.ats_type);
    const assisted = ASSISTED_ATS_TYPES.includes(ats);

    const lease = await c.query('SELECT 1 FROM ic_easy_apply_leases WHERE application_id = $1 AND closed_at IS NULL AND expires_at > now() LIMIT 1', [id]);
    const treeIds = await collectDuplicateTreeIds(c, await walkDuplicateRoot(c, row.listing_id));
    const closed = await c.query('SELECT 1 FROM ic_job_listings WHERE id = ANY($1::int[]) AND status = ANY($2::text[]) LIMIT 1', [treeIds, STATUS_GROUPS.closed]);
    /** @type {ResumeContext} */
    const ctx = {
      leaseHeld: (lease.rowCount ?? 0) > 0,
      applyRunning: Boolean(opts.applyRunning),
      chainRunning: Boolean(opts.chainRunning),
      // Spec v2 C2: the durable marker from ANY attempt, not only this one.
      submitRequestSent: await hasSubmitRequestSentEver(c, id),
      listingClosed: (closed.rowCount ?? 0) > 0,
      partialDraft: await hasAssistedNextClickEver(c, id),
      acknowledgedPartialDraft: opts.acknowledgePartialDraft === true,
    };
    if (assisted) {
      ctx.breakerTripped = (await breakerStatus(c, now, ats)).tripped;
      const slot = await c.query(
        `SELECT 1 FROM ic_job_applications WHERE ats_type = $1 AND id <> $2
           AND (state = 'submitting' OR (state = 'needs_human' AND pending_question->>'kind' = $3)) LIMIT 1`,
        [ats, id, AWAITING_SUBMIT_KIND],
      );
      ctx.slotBusy = (slot.rowCount ?? 0) > 0;
      ctx.budgetExhausted = await isBudgetExhausted(c, ats, config, now);
    }

    const verdict = classifyResume(row, ctx);
    if (verdict.action === 'refuse') {
      // Spec v2 C2 "route to submit_unconfirmed": a parked row that carries the submit marker but whose
      // kind does not say so is re-labelled, so its card shows "already submitted (unconfirmed)" and the
      // Gmail cross-check picks it up. The state stays needs_human (no transition).
      const pqKind = row.pending_question && typeof row.pending_question === 'object' ? row.pending_question.kind : null;
      if (row.state === 'needs_human' && ctx.submitRequestSent && !UNCONFIRMED_SUBMIT_KINDS.includes(pqKind) && pqKind !== SUBMIT_ERROR_KIND) {
        await c.query('UPDATE ic_job_applications SET pending_question = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(submitUnconfirmedQuestion(null, `re-labelled from ${String(pqKind)}: a submit request was sent earlier`))]);
        await recordApplicationEvent(c, { applicationId: id, kind: 'note', actor: /** @type {any} */ (actor), note: `resume refused: submit marker present; re-labelled ${String(pqKind)} -> ${SUBMIT_UNCONFIRMED_KIND}` });
      }
      return { outcome: /** @type {const} */ ('refused'), reason: verdict.reason, message: verdict.message, state: row.state };
    }
    const priorKind = String(row.pending_question.kind);
    const warning = ctx.partialDraft ? PARTIAL_DRAFT_WARNING : null;
    const meta = { prior_kind: priorKind, partial_draft: Boolean(ctx.partialDraft), partial_draft_acknowledged: Boolean(ctx.partialDraft && ctx.acknowledgedPartialDraft) };
    const ackNote = ctx.partialDraft ? '; human acknowledged a possible partial draft on the site' : '';
    if (verdict.action === 'redraft') {
      const updated = await transitionUnwrapped(c, id, 'drafting', {
        actor, note: `resumed from dashboard (prior kind: ${priorKind}); back to drafting for another resume draft${ackNote}`, meta,
      }, { expectedFromState: 'needs_human', helperName: 'resumeParkedApplication' });
      return { outcome: /** @type {const} */ ('drafting'), row: updated, warning };
    }
    const updated = await transitionUnwrapped(c, id, 'approved', {
      actor, note: `resumed from dashboard (prior kind: ${priorKind})${ackNote}`, meta,
    }, { incrementAttempt: true, expectedFromState: 'needs_human', helperName: 'resumeParkedApplication' });
    return { outcome: /** @type {const} */ ('approved'), row: updated, warning };
  });
}

/**
 * Credential-save resume (R2). Resumes ONLY when the application is parked on kind 'credential' AND the
 * saved target equals its pending_question.target; otherwise nothing moves and the caller reports why.
 * Checked under the row lock. A human path: allowed with the A10 marker set, but the result carries the
 * warning and the event records it.
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {string} target
 * @param {{ actor?: string, acknowledgePartialDraft?: boolean }} opts
 * @returns {Promise<{ resumed: true, row: any, warning: string|null } | { resumed: false, reason: 'not_found'|'not_parked'|'kind_mismatch'|'target_mismatch', state: unknown }>}
 */
export async function resumeForCredential(client, id, target, opts) {
  const actor = opts.actor ?? 'dashboard';
  return withTransaction(client, async (c) => {
    const cur = await c.query('SELECT id, state, pending_question FROM ic_job_applications WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) return { resumed: /** @type {const} */ (false), reason: /** @type {const} */ ('not_found'), state: null };
    const row = cur.rows[0];
    if (row.state !== 'needs_human') return { resumed: /** @type {const} */ (false), reason: /** @type {const} */ ('not_parked'), state: row.state };
    const pq = row.pending_question;
    if (!pq || typeof pq !== 'object' || pq.kind !== 'credential') return { resumed: /** @type {const} */ (false), reason: /** @type {const} */ ('kind_mismatch'), state: row.state };
    if (pq.target !== target) return { resumed: /** @type {const} */ (false), reason: /** @type {const} */ ('target_mismatch'), state: row.state };
    const partialDraft = await hasAssistedNextClickEver(c, id);
    const ack = opts.acknowledgePartialDraft === true;
    const updated = await transitionUnwrapped(c, id, 'approved', {
      actor,
      note: `credential saved for ${target}${partialDraft ? `; possible partial draft on the site (warning ${ack ? 'acknowledged' : 'returned'})` : ''}`,
      meta: partialDraft ? { partial_draft: true, partial_draft_acknowledged: ack } : undefined,
    }, { incrementAttempt: true, expectedFromState: 'needs_human', helperName: 'resumeForCredential' });
    return { resumed: /** @type {const} */ (true), row: updated, warning: partialDraft ? PARTIAL_DRAFT_WARNING : null };
  });
}
