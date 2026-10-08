// @ts-check
/**
 * Pure LinkedIn list-page classification and pagination-stop rules, kept out of the adapter so the adapter
 * stays free of browser-layer imports (test/safety.test.js).
 */
import { classifyPage } from '../browser/wall.js';

const BASE = 'https://www.linkedin.com';

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

/**
 * TOTAL classification of one list page: every input maps to exactly one of
 * cards / end_of_results / empty / wall / unrecognized, and unknown is the default branch.
 *
 * A zero-card page is END_OF_RESULTS only when ALL hold: pageIndex > 1; page 1 of the same query in the same
 * run parsed >= 1 card; HTTP 200; the existing wall classifier finds no challenge/captcha/login/interstitial
 * marker and no wall path; the page AFFIRMATIVELY looks like a LinkedIn search (shell) at a non-wall path;
 * and the final URL kept the requested keywords and location. Anything else falls to the wall classifier's
 * own verdict (wall, empty, unrecognized), unchanged.
 * @param {{ pageIndex: number, page1Parsed: number, deduped: number, status?: number|null, finalPath?: string, cfMitigated?: string|null, requested: { keywords: string, location: string }, shell?: { shell?: boolean, path?: string, keywords?: string|null, location?: string|null }|null, markers?: any, emptyState?: boolean }} p
 * @returns {{ classification: 'cards'|'end_of_results'|'empty'|'wall'|'unrecognized', reason: string }}
 */
export function classifyLinkedInPage(p) {
  if (p.deduped > 0) return { classification: 'cards', reason: 'parsed' };
  const m = p.markers ?? {};
  const v = classifyPage({
    parsed: 0, status: p.status ?? null, cfMitigated: p.cfMitigated ?? null, url: p.finalPath ? `${BASE}${p.finalPath}` : null,
    challengeCloudflare: !!m.challengeCloudflare, challengeForm: !!m.challengeForm, recaptcha: !!m.recaptcha,
    guestInterstitial: !!m.guestInterstitial, loginForm: !!m.loginForm, emptyState: !!p.emptyState,
  });
  if (v.kind === 'empty') return { classification: 'empty', reason: v.reason };
  if (v.kind === 'wall') return { classification: 'wall', reason: v.reason };
  const sh = p.shell;
  const shellPathOk = !!sh && typeof sh.path === 'string' && !/^\/(login|checkpoint|authwall|uas)(\/|$)/i.test(sh.path) && /^\/jobs\/search/i.test(sh.path);
  const sameQuery = !!sh && normParam(sh.keywords) === normParam(p.requested.keywords) && normParam(sh.location) === normParam(p.requested.location);
  if (p.pageIndex > 1 && p.page1Parsed >= 1 && p.status === 200 && !!sh && sh.shell === true && shellPathOk && sameQuery) {
    return { classification: 'end_of_results', reason: 'search_shell_no_cards' };
  }
  return { classification: 'unrecognized', reason: v.reason };
}
