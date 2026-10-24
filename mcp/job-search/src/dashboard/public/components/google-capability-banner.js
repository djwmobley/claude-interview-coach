// @ts-check
/**
 * Home page red banner for a broken Google capability (sql/029): the server's one-line text (for example
 * "Gmail send BROKEN since 2026-10-20 (4 days): read OK, last good send ... Re-authorize on dashboard.") plus
 * the existing Re-authorize Google control, reused from the Run scan drawer (renderGoogleAuthRow) so there is
 * exactly one re-authorization flow. Nothing renders when every capability is fine or unknown.
 */
import { h } from '../lib/dom.js';
import { getJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { renderGoogleAuthRow } from './run-scan-drawer.js';

/**
 * @param {{ broken?: boolean, line?: string|null }|null|undefined} body GET /api/google/capabilities body
 * @returns {HTMLElement|null} null when nothing is broken
 */
export function googleCapabilityBanner(body) {
  if (!body || body.broken !== true || typeof body.line !== 'string' || body.line === '') return null;
  const host = h('div', { className: 'google-capability-banner__auth' });
  const el = h('div', { className: 'banner banner--error google-capability-banner', attrs: { role: 'alert' } }, [
    h('div', { className: 'google-capability-banner__text' }, [
      h('strong', { text: body.line }),
      host,
    ]),
  ]);
  // The auth row is advisory; a failed fetch leaves the banner text alone.
  getJson('/api/google/auth').then((outcome) => renderGoogleAuthRow(host, handleOutcome(outcome)));
  return el;
}
