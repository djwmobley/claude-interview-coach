// @ts-check
/**
 * Pure formatting helpers, no DOM access, so they run identically under node:test (pr3-spec-decisions.md
 * section 12, item 2) and in the browser. US spelling and copy rules apply to every returned string.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "3d ago" / "2h ago" / "5m ago" / "just now" / "in 2d" for a future date. `null`/invalid input renders
 * as the fixed placeholder, never throws and never prints "Invalid Date".
 * @param {string|Date|null|undefined} value
 * @param {Date} [now]
 */
export function relativeTime(value, now = new Date()) {
  if (value === null || value === undefined) return 'unknown';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const diffMs = now.getTime() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = Math.floor(abs / 60000);
  const hours = Math.floor(abs / 3600000);
  const days = Math.floor(abs / DAY_MS);
  /** @type {string} */
  let core;
  if (minutes < 1) core = 'just now';
  else if (minutes < 60) core = `${minutes}m`;
  else if (hours < 24) core = `${hours}h`;
  else if (days < 30) core = `${days}d`;
  else core = d.toISOString().slice(0, 10);
  if (core === 'just now') return core;
  return future ? `in ${core}` : `${core} ago`;
}

/**
 * Age in whole days since `firstSeen`, clamped to 0. Used for the aging-chip thresholds (design's age()
 * function: under 7 / 7-14 / over 14).
 * @param {string|Date|null|undefined} firstSeen
 * @param {Date} [now]
 * @returns {number|null}
 */
export function ageDays(firstSeen, now = new Date()) {
  if (!firstSeen) return null;
  const d = firstSeen instanceof Date ? firstSeen : new Date(firstSeen);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY_MS));
}

/**
 * Aging-chip bucket: 'fresh' (<7d), 'aging' (7-14d), 'stale' (>14d). null input maps to 'fresh' (no
 * data reads as not-yet-aging, never as an error state).
 * @param {number|null} days
 */
export function agingBucket(days) {
  if (days === null || days < 7) return 'fresh';
  if (days <= 14) return 'aging';
  return 'stale';
}

/**
 * Score bucket: 'good' (>=85), 'ok' (>=70), 'low' (below 70 or missing). Matches the design's score()
 * thresholds exactly.
 * @param {number|null|undefined} score
 */
export function scoreBucket(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return 'low';
  const n = Number(score);
  if (n >= 85) return 'good';
  if (n >= 70) return 'ok';
  return 'low';
}

/**
 * Fit-score bucket: same 'good'/'ok'/'low' thresholds as scoreBucket(), but a missing Fit score (never
 * yet triaged) maps to its own neutral 'not-scored' bucket rather than reusing 'low'. Prescore is a
 * deterministic, always-computed-at-scan-time number, so scoreBucket()'s "missing reads as low" default
 * is fine there; Fit is a human/agent judgment call that is legitimately absent until someone makes it,
 * and rendering an untriaged listing with the same red/low styling as a listing someone actively scored
 * poorly would misrepresent "nobody has looked at this yet" as "this was judged and rejected."
 * @param {number|null|undefined} score
 */
export function fitBucket(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return 'not-scored';
  const n = Number(score);
  if (n >= 85) return 'good';
  if (n >= 70) return 'ok';
  return 'low';
}

/**
 * Total classification of a listing's fit-score DISPLAY state (jobs-unscored-visibility PR, Change 3):
 * every visible row maps to EXACTLY one state, so a bare/blank unscored state is impossible. Precedence:
 *   1. `fit_score` IS NOT NULL always wins, regardless of status/noise/prescore -- the number itself is
 *      shown, using fitBucket()'s existing thresholds.
 *   2. `noise_class` not in (ok, ok_manual) -> 'noise'.
 *   3. `status === 'review'` AND (prescore is in [floor, ceiling] OR prescore IS NULL) -> 'pending
 *      review'.
 *   4. otherwise -> 'below floor' (covers prescore < floor, prescore IS NULL outside pending-review,
 *      and the rare case of an in-band model_band row that has not reached the model step yet on this
 *      scan -- an accepted, documented imprecision for that last case: model_band rows are normally
 *      fit-scored within the same scan they are found in, so this label only shows if the model step is
 *      disabled or a batch failed; see this PR's blind-spot note).
 * Every unscored sub-state (2, 3, 4) reuses fitBucket()'s existing neutral 'not-scored' CSS bucket --
 * this function only changes the LABEL text shown/tooltipped, never the color/class, and adds no new
 * column.
 * @param {{ fit_score?: number|null, noise_class?: string|null, status?: string|null, prescore?: number|null }} row
 * @param {{ floor: number, ceiling: number }|null|undefined} [triageBand] the dashboard's own
 *   config.triage.deterministic floor/ceiling (see GET /api/listings' `triage` field). Unavailable (the
 *   server has no config/triage.json loaded) means "in-band" can never be proven, so a non-null prescore
 *   on a review row falls to 'below floor' rather than 'pending review' -- see this PR's blind-spot note.
 * @returns {{ label: string, bucket: string, scored: boolean }}
 */
export function fitDisplayState(row, triageBand) {
  const fitScore = row.fit_score;
  if (fitScore !== null && fitScore !== undefined) {
    return { label: String(fitScore), bucket: fitBucket(fitScore), scored: true };
  }
  const noiseOk = row.noise_class === 'ok' || row.noise_class === 'ok_manual';
  if (!noiseOk) return { label: 'noise', bucket: 'not-scored', scored: false };
  const prescore = row.prescore;
  const prescoreKnown = typeof prescore === 'number' && !Number.isNaN(prescore);
  const inBand = Boolean(triageBand) && prescoreKnown && /** @type {number} */ (prescore) >= /** @type {{floor:number}} */ (triageBand).floor && /** @type {number} */ (prescore) <= /** @type {{ceiling:number}} */ (triageBand).ceiling;
  if (row.status === 'review' && (inBand || !prescoreKnown)) {
    return { label: 'pending review', bucket: 'not-scored', scored: false };
  }
  return { label: 'below floor', bucket: 'not-scored', scored: false };
}

/** One-click apply (PR A spec item 8): job-row.js's Apply-button label for every ic_job_applications
 * state, distinct wording from components/chips.js's applicationStateChip() (which labels the
 * application-card's own state chip, e.g. "Docs ready") -- this is a call-to-action label in a narrow
 * table cell, not a status chip, so it reads as a verb phrase ("Reviewing", "Drafting resume") rather than
 * a noun. */
const APPLY_BUTTON_STATE_LABELS = Object.freeze({
  drafting: 'Drafting resume',
  docs_ready: 'Reviewing',
  approved: 'Approved',
  submitting: 'Submitting',
  needs_human: 'Needs you',
  submitted: 'Submitted',
  confirmed: 'Submitted',
  failed: 'Failed',
});

/** Apply-chain-park fix, spec item 3: mirrors src/dashboard/routes/applications.js's own
 * STALE_ACTIONABLE_MS export exactly (30 minutes) -- public/ code cannot import that server module
 * directly (it pulls in 'pg' and other Node-only packages), same reason pages/jobs.js's SORTS is a
 * mirror rather than an import. test/dashboard-public-format.test.js drift-tests this constant against
 * the real export, same pattern as the SORTS mirror test. Since chain-park A1, applyButtonState() no
 * longer reads it: the server's application_chain_running flag decides "Drafting in progress". */
export const STALE_ACTIONABLE_MS = 30 * 60 * 1000;

/** Apply-chain-park fix, spec item 4: mirrors src/core/normalize.js's own DETAIL_MIN_CHARS export
 * exactly (300 characters) -- same "public/ cannot import a Node-only module" reason as
 * STALE_ACTIONABLE_MS above (normalize.js pulls in 'node:crypto' and config.js). Drift-tested against the
 * real export in test/dashboard-public-format.test.js. */
export const DETAIL_MIN_CHARS = 300;

/** Disabled-reason text for every application state other than 'drafting'/'submitted'/'confirmed' (those
 * three are handled by their own dedicated branches in applyButtonState() below) -- an in-flight
 * application in one of these states is never a candidate for a fresh Apply click; the existing
 * apply-now route already 409s a duplicate attempt regardless, this is only the button's own disabled
 * explanation. Total classification: applyButtonState()'s own fallback below covers any state not listed
 * here (including an unrecognized/future CHECK-constraint value), so this map never needs to be
 * exhaustive to keep the function total. */
const APPLY_IN_PROGRESS_REASONS = Object.freeze({
  docs_ready: 'Resume drafted, awaiting review.',
  approved: 'Approved, awaiting submission.',
  submitting: 'Submitting now.',
  needs_human: 'Needs your input to continue.',
  failed: 'The last attempt failed.',
});

/**
 * Total classification of a job row's Apply-button state (one-click apply PR A spec item 8, extended by
 * the apply-chain-park fix spec item 4). Every input maps to `{ label, actionable, disabledReason }` --
 * never `null`/`undefined` -- so a row for which clicking Apply would do nothing useful still renders a
 * real, informative (disabled) button rather than disappearing or crashing a caller that forgot a null
 * check. `disabledReason` is non-null exactly when `actionable` is false, and is the FIRST matching
 * branch below (precedence matters -- e.g. an already-applied row is reported as "Already applied" even
 * if its description also happens to be thin):
 *   1. applied: listing status 'applied', or the application itself reached 'submitted'/'confirmed'.
 *   2. skipped: listing status 'skip'.
 *   3. excluded: `row.apply_excluded` truthy (a future exclusions-gate column; not written by any query
 *      in this PR, but honored here if a caller ever sets it -- "if present in the row").
 *   4. an in-flight application not currently in the restartable 'drafting' stage (docs_ready/approved/
 *      submitting/needs_human/failed/any other non-null, non-drafting state).
 *   5. a 'drafting' application whose Apply now chain is actually running: the server's
 *      `application_chain_running` (routes/applications.js runningChains, the same signal the apply-now
 *      route uses since chain-park A1). The row's age plays no part, so a row parked and resumed inside
 *      30 minutes is actionable. Only an explicit `false` proves no chain is running; true or a missing or
 *      non-boolean value reads as running (friction, not silent escape).
 *   6. `description_chars` missing/undefined: the listing's description has never been fetched, so a
 *      resume draft attempt would fail the same precheck the server runs.
 *   7. `description_chars` below DETAIL_MIN_CHARS: the posting is too thin to draft a resume from.
 *   8. otherwise: actionable, `disabledReason: null`.
 * @param {{ status?: string|null, application_id?: number|string|null, application_state?: string|null, application_created_at?: string|Date|null, application_chain_running?: boolean|null, description_chars?: number|null, apply_excluded?: boolean }} row
 * @param {Date} [now] kept for call-site compatibility; no branch reads the clock since chain-park A1
 * @returns {{ label: string, actionable: boolean, disabledReason: string|null }}
 */
export function applyButtonState(row, now = new Date()) {
  const hasApplication = row.application_id !== null && row.application_id !== undefined;
  const state = hasApplication ? (row.application_state ?? null) : null;
  const label = !hasApplication
    ? 'Apply'
    : (state && Object.prototype.hasOwnProperty.call(APPLY_BUTTON_STATE_LABELS, state) ? APPLY_BUTTON_STATE_LABELS[state] : (state || 'Apply'));

  // 1. applied
  if (row.status === 'applied' || state === 'submitted' || state === 'confirmed') {
    return { label, actionable: false, disabledReason: 'Already applied.' };
  }
  // 2. skipped
  if (row.status === 'skip') {
    return { label, actionable: false, disabledReason: 'Listing skipped.' };
  }
  // 3. excluded
  if (row.apply_excluded) {
    return { label, actionable: false, disabledReason: 'Excluded from apply.' };
  }
  // 4. an in-flight application not currently restartable
  if (hasApplication && state !== 'drafting') {
    const reason = state && Object.prototype.hasOwnProperty.call(APPLY_IN_PROGRESS_REASONS, state)
      ? APPLY_IN_PROGRESS_REASONS[state] : (state ? `Application ${state}.` : 'Application in progress.');
    return { label, actionable: false, disabledReason: reason };
  }
  // 5. drafting with a chain actually running, or no proof that none is (see doc comment)
  if (hasApplication && state === 'drafting' && row.application_chain_running !== false) {
    return { label, actionable: false, disabledReason: 'Drafting in progress.' };
  }
  // 6/7. description gates (reached only for "no application yet" or "stale drafting, eligible to retry")
  const descChars = row.description_chars;
  if (descChars === null || descChars === undefined) {
    return { label, actionable: false, disabledReason: 'Unknown description, not fetched yet.' };
  }
  if (descChars < DETAIL_MIN_CHARS) {
    return { label, actionable: false, disabledReason: 'Posting too thin to draft from.' };
  }
  // 8. otherwise actionable
  return { label, actionable: true, disabledReason: null };
}

/**
 * Format an ISO date/datetime string as a short human date, e.g. "Aug 27". Invalid/missing input
 * renders as a placeholder dash-free string, never throws.
 * @param {string|Date|null|undefined} value
 */
export function shortDate(value) {
  if (!value) return 'not set';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'not set';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Bare 24-hour "HH:MM" for a same-day compact status line (Google reauth badge: "running since 14:05"),
 * where a full date would be redundant. Invalid/missing input renders as 'unknown', never throws.
 * @param {string|Date|null|undefined} value
 */
export function hhmm(value) {
  if (!value) return 'unknown';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Format a datetime for display, e.g. "Aug 27, 9:00 AM".
 * @param {string|Date|null|undefined} value
 */
export function shortDateTime(value) {
  if (!value) return 'not set';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return 'not set';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** @param {number|null|undefined} n */
export function formatMoney(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'not listed';
  return `$${Number(n).toLocaleString('en-US')}`;
}

/**
 * Salary range as "N to M" or a single value; "not listed" when both are absent.
 * @param {number|null|undefined} min
 * @param {number|null|undefined} max
 */
export function salaryRange(min, max) {
  if (min == null && max == null) return 'not listed';
  if (min != null && max != null && min !== max) return `${formatMoney(min)} to ${formatMoney(max)}`;
  return formatMoney(min ?? max);
}

/** Pluralize a simple count-noun pair, e.g. count(3, 'item') -> "3 items". @param {number} n @param {string} noun */
export function pluralize(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Clamp text to a max length with a trailing ellipsis marker (three periods, never an en/em dash). @param {string} s @param {number} max */
export function truncate(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * A source's display label; sentence case, US spelling. Unknown sources fall back to their raw value
 * title-cased rather than a blank string (totality: every input maps to a string).
 * @param {string|null|undefined} source
 */
export function sourceLabel(source) {
  const known = {
    greenhouse: 'Greenhouse', lever: 'Lever', linkedin: 'LinkedIn', indeed: 'Indeed',
    builtin: 'BuiltIn', ziprecruiter: 'ZipRecruiter', manual: 'Manual',
  };
  if (!source) return 'Unknown';
  if (known[source]) return known[source];
  return source.length ? source[0].toUpperCase() + source.slice(1) : 'Unknown';
}

/** Render a percentage from a 0-1 fraction, or a fixed placeholder when null (no data yet). @param {number|null|undefined} frac */
export function formatPercent(frac) {
  if (frac === null || frac === undefined || Number.isNaN(Number(frac))) return 'not enough data yet';
  return `${Math.round(Number(frac) * 100)}%`;
}

/**
 * Total normalizer for one Google Calendar-shaped `start` (or `end`) value, as returned in the `events`
 * array of GET /api/calendar/agenda. The real Google Calendar API resource never carries a bare
 * `startIso`/`start_at` field -- it is always `start: { dateTime, timeZone }` for a timed event or
 * `start: { date }` for an all-day event (Calendar's own date field has no time-of-day at all). Earlier
 * front-end code read `e.start ?? e.startIso ?? e.start_at`, none of which matched that real shape, which
 * is why the Calendar page crashed blank against a live Google event: `e.start` is an object, so
 * `new Date(object)` produced an Invalid Date that then broke on `.toISOString()` downstream.
 *
 * Every input maps to a branch here, never throws, and callers never need a try/catch:
 * - a bare ISO string -> `{ at: <ISO>, allDay: false }` (kept for any caller that already has a flat
 *   string, e.g. a follow-up's `due_at`)
 * - `{ dateTime }` -> `{ at: <ISO>, allDay: false }`
 * - `{ date }` (all-day) -> `{ at: <ISO>, allDay: true }`
 * - `null`/`undefined` (no start at all) -> `{ at: null, allDay: false }`
 * - anything else -- wrong type, an object with neither `dateTime` nor `date`, or a string/dateTime/date
 *   value that fails to parse as a real date -- is the unknown/failure branch and returns `null`, so a
 *   caller can filter it out of a rendered agenda rather than showing "Invalid Date" or crashing.
 * @param {unknown} start
 * @returns {{ at: string|null, allDay: boolean } | null}
 */
export function normalizeAgendaTime(start) {
  if (start === null || start === undefined) return { at: null, allDay: false };
  if (typeof start === 'string') {
    const d = new Date(start);
    return Number.isNaN(d.getTime()) ? null : { at: d.toISOString(), allDay: false };
  }
  if (typeof start === 'object' && !Array.isArray(start)) {
    const obj = /** @type {Record<string, unknown>} */ (start);
    if (typeof obj.dateTime === 'string') {
      const d = new Date(obj.dateTime);
      return Number.isNaN(d.getTime()) ? null : { at: d.toISOString(), allDay: false };
    }
    if (typeof obj.date === 'string') {
      const d = new Date(obj.date);
      return Number.isNaN(d.getTime()) ? null : { at: d.toISOString(), allDay: true };
    }
  }
  return null;
}

/**
 * Display label for one agenda item's time: the normal short datetime for a timed item, or the date
 * plus a plain "all day" marker (no dash) for an all-day item. `at: null` (a normalized-but-empty start)
 * falls back to the same "not set" placeholder `shortDateTime`/`shortDate` already use.
 * @param {{ at: string|null, allDay: boolean }} normalized
 */
export function agendaTimeLabel(normalized) {
  if (normalized.allDay) {
    return normalized.at ? `${shortDate(normalized.at)}, all day` : 'not set';
  }
  return shortDateTime(normalized.at);
}

/**
 * Total classification of one docs_ready row's findings-panel default expand state on the Review page's
 * "Applications awaiting approval" card (review-approvals-list PR spec A3): findings are EXPANDED by
 * default when the verdict is FAIL, or when the verdict is anything but PASS and findings are empty (an
 * unparseable/missing verdict with nothing recorded is exactly the case an operator most needs surfaced,
 * never collapsed by default). `emptyMessage` is set ONLY in that second, empty-non-PASS case, to the
 * required amber-styled "No findings recorded" text -- never the plain "No findings." wording, which
 * this function reserves for a PASS verdict with an empty findings list (rendered by the caller, not
 * returned here, since that combination is not "needs attention").
 * @param {{ review_verdict?: string|null, review_findings?: unknown }} application
 * @returns {{ expanded: boolean, emptyMessage: string|null }}
 */
export function approvalRowFindingsState(application) {
  const verdict = application.review_verdict ?? null;
  const findings = Array.isArray(application.review_findings) ? application.review_findings : [];
  const isEmpty = findings.length === 0;
  const expanded = verdict === 'FAIL' || (verdict !== 'PASS' && isEmpty);
  const emptyMessage = isEmpty && verdict !== 'PASS' ? 'No findings recorded' : null;
  return { expanded, emptyMessage };
}

/**
 * Total classification of the Review page's "Applications awaiting approval" row Approve button
 * (review-approvals-list PR spec A3): hidden entirely when the row has no linked resume yet (nothing to
 * approve against -- server-side approve() would reject this the same way); otherwise visible, and
 * disabled (with the reason shown) when a request for this row is already in flight, when the row is
 * `blocked` (apply exclusion HARD branch or a closed listing status -- src/core/applications.js's
 * checkApplicationBlockers), or when `sibling_active` (another application for the same job already
 * reached approved/submitting/submitted/confirmed). `blocked` takes precedence over `sibling_active` when
 * both are true (a `blocked_reason` string is always present in that case; `sibling_active` alone is not).
 * @param {{ resume_doc_id?: number|string|null, blocked?: boolean, blocked_reason?: string|null, sibling_active?: boolean }} row
 * @param {{ inFlight?: boolean }} [state]
 * @returns {{ visible: boolean, disabled: boolean, reason: string|null }}
 */
export function approvalRowApproveState(row, state = {}) {
  const hasResume = row.resume_doc_id !== null && row.resume_doc_id !== undefined;
  if (!hasResume) return { visible: false, disabled: true, reason: null };
  if (state.inFlight) return { visible: true, disabled: true, reason: null };
  if (row.blocked) return { visible: true, disabled: true, reason: row.blocked_reason ?? 'Blocked.' };
  if (row.sibling_active) {
    return { visible: true, disabled: true, reason: 'Another application for this job is already approved, submitting, submitted, or confirmed.' };
  }
  return { visible: true, disabled: false, reason: null };
}

/**
 * Whether an application card or Review row shows the Withdraw button: drafting, failed, and parked
 * needs_human rows only. An awaiting_submit Easy Apply card has its own Abandon (which also closes the
 * LinkedIn tab), so it never shows Withdraw. Every other or unknown state hides it; the server
 * (core/applications.js classifyWithdraw) is the authority either way. Accepts either a full application
 * row (pending_question) or a GET /api/applications list row (pending_kind).
 * @param {any} row
 */
export function withdrawButtonVisible(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.state === 'drafting' || row.state === 'failed') return true;
  if (row.state !== 'needs_human') return false;
  const kind = row.pending_kind ?? (row.pending_question && typeof row.pending_question === 'object' ? row.pending_question.kind : null);
  return kind !== 'awaiting_submit';
}

/**
 * Card text for the A10 partial-draft warning: the same text as core/applications.js
 * PARTIAL_DRAFT_WARNING (drift-tested), shown on any needs_human card whose row carries partial_draft.
 */
export const PARTIAL_DRAFT_CARD_WARNING = 'An assisted run clicked Next on this application before, so the site (Workday) may hold a partial draft. Check the draft on the site before the run continues.';

/**
 * Parked kinds the Resume button is shown for (resume gate R1): the server's RESUME_APPROVE_KINDS plus
 * RESUME_REDRAFT_KINDS (apply/resume-gate.js; drift-tested against them). Every other kind hides the
 * button, because the server refuses it (question, credential, awaiting_submit, post_submit_uncertain
 * have their own actions; an unknown kind is refused by default).
 */
export const RESUME_BUTTON_KINDS = Object.freeze(['unrecognized_page', 'captcha', 'assisted_stopped', 'assisted_partial', 'email_verification', 'resume_failed']);

/**
 * Whether an application card or Review row shows Resume: needs_human parked on one of
 * RESUME_BUTTON_KINDS. The server (apply/resume-gate.js classifyResume) is the authority; a refusal it
 * makes anyway (breaker, slot, budget, closed listing, submit request sent) comes back as a toast.
 * Accepts a full application row (pending_question) or a GET /api/applications list row (pending_kind).
 * @param {any} row
 */
export function resumeButtonVisible(row) {
  if (!row || typeof row !== 'object' || row.state !== 'needs_human') return false;
  // Chain-park spec D2: a server-computed resume_eligible (apply/resume-gate.js resumeEligible) decides
  // when present, so a legacy blocked resume-runner park shows Resume. Absent: the kind list below.
  if (typeof row.resume_eligible === 'boolean') return row.resume_eligible;
  const kind = row.pending_kind ?? (row.pending_question && typeof row.pending_question === 'object' ? row.pending_question.kind : null);
  return typeof kind === 'string' && RESUME_BUTTON_KINDS.includes(kind);
}

/**
 * One "Filled answers" line on the assisted review card (answer-fallback F3): question = value, the bank
 * key, and the fallback rank when a ranked fallback (not the value) was the option picked.
 * @param {any} e ledger entry
 */
export function ledgerLineText(e) {
  const notes = [];
  if (e && e.bank_key) notes.push(`bank: ${String(e.bank_key)}`);
  if (e && e.fallback_used === true) notes.push(`fallback rank ${String(e.fallback_rank ?? '?')}`);
  return `${String(e?.question ?? '')} = ${String(e?.value ?? '')}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/** Choice field kinds; mirrors routes/applications.js CHOICE_FIELD_KINDS. */
const CHOICE_FIELD_KINDS = Object.freeze(['select', 'radio', 'listbox']);

/**
 * The offered options for a parked choice question (answer-fallback F6), or null for a free-text one. Same
 * rule as the server's isChoicePending: a non-empty options list, field kind a choice kind or unrecorded.
 * The card renders each option with textContent only.
 * @param {any} pq
 * @returns {string[]|null}
 */
export function pendingChoiceOptions(pq) {
  if (!pq || !Array.isArray(pq.options)) return null;
  const options = pq.options.filter((/** @type {unknown} */ o) => typeof o === 'string');
  if (options.length === 0) return null;
  if (pq.field_kind !== undefined && pq.field_kind !== null && !CHOICE_FIELD_KINDS.includes(pq.field_kind)) return null;
  return options;
}
