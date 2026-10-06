// @ts-check
/**
 * Unattended submit gate (spec v1 items 1-3, spec v2 addendum C1, C4-C6, C10, C11). Pure decision tables
 * only: no DB, no browser, no clock. src/apply/unattended-submit.js gathers the inputs at click time (fresh
 * config, a fresh exclusion verdict, the resume hash, a page snapshot from the apply capability's
 * pageState verb, the marker and the submit count) and calls these; this module decides.
 *
 * Every function is a TOTAL classification: each input maps to exactly one branch, and anything this module
 * does not recognize lands on the refusing branch (park, never submit). Never submits on uncertainty.
 *
 *   classifyPreSubmit(state)      submit | park(reason)      runs immediately before the click
 *   auditForm(snap, ledger)       problems[]                 single-page forms (Greenhouse, Lever, ...)
 *   auditReview(snap, ledger)     problems[]                 Workday's Review page (values shown as text)
 *   reviewSingleForm(snap)        ok | reason                the adapter's own "ready to submit" check
 *   reviewWorkday(snap, resume)   ok | reason                classifyStep 'review' + verifyResumeCards + C4
 *   confirmationSignal / classifyConfirmation                confirmed | error | unconfirmed (C6)
 */
import { classifyStep, verifyResumeCards, isSubmitMarked, normalizeName } from './assisted/guard.js';
import { WORKDAY_RULES } from './assisted/profiles/workday.js';

/** ATS types that can ever submit unattended. LinkedIn and Indeed are never here (unchanged behavior). */
export const UNATTENDED_ATS = Object.freeze(['greenhouse', 'lever', 'smartrecruiters', 'icims', 'dayforce', 'workday']);

/** pending_question.kind for a pre-click park (no click happened, no marker written). Resumable. */
export const SUBMIT_GATE_KIND = 'submit_gate';

/** pending_question.kind for a click followed by a visible validation or error element. Never retried. */
export const SUBMIT_ERROR_KIND = 'submit_error';

/**
 * Closed set of pre-click park reasons with their card labels. `soft` reasons are configuration or budget
 * (nothing is wrong with the application itself): for Workday they fall back to the assisted
 * awaiting_submit hand-off (Damian submits), for single-page forms they park like every other reason.
 */
export const PRE_SUBMIT_REASONS = Object.freeze(/** @type {Record<string, { soft: boolean, label: string }>} */ ({
  unrecognized_state: { soft: false, label: 'The pre-submit check could not read its own inputs, so nothing was submitted.' },
  marker_exists: { soft: false, label: 'A submit request was already sent for this application on an earlier attempt, so it is never submitted again.' },
  exclusion: { soft: false, label: 'The apply exclusion check at submit time no longer allows this application.' },
  resume_hash_missing: { soft: false, label: 'No approved resume hash is on record, so the uploaded resume cannot be verified.' },
  resume_hash_mismatch: { soft: false, label: 'The linked resume file changed on disk since Approve.' },
  prefilled_unledgered: { soft: false, label: 'The site prefilled answers that no server-side answer wrote; review them before submitting.' },
  review_unverified: { soft: false, label: 'The page right before Submit did not match the expected review shape.' },
  audit_failed: { soft: false, label: 'A required field is empty, unverifiable, or not answered from your own data.' },
  application_locked: { soft: false, label: 'Another worker holds this application right now, so this run did not submit it.' },
  kill_switch: { soft: true, label: 'Unattended submit is switched off (config/auto-apply.json unattendedSubmit.enabled).' },
  ats_disabled: { soft: true, label: 'Unattended submit is not switched on for this ATS.' },
  ats_not_allowed: { soft: true, label: 'This ATS is not in auto-apply atsAllow.' },
  submit_mode_assisted: { soft: true, label: 'Workday submitMode is assisted: you submit on the Review page.' },
  cap_exhausted: { soft: true, label: "Today's unattended submit cap is used up." },
  cap_invalid: { soft: true, label: 'The unattended daily submit cap is not a positive number.' },
}));

/**
 * The unattended-submit slice of a LOADED config (read fresh from disk at click time by the caller).
 * Total: a missing or malformed block reads as switched off.
 * @param {any} config
 * @returns {{ enabled: boolean, ats: Record<string, boolean>, dailySubmitCap: unknown, atsAllow: string[], workdaySubmitMode: unknown }}
 */
export function unattendedSubmitConfig(config) {
  const aa = config && typeof config === 'object' && config.autoApply && typeof config.autoApply === 'object' ? config.autoApply : {};
  const us = aa.unattendedSubmit && typeof aa.unattendedSubmit === 'object' ? aa.unattendedSubmit : {};
  /** @type {Record<string, boolean>} */
  const ats = {};
  const rawAts = us.ats && typeof us.ats === 'object' ? us.ats : {};
  for (const k of UNATTENDED_ATS) ats[k] = rawAts[k] === true;
  return {
    enabled: us.enabled === true,
    ats,
    dailySubmitCap: us.dailySubmitCap,
    atsAllow: Array.isArray(aa.atsAllow) ? aa.atsAllow.filter((/** @type {unknown} */ x) => typeof x === 'string') : [],
    workdaySubmitMode: aa.workday && typeof aa.workday === 'object' ? aa.workday.submitMode : undefined,
  };
}

/**
 * @typedef {Object} PreSubmitState
 * @property {string} ats
 * @property {ReturnType<typeof unattendedSubmitConfig>} config
 * @property {boolean} markerEver
 * @property {{ branch: string, reason?: string }} exclusion
 * @property {{ expected: string|null, actual: string|null }} resume
 * @property {string[]|null} [prefilledUnledgered] Workday only
 * @property {{ ok: boolean, reason?: string|null }} review
 * @property {{ ok: boolean, problems: string[] }} audit
 * @property {{ used: number, cap: unknown }} count
 */

/**
 * The submit gate (spec item 1, v2 C1). Runs immediately before the click, inside the per-application lock.
 * Hard reasons (something about THIS application) are checked before soft ones (configuration or budget),
 * so a soft fallback can never hide a hard problem. Every check must hold EXACTLY; any value this function
 * does not recognize parks.
 * @param {PreSubmitState|null|undefined} state
 * @returns {{ action: 'submit' } | { action: 'park', reason: string, soft: boolean, label: string, detail: string|null }}
 */
export function classifyPreSubmit(state) {
  /** @param {string} reason @param {string|null} [detail] */
  const park = (reason, detail = null) => ({ action: /** @type {const} */ ('park'), reason, soft: PRE_SUBMIT_REASONS[reason].soft, label: PRE_SUBMIT_REASONS[reason].label, detail });
  if (!state || typeof state !== 'object') return park('unrecognized_state');
  const s = /** @type {any} */ (state);
  if (typeof s.ats !== 'string' || !UNATTENDED_ATS.includes(s.ats)) return park('ats_disabled', `ats ${String(s.ats)}`);
  if (!s.config || typeof s.config !== 'object' || !s.exclusion || !s.resume || !s.review || !s.audit || !s.count) return park('unrecognized_state');
  // Hard reasons first.
  if (s.markerEver !== false) return park('marker_exists');
  if (s.exclusion.branch !== 'eligible') return park('exclusion', `${String(s.exclusion.branch)}${s.exclusion.reason ? `: ${String(s.exclusion.reason).slice(0, 200)}` : ''}`);
  if (typeof s.resume.expected !== 'string' || !s.resume.expected) return park('resume_hash_missing');
  if (s.resume.actual !== s.resume.expected) return park('resume_hash_mismatch');
  if (s.ats === 'workday' && (!Array.isArray(s.prefilledUnledgered) || s.prefilledUnledgered.length > 0)) {
    return park('prefilled_unledgered', Array.isArray(s.prefilledUnledgered) ? s.prefilledUnledgered.join(', ').slice(0, 300) : 'missing');
  }
  if (s.review.ok !== true) return park('review_unverified', typeof s.review.reason === 'string' ? s.review.reason : null);
  if (s.audit.ok !== true || !Array.isArray(s.audit.problems) || s.audit.problems.length > 0) {
    return park('audit_failed', Array.isArray(s.audit.problems) ? s.audit.problems.join(', ').slice(0, 400) : null);
  }
  // Soft reasons: configuration (read fresh at click time) and budget.
  if (s.config.enabled !== true) return park('kill_switch');
  if (!s.config.ats || s.config.ats[s.ats] !== true) return park('ats_disabled', `ats ${s.ats}`);
  if (!Array.isArray(s.config.atsAllow) || !s.config.atsAllow.includes(s.ats)) return park('ats_not_allowed', `ats ${s.ats}`);
  if (s.ats === 'workday' && s.config.workdaySubmitMode !== 'unattended') return park('submit_mode_assisted');
  const cap = s.count.cap;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) return park('cap_invalid');
  if (typeof s.count.used !== 'number' || !Number.isInteger(s.count.used) || s.count.used < 0) return park('unrecognized_state');
  if (s.count.used >= cap) return park('cap_exhausted', `${s.count.used} of ${cap}`);
  return { action: 'submit' };
}

/** @param {unknown} s */
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Placeholder values that never count as an answer (C10). '0' is a placeholder only for a pay field.
 */
export const PLACEHOLDER_VALUES = Object.freeze([
  '', 'n/a', 'na', 'n.a.', 'tbd', 'tba', '-', '--', '---', '.', 'none', 'null', 'undefined', 'nil',
  'select', 'select one', 'select...', 'select an option', 'please select', 'choose', 'choose one', 'choose...', 'choose an option',
]);

/** Pay-class labels (C10: '0' is a placeholder here; the salary floor is an allowed source here only). */
export const PAY_LABEL_RE = /\b(?:salary|compensation|pay|wage|wages|remuneration|desired pay|expected pay)\b/i;

/** Sensitive labels (C10): the value must come from the learned tier or a recorded ranked fallback. */
export const SENSITIVE_LABEL_RE = /\b(?:salary|compensation|pay|wage|wages|authori[sz]ed|authori[sz]ation|work permit|right to work|sponsor|sponsorship|visa|gender|sex|race|racial|ethnic|ethnicity|hispanic|latino|latinx|veteran|disability|disabled|sexual orientation|pronouns?)\b/i;

/** Consent / attestation checkbox labels (C4; applied to every ATS, not only Workday). */
export const CONSENT_LABEL_RE = /\b(?:consent|certify|certification|attest|attestation|agree|agreement|acknowledge|acknowledgement|acknowledgment|accept|terms)\b/i;

/** Signature-like fields (C4). */
export const SIGNATURE_RE = /\b(?:signature|e-?sign(?:ature)?|sign here|signed by|type your (?:full )?name)\b/i;

/**
 * @param {unknown} value
 * @param {string} label
 */
export function isPlaceholder(value, label) {
  const v = collapse(value);
  if (PLACEHOLDER_VALUES.includes(v)) return true;
  if (PAY_LABEL_RE.test(label) && /^\$?0+(?:[.,]0+)?$/.test(v)) return true;
  return false;
}

/** Ledger sources that count as "your own data" (spec item 1: learned tier, contact data, account email). */
const BASE_SOURCES = Object.freeze(['learned', 'contact', 'account_email']);

/**
 * Is a ledger entry's source allowed for its label (C10)? Total.
 *   - a file entry: only 'document' (the approved, hash-checked resume or cover letter);
 *   - a sensitive label: 'learned', a recorded ranked fallback (fallback_used with a bank key), or for a pay
 *     label the configured salary floor ('salary_floor'); contact data and anything else park;
 *   - any other label: learned, contact, account email, or a recorded ranked fallback.
 * @param {{ source?: unknown, fallback_used?: unknown, fallbackUsed?: unknown, bank_key?: unknown, bankKey?: unknown, controlType?: unknown, kind?: unknown }} entry
 * @param {string} label
 */
export function sourceAllowed(entry, label) {
  if (!entry || typeof entry !== 'object') return false;
  const source = typeof entry.source === 'string' ? entry.source : '';
  const bankKey = typeof entry.bank_key === 'string' ? entry.bank_key : typeof entry.bankKey === 'string' ? entry.bankKey : '';
  const fallback = (entry.fallback_used === true || entry.fallbackUsed === true) && bankKey.length > 0;
  if (entry.controlType === 'file' || entry.kind === 'file') return source === 'document';
  if (SENSITIVE_LABEL_RE.test(label)) {
    if (source === 'learned' || fallback) return true;
    return source === 'salary_floor' && PAY_LABEL_RE.test(label);
  }
  return BASE_SOURCES.includes(source) || fallback;
}

/**
 * @typedef {Object} SnapField
 * @property {number} idx
 * @property {string} tag
 * @property {string} type
 * @property {string} name
 * @property {string} label
 * @property {boolean} required
 * @property {string|null} ariaRequired
 * @property {boolean} asterisk
 * @property {boolean} optionalMarker
 * @property {string} value
 * @property {boolean} checked
 * @property {string} selectedText
 * @property {string} fileName
 * @property {boolean} visible
 * @property {boolean} disabled
 * @property {string} automationId
 */

/**
 * @param {SnapField} f
 * @param {SnapField[]} fields
 */
function fieldFilled(f, fields) {
  if (f.type === 'checkbox') return f.checked === true;
  if (f.type === 'radio') return fields.some((x) => x.type === 'radio' && x.name && x.name === f.name && x.checked === true) || f.checked === true;
  if (f.type === 'file') return typeof f.fileName === 'string' && f.fileName.length > 0;
  if (f.tag === 'select') return f.value !== '' && !isPlaceholder(f.selectedText, f.label);
  return !isPlaceholder(f.value, f.label);
}

/** Field types the audit looks at (everything a person could type into, pick, check, or attach). */
const AUDITED_TYPES = Object.freeze(['text', 'email', 'tel', 'number', 'url', 'date', 'search', 'textarea', 'select', 'checkbox', 'radio', 'file', '']);

/**
 * Compare one ledger entry with what the page shows now (C5 fill drift). Total.
 * @param {any} entry
 * @param {any} probe
 */
function ledgerMatches(entry, probe) {
  if (!probe || probe.found !== true) return false;
  const ct = entry.controlType;
  if (ct === 'check') return probe.checked === true;
  if (ct === 'file') return typeof probe.fileName === 'string' && collapse(probe.fileName) === collapse(entry.value);
  if (ct === 'select') return collapse(probe.selectedText) === collapse(entry.value) || String(probe.value ?? '') === String(entry.value ?? '');
  if (ct === 'text') return String(probe.value ?? '') === String(entry.value ?? '');
  return false;
}

/**
 * Post-fill required-field audit for a single-page form (spec item 1, v2 C5, C10, D3). `snap` is the
 * apply capability's pageState() taken immediately before the click, with one probe per ledger entry
 * (probe key = entry.key). Returns every problem found; an empty list is the only passing result.
 *
 * Required detection (C5): the `required` attribute, aria-required="true", an asterisk in the field's label,
 * or a validation error surfaced on the page. A field is treated as optional only with a positive signal:
 * aria-required="false", an "optional" marker in its label, or a form whose fields DO mark required ones
 * (at least one field in scope carries a required signal) while this one carries none. A visible empty
 * field with no signal either way parks (required_signal_missing).
 * @param {any} snap
 * @param {any[]} ledger
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function auditForm(snap, ledger) {
  /** @type {string[]} */
  const problems = [];
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.fields) || !Array.isArray(snap.errors)) return { ok: false, problems: ['snapshot_unreadable'] };
  if (snap.scopeFound !== true) problems.push('form_scope_missing');
  if (snap.errors.length > 0) problems.push('validation_error_visible');
  if (!Array.isArray(ledger)) return { ok: false, problems: [...problems, 'ledger_missing'] };
  const probes = snap.probes && typeof snap.probes === 'object' ? snap.probes : {};
  /** @type {Set<number>} */
  const ledgered = new Set();
  for (const e of ledger) {
    const label = typeof e?.label === 'string' && e.label ? e.label : String(e?.key ?? 'field');
    const probe = probes[e?.key];
    if (!probe || probe.found !== true) { problems.push(`ledger_field_missing:${label}`); continue; }
    if (Number.isInteger(probe.fieldIdx) && probe.fieldIdx >= 0) ledgered.add(probe.fieldIdx);
    if (!ledgerMatches(e, probe)) problems.push(`fill_drift:${label}`);
    if (!sourceAllowed(e, label)) problems.push(`source_not_allowed:${label}`);
    if (e.controlType !== 'check' && e.controlType !== 'file' && isPlaceholder(e.value, label)) problems.push(`placeholder_value:${label}`);
  }
  /** @type {SnapField[]} */
  const fields = snap.fields.filter((/** @type {any} */ f) => f && f.visible === true && f.disabled !== true && AUDITED_TYPES.includes(f.tag === 'select' ? 'select' : f.tag === 'textarea' ? 'textarea' : String(f.type ?? '')));
  const hasRequiredSignal = (/** @type {SnapField} */ f) => f.required === true || f.ariaRequired === 'true' || f.asterisk === true;
  const convention = fields.some(hasRequiredSignal);
  /** radio groups already judged, by name */
  const seenRadio = new Set();
  for (const f of fields) {
    const label = f.label || f.name || `field ${f.idx}`;
    if (f.type === 'checkbox' && CONSENT_LABEL_RE.test(f.label) && f.checked !== true) { problems.push(`consent_unchecked:${label}`); continue; }
    if (SIGNATURE_RE.test(`${f.label} ${f.name} ${f.automationId}`)) { problems.push(`signature_field:${label}`); continue; }
    let group = [f];
    if (f.type === 'radio' && f.name) {
      if (seenRadio.has(f.name)) continue;
      seenRadio.add(f.name);
      group = fields.filter((x) => x.type === 'radio' && x.name === f.name);
    }
    const required = group.some(hasRequiredSignal);
    const optional = !required && (group.some((x) => x.ariaRequired === 'false' || x.optionalMarker === true) || convention);
    const filled = fieldFilled(f, fields);
    const isLedgered = group.some((x) => ledgered.has(x.idx));
    if (required) {
      if (!filled) problems.push(`required_empty:${label}`);
      else if (!isLedgered) problems.push(`required_unledgered:${label}`);
    } else if (!optional) {
      if (!filled) problems.push(`required_signal_missing:${label}`);
      else if (!isLedgered) problems.push(`unledgered_value:${label}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Required-field and drift audit for Workday's Review page (spec item 1, v2 C5, C10), where answers are
 * shown as text, not inputs. Every ledger value (checkboxes excepted) must still appear in the review
 * scope's text, every source must be allowed for its label, no placeholder counts, no validation error may
 * be visible, and any editable field still on the page is audited exactly like a form field.
 * @param {any} snap
 * @param {any[]} ledger the assisted lease ledger ({ question, value, kind, source, bank_key, fallback_used })
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function auditReview(snap, ledger) {
  /** @type {string[]} */
  const problems = [];
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.fields) || !Array.isArray(snap.errors)) return { ok: false, problems: ['snapshot_unreadable'] };
  if (snap.errors.length > 0) problems.push('validation_error_visible');
  if (!Array.isArray(ledger)) return { ok: false, problems: [...problems, 'ledger_missing'] };
  const reviewText = collapse(snap.scopeText);
  const digits = (/** @type {string} */ v) => v.replace(/\D/g, '');
  for (const e of ledger) {
    const label = typeof e?.question === 'string' && e.question ? e.question : String(e?.bank_key ?? 'field');
    if (!sourceAllowed(e, label)) problems.push(`source_not_allowed:${label}`);
    if (e?.kind === 'checkbox') continue;
    if (isPlaceholder(e?.value, label)) { problems.push(`placeholder_value:${label}`); continue; }
    const v = collapse(e.value);
    const found = reviewText.includes(v) || (digits(v).length >= 7 && digits(reviewText).includes(digits(v)));
    if (!found) problems.push(`review_missing_value:${label}`);
  }
  const editable = auditForm({ ...snap, scopeFound: true, errors: [], probes: {} }, []);
  for (const p of editable.problems) problems.push(p);
  return { ok: problems.length === 0, problems };
}

/**
 * The single-page form adapters' "ready to submit" check: the form is on the page, no validation error is
 * visible, and EXACTLY one visible, enabled control matches the adapter's submit selector (two submit
 * controls park: the click target would be ambiguous).
 * @param {any} snap
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function reviewSingleForm(snap) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.submitMatches)) return { ok: false, reason: 'snapshot_unreadable' };
  if (snap.scopeFound !== true) return { ok: false, reason: 'form_missing' };
  const usable = snap.submitMatches.filter((/** @type {any} */ m) => m && m.visible === true && m.enabled === true);
  if (usable.length !== 1) return { ok: false, reason: `submit_controls_${usable.length}` };
  return { ok: true, reason: null };
}

/** Accessible names (normalized) of Workday's final Submit control (C4: a fixed set). */
export const WORKDAY_SUBMIT_NAMES = Object.freeze(['submit', 'submit application']);

/** The Workday click target: any button carrying a data-automation-id, narrowed by WORKDAY_SUBMIT_NAMES. */
export const WORKDAY_SUBMIT_TARGET = Object.freeze({ selector: 'button[data-automation-id]', names: WORKDAY_SUBMIT_NAMES });

/** pageState request for a Workday Review page (selectors come from the Workday profile's own rules). */
export const WORKDAY_STATE_REQUEST = Object.freeze({
  scopeSelector: WORKDAY_RULES.scope.containerSelector,
  footerSelector: WORKDAY_RULES.scope.footerSelector,
  dataDeny: WORKDAY_RULES.dataDeny,
  extras: Object.freeze([
    Object.freeze({ key: 'authGate', selector: WORKDAY_RULES.authLost.selector }),
    Object.freeze({ key: 'password', selector: 'input[type="password"]' }),
    Object.freeze({ key: 'uploads', selector: WORKDAY_RULES.upload.itemSelector, nameSelector: WORKDAY_RULES.upload.nameSelector }),
  ]),
});

/**
 * Workday's Review-page check (spec item 1, v2 C4), re-run on the snapshot taken immediately before the
 * click: classifyStep (the assisted guard's own table, Workday rules) must say 'review'; the uploaded-file
 * item must show exactly the uploaded resume (verifyResumeCards); no unchecked consent or agree checkbox,
 * no signature field; and exactly ONE visible, enabled button carrying a data-automation-id whose
 * accessible name is in WORKDAY_SUBMIT_NAMES, with no second submit-named button anywhere on the page.
 * @param {any} snap
 * @param {{ expectedResume: string|null }} o
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function reviewWorkday(snap, o) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.buttons) || !Array.isArray(snap.fields)) return { ok: false, reason: 'snapshot_unreadable' };
  const extras = snap.extras && typeof snap.extras === 'object' ? snap.extras : {};
  const count = (/** @type {string} */ k) => (extras[k] && Number.isInteger(extras[k].count) ? extras[k].count : -1);
  if (count('authGate') < 0 || count('password') < 0 || count('uploads') < 0) return { ok: false, reason: 'snapshot_unreadable' };
  const visibleButtons = snap.buttons.filter((/** @type {any} */ b) => b && b.visible === true);
  const submitVisible = visibleButtons.some((/** @type {any} */ b) => isSubmitMarked(b, WORKDAY_RULES)) || snap.dataMarked === true;
  const step = classifyStep({
    dialogPresent: snap.scopeFound === true,
    headerTexts: Array.isArray(snap.scopeHeadings) ? snap.scopeHeadings : [],
    submitVisible,
    dialogText: typeof snap.scopeText === 'string' ? snap.scopeText : '',
    pageText: typeof snap.text === 'string' ? snap.text.slice(0, 5000) : '',
    url: typeof snap.url === 'string' ? snap.url : '',
    authGatePresent: count('authGate') > 0,
    passwordPresent: count('password') > 0,
  }, WORKDAY_RULES);
  if (step.kind !== 'review') return { ok: false, reason: `step_${step.kind}` };
  const uploads = Array.isArray(extras.uploads.texts) ? extras.uploads.texts : [];
  const cards = verifyResumeCards(uploads.map((/** @type {unknown} */ n) => ({ name: String(n ?? ''), selected: true })), String(o?.expectedResume ?? ''));
  if (!cards.ok) return { ok: false, reason: `resume_${cards.reason}` };
  for (const f of snap.fields) {
    if (!f || f.visible !== true) continue;
    if (f.type === 'checkbox' && f.checked !== true && CONSENT_LABEL_RE.test(String(f.label ?? ''))) return { ok: false, reason: 'consent_unchecked' };
    if (SIGNATURE_RE.test(`${f.label ?? ''} ${f.name ?? ''} ${f.automationId ?? ''}`)) return { ok: false, reason: 'signature_field' };
  }
  const named = visibleButtons.filter((/** @type {any} */ b) => WORKDAY_SUBMIT_NAMES.includes(normalizeName(b.name)));
  const targets = named.filter((/** @type {any} */ b) => b.enabled === true && typeof b.automationId === 'string' && b.automationId.length > 0);
  if (named.length !== 1 || targets.length !== 1) return { ok: false, reason: `submit_controls_${named.length}_${targets.length}` };
  return { ok: true, reason: null };
}

/**
 * "Application sent" text per ATS (C6). Deliberately narrower than "thank you": a page that merely thanks
 * the visitor for their interest is not a confirmation. Workday reuses the assisted profile's own rule.
 */
export const SENT_TEXT = Object.freeze({
  default: /\bthank you for (?:applying|your application|submitting your application)\b|\b(?:your )?application (?:has been |was )?(?:received|submitted|complete(?:d)?)\b|\bwe(?:'ve| have) received your application\b|\bsuccessfully submitted\b/i,
  workday: new RegExp(WORKDAY_RULES.sent.source, WORKDAY_RULES.sent.flags),
});

/**
 * Thanks-page path SEGMENTS per ATS (C6: anchored to a whole path segment, never a substring). An ATS with
 * no entry has no URL confirmation (text only): iCIMS, Dayforce, Workday.
 */
export const THANKS_SEGMENT = Object.freeze(/** @type {Record<string, RegExp>} */ ({
  greenhouse: /^(?:thanks|confirmation)$/i,
  lever: /^thanks$/i,
  smartrecruiters: /^(?:thanks|confirmation|success)$/i,
}));

/** A URL carrying any of these is never a confirmation (C6). */
export const ERROR_URL_RE = /error|invalid|validation|fail|denied|captcha|retry/i;

/**
 * @param {string} ats
 * @param {unknown} url
 */
export function thanksUrlMatches(ats, url) {
  const rx = Object.prototype.hasOwnProperty.call(THANKS_SEGMENT, ats) ? THANKS_SEGMENT[ats] : null;
  if (!rx || typeof url !== 'string') return false;
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (ERROR_URL_RE.test(`${u.pathname}${u.search}${u.hash}`)) return false;
  const segs = u.pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  return segs.some((s) => rx.test(s));
}

/** @param {string} ats */
function sentRe(ats) {
  return ats === 'workday' ? SENT_TEXT.workday : SENT_TEXT.default;
}

/**
 * One post-click snapshot's signal, compared with the pre-click baseline. Main-frame text only: a
 * confirmation that appears only inside an iframe is never a signal (C6).
 * @param {string} ats
 * @param {any} baseline
 * @param {any} snap
 * @returns {'error'|'candidate'|'none'}
 */
export function confirmationSignal(ats, baseline, snap) {
  if (!snap || typeof snap !== 'object') return 'none';
  if (Array.isArray(snap.errors) && snap.errors.length > 0) return 'error';
  const rx = sentRe(ats);
  const baseText = baseline && typeof baseline.text === 'string' ? baseline.text : '';
  const text = typeof snap.text === 'string' ? snap.text : '';
  if (rx.test(text) && !rx.test(baseText)) return 'candidate';
  const baseUrl = baseline && typeof baseline.url === 'string' ? baseline.url : '';
  if (typeof snap.url === 'string' && snap.url !== baseUrl && thanksUrlMatches(ats, snap.url)) return 'candidate';
  return 'none';
}

/**
 * Final confirmation verdict (spec item 3, v2 C6). `after` is the first post-click snapshot that carried a
 * signal; `settled` is taken about 3 seconds later. Total:
 *   error        a validation or error element is visible in either snapshot (park, never retried);
 *   confirmed    the sent text is in BOTH the after and settled main-frame text and was absent from the
 *                baseline, or the CURRENT (settled) URL differs from the baseline URL and matches the ATS's
 *                anchored thanks segment with no error marker; and nothing errored;
 *   unconfirmed  anything else (no signal, a signal that did not survive settling, iframe-only text, a
 *                pre-existing thank-you heading, a stale thanks apply URL).
 * @param {{ ats: string, baseline: any, after: any, settled: any }} o
 * @returns {'confirmed'|'error'|'unconfirmed'}
 */
export function classifyConfirmation(o) {
  if (!o || typeof o !== 'object') return 'unconfirmed';
  const { ats, baseline, after, settled } = o;
  const errorsIn = (/** @type {any} */ s) => Boolean(s && Array.isArray(s.errors) && s.errors.length > 0);
  if (errorsIn(after) || errorsIn(settled)) return 'error';
  if (!after || !settled || typeof after !== 'object' || typeof settled !== 'object') return 'unconfirmed';
  const rx = sentRe(ats);
  const baseText = baseline && typeof baseline.text === 'string' ? baseline.text : null;
  if (baseText === null) return 'unconfirmed';
  const textOk = rx.test(String(after.text ?? '')) && rx.test(String(settled.text ?? '')) && !rx.test(baseText);
  const baseUrl = baseline && typeof baseline.url === 'string' ? baseline.url : '';
  const urlOk = typeof settled.url === 'string' && settled.url !== baseUrl && thanksUrlMatches(ats, settled.url);
  return textOk || urlOk ? 'confirmed' : 'unconfirmed';
}
