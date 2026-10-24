// @ts-check
/**
 * Pure LinkedIn list-page classification and pagination-stop rules, kept out of the adapter so the adapter
 * stays free of browser-layer imports (test/safety.test.js).
 */

/**
 * A page must carry at least this share of page 1's unique parsed cards (and never fewer than 10) for
 * pagination to continue; maxPages stays the hard stop.
 * @param {number} page1Parsed
 */
export function pageStopThreshold(page1Parsed) {
  return Math.max(0.8 * (Number.isFinite(page1Parsed) ? page1Parsed : 0), 10);
}

/** @param {unknown} v */
const normParam = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The closed set of list-page classifications, in priority order. */
export const LIST_CLASSES = Object.freeze(['login', 'throttle_or_block', 'results', 'explicit_empty', 'end_of_results', 'unhydrated_after_retry', 'unknown']);

/** Classes the run loop counts as a wall (the source stops and the backoff counter advances). */
export const WALL_CLASSES = Object.freeze(['login', 'throttle_or_block', 'unhydrated_after_retry', 'unknown']);

const LOGIN_PATH = /^\/(login|checkpoint|authwall|uas)(\/|$)/i;

/**
 * TOTAL classification of one list page: every input maps to exactly one class, tested in this fixed
 * priority order, and `unknown` is the default branch.
 *
 *   1. login               final path is /login, /authwall, /checkpoint or /uas, or a guest-interstitial or
 *                          inline login-form marker is present
 *   2. throttle_or_block   HTTP 403/429, a cf-mitigated header, or a challenge/captcha marker
 *   3. results             at least one mapCard-valid card with an id (the caller counts them, `deduped`)
 *   4. explicit_empty      LinkedIn's own no-results selector is present
 *   5. end_of_results      pageIndex > 1; page 1 of the same query in the same run parsed >= 1 card; HTTP 200;
 *                          the page AFFIRMATIVELY looks like a LinkedIn search (shell) at a non-login path;
 *                          and the final URL kept the requested keywords and location
 *   6. unhydrated_after_retry   the page was reloaded once, waited on again, and still has neither cards, an
 *                          empty-state selector nor the search shell: the Ember app never rendered
 *   7. unknown             anything else (for example the shell with no cards, or a skeleton that could not
 *                          be reloaded because the per-run reload cap was spent)
 *
 * login is checked before any hydration wait, and a skeleton page carries none of the markers above, so a
 * skeleton can never be mistaken for a login or a block. `unhydrated_after_retry` and `unknown` count as
 * walls; the caller turns them into a wall event.
 * @param {{ pageIndex: number, page1Parsed: number, deduped: number, status?: number|null, finalPath?: string, cfMitigated?: string|null, requested: { keywords: string, location: string }, shell?: { shell?: boolean, path?: string, keywords?: string|null, location?: string|null }|null, markers?: any, emptyState?: boolean, retried?: boolean }} p
 * @returns {{ classification: 'login'|'throttle_or_block'|'results'|'explicit_empty'|'end_of_results'|'unhydrated_after_retry'|'unknown', reason: string }}
 */
export function classifyLinkedInPage(p) {
  const m = p.markers ?? {};
  if (typeof p.finalPath === 'string' && LOGIN_PATH.test(p.finalPath)) return { classification: 'login', reason: 'wall_path' };
  if (m.guestInterstitial) return { classification: 'login', reason: 'guest_interstitial' };
  if (m.loginForm) return { classification: 'login', reason: 'login_form' };
  const status = p.status ?? null;
  if (status === 403 || status === 429) return { classification: 'throttle_or_block', reason: `http_${status}` };
  if (p.cfMitigated) return { classification: 'throttle_or_block', reason: 'cf_mitigated' };
  if (m.challengeCloudflare) return { classification: 'throttle_or_block', reason: 'cloudflare_challenge' };
  if (m.challengeForm) return { classification: 'throttle_or_block', reason: 'challenge_form' };
  if (m.recaptcha) return { classification: 'throttle_or_block', reason: 'recaptcha' };
  if (p.deduped > 0) return { classification: 'results', reason: 'parsed' };
  if (p.emptyState) return { classification: 'explicit_empty', reason: 'empty_state_marker' };
  const sh = p.shell;
  const shellPathOk = !!sh && typeof sh.path === 'string' && !LOGIN_PATH.test(sh.path) && /^\/jobs\/search/i.test(sh.path);
  const sameQuery = !!sh && normParam(sh.keywords) === normParam(p.requested.keywords) && normParam(sh.location) === normParam(p.requested.location);
  if (p.pageIndex > 1 && p.page1Parsed >= 1 && status === 200 && !!sh && sh.shell === true && shellPathOk && sameQuery) {
    return { classification: 'end_of_results', reason: 'search_shell_no_cards' };
  }
  if (p.retried === true && !(sh && sh.shell === true)) return { classification: 'unhydrated_after_retry', reason: 'no_cards_no_shell_after_reload' };
  return { classification: 'unknown', reason: sh && sh.shell === true ? 'shell_no_cards' : 'no_results_no_marker' };
}
