// @ts-check
/**
 * Normalizers (spec section 3.1). Single implementation shared by
 * bin/migrate.js, adoption (upsert.js), and the scan pipeline.
 *
 * Every function here is total: any input (including null, undefined, and
 * garbage strings) maps to a well-defined output, never a throw.
 *
 * Stored forms:
 *   url_normalized  full https URL for canonical sources
 *                   (e.g. https://www.linkedin.com/jobs/view/4378403522);
 *                   lowercased scheme/host/path + sorted query for residuals;
 *                   NULL (never '') for invalid or redirect kinds.
 *   external_id     tenant-qualified: linkedin:<digits>, indeed:<jk>,
 *                   greenhouse:<board>/<id>, lever:<co>/<uuid>,
 *                   workday:<tenant>/<site>/<req>, dayforce:<host>/<client>/<id>,
 *                   dice:<uuid>, oracle:<host>/<id>.
 */
import crypto from 'node:crypto';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// Options (config-backed, with built-in fallbacks so the module is importable
// without a config directory, e.g. in unit tests)
// ---------------------------------------------------------------------------

/** Built-in tracking parameter list; config/adapters.json extends it. */
export const DEFAULT_TRACKING_PARAMS = Object.freeze([
  'utm_*', 'ref', 'refid', 'trk', 'trackingid', 'position', 'pagenum', 'src', 'from', 'vjs', 'tk',
  'fccid', 'xkcb', 'gh_src', 'lever-source', 'source', 'sid', 'advn', 'adid', 'ad', 'sjdu', 'vjk',
  'xpse', 'sc', 'hidesmb', 'alid', 'acatk', 'pub', 'mo',
]);

/** Built-in trailing UI-fragment list; config/adapters.json's titleTrailingFragments extends/replaces it. */
export const DEFAULT_TITLE_TRAILING_FRAGMENTS = Object.freeze(['with verification']);

/**
 * @typedef {Object} NormalizeOptions
 * @property {readonly string[]} [trackingParams] lowercase keys; `utm_*` style prefixes allowed
 * @property {ReadonlyArray<{ board: string, hosts?: string[] }>} [greenhouseBoards] host -> board lookup for embedded gh_jid
 * @property {Record<string, string>} [aliases] company alias map (keys are collapsed the same way as company names)
 * @property {readonly string[]} [titleTrailingFragments] source-UI fragments to strip from the END of a title (spec: LinkedIn's verified-badge text; total classification -- a trailing fragment not on this list is left in place, never guessed at)
 */

/** @type {NormalizeOptions | null} */
let defaultOpts = null;

/**
 * Lazily build default options from config/*.json. Falls back to built-ins
 * when config cannot be loaded, so normalization never fails on config.
 * @returns {NormalizeOptions}
 */
export function getDefaultNormalizeOptions() {
  if (defaultOpts) return defaultOpts;
  /** @type {NormalizeOptions} */
  let opts = { trackingParams: DEFAULT_TRACKING_PARAMS, greenhouseBoards: [], aliases: {}, titleTrailingFragments: DEFAULT_TITLE_TRAILING_FRAGMENTS };
  try {
    // Dynamic require-free import would be async; config.js is sync, so import it statically below.
    const cfg = _loadConfigSync();
    if (cfg) {
      opts = {
        trackingParams: cfg.adapters.trackingParams.map((p) => p.toLowerCase()),
        greenhouseBoards: cfg.atsBoards.greenhouse.map((b) => ({ board: b.board, hosts: b.hosts })),
        aliases: buildAliasMap(cfg.companyAliases),
        titleTrailingFragments: (cfg.adapters.titleTrailingFragments ?? DEFAULT_TITLE_TRAILING_FRAGMENTS).map((f) => String(f).toLowerCase()),
      };
    }
  } catch {
    /* built-ins */
  }
  defaultOpts = opts;
  return opts;
}

/** Test hook: reset the cached defaults. */
export function _resetDefaultNormalizeOptions() {
  defaultOpts = null;
}

// config.js is imported statically; it only touches the filesystem when loadConfig() runs.
import { loadConfig } from './config.js';
function _loadConfigSync() {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}

/**
 * Normalize alias keys with the same collapse used for company names.
 * @param {Record<string, string>} raw
 * @returns {Record<string, string>}
 */
export function buildAliasMap(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k.startsWith('_')) continue;
    const key = collapse(stripAccents(String(k).toLowerCase()));
    const val = collapse(stripAccents(String(v).toLowerCase()));
    if (key && val) out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {string} s */
export function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

/** @param {string} s */
function stripAccents(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** Collapse every non-alphanumeric run to one space and trim. @param {string} s */
function collapse(s) {
  return s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Title/company/location text cleaning (spec R3.1, decisions 9-11)
// ---------------------------------------------------------------------------

/**
 * Zero-width / invisible format characters observed in real source markup
 * (LinkedIn embeds U+200B etc. between repeated title segments) plus the
 * Unicode Cf (format) category generally, since \s does not match any of
 * these and they defeat a plain whitespace collapse. Explicit codepoints are
 * listed because U+034F (COMBINING GRAPHEME JOINER) is category Mn, not Cf,
 * and would otherwise slip through a Cf-only test. This is the canonical
 * definition; gmail-parsers.js re-exports it for its own zero-width strip
 * rather than keeping a second copy.
 */
export const ZERO_WIDTH_RE = /[\u200b\u200c\u200d\u00ad\u034f\ufeff]|\p{Cf}/gu;

/** @param {unknown} s */
export function stripZeroWidth(s) {
  return String(s ?? '').replace(ZERO_WIDTH_RE, '');
}

/**
 * Strip zero-width/format characters, then collapse every whitespace run
 * (including newlines and tabs) to a single space, and trim (spec R3.1).
 * @param {unknown} s
 */
export function collapseWhitespace(s) {
  return stripZeroWidth(s).replace(/\s+/g, ' ').trim();
}

/** Minimum size of a repeated leading segment eligible to be stripped (decision 9-10). */
export const MIN_REPEAT_SEGMENT_CHARS = 12;
export const MIN_REPEAT_SEGMENT_WORDS = 2;

/**
 * Strip a repeated leading segment (spec R3.1, decisions 9-11): when the
 * (already whitespace-collapsed) string is `A + ' ' + B` and B starts with
 * A, keep only B -- UNLESS A is short (fewer than 12 chars or fewer than 2
 * words), in which case the string is returned unchanged (decision 9-10:
 * "CTO CTO Group" and "Manager, Manager Development Program" must not be
 * mangled by a single-token or otherwise short coincidental repeat). Among
 * every valid split point the LONGEST matching A is chosen, so a title with
 * one genuine boilerplate repeat resolves in a single pass. No recursion:
 * at most one repeat is stripped per call, matching the spec's "keep the
 * text once."
 * @param {string} s already collapseWhitespace()-d
 * @returns {{ text: string, stripped: boolean, segment: string|null }}
 */
export function stripRepeatedLeadingSegment(s) {
  const text = String(s ?? '');

  // Whole-string exact duplication with no reliable space separator ("Chief AI Transformation
  // OfficerChief AI Transformation Officer", "...ComplianceSenior Director..."): A+A directly
  // concatenated, or A + exactly one separator character + A. Checked first since it is a stronger,
  // unambiguous signal (the ENTIRE title is two copies of the same text) than the space-delimited
  // prefix search below, which only requires a matching PREFIX followed by arbitrary trailing text.
  const exact = matchExactHalfRepeat(text);
  if (exact) {
    const exactWords = exact.split(' ').filter(Boolean).length;
    if (exact.length >= MIN_REPEAT_SEGMENT_CHARS && exactWords >= MIN_REPEAT_SEGMENT_WORDS) {
      return { text: exact, stripped: true, segment: exact };
    }
    // Below the floor (e.g. "CTOCTO" or "CTO CTO"): deliberately falls through to the space-delimited
    // search below, which applies the identical floor and will also correctly leave it untouched.
  }

  /** @type {{ a: string, rest: string } | null} */
  let best = null;
  for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) {
    const a = text.slice(0, i);
    const rest = text.slice(i + 1);
    if (a && rest.startsWith(a)) best = { a, rest };
  }
  if (!best) return { text, stripped: false, segment: exact };
  const words = best.a.split(' ').filter(Boolean).length;
  if (best.a.length < MIN_REPEAT_SEGMENT_CHARS || words < MIN_REPEAT_SEGMENT_WORDS) {
    return { text, stripped: false, segment: best.a };
  }
  return { text: best.rest, stripped: true, segment: best.a };
}

/**
 * Does `text` consist of exactly two copies of the same substring A, either directly concatenated
 * (A+A) or separated by exactly one character (A+sep+A, e.g. a stray comma or dash the source dropped
 * the surrounding whitespace from)? Returns A (the un-floor-checked candidate) or null. The floor
 * (length/word-count) is applied by the caller, same as the space-delimited search.
 * @param {string} text
 * @returns {string|null}
 */
function matchExactHalfRepeat(text) {
  const n = text.length;
  if (n >= 2 && n % 2 === 0) {
    const half = n / 2;
    const a = text.slice(0, half);
    if (a && text.slice(half) === a) return a;
  }
  if (n >= 3 && (n - 1) % 2 === 0) {
    const half = (n - 1) / 2;
    const a = text.slice(0, half);
    const rest = text.slice(half + 1);
    if (a && rest === a) return a;
  }
  return null;
}

/** Titles are capped at this many chars after normalization (spec R3.1). */
export const TITLE_MAX_CHARS = 200;

/**
 * Strip a trailing source-UI fragment (spec: LinkedIn's verified-badge text, "<title> with
 * verification", appended by the list scraper) from the end of `text`. Total classification: a
 * fragment on the configured list is stripped (case-insensitively, exactly once, longest match wins
 * so a fragment that is itself a suffix of another configured fragment does not partially match); a
 * trailing fragment NOT on the list is left in place -- this never guesses, it only ever acts on a
 * known, explicit list.
 * @param {string} text already collapseWhitespace()-d
 * @param {readonly string[]} fragments lowercase, from config (or DEFAULT_TITLE_TRAILING_FRAGMENTS)
 * @returns {{ text: string, stripped: boolean, fragment: string|null }}
 */
export function stripTrailingUiFragments(text, fragments) {
  const lower = text.toLowerCase();
  /** @type {string|null} */
  let longest = null;
  for (const f of fragments ?? []) {
    const frag = String(f ?? '').toLowerCase();
    if (!frag) continue;
    const suffix = ` ${frag}`;
    if (lower.endsWith(suffix) && (longest === null || suffix.length > longest.length)) longest = suffix;
  }
  if (longest === null) return { text, stripped: false, fragment: null };
  const kept = text.slice(0, text.length - longest.length).trimEnd();
  return { text: kept, stripped: true, fragment: longest.trim() };
}

/**
 * Full title text cleaning pipeline (spec R3.1, plus a defense against source-UI fragments like
 * LinkedIn's verified-badge text): zero-width strip, whitespace collapse, trailing-UI-fragment strip,
 * repeated-leading-segment strip, 200-char cap. Used both for the stored `title` column and as the
 * input to normalizeTitle()'s tokenizer, so a duplicated boilerplate segment or a UI fragment never
 * reaches title_norm either.
 * @param {unknown} raw
 * @param {NormalizeOptions} [opts]
 */
export function cleanTitleText(raw, opts) {
  const o = opts ?? getDefaultNormalizeOptions();
  const collapsed = collapseWhitespace(raw);
  const { text: defragmented, stripped, fragment } = stripTrailingUiFragments(collapsed, o.titleTrailingFragments ?? DEFAULT_TITLE_TRAILING_FRAGMENTS);
  // Total classification (spec R3.1 item 1): a fragment on the configured list is stripped silently in
  // the normal case, but the strip event itself is logged at debug so an operator reviewing logs can
  // confirm which titles were affected and by which fragment -- an audit trail, not a gate. A trailing
  // fragment NOT on the list is left in place and is not logged here (there is nothing specific to
  // report about it; it is indistinguishable from a title that never had one).
  if (stripped) log.debug({ event: 'title_ui_fragment_stripped', fragment, title_before: collapsed, title_after: defragmented });
  const { text } = stripRepeatedLeadingSegment(defragmented);
  return text.length > TITLE_MAX_CHARS ? text.slice(0, TITLE_MAX_CHARS) : text;
}

/** @param {string} s */
function slugify(s) {
  return stripAccents(s.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * @param {string} host
 * @param {string} base
 */
function hostIs(host, base) {
  return host === base || host.endsWith('.' + base);
}

/** @param {string} s */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Merge query params from the search string and from a `#a=b&c=d` fragment.
 * @param {URL} u
 */
function paramsOf(u) {
  const p = new URLSearchParams(u.search);
  const frag = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash;
  if (frag.includes('=')) {
    const fp = new URLSearchParams(frag.startsWith('?') ? frag.slice(1) : frag);
    for (const [k, v] of fp) if (!p.has(k)) p.append(k, v);
  }
  return p;
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * @typedef {'canonical'|'residual'|'redirect'|'invalid'} UrlKind
 * @typedef {Object} NormalizedUrl
 * @property {string|null} url_normalized
 * @property {string|null} external_id
 * @property {UrlKind} kind
 * @property {string} source adapter/source name inferred from host ('manual' when unknown or invalid)
 */

/**
 * Source name for a hostname (spec 2.2: linkedin, indeed, dice, oracle, else manual;
 * plus the ATS hosts the adapters own).
 * @param {string} host lowercase hostname
 */
export function sourceForHost(host) {
  if (!host) return 'manual';
  if (hostIs(host, 'linkedin.com')) return 'linkedin';
  if (hostIs(host, 'indeed.com')) return 'indeed';
  if (hostIs(host, 'dice.com')) return 'dice';
  if (hostIs(host, 'oraclecloud.com')) return 'oracle';
  if (hostIs(host, 'greenhouse.io')) return 'greenhouse';
  if (hostIs(host, 'lever.co')) return 'lever';
  if (hostIs(host, 'myworkdayjobs.com')) return 'workday';
  if (hostIs(host, 'dayforcehcm.com')) return 'dayforce';
  return 'manual';
}

const INVALID = Object.freeze({ url_normalized: null, external_id: null, kind: /** @type {UrlKind} */ ('invalid'), source: 'manual' });

/**
 * @param {unknown} input
 * @param {NormalizeOptions} [opts]
 * @returns {NormalizedUrl}
 */
export function normalizeUrl(input, opts) {
  const o = opts ?? getDefaultNormalizeOptions();
  if (typeof input !== 'string') return { ...INVALID };
  const raw = input.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return { ...INVALID };
  /** @type {URL} */
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ...INVALID };
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const path = u.pathname;
  const lpath = path.toLowerCase();
  const params = paramsOf(u);

  // ---- Indeed
  if (hostIs(host, 'indeed.com')) {
    const jk = params.get('jk');
    if (jk && /^[0-9a-f]{8,}$/i.test(jk)) {
      const id = jk.toLowerCase();
      return { url_normalized: `https://www.indeed.com/viewjob?jk=${id}`, external_id: `indeed:${id}`, kind: 'canonical', source: 'indeed' };
    }
    if (/^\/(pagead|rc)\/clk/.test(lpath)) return { url_normalized: null, external_id: null, kind: 'redirect', source: 'indeed' };
    return residual(u, host, o, 'indeed');
  }

  // ---- LinkedIn
  if (hostIs(host, 'linkedin.com')) {
    let id = null;
    const m = /^\/jobs\/view\/(?:[^/]*?-)?(\d{6,})\/?$/.exec(lpath);
    if (m) id = m[1];
    else {
      const cj = params.get('currentJobId');
      if (cj && /^\d{6,}$/.test(cj)) id = cj;
    }
    if (id) return { url_normalized: `https://www.linkedin.com/jobs/view/${id}`, external_id: `linkedin:${id}`, kind: 'canonical', source: 'linkedin' };
    return residual(u, host, o, 'linkedin');
  }

  // ---- Greenhouse (hosted boards and API)
  const ghHosts = ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'boards-api.greenhouse.io', 'my.greenhouse.io'];
  const ghEmbedded = params.get('gh_jid');
  if (ghHosts.includes(host)) {
    const m = /^\/(?:v1\/boards\/)?([a-z0-9-]+)\/jobs\/(\d+)/i.exec(path);
    if (m) return greenhouseCanonical(m[1].toLowerCase(), m[2]);
    const isEmbed = /^\/embed\/job_app/.test(lpath);
    const token = params.get('token');
    const id = ghEmbedded ?? (isEmbed ? token : null);
    const board = params.get('for');
    if (id && /^\d+$/.test(id) && board && /^[a-z0-9-]+$/i.test(board)) return greenhouseCanonical(board.toLowerCase(), id);
    return residual(u, host, o, 'greenhouse');
  }
  if (ghEmbedded && /^\d+$/.test(ghEmbedded)) {
    const board = (o.greenhouseBoards ?? []).find((b) => (b.hosts ?? []).some((h) => hostIs(host, h.toLowerCase())));
    if (board) return greenhouseCanonical(board.board, ghEmbedded);
    // Embedded id on an unregistered host: tenant unknown, cannot qualify.
    return residual(u, host, o, sourceForHost(host));
  }

  // ---- Lever
  if (host === 'jobs.lever.co' || host === 'api.lever.co') {
    const m = /^\/(?:v0\/postings\/)?([a-z0-9-]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/apply)?\/?$/.exec(lpath);
    if (m) return { url_normalized: `https://jobs.lever.co/${m[1]}/${m[2]}`, external_id: `lever:${m[1]}/${m[2]}`, kind: 'canonical', source: 'lever' };
    return residual(u, host, o, 'lever');
  }

  // ---- Workday
  const wd = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (wd) {
    const segs = lpath.split('/').filter(Boolean);
    const jobIdx = segs.indexOf('job');
    if (jobIdx > 0 && jobIdx < segs.length - 1) {
      const site = segs[jobIdx - 1];
      const last = segs[segs.length - 1];
      const us = last.lastIndexOf('_');
      const req = us >= 0 ? last.slice(us + 1) : last;
      if (req) {
        return {
          url_normalized: `https://${host}${lpath.replace(/\/+$/, '')}`,
          external_id: `workday:${wd[1]}/${site}/${req}`,
          kind: 'canonical',
          source: 'workday',
        };
      }
    }
    return residual(u, host, o, 'workday');
  }

  // ---- Dayforce
  {
    const m = /^\/candidateportal\/([a-z]{2}-[a-z]{2})\/([^/]+)\/posting\/view\/(\d+)/i.exec(path);
    if (m && hostIs(host, 'dayforcehcm.com')) {
      const client = m[2].toLowerCase();
      return {
        url_normalized: `https://${host}/CandidatePortal/${m[1]}/${m[2]}/Posting/View/${m[3]}`,
        external_id: `dayforce:${host}/${client}/${m[3]}`,
        kind: 'canonical',
        source: 'dayforce',
      };
    }
  }

  // ---- Dice
  if (hostIs(host, 'dice.com')) {
    const m = /^\/job-detail\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(path);
    if (m) {
      const id = m[1].toLowerCase();
      return { url_normalized: `https://www.dice.com/job-detail/${id}`, external_id: `dice:${id}`, kind: 'canonical', source: 'dice' };
    }
    return residual(u, host, o, 'dice');
  }

  // ---- Oracle HCM
  if (hostIs(host, 'oraclecloud.com')) {
    const m = /\/job\/(\d+)(?:\/|$)/i.exec(path);
    if (m) {
      return { url_normalized: `https://${host}${path.replace(/\/+$/, '')}`, external_id: `oracle:${host}/${m[1]}`, kind: 'canonical', source: 'oracle' };
    }
    return residual(u, host, o, 'oracle');
  }

  return residual(u, host, o, sourceForHost(host));
}

/**
 * @param {string} board
 * @param {string} id
 * @returns {NormalizedUrl}
 */
function greenhouseCanonical(board, id) {
  return { url_normalized: `https://boards.greenhouse.io/${board}/jobs/${id}`, external_id: `greenhouse:${board}/${id}`, kind: 'canonical', source: 'greenhouse' };
}

/**
 * @param {string} key lowercase
 * @param {readonly string[]} list
 */
function isTracking(key, list) {
  for (const t of list) {
    if (t.endsWith('*')) {
      if (key.startsWith(t.slice(0, -1))) return true;
    } else if (key === t) return true;
  }
  return false;
}

/**
 * Residual canonicalization: lowercase scheme/host/path, re-encode path with
 * one encoder, drop tracking params, sort remaining by key then value
 * (repeats preserved), strip fragment and trailing slash.
 * @param {URL} u
 * @param {string} host
 * @param {NormalizeOptions} o
 * @param {string} source
 * @returns {NormalizedUrl}
 */
function residual(u, host, o, source) {
  const scheme = u.protocol.replace(':', '').toLowerCase();
  const segs = u.pathname.split('/').map((s) => encodeURIComponent(safeDecode(s)).toLowerCase());
  let path = segs.join('/');
  path = path.replace(/\/+$/, '');
  const tracking = o.trackingParams ?? DEFAULT_TRACKING_PARAMS;
  /** @type {Array<[string, string]>} */
  const kept = [];
  for (const [k, v] of new URLSearchParams(u.search)) {
    if (isTracking(k.toLowerCase(), tracking)) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const qs = new URLSearchParams(kept).toString();
  const port = u.port ? `:${u.port}` : '';
  return { url_normalized: `${scheme}://${host}${port}${path}${qs ? '?' + qs : ''}`, external_id: null, kind: 'residual', source };
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

const SUFFIX_RE = /[\s.,\-]+(inc|llc|ltd|corp|corporation|co|plc|gmbh)\.?$/;

/**
 * @typedef {Object} NormalizedCompany
 * @property {string} company_norm
 * @property {string|null} company_note parenthetical text extracted from the raw name
 */

/**
 * @param {unknown} raw
 * @param {NormalizeOptions & { confidentialFirm?: string, source?: string }} [opts]
 * @returns {NormalizedCompany}
 */
export function normalizeCompany(raw, opts) {
  const o = opts ?? getDefaultNormalizeOptions();
  if (typeof raw !== 'string' || !raw.trim()) return { company_norm: '', company_note: null };
  /** @type {string[]} */
  const notes = [];
  let s = raw.replace(/\(([^)]*)\)/g, (_m, n) => {
    const t = String(n).trim();
    if (t) notes.push(t);
    return ' ';
  });
  s = stripAccents(s.toLowerCase()).trim();
  const aliases = o.aliases ?? {};
  const preKey = collapse(s);
  const note = notes.length ? notes.join('; ') : null;
  if (preKey && aliases[preKey]) return { company_norm: aliases[preKey], company_note: note };

  let t = s.replace(/[\s.,]+$/, '');
  t = t.replace(SUFFIX_RE, '');
  t = t.replace(/^\s*the\s+/, '');
  let norm = collapse(t);
  if (norm && aliases[norm]) return { company_norm: aliases[norm], company_note: note };

  if (norm === 'confidential' || norm.startsWith('confidential ')) {
    const firm = /** @type {any} */ (opts)?.confidentialFirm ?? /** @type {any} */ (opts)?.source ?? 'unknown';
    norm = `confidential:${slugify(String(firm)) || 'unknown'}`;
  }
  return { company_norm: norm, company_note: note };
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const US_STATES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct',
  delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia',
  kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi',
  minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh',
  'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh',
  oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv',
  wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc', 'washington dc': 'dc', 'washington d c': 'dc',
};
const US_ABBRS = new Set(Object.values(US_STATES));

/** @type {Record<string, string>} */
const COUNTRIES = {
  'united states': 'us', 'united states of america': 'us', usa: 'us', us: 'us', 'u s': 'us', 'u s a': 'us',
  canada: 'ca', 'united kingdom': 'gb', uk: 'gb', 'great britain': 'gb', england: 'gb', germany: 'de', france: 'fr',
  australia: 'au', india: 'in', mexico: 'mx', ireland: 'ie', netherlands: 'nl', spain: 'es', singapore: 'sg',
  switzerland: 'ch', italy: 'it', brazil: 'br', japan: 'jp', 'new zealand': 'nz', sweden: 'se', norway: 'no',
  denmark: 'dk', belgium: 'be', poland: 'pl', portugal: 'pt', israel: 'il', 'united arab emirates': 'ae', uae: 'ae',
};

/** @param {string} s */
function countryIso(s) {
  const k = collapse(stripAccents(s.toLowerCase()));
  return COUNTRIES[k] ?? null;
}

/** @param {string} s */
function stateAbbr(s) {
  const k = collapse(stripAccents(s.toLowerCase()));
  if (US_STATES[k]) return US_STATES[k];
  if (k.length === 2 && US_ABBRS.has(k)) return k;
  return null;
}

/**
 * @typedef {{ kind: 'city-st', value: string } | { kind: 'country', iso: string } | { kind: 'state', abbr: string }} ParsedLocation
 */

/**
 * Parse a free-text location. Returns null when it does not fit a known shape.
 * @param {unknown} raw
 * @returns {ParsedLocation | null}
 */
export function parseLocation(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/\s+\d{5}(?:-\d{4})?$/, '');
  const parts = s.split(',').map((t) => t.trim()).filter(Boolean);
  while (parts.length > 1 && countryIso(parts[parts.length - 1])) parts.pop();
  if (parts.length >= 2) {
    const city = parts[0];
    const st = stateAbbr(parts[1]);
    if (st && /^[a-z .'-]+$/i.test(stripAccents(city))) return { kind: 'city-st', value: `${slugify(city)}-${st}` };
    return null;
  }
  const only = parts[0];
  const iso = countryIso(only);
  if (iso) return { kind: 'country', iso };
  // A single part that IS a state name/abbreviation on its own (spec R6, decision 13: "Texas" or
  // "Texas, United States" -- the country suffix was already popped above -- with no city). Checked
  // before the "City ST" regex below so a bare state name is never mistaken for a one-word "city."
  const bareState = stateAbbr(only);
  if (bareState) return { kind: 'state', abbr: bareState };
  const m = /^([a-z .'-]+?)\s+([a-z]{2})$/i.exec(stripAccents(only));
  if (m && stateAbbr(m[2]) && !countryIso(m[2])) return { kind: 'city-st', value: `${slugify(m[1])}-${stateAbbr(m[2])}` };
  return null;
}

export const LEGACY_UNKNOWN_LOCATION = 'legacy-unknown';
export const ABSENT_LOCATION = 'absent';

/**
 * True when a location_norm value is eligible for automatic dedup merges
 * (spec 3.2 branch 2: not absent, unknown:*, or legacy-unknown).
 * @param {string|null|undefined} locationNorm
 */
export function isLocationEligible(locationNorm) {
  if (!locationNorm) return false;
  if (locationNorm === ABSENT_LOCATION || locationNorm === LEGACY_UNKNOWN_LOCATION) return false;
  if (locationNorm.startsWith('unknown:')) return false;
  return true;
}

/**
 * @typedef {Object} NormalizedLocation
 * @property {string} location_norm
 * @property {'remote'|'hybrid'|'onsite'|null} remote_mode
 */

/**
 * Total classification of a location (spec 3.1).
 * @param {unknown} raw the source's location string; null/undefined when the source supplied none
 * @param {boolean} [remoteDeclared] source explicitly flagged remote
 * @param {boolean} [remoteInferred] remote inferred from text (keeps the city if present)
 * @returns {NormalizedLocation}
 */
export function normalizeLocation(raw, remoteDeclared = false, remoteInferred = false) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const lower = text.toLowerCase();
  const hybrid = /\bhybrid\b/.test(lower);
  const parsed = text ? parseLocation(text) : null;
  if (remoteDeclared) {
    let iso = 'us';
    let stateAbbrFound = parsed && parsed.kind === 'state' ? parsed.abbr : null;
    if (parsed && parsed.kind === 'country') {
      iso = parsed.iso;
    } else if (text) {
      // "Remote - Canada", "Remote (UK)", "Remote - Texas": strip the "remote" word and separator
      // punctuation so the remaining text can be re-parsed on its own for a country OR a bare state, the
      // same way the direct (non-"Remote -" prefixed) case already parses via `parsed` above.
      const inner = text.replace(/\bremote\b/gi, ' ').replace(/[()\-|,]/g, ' ').trim();
      if (inner) {
        const c = countryIso(inner);
        if (c) iso = c;
        if (!stateAbbrFound) {
          const innerParsed = parseLocation(inner);
          if (innerParsed && innerParsed.kind === 'state') stateAbbrFound = innerParsed.abbr;
        }
      }
    }
    // A remote-declared role whose location text still names a US state ("Oklahoma, United States",
    // "Remote - Texas") keeps that state as a suffix (spec R6 fix): collapsing every remote-declared
    // posting straight to the bare `remote-<iso>` value regardless of any stated state throws away the
    // one signal that distinguishes "the identical role, broadcast once per state" postings (e.g.
    // Gartner's "Executive Partner - CIO Advisory" in Oklahoma vs. Arkansas) from each other, which in
    // turn made them collide on an IDENTICAL dedup_hash and get caught by the existing same-source
    // -repost-within-gap ambiguous branch instead of ever reaching the state/remote merge rule (R6) that
    // is supposed to consolidate them deliberately. A location with no discernible state (bare "Remote",
    // "United States") is unaffected and still collapses to the original bare `remote-<iso>`.
    const stateSuffix = stateAbbrFound ? `-${stateAbbrFound}` : '';
    return { location_norm: `remote-${iso}${stateSuffix}`, remote_mode: 'remote' };
  }
  const mode = remoteInferred || /\bremote\b/.test(lower) ? 'remote' : hybrid ? 'hybrid' : text ? 'onsite' : null;
  if (raw === null || raw === undefined || !text) return { location_norm: ABSENT_LOCATION, remote_mode: mode };
  if (parsed && parsed.kind === 'city-st') return { location_norm: parsed.value, remote_mode: mode };
  if (parsed && parsed.kind === 'country') return { location_norm: `country-${parsed.iso}`, remote_mode: mode };
  if (parsed && parsed.kind === 'state') return { location_norm: `state-${parsed.abbr}`, remote_mode: mode };
  return { location_norm: `unknown:${sha1(lower)}`, remote_mode: mode };
}

/** True when a location_norm value is a US state-only location (no city) -- spec R6.1/R6.2. */
export function isStateOnlyLocation(locationNorm) {
  return typeof locationNorm === 'string' && locationNorm.startsWith('state-');
}

/** True when a location_norm value is a remote-<iso> location. */
export function isRemoteLocation(locationNorm) {
  return typeof locationNorm === 'string' && locationNorm.startsWith('remote-');
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const ACRONYMS = {
  cto: 'chief technology officer',
  cio: 'chief information officer',
  coo: 'chief operating officer',
  ceo: 'chief executive officer',
  cfo: 'chief financial officer',
  caio: 'chief ai officer',
  svp: 'senior vice president',
  evp: 'executive vice president',
  vp: 'vice president',
  sr: 'senior',
  jr: 'junior',
  // ambiguous acronyms map to distinct tokens so they never merge with an expansion
  cdo: 'acr_cdo',
  cpo: 'acr_cpo',
  cso: 'acr_cso',
  cro: 'acr_cro',
  cmo: 'acr_cmo',
  cxo: 'acr_cxo',
  cdao: 'acr_cdao',
};

const DROP_SEGMENT_RE = /^(?:remote|hybrid|on-?site|in-?office|work from home|wfh)\b.*$|^(?:req|requisition|job|jr|r|id)[\s#:.-]*\d+$|^#?\d{4,}$|^job id[:\s]*\S+$/i;

/**
 * @typedef {Object} NormalizedTitle
 * @property {string} title_norm
 * @property {string|null} location_from_title raw trailing segment that parsed as a location
 */

/**
 * @param {unknown} raw
 * @param {NormalizeOptions} [opts]
 * @returns {NormalizedTitle}
 */
export function normalizeTitle(raw, opts) {
  if (typeof raw !== 'string' || !raw.trim()) return { title_norm: '', location_from_title: null };
  let t = cleanTitleText(raw, opts);
  /** @type {string|null} */
  let promoted = null;
  for (let guard = 0; guard < 6; guard++) {
    const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(t);
    if (paren && paren[1].trim()) {
      const seg = paren[2].trim();
      if (DROP_SEGMENT_RE.test(seg)) {
        t = paren[1].trim();
        continue;
      }
      if (parseLocation(seg)) {
        if (!promoted) promoted = seg;
        t = paren[1].trim();
        continue;
      }
    }
    // separators: hyphen, en dash (U+2013), em dash (U+2014), pipe, middle dot, slash
    const sep = /^(.*\S)\s+(?:-|\u2013|\u2014|\||·|\/)\s+([^|\u2013\u2014]+?)\s*$/.exec(t);
    if (sep) {
      const seg = sep[2].trim();
      if (DROP_SEGMENT_RE.test(seg)) {
        t = sep[1].trim();
        continue;
      }
      if (parseLocation(seg)) {
        if (!promoted) promoted = seg;
        t = sep[1].trim();
        continue;
      }
    }
    break;
  }
  let s = stripAccents(t.toLowerCase());
  s = s.replace(/&/g, ' and ');
  s = s.replace(/\b(?:[a-z]\.){2,}[a-z]?\b/g, (m) => m.replace(/\./g, ''));
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean).map((tok) => ACRONYMS[tok] ?? tok);
  let out = tokens.join(' ');
  out = out.replace(/\bartificial intelligence\b/g, 'ai');
  return { title_norm: out.trim(), location_from_title: promoted };
}

const TITLE_STOPWORDS = new Set(['of', 'the', 'and', 'a', 'an', 'for', 'in', 'to', 'at', 'or', 'with', 'on', 'by']);

/**
 * Stopword-dropped, sorted token key for the branch-4 token-set comparison.
 * @param {string} titleNorm
 */
export function titleTokenKey(titleNorm) {
  const toks = String(titleNorm ?? '').split(' ').filter((x) => x && !TITLE_STOPWORDS.has(x));
  return Array.from(new Set(toks)).sort().join(' ');
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/**
 * @param {string} companyNorm
 * @param {string} titleNorm
 * @param {string} locationNorm
 */
export function dedupHash(companyNorm, titleNorm, locationNorm) {
  return sha1(`${companyNorm ?? ''}|${titleNorm ?? ''}|${locationNorm ?? ''}`);
}

/** @type {Record<string, string>} */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

/**
 * HTML to plain text: drop script/style, tags, decode common entities.
 * @param {string} html
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = String(e).toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10) || 32);
    return ENTITIES[k] ?? m;
  });
  return s;
}

/**
 * Pinned description pipeline: HTML strip, entity decode, NFKC, whitespace
 * collapse, trim. `text` keeps the source's original case and punctuation
 * (that's what gets stored/rendered); `hash` is computed from the lowercased
 * variant of that same cleaned text, with req-id tokens masked, over the
 * first+last 2000 chars. Two descriptions differing only by case therefore
 * produce the same hash.
 * @param {unknown} description raw HTML or text
 * @returns {{ text: string|null, hash: string|null }}
 */
export function descriptionHash(description) {
  if (typeof description !== 'string') return { text: null, hash: null };
  const cleaned = htmlToText(description).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { text: null, hash: null };
  const lower = cleaned.toLowerCase();
  const masked = lower
    .replace(/\breq[-\s]?\d+\b/g, 'req#')
    .replace(/\br-\d+\b/g, 'r#')
    .replace(/\b\d{6,}\b/g, '#');
  const sample = masked.length <= 4000 ? masked : masked.slice(0, 2000) + masked.slice(-2000);
  return { text: cleaned, hash: sha1(sample) };
}

// ---------------------------------------------------------------------------
// Salary (simple regex; prose-only salaries are a known blind spot)
// ---------------------------------------------------------------------------

/**
 * @param {unknown} raw
 * @returns {{ salary_min: number|null, salary_max: number|null }}
 */
export function parseSalary(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { salary_min: null, salary_max: null };
  const s = raw.toLowerCase().replace(/,/g, '');
  const nums = [];
  const re = /\$?\s*(\d+(?:\.\d+)?)\s*(k|m)?\b/g;
  let m;
  while ((m = re.exec(s)) !== null && nums.length < 4) {
    let n = parseFloat(m[1]);
    if (m[2] === 'k') n *= 1000;
    else if (m[2] === 'm') n *= 1000000;
    if (n >= 20000 && n <= 5000000) nums.push(Math.round(n));
  }
  if (nums.length === 0) return { salary_min: null, salary_max: null };
  const hourly = /\/\s*h(ou)?r\b|per hour|hourly/.test(s);
  if (hourly) return { salary_min: null, salary_max: null };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { salary_min: min, salary_max: max };
}

// ---------------------------------------------------------------------------
// Whole-record normalization
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RawListing
 * @property {string} source
 * @property {string|null} [externalId] adapter-supplied id; normalizeUrl output wins when present
 * @property {string|null} url
 * @property {string} title
 * @property {string} company
 * @property {string|null} [location]
 * @property {string|null} [remoteMode]
 * @property {boolean} [remoteDeclared]
 * @property {string|null} [postedAt] ISO date
 * @property {string|null} [salaryRaw]
 * @property {number|null} [salaryMin]
 * @property {number|null} [salaryMax]
 * @property {string|null} [description]
 * @property {string|null} [confidentialFirm] exec-board firm slug
 */

/**
 * @typedef {Object} NormalizedListing
 * @property {string} source
 * @property {string|null} external_id
 * @property {string|null} url_normalized
 * @property {UrlKind} url_kind
 * @property {string} title
 * @property {string} company
 * @property {string} title_norm
 * @property {string} company_norm
 * @property {string|null} company_note
 * @property {string|null} location
 * @property {string} location_norm
 * @property {'remote'|'hybrid'|'onsite'|null} remote_mode
 * @property {boolean} remote_declared
 * @property {string} dedup_hash
 * @property {string|null} description
 * @property {string|null} description_hash
 * @property {string|null} posted_at
 * @property {string|null} salary_raw
 * @property {number|null} salary_min
 * @property {number|null} salary_max
 */

/**
 * Normalize an adapter RawListing into the columns dedup and upsert use.
 * @param {RawListing} raw
 * @param {NormalizeOptions} [opts]
 * @returns {NormalizedListing}
 */
export function normalizeListing(raw, opts) {
  const o = opts ?? getDefaultNormalizeOptions();
  const url = normalizeUrl(raw.url ?? null, o);
  const externalId = url.external_id ?? (raw.externalId ? `${raw.source}:${raw.externalId}` : null);
  const title = normalizeTitle(raw.title, o);
  const company = normalizeCompany(raw.company, { ...o, confidentialFirm: raw.confidentialFirm ?? undefined, source: raw.source });
  // Company/location get the same whitespace treatment as title (spec R3.1) but not the repeated-segment
  // strip or the 200-char cap, which are title-specific.
  const locationRaw = raw.location != null ? collapseWhitespace(raw.location) : (title.location_from_title ?? null);
  // Adapters set remoteDeclared=true whenever the source states ANY work mode (remote, hybrid, or onsite).
  // Only a declared REMOTE mode may collapse the location to remote-<iso> (spec 3.1); a declared hybrid or
  // onsite role keeps its city, and an undeclared "remote" in the text is inferred (keeps the city too).
  const mode = raw.remoteMode === 'remote' || raw.remoteMode === 'hybrid' || raw.remoteMode === 'onsite' ? raw.remoteMode : null;
  const declared = Boolean(raw.remoteDeclared) && mode === 'remote';
  const inferred = !declared && (mode === 'remote' || /\bremote\b/i.test(`${raw.title ?? ''} ${raw.location ?? ''}`));
  const loc = normalizeLocation(locationRaw, declared, inferred);
  const desc = descriptionHash(raw.description ?? null);
  const sal = raw.salaryMin != null || raw.salaryMax != null
    ? { salary_min: raw.salaryMin ?? null, salary_max: raw.salaryMax ?? null }
    : parseSalary(raw.salaryRaw ?? null);
  return {
    source: raw.source,
    external_id: externalId,
    url_normalized: url.url_normalized,
    url_kind: url.kind,
    title: cleanTitleText(raw.title, o),
    company: collapseWhitespace(raw.company),
    title_norm: title.title_norm,
    company_norm: company.company_norm,
    company_note: company.company_note,
    location: locationRaw,
    location_norm: loc.location_norm,
    remote_mode: mode === 'hybrid' || mode === 'onsite' ? mode : loc.remote_mode,
    remote_declared: declared,
    dedup_hash: dedupHash(company.company_norm, title.title_norm, loc.location_norm),
    description: desc.text,
    description_hash: desc.hash,
    posted_at: raw.postedAt ?? null,
    salary_raw: raw.salaryRaw ?? null,
    salary_min: sal.salary_min,
    salary_max: sal.salary_max,
  };
}

/**
 * Normalize a legacy ic_job_listings row (migration and adoption): location is
 * always `legacy-unknown`, source comes from the URL host, empty URL is NULL.
 * @param {{ id: number, title: string, company: string, url: string|null, source?: string|null }} row
 * @param {NormalizeOptions} [opts]
 */
export function normalizeLegacyRow(row, opts) {
  const o = opts ?? getDefaultNormalizeOptions();
  const url = normalizeUrl(row.url, o);
  const source = row.source || url.source || 'manual';
  const title = normalizeTitle(row.title, o);
  const company = normalizeCompany(row.company, { ...o, source });
  const location_norm = LEGACY_UNKNOWN_LOCATION;
  return {
    id: row.id,
    source,
    external_id: url.external_id,
    url_normalized: url.url_normalized,
    url_kind: url.kind,
    title_norm: title.title_norm,
    company_norm: company.company_norm,
    company_note: company.company_note,
    location: title.location_from_title,
    location_norm,
    dedup_hash: dedupHash(company.company_norm, title.title_norm, location_norm),
  };
}
