// @ts-check
/**
 * Ready to apply list (spec-ready-to-apply-v1 sections 2, 3, 5, 6; resolutions R1-R8, amendments A1-A10).
 *
 * Every live listing with fit >= the floor maps to EXACTLY ONE bucket (READY_BUCKETS). Families:
 *   auto_submit_path   the unattended path owns it; counted, not listed
 *   ready_to_apply     listed with its apply link (and a resume when the description allows one)
 *   held_<reason>      listed in the Held subsection with the reason (link shown only when it passes
 *                      readyLinkCheck), never given a resume
 *   excluded_<reason>  counted by reason, never listed row by row
 * The select reason comes from src/core/auto-apply-select.js classifyCandidateWithExclusions (the same
 * exclusion gate, fit floor, salary floor and location logic auto-apply uses; never re-implemented here),
 * then mapSelectReason (pure, total, never throws) maps it. A reason this table has never seen, a thrown
 * classification, and any sub-rule that matches nothing all land in held_unknown: visible, never silent.
 *
 * Post-mapping rules (classifyRows), in order:
 *   A3  a blocked employer in the manual link or Gmail final URL host -> excluded_blocked_company (no link)
 *   A9  a listed row first seen more than staleDays ago -> excluded_stale
 *   A8  link check: a ready row whose link is unsafe -> held_unsafe_link (shown without the link); a ready
 *       row with no usable link -> held_no_link; a held row keeps its bucket but drops a failing link
 *   A9  drift breaker: when more than driftThreshold of the probed LinkedIn rows in this pass sit on
 *       no_control or reason top_card_no_anchor (and at least driftMinRows were probed), those listed rows
 *       become held_markup_drift, and no manual-only lock is ever written for that bucket
 *   R2/A7 dedup among ready rows: collapse only real (non-placeholder) companies with the same title AND
 *       (the same company plus the same link or location, OR the same normalized link); the lower-fit copy
 *       becomes excluded_duplicate and the kept row carries also_on
 *   R3  resume eligibility: description length >= DETAIL_MIN_CHARS (rows below it stay listed, no resume)
 *
 * The ledger (ic_ready_to_apply) is a cache: refreshReadyLedger stores the last bucket, first_listed_at,
 * the auto-path start (A6), and, when the caller is DISPLAYING the list (report send, dashboard view),
 * writes the manual-only lock for every listed row that never had one (A1), except held_markup_drift.
 */
import { CLOSED_REASONS, classifyCandidateWithExclusions, isHourlyPaySignal, startOfDayInTz } from './auto-apply-select.js';
import { loadExclusionConfig, companyTokens, containsWholePhrase } from '../apply/exclusions.js';
import { loadConfig } from './config.js';
import { DETAIL_MIN_CHARS, ABSENT_LOCATION, LEGACY_UNKNOWN_LOCATION } from './normalize.js';
import { readyLinkCheck, normalizeTargetKey, UNSAFE_LINK_REASONS } from './ready-link.js';
import { LIFETIME_PROBE_ATTEMPTS } from './apply-target-persist.js';
import { isPlaceholderCompany, lockMatches, lockSubjectFromRow, loadActiveManualLocks, writeManualLocks } from './manual-lock.js';
import { withTransaction } from './db.js';
import { errFields } from './errors.js';

export const HELD_BUCKETS = Object.freeze([
  'held_applied_company_other_role', 'held_blocked_company_suspect', 'held_unknown_company', 'held_fit_unverified', 'held_location_unknown',
  'held_no_description', 'held_not_probed', 'held_awaiting_reprobe', 'held_no_link', 'held_unsafe_link', 'held_markup_drift',
  'held_auto_stalled', 'held_stale_application', 'held_unknown',
]);
export const EXCLUDED_BUCKETS = Object.freeze([
  'excluded_blocked_company', 'excluded_already_applied', 'excluded_withdrawn', 'excluded_duplicate', 'excluded_below_fit',
  'excluded_not_us', 'excluded_salary_below_floor', 'excluded_active_application', 'excluded_hourly_pay', 'excluded_stale',
]);
/** The closed, total bucket list. */
export const READY_BUCKETS = Object.freeze(['auto_submit_path', 'ready_to_apply', ...HELD_BUCKETS, ...EXCLUDED_BUCKETS]);
export const READY_CHANNELS = Object.freeze([
  'linkedin_easy', 'linkedin_page', 'indeed_easy', 'indeed_page', 'external_manual', 'ats_manual', 'ats_inferred', 'ats_exact', 'listing_page', 'easy_other',
]);
export const RESUME_STATUSES = Object.freeze(['none', 'queued', 'running', 'ready', 'failed', 'gave_up', 'skipped_no_description']);
/** Listed buckets that never get a manual-only lock on display (A9). */
export const NO_LOCK_BUCKETS = Object.freeze(['held_markup_drift']);

/** @param {string} b */
export function isListedBucket(b) {
  return b === 'ready_to_apply' || HELD_BUCKETS.includes(b);
}

/** Defaults for config/auto-apply.json's readyToApply block (mirrors src/core/config.js's schema). */
export const READY_DEFAULTS = Object.freeze({
  enabled: true,
  fitFloor: /** @type {number|null} */ (null),
  includeEasyApply: true,
  noControlRepeatToList: 2,
  noControlHoldMaxDays: 3,
  staleDays: 21,
  autoStallRuns: 2,
  staleNeedsHumanHours: 24,
  driftThreshold: 0.4,
  driftMinRows: 5,
  reportMaxRows: 40,
  heldReportMaxRows: 20,
});

/**
 * @param {any} config a LoadedConfig, an autoApply object, or {}
 */
export function readyConfig(config) {
  const block = config?.autoApply?.readyToApply ?? config?.readyToApply ?? {};
  const fitFloor = typeof block.fitFloor === 'number' ? block.fitFloor : (config?.autoApply?.fitFloor ?? 60);
  return { ...READY_DEFAULTS, ...block, fitFloor };
}

/** @param {unknown} v @returns {Date|null} */
function asDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(/** @type {any} */ (v));
  return Number.isFinite(d.getTime()) ? d : null;
}

/** @param {unknown} v @returns {string|null} */
function asStr(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Morning runs between two instants: the number of local (timezone) day boundaries crossed (A6). The
 * auto-apply run fires early every morning, so a row first put on the auto path on day D has had one run
 * by day D+1 and two by day D+2.
 * @param {unknown} since
 * @param {Date} now
 * @param {string} timezone
 */
export function morningRunsBetween(since, now, timezone) {
  const s = asDate(since);
  if (!s || s.getTime() >= now.getTime()) return 0;
  const dayStart = (/** @type {Date} */ d) => startOfDayInTz(d, timezone).getTime();
  return Math.max(0, Math.round((dayStart(now) - dayStart(s)) / 86400000));
}

/** @param {unknown} loc */
function locationUnknown(loc) {
  const l = typeof loc === 'string' ? loc.trim().toLowerCase() : '';
  return !l || l === ABSENT_LOCATION || l === LEGACY_UNKNOWN_LOCATION || l.startsWith('unknown:') || l === 'remote';
}

/**
 * @typedef {Object} ReadyMapping
 * @property {string} bucket
 * @property {string} reason
 * @property {string|null} channel
 * @property {string|null} link
 * @property {string[]} flags
 * @property {number|null} applicationId set for held_stale_application (the pointer)
 */

/**
 * Pure, total map of one row's select reason (spec 3.1, rule U 3.2, A6, R7, R8).
 * @param {any} row a ReadyRow (CandidateRow plus the ready columns)
 * @param {string} selectReason
 * @param {any} ctx readyConfig(...) plus { now: Date, timezone: string, lifetimeProbeAttempts?: number }
 * @returns {ReadyMapping}
 */
export function mapSelectReason(row, selectReason, ctx) {
  try {
    return mapUnsafe(row ?? {}, String(selectReason ?? ''), ctx);
  } catch (err) {
    return { bucket: 'held_unknown', reason: `map_error:${errFields(err).err_code}`, channel: null, link: null, flags: [], applicationId: null };
  }
}

/** @param {any} row @param {string} reason @param {any} ctx @returns {ReadyMapping} */
function mapUnsafe(row, reason, ctx) {
  const listingLink = asStr(row.listingUrl) ?? asStr(row.sourceUrl);
  /** @param {string} bucket @param {Partial<ReadyMapping>} [o] @returns {ReadyMapping} */
  const out = (bucket, o = {}) => ({ bucket, reason: o.reason ?? reason, channel: o.channel ?? null, link: o.link === undefined ? listingLink : o.link, flags: o.flags ?? [], applicationId: o.applicationId ?? null });
  /** The auto path, unless a manual-only lock (R8) or a stall (A6) says otherwise. @param {string} channel @param {string|null} link */
  const autoPath = (channel, link) => {
    if (row.locked) return out('ready_to_apply', { channel, link, flags: ['manual_only'] });
    if (morningRunsBetween(row.autoPathSince, ctx.now, ctx.timezone) >= (ctx.autoStallRuns ?? 2)) return out('held_auto_stalled', { channel, link });
    return out('auto_submit_path', { channel, link });
  };

  switch (reason) {
    case 'exclusion_blocked_company': return out('excluded_blocked_company', { link: null });
    case 'exclusion_already_applied_listing':
    case 'exclusion_already_applied_history': return out('excluded_already_applied', { link: null });
    case 'exclusion_previously_withdrawn': return out('excluded_withdrawn', { link: null });
    case 'exclusion_applied_company_other_role': return out('held_applied_company_other_role');
    case 'exclusion_blocked_company_suspect': return out('held_blocked_company_suspect');
    case 'exclusion_unknown_company': return out('held_unknown_company');
    case 'duplicate_of': return out('excluded_duplicate', { link: null });
    case 'not_scored':
    case 'below_fit':
    case 'human_fit_override': return out('excluded_below_fit', { link: null });
    case 'fit_unverified': return out('held_fit_unverified', { flags: ['fit_unverified'] });
    case 'not_us': return locationUnknown(row.locationNorm) ? out('held_location_unknown') : out('excluded_not_us', { link: null });
    case 'salary_below_floor': return out('excluded_salary_below_floor', { link: null });
    case 'active_application': {
      const updated = asDate(row.appUpdatedAt);
      const staleMs = (ctx.staleNeedsHumanHours ?? 24) * 3600000;
      if (row.appState === 'needs_human' && updated && ctx.now.getTime() - updated.getTime() >= staleMs) {
        return out('held_stale_application', { applicationId: row.appId === null || row.appId === undefined ? null : Number(row.appId) });
      }
      return out('excluded_active_application', { link: null });
    }
    case 'no_description': return out('held_no_description');
    case 'hourly_pay': return out('excluded_hourly_pay', { link: null });
    case 'easy_apply_only': return out('ready_to_apply', { channel: row.source === 'indeed' ? 'indeed_easy' : 'easy_other' });
    case 'easy_apply_assisted':
      if (ctx.includeEasyApply !== false) return out('ready_to_apply', { channel: 'linkedin_easy', flags: row.locked ? ['manual_only'] : [] });
      return autoPath('linkedin_easy', listingLink);
    case 'apply_target_unresolved': return ruleU(row, ctx, out, listingLink);
    case 'ats_not_allowed': return out('ready_to_apply', { channel: 'ats_manual', link: asStr(row.applyUrl) ?? listingLink });
    case 'confidence_not_exact': return out('ready_to_apply', { channel: 'ats_inferred', link: asStr(row.applyUrl) ?? listingLink, flags: ['unverified_target'] });
    case 'eligible': return autoPath('ats_exact', asStr(row.applyUrl) ?? listingLink);
    default: return out('held_unknown', { reason: reason || 'empty_reason' });
  }
}

/**
 * Rule U (spec 3.2): apply_target_unresolved.
 * @param {any} row @param {any} ctx @param {(b: string, o?: any) => ReadyMapping} out @param {string|null} listingLink
 */
function ruleU(row, ctx, out, listingLink) {
  if (isHourlyPaySignal(row.salaryPeriod ?? null, row.salaryRaw ?? null)) return out('excluded_hourly_pay', { link: null });
  const manual = asStr(row.manualApplyUrl);
  if (manual) return out('ready_to_apply', { channel: 'external_manual', link: manual });
  const source = typeof row.source === 'string' ? row.source : '';
  if (source === 'linkedin') {
    if (!asDate(row.applyProbedAt)) return out('held_not_probed', { reason: 'apply_target_unresolved:not_probed' });
    const branch = row.applyPageBranch;
    if (branch === 'no_control' || branch === 'unknown') {
      const first = asDate(row.applyPageFirstSeenAt);
      const holdMs = (ctx.noControlHoldMaxDays ?? 3) * 86400000;
      const young = !first || ctx.now.getTime() - first.getTime() < holdMs;
      const attempts = Number(row.probeAttempts ?? 0);
      if (Number(row.applyPageRepeat ?? 0) < (ctx.noControlRepeatToList ?? 2) && attempts < (ctx.lifetimeProbeAttempts ?? LIFETIME_PROBE_ATTEMPTS) && young) {
        return out('held_awaiting_reprobe', { reason: `apply_target_unresolved:${branch}` });
      }
      return out('ready_to_apply', { channel: 'linkedin_page', flags: ['no_apply_control_seen'] });
    }
    if (branch === 'external') return out('ready_to_apply', { channel: 'linkedin_page', flags: ['external_target_unknown'] });
    return out('ready_to_apply', { channel: 'linkedin_page', flags: ['probe_state_unknown'] });
  }
  if (source === 'indeed') return listingLink ? out('ready_to_apply', { channel: 'indeed_page' }) : out('held_no_link', { link: null });
  const link = source === 'gmail' ? (asStr(row.gmailFinalUrl) ?? listingLink) : listingLink;
  if (link) return out('ready_to_apply', { channel: 'listing_page', link });
  return out('held_no_link', { link: null });
}

/**
 * A3: a blocked employer named in the host of the manual link or the Gmail final URL.
 * @param {any} row
 * @param {{ blockedCompanies: string[] }} exclusionConfig
 * @returns {string|null} the matching blocked entry
 */
export function blockedHostEntry(row, exclusionConfig) {
  for (const u of [row.manualApplyUrl, row.gmailFinalUrl]) {
    if (typeof u !== 'string' || !u) continue;
    /** @type {string|null} */
    let host = null;
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      host = null;
    }
    if (!host) continue;
    for (const entry of exclusionConfig.blockedCompanies ?? []) {
      if (containsWholePhrase(host, companyTokens(entry))) return entry;
    }
  }
  return null;
}

/**
 * @typedef {Object} ClassifiedReadyRow
 * @property {number} listingId
 * @property {string} bucket
 * @property {string} reason
 * @property {string|null} channel
 * @property {string|null} link
 * @property {string|null} host
 * @property {string[]} flags
 * @property {string[]} alsoOn
 * @property {number|null} applicationId
 * @property {boolean} resumeEligible
 * @property {any} row the input row
 */

/**
 * The classification core over already-fetched rows (classifyReadyList's DB-free half; tests drive it).
 * @param {any[]} rows ReadyRows
 * @param {{ classify: (row: any) => Promise<string>, ctx: any, exclusionConfig: { blockedCompanies: string[] }, locks: any[] }} deps
 */
export async function classifyRows(rows, deps) {
  const { ctx } = deps;
  /** @type {ClassifiedReadyRow[]} */
  const out = [];
  for (const row of rows) {
    /** @type {ReadyMapping} */
    let m;
    try {
      const subject = lockSubjectFromRow({
        id: row.listingId, duplicate_of: row.duplicateOf, company: row.company, company_norm: row.companyNorm, title_norm: row.titleNorm,
        location_norm: row.locationNorm, urls: [row.listingUrl, row.sourceUrl, row.applyUrl, row.manualApplyUrl, row.gmailFinalUrl],
      });
      row.locked = Boolean(row.lockedOverride) || deps.locks.some((l) => lockMatches(l, subject));
      const reason = await deps.classify(row);
      const blocked = reason === 'exclusion_blocked_company' ? null : blockedHostEntry(row, deps.exclusionConfig);
      m = blocked
        ? { bucket: 'excluded_blocked_company', reason: `blocked_host:${blocked}`, channel: null, link: null, flags: [], applicationId: null }
        : mapSelectReason(row, reason, ctx);
    } catch (err) {
      m = { bucket: 'held_unknown', reason: `classify_error:${errFields(err).err_code}`, channel: null, link: null, flags: [], applicationId: null };
    }
    if (!READY_BUCKETS.includes(m.bucket)) m = { ...m, bucket: 'held_unknown', reason: `unmapped_bucket:${m.bucket}` };

    // A9 age-out.
    const firstSeen = asDate(row.firstSeen);
    if (isListedBucket(m.bucket) && firstSeen && ctx.now.getTime() - firstSeen.getTime() > (ctx.staleDays ?? 21) * 86400000) {
      m = { ...m, bucket: 'excluded_stale', reason: `first_seen_over_${ctx.staleDays ?? 21}_days`, link: null };
    }
    // A8 link check.
    /** @type {string|null} */
    let host = null;
    if (isListedBucket(m.bucket) || m.bucket === 'auto_submit_path') {
      const lc = readyLinkCheck(m.link);
      if (lc.ok) {
        host = lc.host;
        m = { ...m, link: lc.url };
      } else if (m.bucket === 'ready_to_apply') {
        const unsafe = UNSAFE_LINK_REASONS.includes(lc.reason);
        m = { ...m, bucket: unsafe ? 'held_unsafe_link' : 'held_no_link', reason: `link_${lc.reason}`, link: null };
      } else {
        m = { ...m, link: null };
      }
    }
    const desc = typeof row.description === 'string' ? row.description : '';
    out.push({
      listingId: Number(row.listingId), bucket: m.bucket, reason: m.reason, channel: m.channel, link: m.link, host, flags: m.flags, alsoOn: [],
      applicationId: m.applicationId, resumeEligible: desc.length >= DETAIL_MIN_CHARS, row,
    });
  }

  // A9 drift breaker over this pass.
  const probed = out.filter((r) => r.row.source === 'linkedin' && typeof r.row.applyPageBranch === 'string' && r.row.applyPageBranch);
  const driftRows = probed.filter((r) => r.row.applyPageBranch === 'no_control' || r.row.applyPageReason === 'top_card_no_anchor');
  const tripped = probed.length >= (ctx.driftMinRows ?? 5) && driftRows.length / probed.length > (ctx.driftThreshold ?? 0.4);
  if (tripped) {
    for (const r of driftRows) {
      if (isListedBucket(r.bucket)) {
        r.bucket = 'held_markup_drift';
        r.reason = `markup_drift:${r.row.applyPageBranch}:${r.row.applyPageReason ?? ''}`;
      }
    }
  }

  // R2 / A7 dedup among ready rows, best fit first.
  const ready = out.filter((r) => r.bucket === 'ready_to_apply').sort(readyOrder);
  /** @type {ClassifiedReadyRow[]} */
  const kept = [];
  for (const r of ready) {
    const dupOf = kept.find((k) => sameJob(k, r));
    if (dupOf) {
      r.bucket = 'excluded_duplicate';
      r.reason = `ready_duplicate_of:${dupOf.listingId}`;
      const src = typeof r.row.source === 'string' ? r.row.source : 'unknown';
      if (!dupOf.alsoOn.includes(src) && src !== dupOf.row.source) dupOf.alsoOn.push(src);
    } else {
      kept.push(r);
    }
  }

  /** @type {Record<string, number>} */
  const counts = {};
  for (const r of out) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  /** @type {Record<string, number>} */
  const excludedCounts = {};
  for (const r of out) if (r.bucket.startsWith('excluded_')) excludedCounts[r.bucket.slice('excluded_'.length)] = (excludedCounts[r.bucket.slice('excluded_'.length)] ?? 0) + 1;
  return {
    rows: out,
    ready: out.filter((r) => r.bucket === 'ready_to_apply').sort(readyOrder),
    held: out.filter((r) => HELD_BUCKETS.includes(r.bucket)).sort((a, b) => fitOf(b) - fitOf(a) || a.listingId - b.listingId),
    counts,
    excludedCounts,
    autoSubmitCount: counts.auto_submit_path ?? 0,
    total: out.length,
    drift: { tripped, driftRows: driftRows.length, probedRows: probed.length },
  };
}

/** @param {ClassifiedReadyRow} r */
function fitOf(r) {
  return typeof r.row.fitScore === 'number' ? r.row.fitScore : -1;
}

/** @param {ClassifiedReadyRow} a @param {ClassifiedReadyRow} b */
function readyOrder(a, b) {
  const fa = asDate(a.row.firstListedAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const fb = asDate(b.row.firstListedAt)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return fitOf(b) - fitOf(a) || fa - fb || a.listingId - b.listingId;
}

/** A7: same title required; placeholders never collapse. @param {ClassifiedReadyRow} a @param {ClassifiedReadyRow} b */
function sameJob(a, b) {
  const ra = a.row;
  const rb = b.row;
  if (!ra.titleNorm || ra.titleNorm !== rb.titleNorm) return false;
  if (isPlaceholderCompany(ra.company, ra.companyNorm) || isPlaceholderCompany(rb.company, rb.companyNorm)) return false;
  const ka = normalizeTargetKey(a.link);
  const kb = normalizeTargetKey(b.link);
  if (ka && kb && ka === kb) return true;
  if (!ra.companyNorm || ra.companyNorm !== rb.companyNorm) return false;
  return Boolean(ra.locationNorm) && !locationUnknown(ra.locationNorm) && ra.locationNorm === rb.locationNorm;
}

/**
 * Fetch the universe (spec section 2) with every column the classifier, the ledger, and the renderers need.
 * duplicate_of rows ARE fetched, so they map to a visible excluded bucket instead of vanishing.
 * @param {import('pg').ClientBase} client
 * @param {number} fitFloor
 */
export async function fetchReadyRows(client, fitFloor) {
  const r = await client.query(`
    SELECT
      l.id AS listing_id, l.fit_score, l.fit_basis, l.duplicate_of, l.location_norm, l.remote_mode, l.salary_max, l.salary_period, l.salary_raw,
      l.description, l.apply_url, l.apply_ats, l.apply_ats_confidence, l.apply_easy_only, l.company, l.company_norm, l.title, l.title_norm,
      coalesce(l.url_normalized, l.url) AS source_url, l.source, l.first_seen, l.apply_probed_at, l.probe_attempts,
      l.manual_apply_url, l.apply_page_branch, l.apply_page_reason, l.apply_page_repeat, l.apply_page_first_seen_at,
      t.final_url AS gmail_final_url,
      (SELECT e.actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'fit' ORDER BY e.at DESC, e.id DESC LIMIT 1) AS fit_actor,
      a.id AS app_id, a.state AS app_state, a.updated_at AS app_updated_at,
      r.auto_path_since, r.first_listed_at, r.first_displayed_at, r.resume_status, r.resume_doc_id, r.resume_source, r.resume_attempts,
      r.resume_last_error, r.review_verdict, d.rel_path AS resume_rel_path,
      EXISTS (SELECT 1 FROM ic_manual_only_locks k WHERE k.listing_id = l.id AND k.released_at IS NOT NULL) AS handed_back
    FROM ic_job_listings l
    LEFT JOIN ic_gmail_targets t ON t.listing_id = l.id
    LEFT JOIN LATERAL (SELECT x.id, x.state, x.updated_at FROM ic_job_applications x WHERE x.listing_id = l.id AND x.state <> 'withdrawn' ORDER BY x.id DESC LIMIT 1) a ON true
    LEFT JOIN ic_ready_to_apply r ON r.listing_id = l.id
    LEFT JOIN ic_job_documents d ON d.id = r.resume_doc_id
    WHERE coalesce(l.record_kind, 'listing') = 'listing'
      AND l.expired_at IS NULL
      AND (l.status IS NULL OR l.status IN ('new', 'maybe', 'shortlisted'))
      AND l.fit_score >= $1
    ORDER BY l.fit_score DESC, l.id ASC
  `, [fitFloor]);
  return r.rows.map((x) => ({
    listingId: Number(x.listing_id),
    fitScore: x.fit_score === null ? null : Number(x.fit_score),
    fitActor: x.fit_actor ?? null,
    fitBasis: x.fit_basis ?? null,
    duplicateOf: x.duplicate_of === null ? null : Number(x.duplicate_of),
    locationNorm: x.location_norm ?? null,
    remoteMode: x.remote_mode ?? null,
    salaryMax: x.salary_max === null ? null : Number(x.salary_max),
    salaryPeriod: x.salary_period ?? null,
    salaryRaw: x.salary_raw ?? null,
    hasActiveApplication: x.app_id !== null && x.app_id !== undefined,
    description: x.description ?? null,
    applyUrl: x.apply_url ?? null,
    applyAts: x.apply_ats ?? null,
    applyConfidence: x.apply_ats_confidence ?? null,
    applyEasyOnly: Boolean(x.apply_easy_only),
    company: x.company ?? null,
    companyNorm: x.company_norm ?? null,
    title: x.title ?? null,
    titleNorm: x.title_norm ?? null,
    sourceUrl: x.source_url ?? null,
    listingUrl: x.source_url ?? null,
    source: x.source ?? null,
    firstSeen: x.first_seen ?? null,
    applyProbedAt: x.apply_probed_at ?? null,
    probeAttempts: Number(x.probe_attempts ?? 0),
    manualApplyUrl: x.manual_apply_url ?? null,
    applyPageBranch: x.apply_page_branch ?? null,
    applyPageReason: x.apply_page_reason ?? null,
    applyPageRepeat: Number(x.apply_page_repeat ?? 0),
    applyPageFirstSeenAt: x.apply_page_first_seen_at ?? null,
    gmailFinalUrl: x.gmail_final_url ?? null,
    appId: x.app_id === null || x.app_id === undefined ? null : Number(x.app_id),
    appState: x.app_state ?? null,
    appUpdatedAt: x.app_updated_at ?? null,
    autoPathSince: x.auto_path_since ?? null,
    firstListedAt: x.first_listed_at ?? null,
    firstDisplayedAt: x.first_displayed_at ?? null,
    handedBack: Boolean(x.handed_back),
    resume: {
      status: x.resume_status ?? 'none',
      docId: x.resume_doc_id === null || x.resume_doc_id === undefined ? null : Number(x.resume_doc_id),
      source: x.resume_source ?? null,
      attempts: Number(x.resume_attempts ?? 0),
      lastError: x.resume_last_error ?? null,
      reviewVerdict: x.review_verdict ?? null,
      relPath: x.resume_rel_path ?? null,
    },
  }));
}

/**
 * Fetch, classify and map the whole universe. Exclusion config is loaded once (unless injected).
 * @param {import('pg').ClientBase} client
 * @param {{ config?: any, now?: Date, exclusionConfig?: any, timezone?: string, classify?: (client: any, row: any, ctx: any) => Promise<string>, locks?: any[] }} [opts]
 */
export async function classifyReadyList(client, opts = {}) {
  const config = opts.config ?? loadConfig();
  const rc = readyConfig(config);
  const now = opts.now ?? new Date();
  const timezone = opts.timezone ?? config?.adapters?.run?.timezone ?? 'America/Chicago';
  const exclusionConfig = opts.exclusionConfig ?? loadExclusionConfig(config.configDir);
  const aa = config.autoApply ?? {};
  const selectCtx = { fitFloor: aa.fitFloor ?? 60, floors: aa.floors, atsAllow: aa.atsAllow ?? [], exclusionConfig };
  const classify = opts.classify ?? classifyCandidateWithExclusions;
  const rows = await fetchReadyRows(client, rc.fitFloor);
  const locks = opts.locks ?? await loadActiveManualLocks(client);
  const ctx = { ...rc, now, timezone, lifetimeProbeAttempts: LIFETIME_PROBE_ATTEMPTS };
  const res = await classifyRows(rows, { classify: (row) => classify(client, row, selectCtx), ctx, exclusionConfig, locks });
  return { ...res, generatedAt: now.toISOString(), config: rc };
}

/** Buckets the ledger tracks (listed rows plus the auto path, for A6's stall clock). */
function tracked(/** @type {string} */ b) {
  return isListedBucket(b) || b === 'auto_submit_path';
}

/**
 * Upsert the ledger from a classification, in one transaction (spec 5). `display` (A1): the caller is
 * showing the list to Damian right now (report send, dashboard view): first_displayed_at is stamped and the
 * manual-only lock is written for every listed row that never had one (except NO_LOCK_BUCKETS).
 * @param {import('pg').ClientBase} client
 * @param {Awaited<ReturnType<typeof classifyRows>>} result
 * @param {Date} now
 * @param {{ display?: boolean }} [opts]
 * @returns {Promise<{ upserted: number, left: number, locksWritten: number }>}
 */
export async function refreshReadyLedger(client, result, now, opts = {}) {
  const display = Boolean(opts.display);
  return withTransaction(client, async (c) => {
    let upserted = 0;
    const ids = [];
    for (const r of result.rows) {
      if (!tracked(r.bucket)) continue;
      ids.push(r.listingId);
      const listed = isListedBucket(r.bucket);
      const autoish = r.bucket === 'auto_submit_path' || r.bucket === 'held_auto_stalled';
      const skippedNoDesc = r.bucket === 'ready_to_apply' && !r.resumeEligible;
      await c.query(
        `INSERT INTO ic_ready_to_apply (listing_id, bucket, reason, channel, first_listed_at, first_displayed_at, auto_path_since, last_classified_at, left_at, resume_status, updated_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $2 = 'ready_to_apply' THEN $5::timestamptz END, CASE WHEN $6 THEN $5::timestamptz END,
                 CASE WHEN $7 THEN $5::timestamptz END, $5, NULL, CASE WHEN $8 THEN 'skipped_no_description' ELSE 'none' END, $5)
         ON CONFLICT (listing_id) DO UPDATE SET
           bucket = EXCLUDED.bucket, reason = EXCLUDED.reason, channel = EXCLUDED.channel,
           first_listed_at = coalesce(ic_ready_to_apply.first_listed_at, EXCLUDED.first_listed_at),
           first_displayed_at = coalesce(ic_ready_to_apply.first_displayed_at, EXCLUDED.first_displayed_at),
           auto_path_since = CASE WHEN $7 THEN coalesce(ic_ready_to_apply.auto_path_since, $5::timestamptz) ELSE NULL END,
           last_classified_at = $5, left_at = NULL,
           resume_status = CASE
             WHEN $8 AND ic_ready_to_apply.resume_status IN ('none', 'queued') THEN 'skipped_no_description'
             WHEN NOT $8 AND ic_ready_to_apply.resume_status = 'skipped_no_description' THEN 'none'
             ELSE ic_ready_to_apply.resume_status END,
           updated_at = $5`,
        [r.listingId, r.bucket, String(r.reason).slice(0, 200), r.channel, now, display && listed, autoish, skippedNoDesc],
      );
      upserted++;
    }
    const left = await c.query(
      `UPDATE ic_ready_to_apply SET left_at = $2, updated_at = $2 WHERE left_at IS NULL AND NOT (listing_id = ANY($1::int[]))`,
      [ids, now],
    );
    let locksWritten = 0;
    if (display) {
      const entries = result.rows
        .filter((r) => isListedBucket(r.bucket) && !NO_LOCK_BUCKETS.includes(r.bucket))
        .map((r) => ({
          bucket: r.bucket,
          subject: lockSubjectFromRow({
            id: r.listingId, duplicate_of: r.row.duplicateOf, company: r.row.company, company_norm: r.row.companyNorm, title_norm: r.row.titleNorm,
            location_norm: r.row.locationNorm, urls: [r.row.listingUrl, r.row.applyUrl, r.row.manualApplyUrl, r.row.gmailFinalUrl, r.link],
          }),
        }));
      locksWritten = await writeManualLocks(c, entries, now);
    }
    return { upserted, left: left.rowCount ?? 0, locksWritten };
  });
}

/** CLOSED_REASONS re-exported for the totality test's convenience. */
export { CLOSED_REASONS };
