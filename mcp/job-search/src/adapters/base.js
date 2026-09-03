// @ts-check
/**
 * Adapter contract (spec section 4).
 *
 *   { name, needsBrowser, domains[], pathPatterns[], async *search(profile, ctx), fetchDetail?(listing, ctx) }
 *
 * `search` is an async generator of AdapterEvents. It yields a `page` event
 * before the listings parsed from that page, then one `listing` event per
 * RawListing, and optionally `warning` events. The scheduler answers each
 * yield with a Directive; `{ stopQuery: true }` tells the adapter to stop
 * paginating the current query (maxPages reached, or three consecutive
 * results older than the window) and move on to the next one.
 *
 * Adapters never see a page, context, or browser. Browser-backed adapters
 * receive the frozen capability object as `ctx.cap`; fetch adapters use
 * `ctx.fetchText` / `ctx.fetchJson`, which route through the URL guard and
 * the rate limiter. Pagination is URL construction only.
 *
 * Every adapter also reports what it cannot see (`blindSpots`), so the
 * scan summary can state them.
 */
import { JobSearchError } from '../core/errors.js';

/** Keyword validation (spec section 4): letters, digits, space . , + ' / & - only, 1-80 chars. */
export const KEYWORD_RE = /^[\p{L}\p{N} .,+'/&-]{1,80}$/u;

/**
 * @typedef {import('../core/normalize.js').RawListing} RawListing
 */

/**
 * @typedef {Object} SearchProfile
 * @property {string} name
 * @property {string[]} keywords
 * @property {string[]} phrases
 * @property {string[]} exclude_terms
 * @property {string[]} locations
 * @property {string} remote any|remote|hybrid|onsite
 * @property {number} posted_within_days
 * @property {number} max_pages
 * @property {string[]} sources
 */

/**
 * @typedef {Object} FetchResult
 * @property {number} status
 * @property {string} url final URL after redirects
 * @property {string} text
 * @property {string|null} contentType
 */

/**
 * @typedef {Object} AdapterCtx
 * @property {AbortSignal} signal
 * @property {Date} now
 * @property {Date|null} windowStart listings posted before this are outside the window
 * @property {number} maxPages per-query page cap already clamped to the adapter's maxPagesPerQuery
 * @property {(url: string, opts?: { method?: 'GET'|'POST', headers?: Record<string, string>, body?: string, source?: string }) => Promise<FetchResult>} fetchText guarded, rate-limited fetch; `source` overrides the registry scope (exec boards)
 * @property {(url: string, opts?: { method?: 'GET'|'POST', headers?: Record<string, string>, body?: string, source?: string }) => Promise<{ status: number, url: string, json: unknown }>} fetchJson same, parsed as JSON (json is null when unparseable)
 * @property {() => Promise<void>} reservePage throws BUDGET_EXHAUSTED when the daily page cap is hit
 * @property {() => Promise<void>} reserveDetail throws BUDGET_EXHAUSTED when the daily detail cap is hit
 * @property {(source: string) => Promise<import('../browser/capability.js').Capability|null>} capFor frozen capability scoped to a registry source; null when the scan Chrome is unreachable (connects lazily on first call)
 * @property {import('../core/config.js').LoadedConfig} config
 * @property {{ GOOGLE_TOKEN_FILE?: string }} [env] scalar env values an adapter may need directly (gmail: the workspace-mcp OAuth token file path)
 * @property {(fields: Record<string, string|number|boolean|null>) => void} log enumerated scalars only
 */

/**
 * @typedef {{ kind: 'batch', query: string, pageIndex: number, parsed: number, status?: number|null, url?: string|null }} PageEvent
 * @typedef {{ kind: 'listing', query: string, pageIndex: number, listing: RawListing }} ListingEvent
 * @typedef {{ kind: 'warning', code: string, message: string, query?: string }} WarningEvent
 * @typedef {{ kind: 'wall', query: string, pageIndex: number, signals: import('../browser/wall.js').PageSignals }} WallEvent
 * @typedef {PageEvent|ListingEvent|WarningEvent|WallEvent} AdapterEvent
 * @typedef {{ stopQuery?: boolean }|undefined} Directive
 */

/**
 * @typedef {Object} Adapter
 * @property {string} name
 * @property {boolean} needsBrowser
 * @property {boolean} dateOrdered results arrive newest first; only then may the scheduler stop a query on stale results
 * @property {boolean} [ignoresQuery] true when the adapter runs one query regardless of profile keywords/phrases/locations (gmail: the Gmail search `q` is sender-based, not term-based); budget.planPages special-cases sources in this set instead of matching on a literal adapter name
 * @property {string[]} domains
 * @property {string[]} pathPatterns
 * @property {string[]} blindSpots
 * @property {(profile: SearchProfile, ctx: AdapterCtx) => AsyncGenerator<AdapterEvent, void, Directive>} search
 * @property {((listing: { url: string|null, url_normalized?: string|null, external_id?: string|null, source?: string|null }, ctx: AdapterCtx) => Promise<FetchDetailResult>)} [fetchDetail]
 */

/**
 * fetchDetail's return shape, widened for auto-apply PR B (docs/auto-apply-spec.md) without breaking any
 * existing caller: every new field is OPTIONAL, so a legacy adapter returning only `{ description }`
 * remains a perfectly valid FetchDetailResult -- scan-run.js's own apply-target persistence step treats a
 * missing field as "this adapter has nothing to say about the apply target", never as an error.
 * @typedef {Object} FetchDetailResult
 * @property {string|null} description
 * @property {string|null} [externalApplyUrl] a candidate apply-page URL discovered on the listing page
 *   (an anchor href, a decoded LinkedIn safety/go wrapper, or the listing's own URL when the ATS's apply
 *   page IS the listing page). Never itself redirect-chased or classified by the adapter -- that is
 *   src/apply/apply-target.js's job, run later by scan-run.js/bin/auto-apply.js.
 * @property {boolean} [easyApplyOnly] true when the listing's own apply flow is an in-page "Easy Apply"
 *   with no external URL to resolve at all (no browser click was performed to determine this; adapters
 *   set it only when the classify-only nature of the ATS itself already implies it, e.g. LinkedIn/Indeed
 *   Easy Apply postings).
 * @property {{ applicantTrackingSystemName?: string|null, companyName?: string|null }|null} [applyProbe]
 *   a same-tab query-param hint captured incidentally (never from a browser click performed by
 *   fetchDetail itself, which never clicks anything) -- diagnostic only, never treated as a resolved
 *   apply target on its own.
 */

/**
 * Validate and freeze an adapter definition.
 * @param {Adapter} def
 * @returns {Adapter}
 */
export function defineAdapter(def) {
  if (!/^[a-z][a-z0-9-]*$/.test(def.name)) throw new Error(`adapter name invalid: ${def.name}`);
  if (typeof def.search !== 'function') throw new Error(`adapter ${def.name} has no search`);
  return Object.freeze({ ...def, ignoresQuery: Boolean(def.ignoresQuery), domains: Object.freeze([...def.domains]), pathPatterns: Object.freeze([...def.pathPatterns]), blindSpots: Object.freeze([...(def.blindSpots ?? [])]) });
}

/**
 * Validate a keyword/phrase/location term with a visible rejection.
 * @param {unknown} term
 * @param {string} field
 * @returns {string}
 */
export function validateTerm(term, field) {
  const t = String(term ?? '').trim();
  if (!KEYWORD_RE.test(t)) {
    throw new JobSearchError('VALIDATION', `${field} rejected: only letters, digits, space . , + ' / & - (1-80 chars): ${t.slice(0, 40)}`);
  }
  return t;
}

/**
 * Search terms for a profile: keywords + phrases, validated, de-duplicated.
 * @param {SearchProfile} profile
 */
export function searchTerms(profile) {
  /** @type {string[]} */
  const out = [];
  for (const t of [...(profile.keywords ?? []), ...(profile.phrases ?? [])]) {
    const v = validateTerm(t, 'keyword');
    if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

/**
 * Locations for a profile (validated); [''] when none so browser adapters
 * still run one query.
 * @param {SearchProfile} profile
 */
export function searchLocations(profile) {
  const locs = (profile.locations ?? []).map((l) => validateTerm(l, 'location'));
  return locs.length > 0 ? locs : [''];
}

/**
 * Client-side title filter for list-everything sources (Greenhouse, Lever,
 * exec boards): a title matches when it contains any keyword or phrase
 * (case-insensitive, whole-token for short acronyms) and no exclude term.
 * @param {string} title
 * @param {SearchProfile} profile
 */
export function titleMatches(title, profile) {
  const t = String(title ?? '').toLowerCase();
  if (!t) return false;
  for (const ex of profile.exclude_terms ?? []) {
    if (ex && t.includes(String(ex).toLowerCase())) return false;
  }
  const terms = [...(profile.keywords ?? []), ...(profile.phrases ?? [])].map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  if (terms.length === 0) return true;
  for (const term of terms) {
    if (term.length <= 4 && /^[a-z0-9]+$/.test(term)) {
      if (new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(t)) return true;
    } else if (t.includes(term)) return true;
  }
  return false;
}

/**
 * Is a posted date inside the window? Unknown dates count as inside (they
 * cannot be proven stale).
 * @param {string|null|undefined} postedAt ISO date
 * @param {Date|null} windowStart
 */
export function withinWindow(postedAt, windowStart) {
  if (!windowStart || !postedAt) return true;
  const t = Date.parse(postedAt);
  if (!Number.isFinite(t)) return true;
  return t >= windowStart.getTime() - 86400000;
}

/**
 * ISO date (YYYY-MM-DD) from a variety of inputs; null when unusable.
 * @param {unknown} v ms number, ISO string, or Date
 */
export function isoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Relative "Posted N Days Ago" style text to an ISO date.
 * @param {string|null|undefined} text
 * @param {Date} now
 */
export function relativeDate(text, now) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  if (/\btoday\b|just posted|\bnow\b/.test(s)) return isoDate(now);
  if (/\byesterday\b/.test(s)) return isoDate(new Date(now.getTime() - 86400000));
  const m = /(\d+)\+?\s*(day|hour|minute|week|month)s?\s*ago/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === 'minute' ? 60000 : unit === 'hour' ? 3600000 : unit === 'day' ? 86400000 : unit === 'week' ? 7 * 86400000 : 30 * 86400000;
  return isoDate(new Date(now.getTime() - n * ms));
}

/**
 * Decode the handful of HTML entities that appear in API payloads (Greenhouse
 * returns HTML-escaped HTML). Numeric entities included.
 * @param {string} s
 */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Remote mode from free text (title, location, workplace type).
 * @param {string} text
 * @returns {{ remoteMode: 'remote'|'hybrid'|'onsite'|null, remoteDeclared: boolean }}
 */
export function remoteFromText(text) {
  const s = String(text ?? '').toLowerCase();
  if (/\bhybrid\b/.test(s)) return { remoteMode: 'hybrid', remoteDeclared: true };
  if (/\bremote\b/.test(s)) return { remoteMode: 'remote', remoteDeclared: true };
  if (/\bon[- ]?site\b/.test(s)) return { remoteMode: 'onsite', remoteDeclared: true };
  return { remoteMode: null, remoteDeclared: false };
}

/**
 * Build a RawListing with every field present (null when unknown) so the
 * shape is uniform across adapters.
 * @param {Partial<RawListing> & { source: string, url: string|null, title: string, company: string }} p
 * @returns {RawListing}
 */
export function rawListing(p) {
  return {
    source: p.source,
    externalId: p.externalId ?? null,
    url: p.url,
    title: String(p.title ?? '').trim(),
    company: String(p.company ?? '').trim(),
    location: p.location ?? null,
    remoteMode: p.remoteMode ?? null,
    remoteDeclared: Boolean(p.remoteDeclared),
    postedAt: p.postedAt ?? null,
    salaryRaw: p.salaryRaw ?? null,
    salaryMin: p.salaryMin ?? null,
    salaryMax: p.salaryMax ?? null,
    description: p.description ?? null,
    confidentialFirm: p.confidentialFirm ?? null,
  };
}
