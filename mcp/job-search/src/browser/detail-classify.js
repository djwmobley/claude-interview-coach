// @ts-check
/**
 * Detail-page classification (job description fetches). wall.js's classifyPage is a LIST-page classifier
 * ("zero listings parsed" is meaningful there); a detail page has a body to judge, so this is a separate,
 * total function. It never calls classifyPage and never treats 'unrecognized' as a block. Re-exported
 * from wall.js.
 */

const WALL_PATH = /\/(login|checkpoint|authwall|uas)(\/|$|\?)/i;

export const DETAIL_BLOCK_REASONS = Object.freeze(['cloudflare_challenge', 'indeed_verification', 'captcha', 'login_wall', 'http_403']);

/** Every string classifyDetail can return. */
export const DETAIL_CLASSIFICATIONS = Object.freeze(['ok', 'transient', 'empty', 'too_short', 'unverified', ...DETAIL_BLOCK_REASONS.map((r) => `blocked:${r}`)]);

const DETAIL_TOO_SHORT = 300;
const DETAIL_UNVERIFIED_BELOW = 1200;
const JOB_SHAPE_MARKERS = Object.freeze(['responsibilit', 'qualification', 'requirement', 'about the role', 'about the job', 'experience', 'what you will', 'what you\'ll', 'you will', 'skills']);

/**
 * Text signatures. A signature fires only when the normalized text is shorter than 800 chars OR the
 * match starts within the first 300 chars. `/cloudflare/` is the exception: it fires only on text
 * shorter than 1000 chars. "attention required" and "too many requests" are deliberately absent (they
 * appear in ordinary prose).
 * @type {ReadonlyArray<{ re: RegExp, reason: string, onlyBelow?: number }>}
 */
const TEXT_SIGNATURES = Object.freeze([
  { re: /ray id\b/, reason: 'cloudflare_challenge' },
  { re: /troubleshooting cloudflare errors/, reason: 'cloudflare_challenge' },
  { re: /just a moment/, reason: 'cloudflare_challenge' },
  { re: /checking your browser/, reason: 'cloudflare_challenge' },
  { re: /performance & security by cloudflare/, reason: 'cloudflare_challenge' },
  { re: /enable javascript and cookies to continue/, reason: 'cloudflare_challenge' },
  { re: /cloudflare/, reason: 'cloudflare_challenge', onlyBelow: 1000 },
  { re: /additional verification required/, reason: 'indeed_verification' },
  { re: /verification required/, reason: 'indeed_verification' },
  { re: /verify you are human/, reason: 'indeed_verification' },
  { re: /please verify you are a human/, reason: 'indeed_verification' },
  { re: /hcaptcha/, reason: 'indeed_verification' },
  { re: /unusual traffic from your/, reason: 'captcha' },
  { re: /are you a robot/, reason: 'captcha' },
  { re: /request blocked/, reason: 'http_403' },
  { re: /access denied/, reason: 'http_403' },
  { re: /sign in to continue/, reason: 'login_wall' },
  { re: /captcha/, reason: 'captcha' },
]);

const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '-', mdash: '-', rsquo: '\'', lsquo: '\'', ldquo: '"', rdquo: '"', hellip: '...', bull: '*' });

/**
 * Strip tags, script/style contents and entities; collapse whitespace. Total: non-strings are ''.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDetailText(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ');
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    const k = String(e);
    if (k[0] === '#') {
      const code = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    const v = /** @type {Record<string, string>} */ (NAMED_ENTITIES)[k.toLowerCase()];
    return v === undefined ? m : v;
  });
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * @typedef {Object} DetailInput
 * @property {string|null} [text] fetched description / page text (HTML allowed)
 * @property {string|null} [url] final URL after navigation
 * @property {string|null} [source]
 * @property {number|null} [httpStatus]
 * @property {string|null} [cfMitigated] cf-mitigated header value
 * @property {{ challengeCloudflare?: boolean, challengeForm?: boolean, recaptcha?: boolean, loginForm?: boolean, guestInterstitial?: boolean }|null} [wallSignals]
 */

/**
 * Total classification of a fetched job detail. Returns exactly one of DETAIL_CLASSIFICATIONS.
 * Order: (1) HTTP status / cf-mitigated, (2) wall-type signals, (3) empty, (4) text signatures,
 * (5) too_short, (6) unverified, (7) ok.
 * @param {DetailInput} [input]
 * @returns {string}
 */
export function classifyDetail(input) {
  const i = input ?? {};
  const status = typeof i.httpStatus === 'number' ? i.httpStatus : null;
  if (status === 403) return 'blocked:http_403';
  if (i.cfMitigated) return 'blocked:cloudflare_challenge';
  if (status === 429 || status === 503) return 'transient';
  const w = i.wallSignals ?? {};
  if (w.challengeCloudflare === true || w.challengeForm === true) return 'blocked:cloudflare_challenge';
  if (w.recaptcha === true) return 'blocked:captcha';
  if (i.url) {
    let pathname = '';
    try {
      pathname = new URL(String(i.url)).pathname;
    } catch {
      pathname = String(i.url);
    }
    if (WALL_PATH.test(pathname)) return 'blocked:login_wall';
  }
  if (w.loginForm === true || w.guestInterstitial === true) return 'blocked:login_wall';
  const text = normalizeDetailText(i.text);
  if (!text) return 'empty';
  const lower = text.toLowerCase();
  const len = lower.length;
  for (const sig of TEXT_SIGNATURES) {
    const m = sig.re.exec(lower);
    if (!m) continue;
    const fires = sig.onlyBelow !== undefined ? len < sig.onlyBelow : len < 800 || m.index < 300;
    if (fires) return `blocked:${sig.reason}`;
  }
  if (len < DETAIL_TOO_SHORT) return 'too_short';
  if (len < DETAIL_UNVERIFIED_BELOW && !JOB_SHAPE_MARKERS.some((k) => lower.includes(k))) return 'unverified';
  return 'ok';
}

/** @param {unknown} c @returns {boolean} */
export function isBlockedClass(c) {
  return typeof c === 'string' && c.startsWith('blocked:');
}

/**
 * Detail blocks never touch the source's own wall state (that would stop list scans and apply paths):
 * they live under a separate ic_source_state key with its own backoff.
 * @param {string} source
 */
export function detailWallKey(source) {
  return `${source}:detail`;
}
