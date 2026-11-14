// @ts-check
/**
 * Indeed page classifier (source `indeed` ONLY), one shared function for the list path and the detail path.
 * Detect only: nothing here solves, clicks, or evades a challenge.
 *
 * Total order:
 *   1. OK         expected content parsed (list: parsed > 0; detail: a JSON-LD description was extracted)
 *   2. CHALLENGE  a Cloudflare challenge or challenge-form DOM marker, OR a frame whose URL host is a
 *                 challenge host, OR body text matching a challenge phrase under the text guard
 *                 (body shorter than 800 chars, or the match starts within the first 300 chars).
 *                 This runs BEFORE any HTTP status / cf-mitigated handling by the callers.
 *   3. DEFAULT    everything else (including failure and unknown): the caller applies today's
 *                 classification. A blank or too-short page has its DOM re-read once after a short wait
 *                 (no reload, no new request) before this verdict.
 */

export const INDEED_CHALLENGE_KIND = 'indeed_verification';
/** Body shorter than this (trimmed) reads as blank/too short and is re-read once. */
export const INDEED_BLANK_BELOW = 50;
export const INDEED_REREAD_WAIT_MS = 1500;

const CHALLENGE_TEXT = Object.freeze([/additional verification required/, /verify you are human/, /just a moment/]);

/**
 * Challenge host test on a frame URL, compared on the lowercased URL host. An unparseable URL is not a
 * challenge host.
 * @param {unknown} frameUrl
 * @returns {boolean}
 */
export function isChallengeHost(frameUrl) {
  if (typeof frameUrl !== 'string' || !frameUrl) return false;
  let u;
  try {
    u = new URL(frameUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'challenges.cloudflare.com') return true;
  if (host === 'hcaptcha.com' || host.endsWith('.hcaptcha.com')) return true;
  if (host === 'recaptcha.net' || host.endsWith('.recaptcha.net')) return true;
  if (host === 'www.google.com' && u.pathname.startsWith('/recaptcha/')) return true;
  return false;
}

/**
 * Challenge phrase test under the same text guard classifyDetail uses.
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasChallengeText(text) {
  if (typeof text !== 'string') return false;
  const lower = text.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const re of CHALLENGE_TEXT) {
    const m = re.exec(lower);
    if (m && (lower.length < 800 || m.index < 300)) return true;
  }
  return false;
}

/**
 * @typedef {Object} IndeedProbe
 * @property {boolean} [challengeCloudflare] iframe[src*="challenges.cloudflare.com"] present
 * @property {boolean} [challengeForm] #challenge-form present
 * @property {string[]} [frameUrls] URLs of the page's frames
 * @property {string} [bodyText] bounded visible body text
 */

/**
 * @param {IndeedProbe|null|undefined} p
 * @returns {string|null} a challenge reason, or null
 */
function challengeReason(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.challengeCloudflare === true || p.challengeForm === true) return 'challenge_marker';
  if (Array.isArray(p.frameUrls) && p.frameUrls.some(isChallengeHost)) return 'challenge_frame';
  if (hasChallengeText(p.bodyText)) return 'challenge_text';
  return null;
}

/**
 * @typedef {Object} IndeedClassifyInput
 * @property {'list'|'detail'} stage
 * @property {number} [parsed] list: cards parsed
 * @property {boolean} [descriptionExtracted] detail: a real description (not a body-text fallback) was extracted
 * @property {() => Promise<IndeedProbe|null>} readProbe reads the DOM probe; null when unreadable
 * @property {(ms: number) => Promise<void>} [sleep] test seam for the one re-read wait
 */

/**
 * @param {IndeedClassifyInput} input
 * @returns {Promise<{ kind: 'ok'|'challenge'|'default', reason: string, reread: boolean }>}
 */
export async function classifyIndeedPage(input) {
  const ok = input.stage === 'list' ? Number(input.parsed) > 0 : input.descriptionExtracted === true;
  if (ok) return { kind: 'ok', reason: input.stage === 'list' ? 'parsed' : 'description', reread: false };
  let probe = null;
  try {
    probe = await input.readProbe();
  } catch {
    probe = null;
  }
  let why = challengeReason(probe);
  if (why) return { kind: 'challenge', reason: why, reread: false };
  let reread = false;
  const blank = probe !== null && typeof probe === 'object' && String(probe.bodyText ?? '').trim().length < INDEED_BLANK_BELOW;
  if (blank) {
    reread = true;
    const sleep = input.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
    await sleep(INDEED_REREAD_WAIT_MS);
    try {
      probe = await input.readProbe();
    } catch {
      probe = null;
    }
    why = challengeReason(probe);
    if (why) return { kind: 'challenge', reason: why, reread };
  }
  return { kind: 'default', reason: 'no_challenge_signal', reread };
}
