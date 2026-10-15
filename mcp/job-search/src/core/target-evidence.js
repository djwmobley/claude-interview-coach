// @ts-check
/**
 * Target finder evidence-source registry. Deliberately SEPARATE from the job-board urlguard registry
 * (src/core/urlguard.js buildRegistry/classifyUrl): that one answers "may the scanner fetch this job
 * board", this one answers "is this URL a plausible evidence link for a signal of this source type".
 * It reuses urlguard's host-name checks (hostNameProblem) so IP literals, localhost and internal
 * suffixes are refused the same way, but no job-board host list is shared.
 *
 * Pure, synchronous, never throws, makes no network call. checkEvidence() is a TOTAL classification:
 * every (url, source) pair is either ok:true with a canonical URL, or ok:false with one reason.
 *
 *   edgar_*       host sec.gov / www.sec.gov, https only, path /Archives/edgar/data/<CIK>/<accession>/...
 *                 where <accession> is the 18-digit folder form or the 10-2-6 dashed form
 *   google_alert  a google.com/url redirect is unwrapped exactly once (url= or q= parameter); the
 *                 destination must be a public http(s) host. A bare destination URL is also accepted.
 *   listings      a public http(s) URL (the listing's own page)
 */
import { hostNameProblem, hostMatches } from './urlguard.js';

/** The closed set of evidence source types a signal may declare. */
export const EVIDENCE_SOURCES = Object.freeze(['edgar_form_d', 'edgar_8k', 'edgar_fts', 'google_alert', 'listings']);

// Two real EDGAR shapes: the 18-digit accession folder (optionally with a file under it), and the dashed
// accession as a direct file under the CIK (.txt or -index.htm[l]).
const EDGAR_PATH_RE = /^\/Archives\/edgar\/data\/\d{1,10}\/(?:\d{18}(?:\/[^?#]*)?|\d{10}-\d{2}-\d{6}(?:\.txt|-index\.html?)?)$/;
const MAX_URL_CHARS = 2048;

/**
 * @typedef {Object} EvidenceCheck
 * @property {boolean} ok
 * @property {string} reason 'ok' or the refusal branch
 * @property {string|null} url canonical URL when ok
 * @property {string|null} host lowercase host when parseable
 */

/** @param {string} reason @param {string|null} [host] @returns {EvidenceCheck} */
function refuse(reason, host = null) {
  return { ok: false, reason, url: null, host };
}

/**
 * @param {string} input
 * @returns {URL|null}
 */
function parsePublicUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  return u;
}

/**
 * Unwrap a Google Alerts redirect (https://www.google.com/url?...&url=<dest>&...) exactly once.
 * Returns null when the URL is not a google redirect, or the destination is missing or unparseable.
 * A destination that is itself a google redirect is returned as-is (the caller refuses it).
 * @param {string} input
 * @returns {string|null}
 */
export function unwrapGoogleAlertUrl(input) {
  const u = parsePublicUrl(input);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (!(hostMatches(host, 'google.com') && u.pathname === '/url')) return null;
  const dest = u.searchParams.get('url') ?? u.searchParams.get('q');
  if (!dest) return null;
  return dest;
}

/**
 * @param {URL} u
 * @returns {string|null} reason when the URL is not a plain public http(s) URL
 */
function publicProblem(u) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'bad_scheme';
  if (u.username || u.password) return 'credentials_in_url';
  const hp = hostNameProblem(u.hostname.toLowerCase());
  if (hp) return `host_${hp}`;
  if (!u.hostname.includes('.')) return 'host_not_fqdn';
  return null;
}

/**
 * @param {unknown} url
 * @param {unknown} source one of EVIDENCE_SOURCES
 * @returns {EvidenceCheck}
 */
export function checkEvidence(url, source) {
  if (typeof url !== 'string' || !url.trim()) return refuse('missing');
  const raw = url.trim();
  if (raw.length > MAX_URL_CHARS) return refuse('too_long');
  if (typeof source !== 'string' || !EVIDENCE_SOURCES.includes(source)) return refuse('unknown_source');

  let candidate = raw;
  if (source === 'google_alert') {
    const first = parsePublicUrl(raw);
    if (!first) return refuse('unparseable');
    if (hostMatches(first.hostname.toLowerCase(), 'google.com')) {
      const dest = unwrapGoogleAlertUrl(raw);
      if (!dest) return refuse('google_redirect_without_destination', first.hostname.toLowerCase());
      candidate = dest;
    }
  }

  const u = parsePublicUrl(candidate);
  if (!u) return refuse('unparseable');
  const host = u.hostname.toLowerCase();
  const problem = publicProblem(u);
  if (problem) return refuse(problem, host);

  if (source === 'google_alert' && hostMatches(host, 'google.com')) return refuse('google_redirect_chain', host);

  if (source.startsWith('edgar_')) {
    if (u.protocol !== 'https:') return refuse('edgar_requires_https', host);
    if (host !== 'sec.gov' && host !== 'www.sec.gov') return refuse('edgar_host_mismatch', host);
    if (!EDGAR_PATH_RE.test(u.pathname)) return refuse('edgar_path_mismatch', host);
  }

  u.hash = '';
  return { ok: true, reason: 'ok', url: u.toString(), host };
}
