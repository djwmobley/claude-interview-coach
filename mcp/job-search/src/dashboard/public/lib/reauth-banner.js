// @ts-check
/**
 * Every-page Google consent banner (2026-10-04 consent-link fix, spec S6): while a reauth helper is
 * waiting (GET /api/google/reauth's `running`), app.js shows a top-of-page banner carrying the
 * "Open Google sign-in" link, so a helper started by the scan's unattended policy or another tab
 * completes with one click from whatever page the operator is on, not only inside the run-scan drawer.
 *
 * Pure decision only; app.js does the rendering. The link is included only when it classifies OPEN
 * (lib/consent-url.js, the same check the server ran).
 */
import { openableConsentUrl } from './consent-url.js';

export const REAUTH_BANNER_KEY = 'google-reauth';

/**
 * @param {{ running?: unknown, consentUrl?: unknown, consentExpect?: unknown }|null} body GET /api/google/reauth body, or null when the GET failed
 * @param {string|null} dismissedUrl the link (or '' for the linkless banner) the operator dismissed in this tab
 * @returns {{ message: string, url: string|null }|null} null means "no banner"
 */
export function reauthBannerState(body, dismissedUrl) {
  if (!body || body.running !== true) return null;
  const url = openableConsentUrl(body.consentUrl, body.consentExpect);
  const key = url ?? '';
  if (dismissedUrl !== null && dismissedUrl === key) return null;
  return url
    ? { message: 'Google sign-in is waiting for your approval.', url }
    : { message: 'A Google sign-in helper is running; its sign-in link is not available yet.', url: null };
}
