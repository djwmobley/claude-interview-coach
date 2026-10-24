// @ts-check
/**
 * Per-capability Google health (sql/029, ic_google_capability): read, send and calendar are tracked
 * separately, because one grant can lose a scope or a use while the others keep working. Gmail auth was dead
 * 2026-10-20 to 2026-10-24 and the only trace was a log line; the report now opens with the broken capability,
 * how long it has been broken, the last good time, and the missing scopes, and the dashboard home shows a red
 * banner.
 *
 * A capability is GOOD when a token refresh succeeded and the token holds that capability's scope; BROKEN when
 * the refresh failed (every capability) or the scope is missing (that capability). Callers: remind.js (every
 * report run), the Gmail adapter's scan pass (read), and a confirmed send (send).
 */
import { SCOPE_GMAIL_READONLY, SCOPE_GMAIL_SEND, SCOPE_CALENDAR_EVENTS } from './google.js';
import { REAUTH_REQUIRED_SCOPES } from './google-reauth.js';

export const CAPABILITIES = Object.freeze(['read', 'send', 'calendar']);

/** Report/banner wording per capability. */
const CAPABILITY_LABEL = Object.freeze({ read: 'Gmail read', send: 'Gmail send', calendar: 'Google calendar' });

/** The REAUTH_REQUIRED_SCOPES entry that grants each capability. */
const CAPABILITY_SCOPE = Object.freeze({ read: SCOPE_GMAIL_READONLY, send: SCOPE_GMAIL_SEND, calendar: SCOPE_CALENDAR_EVENTS });

/** Every capability's required scope is a member of REAUTH_REQUIRED_SCOPES (asserted by test). */
export const CAPABILITY_REQUIRED_SCOPES = Object.freeze(CAPABILITIES.map((c) => /** @type {Record<string, string>} */ (CAPABILITY_SCOPE)[c]).filter((s) => REAUTH_REQUIRED_SCOPES.includes(s)));

/**
 * @typedef {{ capability: 'read'|'send'|'calendar', ok: boolean, state: string, missing: string[] }} CapabilityOutcome
 */

/**
 * Per-capability outcomes from one token classification. Total: every GoogleTokenState maps to a list (possibly
 * empty when nothing is known about a capability).
 *  ok                    each capability is good when its scope is present (info flags), else broken: missing scope
 *  broken_missing_scopes the capabilities whose scope is absent are broken; the rest are not known (the refresh
 *                        never ran), so no outcome is written for them
 *  any other broken_*    all three are broken, state recorded
 * @param {import('./google.js').GoogleTokenState} state
 * @param {{ gmail_read_ok: boolean, gmail_send_ok: boolean, calendar_ok: boolean }|null} [info] token scope flags; null = assume all present
 * @returns {CapabilityOutcome[]}
 */
export function outcomesFromTokenState(state, info = null) {
  const has = (/** @type {'read'|'send'|'calendar'} */ c) => {
    if (!info) return true;
    // A flag that is absent (a partial info object) is not evidence of a missing scope; only an explicit false is.
    return (c === 'read' ? info.gmail_read_ok : c === 'send' ? info.gmail_send_ok : info.calendar_ok) !== false;
  };
  /** @type {CapabilityOutcome[]} */
  const out = [];
  for (const capability of /** @type {const} */ (CAPABILITIES)) {
    if (state.state === 'ok') {
      out.push(has(capability)
        ? { capability, ok: true, state: 'ok', missing: [] }
        : { capability, ok: false, state: 'broken_missing_scopes', missing: [CAPABILITY_SCOPE[capability]] });
    } else if (state.state === 'broken_missing_scopes') {
      if (!has(capability) || state.missing.includes(CAPABILITY_SCOPE[capability])) {
        out.push({ capability, ok: false, state: 'broken_missing_scopes', missing: [CAPABILITY_SCOPE[capability]] });
      }
    } else {
      out.push({ capability, ok: false, state: state.state, missing: [] });
    }
  }
  return out;
}

/**
 * Write outcomes. A good outcome stamps last_good_at and clears broken_since; a failure stamps last_fail_at and
 * keeps the EARLIEST broken_since until a good outcome clears it.
 * @param {import('pg').ClientBase} client
 * @param {CapabilityOutcome[]} outcomes
 * @param {Date} [now]
 */
export async function recordCapabilityOutcomes(client, outcomes, now = new Date()) {
  for (const o of outcomes) {
    if (o.ok) {
      await client.query(
        `INSERT INTO ic_google_capability (capability, last_good_at, broken_since, last_state, missing_scopes, updated_at)
         VALUES ($1, $2, NULL, 'ok', '{}', $2)
         ON CONFLICT (capability) DO UPDATE SET last_good_at = $2, broken_since = NULL, last_state = 'ok', missing_scopes = '{}', updated_at = $2`,
        [o.capability, now],
      );
    } else {
      await client.query(
        `INSERT INTO ic_google_capability (capability, last_fail_at, broken_since, last_state, missing_scopes, updated_at)
         VALUES ($1, $2, $2, $3, $4::text[], $2)
         ON CONFLICT (capability) DO UPDATE SET last_fail_at = $2, broken_since = coalesce(ic_google_capability.broken_since, $2),
           last_state = $3, missing_scopes = $4::text[], updated_at = $2`,
        [o.capability, now, o.state, o.missing],
      );
    }
  }
}

/**
 * @param {import('pg').ClientBase} client
 * @returns {Promise<Array<{ capability: string, last_good_at: string|null, last_fail_at: string|null, broken_since: string|null, last_state: string|null, missing_scopes: string[] }>>}
 */
export async function collectGoogleCapability(client) {
  const r = await client.query('SELECT capability, last_good_at, last_fail_at, broken_since, last_state, missing_scopes FROM ic_google_capability ORDER BY capability');
  const iso = (/** @type {any} */ d) => (d ? new Date(d).toISOString() : null);
  return r.rows.map((x) => ({
    capability: String(x.capability), last_good_at: iso(x.last_good_at), last_fail_at: iso(x.last_fail_at), broken_since: iso(x.broken_since),
    last_state: x.last_state ?? null, missing_scopes: Array.isArray(x.missing_scopes) ? x.missing_scopes.map(String) : [],
  }));
}

/** @param {Date} now @param {string} since ISO */
function daysBetween(now, since) {
  return Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 86400000));
}

/**
 * The one-line banner, or null when nothing is broken. Total over its input: a capability with no row is
 * unknown (not reported as broken or OK); a broken capability with no last good time says "never".
 *   Gmail send BROKEN since 2026-10-20 (4 days): read OK, last good send 2026-10-19T23:00:00.000Z. Missing scopes: ... Re-authorize on dashboard.
 * @param {Array<{ capability: string, last_good_at: string|null, broken_since: string|null, missing_scopes?: string[], last_state?: string|null }>|null|undefined} rows
 * @param {Date} now
 * @returns {string|null}
 */
export function capabilityBannerLine(rows, now) {
  const list = Array.isArray(rows) ? rows : [];
  const byCap = new Map(list.map((r) => [r.capability, r]));
  const broken = CAPABILITIES.filter((c) => byCap.get(c)?.broken_since);
  if (broken.length === 0) return null;
  const okCaps = CAPABILITIES.filter((c) => byCap.has(c) && !byCap.get(c)?.broken_since && byCap.get(c)?.last_good_at);
  const earliest = broken.map((c) => /** @type {string} */ (byCap.get(c)?.broken_since)).sort()[0];
  const label = broken.map((c) => /** @type {Record<string, string>} */ (CAPABILITY_LABEL)[c]).join(', ');
  const days = daysBetween(now, earliest);
  const parts = [];
  if (okCaps.length) parts.push(okCaps.map((c) => `${c} OK`).join(', '));
  parts.push(broken.map((c) => `last good ${c} ${byCap.get(c)?.last_good_at ?? 'never'}`).join(', '));
  const missing = [...new Set(broken.flatMap((c) => byCap.get(c)?.missing_scopes ?? []))].filter((s) => REAUTH_REQUIRED_SCOPES.includes(s));
  const missingText = missing.length ? ` Missing scopes: ${missing.join(', ')}.` : '';
  return `${label} BROKEN since ${earliest.slice(0, 10)} (${days} day${days === 1 ? '' : 's'}): ${parts.join(', ')}.${missingText} Re-authorize on dashboard.`;
}
