// @ts-check
/**
 * Target finder classifier (plan: target-finder-2026-10-15, section 4). Pure and synchronous; no DB, no
 * network, no clock except the injected `now`.
 *
 * classifySignal(signal, opts) is a TOTAL classification: every input, including null, a non-object, or
 * garbage in any field, yields exactly one {class, rule, inputs} with class in
 * target | needs-review | not-target. The default for anything unexpected is needs-review (friction),
 * never target. Steps run in the ascending priority order declared in config/target-rules.json; the first
 * step that yields a verdict wins:
 *
 *   0 normalize   NFKC + zero-width/soft-hyphen strip on every name field (always runs, no verdict)
 *   1 trigger_kind     unrecognized -> needs-review
 *   2 exclusion        blocked company -> not-target; suspect / unknown / applied / unavailable list -> needs-review
 *   3 evidence         missing or failing the evidence registry (src/core/target-evidence.js) -> needs-review
 *   4 date             null, invalid, >7d future -> needs-review; older than the window -> not-target
 *   5 size             confidence-enum total mapping (see sizeStep)
 *   6 form_d_issuer    fund-like issuer or SIC 6799 -> needs-review
 *   7 trigger_specific departure role must be CTO-level; gap needs a hiring VP/Director/Head of Engineering
 *                      listing, no CTO-level listing, and a departure signal ruled out
 *   8 final            target
 *
 * Signal shape (all optional; anything missing is handled by the step that needs it):
 *   { trigger_kind: 'pe_deal'|'exec_departure'|'leadership_gap', company, aliases[], acquirer, investor,
 *     pe_firm, text, evidence_url, evidence_source, event_date, filing_date,
 *     size: { low, high, basis, confidence }, employees, offering_amount (IGNORED, never size),
 *     issuer: { name, sic }, role, listings: [{ title, description }], departure_signal }
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { classifyTitle } from './title-gate.js';
import { normalizeCompany } from './normalize.js';
import { getEnv } from './config.js';
import { checkEvidence } from './target-evidence.js';
import { normalizeName, classifySignalExclusion, strippedForm } from './target-exclusion.js';
import { BUILT_IN_BLOCKED } from '../apply/exclusions.js';

export { normalizeName, strippedForm } from './target-exclusion.js';

export const TARGET_CLASSES = Object.freeze(['target', 'needs-review', 'not-target']);
export const TRIGGER_KINDS = Object.freeze(['pe_deal', 'exec_departure', 'leadership_gap']);
export const SIZE_CONFIDENCES = Object.freeze(['high', 'medium', 'low', 'none']);
const CONF_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3 });
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Rules config
// ---------------------------------------------------------------------------

const classEnum = z.enum(['target', 'needs-review', 'not-target']);
export const targetRulesSchema = z.object({
  steps: z.array(z.object({ id: z.string().min(1), priority: z.number().int() })).min(1),
  verdict_rules: z.array(z.object({ rule: z.string().min(1), step: z.string().min(1), class: classEnum })).min(1),
  params: z.object({
    windows_days: z.object({ pe_deal: z.number().int().positive(), exec_departure: z.number().int().positive(), leadership_gap: z.number().int().positive() }),
    future_tolerance_days: z.number().int().min(0),
    size_band: z.object({ low: z.number().positive(), high: z.number().positive() }),
    headcount_revenue_per_employee: z.object({ low: z.number().positive(), high: z.number().positive() }),
    confidence_cap_by_basis: z.record(z.enum(['high', 'medium', 'low', 'none'])),
    fund_name_tokens: z.array(z.string().min(1)),
    fund_sic_codes: z.array(z.string().min(1)),
    stripped_match_min_length: z.number().int().min(1),
  }),
}).superRefine((cfg, ctx) => {
  const prios = new Set();
  for (const s of cfg.steps) {
    if (prios.has(s.priority)) ctx.addIssue({ code: 'custom', message: `target-rules.json: duplicate step priority ${s.priority}` });
    prios.add(s.priority);
  }
  const ids = new Set();
  for (const r of cfg.verdict_rules) {
    if (ids.has(r.rule)) ctx.addIssue({ code: 'custom', message: `target-rules.json: duplicate rule id ${r.rule}` });
    ids.add(r.rule);
  }
  if (cfg.params.size_band.low >= cfg.params.size_band.high) ctx.addIssue({ code: 'custom', message: 'target-rules.json: size_band.low must be below size_band.high' });
});

/** @typedef {z.infer<typeof targetRulesSchema>} TargetRules */

/**
 * Load and validate config/target-rules.json fresh from disk. Throws on a missing or invalid file: the
 * classifier is meaningless without its rules, and the caller (runner) decides how to surface that.
 * @param {string} [configDir]
 * @returns {TargetRules}
 */
export function loadTargetRules(configDir = getEnv().JOBSEARCH_CONFIG_DIR) {
  const file = path.join(configDir, 'target-rules.json');
  return targetRulesSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// ---------------------------------------------------------------------------
// CTO-level / hiring-leadership titles (reuse the triage title floor, src/core/title-gate.js)
// ---------------------------------------------------------------------------

const CTO_TOKEN_RE = /\b(?:cto|cio|cdo|caio|ciso)\b/;
const CHIEF_TECH_RE = /\bchief\s+(?:technology|technical|information|digital|data|ai|artificial intelligence|analytics|security|software|engineering)\b(?:\s+[\w&]+){0,3}?\s+officer\b/;
const HEAD_TECH_RE = /\bhead of (?:technology|it|information technology|digital|data)\b/;
const NOT_CTO_RE = /\b(?:chief of staff|assistant|associate|deputy|office of)\b/;
const LEADERSHIP_LEVEL_RE = /\b(?:vp|svp|evp|vice president|director|head)\b/;
const ENGINEERING_FUNCTION_RE = /\b(?:engineering|technology|software|platform|infrastructure|architecture)\b/;
const REPORTS_TO_CEO_RE = /\breports?\s+(?:directly\s+)?to\s+(?:the\s+)?(?:ceo|chief executive)/i;

/** @param {unknown} title */
function flatTitle(title) {
  return normalizeName(title).toLowerCase().replace(/\./g, '').replace(/[^a-z0-9&\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * CTO-level title: the title must first pass the SAME deterministic floor used by triage
 * (classifyTitle verdict 'pass'), then name a CTO-class role. Head of Technology and Chief Digital Officer
 * count; VP/Director/Head of Engineering do not.
 * @param {unknown} title
 * @returns {boolean}
 */
export function isCtoLevelTitle(title) {
  const raw = normalizeName(title);
  if (!raw) return false;
  if (classifyTitle(raw).verdict !== 'pass') return false;
  const t = flatTitle(raw);
  if (NOT_CTO_RE.test(t)) return false;
  return CTO_TOKEN_RE.test(t) || CHIEF_TECH_RE.test(t) || HEAD_TECH_RE.test(t);
}

/**
 * A hiring VP, Director, or Head of Engineering/Technology-function listing that is not itself CTO-level.
 * Plain Director is accepted here on purpose (the triage floor drops it from the apply flow, but it is
 * exactly the gap signal); a non-technology function is refused through the same floor.
 * @param {unknown} title
 * @returns {boolean}
 */
export function isHiringLeadershipTitle(title) {
  const raw = normalizeName(title);
  if (!raw || isCtoLevelTitle(raw)) return false;
  // Function check through the same floor, with the level forced to VP so a plain Director (dropped by
  // the floor as director_level before its function is looked at) still gets its function judged.
  if (classifyTitle(`VP ${raw}`).reason === 'non_tech_function') return false;
  const t = flatTitle(raw);
  return LEADERSHIP_LEVEL_RE.test(t) && ENGINEERING_FUNCTION_RE.test(t);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Strict date parse to a UTC day number. Accepts YYYY-MM-DD optionally followed by a time; rejects
 * impossible calendar dates (2026-02-30) and anything else.
 * @param {unknown} v
 * @returns {number|null} ms at UTC midnight of that day
 */
export function parseDay(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (m[0].length > 10 && Number.isNaN(Date.parse(v.trim().replace(' ', 'T')))) return null;
  return ms;
}

/** @param {Date|number|string|undefined} now @returns {number} UTC midnight ms of today */
function todayDay(now) {
  const d = now === undefined ? new Date() : (now instanceof Date ? now : new Date(now));
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

/**
 * Revenue range from a headcount. Always max confidence low.
 * @param {unknown} employees
 * @param {TargetRules['params']['headcount_revenue_per_employee']} per
 * @returns {{ low: number, high: number, basis: 'headcount', confidence: 'low' }|null}
 */
export function sizeFromHeadcount(employees, per) {
  if (typeof employees !== 'number' || !Number.isFinite(employees) || employees <= 0) return null;
  return { low: employees * per.low, high: employees * per.high, basis: 'headcount', confidence: 'low' };
}

/**
 * Total confidence mapping: any value outside the enum is 'none'; the basis cap can only lower it.
 * @param {unknown} confidence
 * @param {unknown} basis
 * @param {Record<string, string>} caps
 * @returns {'high'|'medium'|'low'|'none'}
 */
export function effectiveConfidence(confidence, basis, caps) {
  const c = typeof confidence === 'string' && SIZE_CONFIDENCES.includes(confidence) ? /** @type {'high'|'medium'|'low'|'none'} */ (confidence) : 'none';
  const capRaw = typeof basis === 'string' && Object.prototype.hasOwnProperty.call(caps, basis) ? caps[basis] : null;
  if (!capRaw || !SIZE_CONFIDENCES.includes(capRaw)) return c;
  const cap = /** @type {'high'|'medium'|'low'|'none'} */ (capRaw);
  return CONF_RANK[cap] < CONF_RANK[c] ? cap : c;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Verdict
 * @property {'target'|'needs-review'|'not-target'} class
 * @property {string} rule
 * @property {Record<string, unknown>} inputs JSON-safe snapshot of what the verdict was based on
 */

/**
 * @typedef {Object} ClassifyOptions
 * @property {TargetRules} [rules] defaults to loadTargetRules()
 * @property {import('./target-exclusion.js').BlockedList} [blocked] defaults to built-ins with status 'missing'
 * @property {string[]} [appliedCompanies]
 * @property {Date|number|string} [now]
 */

/**
 * @param {unknown} signal
 * @param {ClassifyOptions} [opts]
 * @returns {Verdict}
 */
export function classifySignal(signal, opts = {}) {
  /** @type {Record<string, unknown>} */
  const inputs = {};
  try {
    return classifyInner(signal, opts, inputs);
  } catch (err) {
    inputs.error = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
    return { class: 'needs-review', rule: 'classifier_error', inputs };
  }
}

/**
 * @param {unknown} signal
 * @param {ClassifyOptions} opts
 * @param {Record<string, unknown>} inputs
 * @returns {Verdict}
 */
function classifyInner(signal, opts, inputs) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
    inputs.signal_type = signal === null ? 'null' : Array.isArray(signal) ? 'array' : typeof signal;
    return { class: 'needs-review', rule: 'invalid_input', inputs };
  }
  const rules = opts.rules ?? loadTargetRules();
  const p = rules.params;
  const registry = new Map(rules.verdict_rules.map((r) => [r.rule, r.class]));
  const sig = /** @type {Record<string, any>} */ (signal);

  // Step 0: normalize every name field.
  const company = normalizeName(sig.company);
  const aliases = Array.isArray(sig.aliases) ? sig.aliases.map(normalizeName).filter(Boolean) : [];
  const otherParties = ['acquirer', 'investor', 'pe_firm'].map((k) => normalizeName(sig[k])).filter(Boolean);
  const kind = typeof sig.trigger_kind === 'string' ? sig.trigger_kind : '';
  Object.assign(inputs, { company, company_norm: normalizeCompany(company).company_norm, trigger_kind: kind || null });

  /** @type {Record<string, (() => Verdict|null)>} */
  const handlers = {
    trigger_kind: () => {
      if (!TRIGGER_KINDS.includes(kind)) return verdict('needs-review', 'trigger_kind_unrecognized');
      return null;
    },

    exclusion: () => {
      const blocked = opts.blocked ?? { entries: [...BUILT_IN_BLOCKED], status: /** @type {const} */ ('missing'), error: null };
      const textFields = [sig.text, sig.evidence_url, ...(Array.isArray(sig.listings) ? sig.listings.flatMap((l) => [l?.title, l?.description]) : [])];
      const ex = classifySignalExclusion(
        { company, aliases, otherParties, texts: textFields },
        { blocked: blocked.entries, appliedCompanies: opts.appliedCompanies, strippedMinLength: p.stripped_match_min_length },
      );
      inputs.exclusion_branch = ex.branch;
      inputs.exclusion_detail = ex.detail;
      inputs.blocklist_status = blocked.status;
      if (ex.class && ex.rule) return verdict(ex.class, ex.rule);
      if (blocked.status !== 'ok') return verdict('needs-review', 'excl_blocklist_unavailable');
      return null;
    },

    evidence: () => {
      const source = typeof sig.evidence_source === 'string' ? sig.evidence_source : null;
      inputs.evidence_source = source;
      if (typeof sig.evidence_url !== 'string' || !sig.evidence_url.trim()) return verdict('needs-review', 'evidence_missing');
      const ev = checkEvidence(sig.evidence_url, source);
      inputs.evidence_check = ev.reason;
      inputs.evidence_host = ev.host;
      if (!ev.ok) return verdict('needs-review', 'evidence_invalid');
      inputs.evidence_url = ev.url;
      return null;
    },

    date: () => {
      const hasEvent = sig.event_date !== null && sig.event_date !== undefined && sig.event_date !== '';
      const raw = hasEvent ? sig.event_date : sig.filing_date;
      inputs.date_source = hasEvent ? 'event_date' : 'filing_date';
      if (raw === null || raw === undefined || raw === '') return verdict('needs-review', 'date_missing');
      const day = parseDay(raw);
      if (day === null) {
        inputs.date_raw = String(raw).slice(0, 40);
        return verdict('needs-review', 'date_invalid');
      }
      const today = todayDay(opts.now);
      const ageDays = Math.round((today - day) / DAY_MS);
      const window = p.windows_days[/** @type {'pe_deal'|'exec_departure'|'leadership_gap'} */ (kind)];
      inputs.trigger_date = new Date(day).toISOString().slice(0, 10);
      inputs.age_days = ageDays;
      inputs.window_days = window;
      if (-ageDays > p.future_tolerance_days) return verdict('needs-review', 'date_future');
      if (ageDays > window) return verdict('not-target', 'date_stale');
      return null;
    },

    size: () => sizeStep(sig, p, inputs, verdict),

    form_d_issuer: () => {
      const isFormD = sig.evidence_source === 'edgar_form_d' || (sig.issuer && typeof sig.issuer === 'object');
      if (!isFormD) return null;
      const issuerName = normalizeName(sig.issuer?.name);
      inputs.issuer_name = issuerName || null;
      if (!issuerName) return verdict('needs-review', 'form_d_issuer_unknown');
      const words = issuerName.toLowerCase().replace(/\./g, '').split(/[^a-z0-9]+/).filter(Boolean);
      const fundLike = words.some((w) => p.fund_name_tokens.includes(w));
      const sic = String(sig.issuer?.sic ?? '').trim();
      inputs.issuer_sic = sic || null;
      if (fundLike || (sic && p.fund_sic_codes.includes(sic))) return verdict('needs-review', 'form_d_fund_issuer');
      return null;
    },

    trigger_specific: () => {
      if (kind === 'exec_departure') {
        inputs.role = normalizeName(sig.role) || null;
        if (!isCtoLevelTitle(sig.role)) return verdict('needs-review', 'departure_role_not_cto_level');
        return null;
      }
      if (kind === 'leadership_gap') {
        const listings = Array.isArray(sig.listings) ? sig.listings : [];
        const titles = listings.map((l) => normalizeName(l?.title)).filter(Boolean);
        inputs.listing_titles = titles.slice(0, 20);
        inputs.reports_to_ceo_hint = listings.some((l) => REPORTS_TO_CEO_RE.test(normalizeName(l?.description)));
        if (titles.some(isCtoLevelTitle)) return verdict('needs-review', 'gap_cto_level_listing_present');
        if (!titles.some(isHiringLeadershipTitle)) return verdict('needs-review', 'gap_no_hiring_listing');
        inputs.departure_signal = sig.departure_signal === false ? false : (sig.departure_signal ?? null);
        if (sig.departure_signal !== false) return verdict('needs-review', 'gap_departure_not_ruled_out');
      }
      return null;
    },

    final: () => verdict('target', 'target_all_checks_passed'),
  };

  /**
   * Build a verdict, enforcing that the rule is registered with this exact class (a code/config drift
   * degrades to needs-review, never to a silent pass).
   * @param {'target'|'needs-review'|'not-target'} cls
   * @param {string} rule
   * @returns {Verdict}
   */
  function verdict(cls, rule) {
    const declared = registry.get(rule);
    if (declared !== cls) {
      inputs.rule_drift = { rule, wanted: cls, declared: declared ?? null };
      return { class: 'needs-review', rule: 'classifier_error', inputs: { ...inputs } };
    }
    return { class: cls, rule, inputs: { ...inputs } };
  }

  const ordered = [...rules.steps].sort((a, b) => a.priority - b.priority);
  for (const step of ordered) {
    const h = handlers[step.id];
    if (!h) {
      inputs.unknown_step = step.id;
      return { class: 'needs-review', rule: 'classifier_error', inputs: { ...inputs } };
    }
    const v = h();
    if (v) return v;
  }
  inputs.no_terminal_step = true;
  return { class: 'needs-review', rule: 'classifier_error', inputs: { ...inputs } };
}

/**
 * Size step (5). Confidence enum {high, medium, low, none} with a total mapping:
 *   none (incl. Form D offering amount, unknown enum value, no size)  -> needs-review size_none
 *   a non-number / negative / reversed bound                          -> needs-review size_invalid
 *   exactly one bound known                                           -> needs-review size_one_bound
 *   out of band entirely, effective confidence high                   -> not-target size_out_of_band
 *   in band, confidence medium or high                                -> continue
 *   in band, confidence low                                           -> needs-review size_low_confidence
 *   anything else (straddling, out of band below high)                -> needs-review size_not_clearly_in_band
 * @param {Record<string, any>} sig
 * @param {TargetRules['params']} p
 * @param {Record<string, unknown>} inputs
 * @param {(cls: 'target'|'needs-review'|'not-target', rule: string) => Verdict} verdict
 * @returns {Verdict|null}
 */
function sizeStep(sig, p, inputs, verdict) {
  // offering_amount is never size: it is not even read here.
  let size = sig.size && typeof sig.size === 'object' ? sig.size : null;
  if (!size) size = sizeFromHeadcount(sig.employees, p.headcount_revenue_per_employee);
  const basis = typeof size?.basis === 'string' ? size.basis : null;
  const conf = size ? effectiveConfidence(size.confidence, basis, p.confidence_cap_by_basis) : 'none';
  inputs.size_basis = basis;
  inputs.size_confidence = conf;
  if (conf === 'none') return verdict('needs-review', 'size_none');

  const known = (/** @type {unknown} */ v) => v !== null && v !== undefined;
  const lowKnown = known(size.low);
  const highKnown = known(size.high);
  const bad = (/** @type {unknown} */ v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0;
  if ((lowKnown && bad(size.low)) || (highKnown && bad(size.high))) return verdict('needs-review', 'size_invalid');
  if (!lowKnown && !highKnown) return verdict('needs-review', 'size_none');
  if (lowKnown !== highKnown) return verdict('needs-review', 'size_one_bound');
  if (size.low > size.high) return verdict('needs-review', 'size_invalid');
  inputs.size_low = size.low;
  inputs.size_high = size.high;

  const band = p.size_band;
  const inBand = size.low >= band.low && size.high <= band.high;
  const outOfBand = size.high < band.low || size.low > band.high;
  if (outOfBand && conf === 'high') return verdict('not-target', 'size_out_of_band');
  if (inBand && (conf === 'high' || conf === 'medium')) return null;
  if (inBand) return verdict('needs-review', 'size_low_confidence');
  return verdict('needs-review', 'size_not_clearly_in_band');
}

// ---------------------------------------------------------------------------
// Rules lint (config/target-rules.json + config/target-rules-fixtures.json)
// ---------------------------------------------------------------------------

/** Step ids the classifier has a handler for; config steps must be exactly this set. */
export const STEP_IDS = Object.freeze(['trigger_kind', 'exclusion', 'evidence', 'date', 'size', 'form_d_issuer', 'trigger_specific', 'final']);

/** Every rule id classifySignal can emit. config verdict_rules must be exactly this set. */
export const EMITTABLE_RULES = Object.freeze([
  'invalid_input', 'classifier_error', 'trigger_kind_unrecognized',
  'excl_blocked_company', 'excl_blocked_suspect', 'excl_unknown_company', 'excl_applied_before', 'excl_unmapped_branch', 'excl_blocklist_unavailable',
  'evidence_missing', 'evidence_invalid', 'date_missing', 'date_invalid', 'date_future', 'date_stale',
  'size_none', 'size_invalid', 'size_one_bound', 'size_out_of_band', 'size_low_confidence', 'size_not_clearly_in_band',
  'form_d_issuer_unknown', 'form_d_fund_issuer',
  'departure_role_not_cto_level', 'gap_no_hiring_listing', 'gap_cto_level_listing_present', 'gap_departure_not_ruled_out',
  'target_all_checks_passed',
]);

/**
 * Lint the rules and run every fixture. Returns human-readable failures (empty = ok).
 * @param {unknown} rulesRaw parsed target-rules.json
 * @param {unknown} fixtureDoc parsed target-rules-fixtures.json
 * @returns {{ ok: boolean, failures: string[], fixtureCount: number }}
 */
export function lintTargetRules(rulesRaw, fixtureDoc) {
  /** @type {string[]} */
  const failures = [];
  const parsed = targetRulesSchema.safeParse(rulesRaw);
  if (!parsed.success) {
    return { ok: false, failures: parsed.error.issues.map((i) => `target-rules.json: ${i.path.join('.')}: ${i.message}`), fixtureCount: 0 };
  }
  const rules = parsed.data;
  const configRules = new Set(rules.verdict_rules.map((r) => r.rule));
  for (const r of EMITTABLE_RULES) if (!configRules.has(r)) failures.push(`rule "${r}" is emitted by the classifier but missing from verdict_rules`);
  for (const r of configRules) if (!EMITTABLE_RULES.includes(r)) failures.push(`rule "${r}" is in verdict_rules but the classifier never emits it`);
  const stepIds = rules.steps.map((s) => s.id);
  for (const id of STEP_IDS) if (!stepIds.includes(id)) failures.push(`step "${id}" has a handler but is missing from steps`);
  for (const id of stepIds) if (!STEP_IDS.includes(id)) failures.push(`step "${id}" has no handler`);
  const ordered = [...rules.steps].sort((a, b) => a.priority - b.priority).map((s) => s.id);
  if (ordered[ordered.length - 1] !== 'final') failures.push('the final step must have the highest priority');
  if (ordered[0] !== 'trigger_kind') failures.push('trigger_kind must have the lowest priority');

  const doc = /** @type {any} */ (fixtureDoc);
  const fixtures = Array.isArray(doc?.fixtures) ? doc.fixtures : [];
  if (!doc || typeof doc !== 'object' || !doc.base || fixtures.length === 0) {
    failures.push('target-rules-fixtures.json: needs now, base, and a non-empty fixtures array');
    return { ok: false, failures, fixtureCount: 0 };
  }
  for (const f of fixtures) {
    /** @type {Record<string, any>} */
    const sig = { ...doc.base };
    for (const [k, v] of Object.entries(f.patch ?? {})) {
      if (v === null) delete sig[k]; else sig[k] = v;
    }
    const v = classifySignal(sig, { rules, now: doc.now, blocked: { entries: [...BUILT_IN_BLOCKED], status: 'ok', error: null } });
    if (v.class !== f.expected_class || v.rule !== f.expected_rule) {
      failures.push(`fixture "${f.name}": expected ${f.expected_class}/${f.expected_rule}, got ${v.class}/${v.rule}`);
    }
  }
  return { ok: failures.length === 0, failures, fixtureCount: fixtures.length };
}

// ---------------------------------------------------------------------------
// Dedup (runs AFTER classification)
// ---------------------------------------------------------------------------

const CLASS_RANK = Object.freeze({ 'target': 3, 'needs-review': 2, 'not-target': 1 });

/**
 * @typedef {Object} ClassifiedSignal
 * @property {number|string} id
 * @property {string} company
 * @property {'target'|'needs-review'|'not-target'} class
 * @property {string|null|undefined} trigger_date
 */

/**
 * Per company group keep the best outcome (target > needs-review > not-target), then the newest trigger
 * date (null/invalid sorts oldest), then the highest id. Every collapsed id is returned so the caller can
 * log it. A blank or unresolvable company never groups with anything.
 * @template {ClassifiedSignal} T
 * @param {T[]} items
 * @returns {{ kept: Array<T & { collapsed_ids: Array<number|string> }>, collapsed: Array<{ kept_id: number|string, company_norm: string, collapsed_ids: Array<number|string> }> }}
 */
export function dedupSignals(items) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const it of items) {
    const norm = normalizeCompany(normalizeName(it.company)).company_norm;
    const key = norm && !norm.startsWith('confidential:') ? norm : `__ungrouped:${String(it.id)}`;
    const g = groups.get(key);
    if (g) g.push(it); else groups.set(key, [it]);
  }
  const rank = (/** @type {T} */ t) => /** @type {Record<string, number>} */ (CLASS_RANK)[t.class] ?? 0;
  const dayOf = (/** @type {T} */ t) => parseDay(t.trigger_date) ?? Number.NEGATIVE_INFINITY;
  const idCmp = (/** @type {T} */ a, /** @type {T} */ b) => {
    const [x, y] = [Number(a.id), Number(b.id)];
    if (Number.isFinite(x) && Number.isFinite(y)) return y - x;
    return String(b.id).localeCompare(String(a.id));
  };
  /** @type {Array<T & { collapsed_ids: Array<number|string> }>} */
  const kept = [];
  /** @type {Array<{ kept_id: number|string, company_norm: string, collapsed_ids: Array<number|string> }>} */
  const collapsed = [];
  for (const [key, g] of groups) {
    const sorted = [...g].sort((a, b) => rank(b) - rank(a) || (dayOf(b) === dayOf(a) ? 0 : dayOf(b) > dayOf(a) ? 1 : -1) || idCmp(a, b));
    const winner = sorted[0];
    const others = sorted.slice(1).map((s) => s.id);
    kept.push({ ...winner, collapsed_ids: others });
    if (others.length) collapsed.push({ kept_id: winner.id, company_norm: key, collapsed_ids: others });
  }
  return { kept, collapsed };
}

/**
 * Count verdict classes (the weekly not-target count surfaced in the digest).
 * @param {Array<{ class: string }>} items
 * @returns {{ target: number, 'needs-review': number, 'not-target': number }}
 */
export function countByClass(items) {
  const c = { 'target': 0, 'needs-review': 0, 'not-target': 0 };
  for (const it of items) if (it.class in c) c[/** @type {keyof typeof c} */ (it.class)] += 1;
  return c;
}
