// @ts-check
/**
 * Google OAuth reuse (spec section 8) for follow-up reminders.
 *
 * - Reads the workspace-mcp token file READ-ONLY. That server owns and
 *   rewrites the file; this module never writes it back.
 * - Refreshes the access token IN MEMORY through google-auth-library's
 *   OAuth2Client built from the file's client_id / client_secret /
 *   refresh_token.
 * - Never logs token values. Only has_refresh_token, scopes_ok, expiry.
 * - Gmail send and Calendar event CRUD go through plain HTTP against the
 *   REST endpoints with an injectable `fetch` so tests stub the network.
 */
import fs from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { JobSearchError } from './errors.js';

export const SCOPE_GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
export const SCOPE_GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const SCOPE_GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
export const SCOPE_CALENDAR_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
export const SCOPE_CALENDAR_FULL = 'https://www.googleapis.com/auth/calendar';

export const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
export const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
export const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/**
 * @typedef {Object} TokenFile
 * @property {string} client_id
 * @property {string} client_secret
 * @property {string|null} refresh_token
 * @property {string|null} access_token
 * @property {string[]} scopes
 * @property {string|null} expiry ISO string as stored (naive UTC from the Python writer)
 * @property {string} token_uri
 */

/**
 * @typedef {Object} TokenInfo scalar summary safe to log
 * @property {boolean} has_refresh_token
 * @property {boolean} gmail_send_ok
 * @property {boolean} gmail_read_ok
 * @property {boolean} calendar_ok
 * @property {string|null} expiry
 * @property {number} scope_count
 */

/**
 * Parse the token file. Throws a JobSearchError naming the file (never its
 * contents) when missing or malformed.
 * @param {string} file
 * @returns {TokenFile}
 */
export function readTokenFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new JobSearchError('NOT_FOUND', `google token file not readable: ${file}`, { hint: 'run the workspace-mcp auth flow so the token file exists' });
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new JobSearchError('VALIDATION', `google token file is not valid JSON: ${file}`);
  }
  if (!j || typeof j !== 'object' || typeof j.client_id !== 'string' || typeof j.client_secret !== 'string') {
    throw new JobSearchError('VALIDATION', `google token file lacks client_id/client_secret: ${file}`);
  }
  return {
    client_id: j.client_id,
    client_secret: j.client_secret,
    refresh_token: typeof j.refresh_token === 'string' ? j.refresh_token : null,
    access_token: typeof j.token === 'string' ? j.token : typeof j.access_token === 'string' ? j.access_token : null,
    scopes: Array.isArray(j.scopes) ? j.scopes.map(String) : typeof j.scope === 'string' ? j.scope.split(/\s+/) : [],
    expiry: typeof j.expiry === 'string' ? j.expiry : null,
    token_uri: typeof j.token_uri === 'string' ? j.token_uri : 'https://oauth2.googleapis.com/token',
  };
}

/**
 * Scalar summary for logging. Contains no secret material.
 * @param {TokenFile} t
 * @returns {TokenInfo}
 */
export function tokenInfo(t) {
  const scopes = new Set(t.scopes);
  return {
    has_refresh_token: Boolean(t.refresh_token),
    gmail_send_ok: scopes.has(SCOPE_GMAIL_SEND),
    gmail_read_ok: scopes.has(SCOPE_GMAIL_READONLY) || scopes.has(SCOPE_GMAIL_MODIFY),
    calendar_ok: scopes.has(SCOPE_CALENDAR_EVENTS) || scopes.has(SCOPE_CALENDAR_FULL),
    expiry: t.expiry,
    scope_count: t.scopes.length,
  };
}

/**
 * Require the scopes a caller needs; throws naming the file and the scope.
 * @param {TokenFile} t
 * @param {string} file
 * @param {{ gmail?: boolean, gmailRead?: boolean, calendar?: boolean }} need
 */
export function assertScopes(t, file, need) {
  const info = tokenInfo(t);
  if (!info.has_refresh_token) throw new JobSearchError('VALIDATION', `google token file has no refresh_token: ${file}`);
  if (need.gmail && !info.gmail_send_ok) throw new JobSearchError('VALIDATION', `google token file lacks scope ${SCOPE_GMAIL_SEND}: ${file}`);
  if (need.gmailRead && !info.gmail_read_ok) throw new JobSearchError('VALIDATION', `google token file lacks scope ${SCOPE_GMAIL_READONLY} or ${SCOPE_GMAIL_MODIFY}: ${file}`);
  if (need.calendar && !info.calendar_ok) throw new JobSearchError('VALIDATION', `google token file lacks scope ${SCOPE_CALENDAR_EVENTS}: ${file}`);
}

/**
 * Parse the Python-written naive expiry ("2026-08-12T04:36:05") as UTC.
 * @param {string|null} expiry
 * @returns {number|null} epoch ms
 */
export function expiryMs(expiry) {
  if (!expiry) return null;
  const s = /[zZ]|[+-]\d{2}:\d{2}$/.test(expiry) ? expiry : expiry + 'Z';
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Build an OAuth2Client with the file's credentials loaded. Nothing is
 * persisted: google-auth-library keeps the refreshed token on the instance.
 * @param {TokenFile} t
 */
export function makeOAuthClient(t) {
  const client = new OAuth2Client({ clientId: t.client_id, clientSecret: t.client_secret });
  client.setCredentials({
    refresh_token: t.refresh_token ?? undefined,
    access_token: t.access_token ?? undefined,
    expiry_date: expiryMs(t.expiry) ?? undefined,
  });
  return client;
}

/**
 * Current access token, refreshed in memory when expired. The returned
 * string is used only in an Authorization header and never logged.
 * @param {OAuth2Client} client
 * @returns {Promise<{ token: string, expiry: string|null }>}
 */
export async function getAccessToken(client) {
  let token;
  try {
    const r = await client.getAccessToken();
    token = r.token ?? null;
  } catch (err) {
    // Google's error string (e.g. invalid_grant) is diagnostic, not secret; token values never appear in it.
    const why = err && typeof err === 'object' && 'message' in err ? String(/** @type {{ message: unknown }} */ (err).message).slice(0, 80) : 'unknown';
    throw new JobSearchError('VALIDATION', `google token refresh failed: ${why} (re-run the workspace-mcp auth flow if the grant was revoked)`, {
      details: { err_code: /** @type {{ code?: string }} */ (err ?? {}).code ?? null },
    });
  }
  if (!token) throw new JobSearchError('VALIDATION', 'google token refresh returned no access token');
  const exp = client.credentials.expiry_date ? new Date(client.credentials.expiry_date).toISOString() : null;
  return { token, expiry: exp };
}

/**
 * base64url without padding (Gmail `raw`).
 * @param {string} s
 */
export function base64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Minimal RFC 2822 text message. Header values are folded to a single line
 * and control characters stripped so no injected header can appear.
 * @param {{ to: string, from?: string, subject: string, body: string, date?: Date }} m
 */
export function buildRfc2822(m) {
  const clean = (/** @type {string} */ s) => String(s).replace(/[\r\n]+/g, ' ').trim();
  const lines = [
    `To: ${clean(m.to)}`,
    m.from ? `From: ${clean(m.from)}` : null,
    `Subject: ${clean(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(m.body).replace(/\r?\n/g, '\r\n'),
  ].filter((l) => l !== null);
  return lines.join('\r\n');
}

/**
 * Multipart/alternative RFC 2822 message (plain text + HTML), for the scan report (spec R1.2). Same
 * header-injection guard as buildRfc2822; a random boundary avoids any collision with body content.
 * @param {{ to: string, from?: string, subject: string, text: string, html: string, date?: Date }} m
 */
export function buildRfc2822Multipart(m) {
  const clean = (/** @type {string} */ s) => String(s).replace(/[\r\n]+/g, ' ').trim();
  const boundary = `job-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const lines = [
    `To: ${clean(m.to)}`,
    m.from ? `From: ${clean(m.from)}` : null,
    `Subject: ${clean(m.subject)}`,
    `Date: ${(m.date ?? new Date()).toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(m.text).replace(/\r?\n/g, '\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    String(m.html).replace(/\r?\n/g, '\r\n'),
    '',
    `--${boundary}--`,
  ].filter((l) => l !== null);
  return lines.join('\r\n');
}

/**
 * @typedef {Object} HttpDeps
 * @property {typeof fetch} fetch
 * @property {string} accessToken
 */

/**
 * @param {Response} res
 * @param {string} what
 */
async function requireOk(res, what) {
  if (res.ok) return;
  let detail = '';
  try {
    const j = await res.json();
    detail = j && j.error && j.error.message ? String(j.error.message).slice(0, 200) : '';
  } catch {
    /* body not JSON */
  }
  throw new JobSearchError('INTERNAL', `${what} failed: HTTP ${res.status}${detail ? ' ' + detail : ''}`, { details: { status: res.status } });
}

/**
 * Send one message. Returns the Gmail message id on 2xx; throws otherwise.
 * @param {HttpDeps} deps
 * @param {string} rfc2822
 * @returns {Promise<string>}
 */
export async function gmailSend(deps, rfc2822) {
  const res = await deps.fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deps.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64url(rfc2822) }),
  });
  await requireOk(res, 'gmail send');
  const j = await res.json();
  return String(j.id ?? '');
}

/**
 * Insert a calendar event on the primary calendar. Returns the event id.
 * @param {HttpDeps} deps
 * @param {{ summary: string, description: string, startIso: string, endIso: string, reminderMinutes?: number }} ev
 * @returns {Promise<string>}
 */
export async function calendarInsertEvent(deps, ev) {
  const body = {
    summary: ev.summary,
    description: ev.description,
    start: { dateTime: ev.startIso },
    end: { dateTime: ev.endIso },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: ev.reminderMinutes ?? 60 }] },
  };
  const res = await deps.fetch(CALENDAR_EVENTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deps.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await requireOk(res, 'calendar insert');
  const j = await res.json();
  return String(j.id ?? '');
}

/**
 * Delete a calendar event. 404/410 count as already gone.
 * @param {HttpDeps} deps
 * @param {string} eventId
 */
export async function calendarDeleteEvent(deps, eventId) {
  const res = await deps.fetch(`${CALENDAR_EVENTS_URL}/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${deps.accessToken}` },
  });
  if (res.status === 404 || res.status === 410) return;
  await requireOk(res, 'calendar delete');
}

/**
 * Convenience: load the token file, check scopes, and return the HTTP deps
 * plus a scalar info block. Used by remind.js and the followups tool.
 * @param {{ tokenFile: string, fetch?: typeof fetch, need: { gmail?: boolean, gmailRead?: boolean, calendar?: boolean } }} opts
 * @returns {Promise<{ deps: HttpDeps, info: TokenInfo, expiry: string|null }>}
 */
export async function googleHttp(opts) {
  const t = readTokenFile(opts.tokenFile);
  assertScopes(t, opts.tokenFile, opts.need);
  const client = makeOAuthClient(t);
  const { token, expiry } = await getAccessToken(client);
  return { deps: { fetch: opts.fetch ?? fetch, accessToken: token }, info: tokenInfo(t), expiry };
}
