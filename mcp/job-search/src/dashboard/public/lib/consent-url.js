// @ts-check
/**
 * Google consent URL classification (2026-10-04 reauth consent-link fix, spec S5). Shared by the server
 * (src/core/reauth-consent.js, before a consent URL is ever returned from an API route) and the browser
 * (components/run-scan-drawer.js and app.js, before a URL is ever navigated to or rendered as a link).
 * Pure and dependency-free so both sides load the exact same file.
 *
 * Total classification: OPEN is returned only when EVERY condition below holds; anything else, including
 * a parse error, a missing/invalid expectation, or an unforeseen shape, is REJECT. REJECT is the default
 * branch, never an afterthought.
 *
 *   - the URL parses (no base URL: a relative string is refused, never resolved);
 *   - protocol is exactly `https:`;
 *   - hostname is exactly `accounts.google.com`;
 *   - no username and no password;
 *   - no explicit port (checked on the raw authority too, since the URL parser drops a default `:443`);
 *   - pathname is exactly `/o/oauth2/v2/auth` or `/o/oauth2/auth`;
 *   - `redirect_uri`, `client_id`, `response_type`, `state` each appear exactly once;
 *   - response_type is `code`;
 *   - client_id equals the configured OAuth client id;
 *   - state equals the consent file's state;
 *   - redirect_uri parses to protocol `http:`, hostname `localhost` or `127.0.0.1`, no credentials, and
 *     a port equal to the consent file's port.
 */

export const CONSENT_HOST = 'accounts.google.com';
export const CONSENT_PATHS = Object.freeze(['/o/oauth2/v2/auth', '/o/oauth2/auth']);
const REQUIRED_SINGLE_PARAMS = Object.freeze(['redirect_uri', 'client_id', 'response_type', 'state']);

/**
 * @param {unknown} url the candidate consent URL
 * @param {{ clientId?: unknown, state?: unknown, port?: unknown }|null|undefined} expect
 * @returns {{ verdict: 'OPEN'|'REJECT', reason: string }}
 */
export function classifyConsentUrl(url, expect) {
  const reject = (/** @type {string} */ reason) => ({ verdict: /** @type {'REJECT'} */ ('REJECT'), reason });
  try {
    if (!expect || typeof expect !== 'object') return reject('no_expectation');
    const { clientId, state, port } = expect;
    if (typeof clientId !== 'string' || !clientId) return reject('no_client_id');
    if (typeof state !== 'string' || !state) return reject('no_state');
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return reject('no_port');
    if (typeof url !== 'string' || !url) return reject('not_a_string');

    /** @type {URL} */
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject('parse_error');
    }
    if (u.protocol !== 'https:') return reject('protocol');
    if (u.hostname !== CONSENT_HOST) return reject('hostname');
    if (u.username !== '' || u.password !== '') return reject('credentials');
    if (u.port !== '') return reject('explicit_port');
    // The URL parser normalizes a default port away (`https://accounts.google.com:443/` -> port ''), so
    // the raw authority is checked too: any `:` or `@` in it means an explicit port or userinfo.
    const authority = /^https:\/\/([^/\\?#]*)/i.exec(url.trim());
    if (!authority || /[:@]/.test(authority[1])) return reject('explicit_port');
    if (!CONSENT_PATHS.includes(u.pathname)) return reject('pathname');

    for (const name of REQUIRED_SINGLE_PARAMS) {
      if (u.searchParams.getAll(name).length !== 1) return reject(`param_count_${name}`);
    }
    if (u.searchParams.get('response_type') !== 'code') return reject('response_type');
    if (u.searchParams.get('client_id') !== clientId) return reject('client_id');
    if (u.searchParams.get('state') !== state) return reject('state');

    /** @type {URL} */
    let r;
    try {
      r = new URL(/** @type {string} */ (u.searchParams.get('redirect_uri')));
    } catch {
      return reject('redirect_parse_error');
    }
    if (r.protocol !== 'http:') return reject('redirect_protocol');
    if (r.hostname !== 'localhost' && r.hostname !== '127.0.0.1') return reject('redirect_hostname');
    if (r.username !== '' || r.password !== '') return reject('redirect_credentials');
    if (r.port === '' || Number(r.port) !== port) return reject('redirect_port');

    return { verdict: 'OPEN', reason: 'ok' };
  } catch {
    return reject('unexpected');
  }
}

/**
 * Convenience for callers holding an API body field pair: returns the URL only when it classifies OPEN.
 * @param {unknown} url
 * @param {unknown} expect
 * @returns {string|null}
 */
export function openableConsentUrl(url, expect) {
  return classifyConsentUrl(url, /** @type {any} */ (expect)).verdict === 'OPEN' ? /** @type {string} */ (url) : null;
}
