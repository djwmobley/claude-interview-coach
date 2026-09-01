// @ts-check
/**
 * Pipeline status vocabulary (dashboard PR 1, plan section "Data model changes" plus the adversary-pass
 * decisions file `pr1-spec-decisions.md`). Single source of truth: `src/tools/mark_jobs.js`'s zod enum
 * and `src/core/dedup.js`'s target-selection precedence both import from here rather than keeping their
 * own copies.
 *
 * NULL (scan-inserted, untriaged) is deliberately NOT a member of PIPELINE_STATUSES -- it is the absence
 * of a status, not a status value. UNTRIAGED documents that value for callers that need to name it.
 */

/** A listing that has never been triaged carries status IS NULL, not a string. */
export const UNTRIAGED = null;

/** Every real (non-null) status a listing row can carry. */
export const PIPELINE_STATUSES = Object.freeze([
  'new', 'maybe', 'shortlisted', 'applied', 'interviewing', 'offer', 'accepted', 'passed', 'lost', 'skip', 'dead', 'review',
]);

/**
 * Groups a status belongs to for board/UI purposes. Every member of PIPELINE_STATUSES appears in
 * exactly one group; NULL (untriaged) is its own pseudo-group, hidden from the board by default.
 */
export const STATUS_GROUPS = Object.freeze({
  triage: Object.freeze(['new', 'maybe', 'shortlisted']),
  active: Object.freeze(['applied', 'interviewing', 'offer']),
  closed: Object.freeze(['accepted', 'passed', 'lost', 'skip', 'dead']),
  system: Object.freeze(['review']),
});

/**
 * Reverse lookup: status -> group name. NULL/untriaged and anything outside PIPELINE_STATUSES map to
 * null, never a guessed group.
 * @param {string|null|undefined} status
 * @returns {'triage'|'active'|'closed'|'system'|null}
 */
export function groupOf(status) {
  if (status === null || status === undefined) return null;
  for (const [group, members] of Object.entries(STATUS_GROUPS)) {
    if (/** @type {readonly string[]} */ (members).includes(status)) return /** @type {any} */ (group);
  }
  return null;
}

/**
 * Target-selection precedence for dedup (src/core/dedup.js's selectTarget): best (lowest index) first.
 * `review` ranks first (pr1-spec-decisions.md): a pending review row stays the merge target until
 * resolved, so a second arrival never silently picks a different row out from under an open review item.
 */
export const STATUS_PRECEDENCE = Object.freeze([
  'review', 'accepted', 'offer', 'interviewing', 'applied', 'shortlisted', 'maybe', 'new', 'passed', 'lost', 'skip', 'dead',
]);

/**
 * Closed lookup of reopen reasons (pr1-spec-decisions.md inheritStatus rule 3): no runtime string
 * building. One entry per status that sends a re-arrival to review.
 */
export const REOPEN_REASONS = Object.freeze({
  applied: 'reopened_applied',
  interviewing: 'reopened_interviewing',
  offer: 'reopened_offer',
  dead: 'reopened_dead',
  skip: 'reopened_skip',
  lost: 'reopened_lost',
  passed: 'reopened_passed',
});

/**
 * Review-queue reasons the apply pipeline's mail classifier can produce (apply pipeline slice 7,
 * amended spec: "using NEW review reasons mail_rejected and mail_closed"). A rejection or
 * position-closed mail NEVER writes a status transition itself -- it only ever routes the listing to
 * review with one of these two reasons (src/apply/mail-confirm.js) -- so they are listed here
 * separately from REOPEN_REASONS (which is keyed by the FROM status a re-arrival left) rather than
 * folded into it: neither reason corresponds to a listing status at all.
 */
export const MAIL_REVIEW_REASONS = Object.freeze(['mail_rejected', 'mail_closed']);

/**
 * The full closed set of review-queue reasons inheritStatus and the apply pipeline's mail classifier can
 * produce: every REOPEN_REASONS value, the two reasons that are not status-specific, and the two mail
 * reasons above.
 */
export const QUEUE_REASONS = Object.freeze([
  ...Object.values(REOPEN_REASONS),
  'concurrent_review',
  'unrecognized_status',
  ...MAIL_REVIEW_REASONS,
]);
