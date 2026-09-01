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

/** Base for every calendar events endpoint; a specific calendar's events URL is built from this. */
export const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3/calendars';

/** @param {string} calendarId */
export function calendarEventsUrl(calendarId) {
  return `${CALENDAR_BASE_URL}/${encodeURIComponent(calendarId)}/events`;
}

/** Kept for existing callers (calendarInsertEvent/calendarDeleteEvent default to the primary calendar). */
export const CALENDAR_EVENTS_URL = calendarEventsUrl('primary');

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
    // .filter(Boolean): a scope string like " a  b " (leading space, double space) splits to
    // ['', 'a', 'b'] -- the empty leading element must never survive into a "stored scopes" array that
    // classifyGoogleTokenState/assertScopes treat as authoritative (health-check spec, token state
    // classification).
    scopes: Array.isArray(j.scopes) ? j.scopes.map(String).filter(Boolean) : typeof j.scope === 'string' ? j.scope.split(/\s+/).filter(Boolean) : [],
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

// ---------------------------------------------------------------------------
// Token state classification (auth-health hardening): a total classification of the current Google
// auth state for a caller's `need`, so a dead refresh grant, a missing scope, or an unreadable token
// file are distinguished from each other instead of collapsing into one generic "not connected" state.
// Never logs or returns token values -- only the classification slug, an expiry, a scope list, or an
// 80-char-capped diagnostic code.
// ---------------------------------------------------------------------------

/** Cap for any raw-error-derived diagnostic string surfaced in a classification (never a token value). */
const OAUTH_FIELD_MAX = 80;

/**
 * @typedef {
 *   | { state: 'ok', expiry: string|null }
 *   | { state: 'broken_missing_file' }
 *   | { state: 'broken_malformed' }
 *   | { state: 'broken_no_refresh_token' }
 *   | { state: 'broken_missing_scopes', missing: string[] }
 *   | { state: 'broken_invalid_grant' }
 *   | { state: 'broken_refresh_error', code: string }
 * } GoogleTokenState
 */

/** Fixed, code-authored hint text per classification branch -- NEVER built from raw error text. */
export const GOOGLE_TOKEN_STATE_HINTS = Object.freeze({
  broken_missing_file: 'Run the workspace-mcp auth flow so the token file exists.',
  broken_malformed: 'The token file is unreadable or missing required fields; re-run the workspace-mcp auth flow to regenerate it.',
  broken_no_refresh_token: 'The token file has no refresh token; re-run the workspace-mcp auth flow to obtain one.',
  broken_missing_scopes: 'The token is missing required scopes; re-run the workspace-mcp auth flow to re-consent with the full scope set.',
  broken_invalid_grant: 'The refresh grant was revoked or expired. Re-run the workspace-mcp auth flow to re-authorize; if this recurs weekly, publish the OAuth app to Production in Google Cloud Console (a Testing-mode consent screen expires refresh tokens after 7 days).',
  broken_refresh_error: 'Google token refresh failed unexpectedly; check connectivity and retry, or re-run the workspace-mcp auth flow if it persists.',
});
/** Fallback hint for a classification slug this map does not recognize (defensive; every real state above is covered). */
export const DEFAULT_GOOGLE_TOKEN_STATE_HINT = 'Google Calendar is not connected; re-run the workspace-mcp auth flow.';

/**
 * Missing raw scope URIs (post readTokenFile normalization, i.e. already .filter(Boolean)'d) for
 * `need`, relative to `t.scopes`. `gmailRead` and `calendar` are either-of pairs: both alternative
 * scope URIs are listed when neither is present, so the caller sees exactly what would satisfy the
 * requirement.
 * @param {TokenFile} t
 * @param {{ gmail?: boolean, gmailRead?: boolean, calendar?: boolean }} need
 * @returns {string[]}
 */
function computeMissingScopes(t, need) {
  const info = tokenInfo(t);
  /** @type {string[]} */
  const missing = [];
  if (need.gmail && !info.gmail_send_ok) missing.push(SCOPE_GMAIL_SEND);
  if (need.gmailRead && !info.gmail_read_ok) missing.push(SCOPE_GMAIL_READONLY, SCOPE_GMAIL_MODIFY);
  if (need.calendar && !info.calendar_ok) missing.push(SCOPE_CALENDAR_EVENTS, SCOPE_CALENDAR_FULL);
  return missing;
}

/**
 * The structured OAuth error field from a live refresh failure, read before any substring fallback
 * (empirically confirmed against a real expired grant: a Gaxios-shaped err.response.data.error of
 * "invalid_grant" -- see the probe referenced in this PR's description). Two shapes are checked: a
 * JobSearchError thrown by this module's own getAccessToken() (details.oauth_error, set below) and a
 * raw, unwrapped Gaxios-shaped error (response.data.error) for callers/tests that inject a refresh
 * function throwing the raw shape directly.
 * @param {unknown} err
 * @returns {string|null}
 */
function structuredOAuthError(err) {
  if (!err || typeof err !== 'object') return null;
  const anyErr = /** @type {any} */ (err);
  if (anyErr.details && typeof anyErr.details.oauth_error === 'string' && anyErr.details.oauth_error) return anyErr.details.oauth_error;
  const field = anyErr.response && anyErr.response.data && anyErr.response.data.error;
  return typeof field === 'string' && field ? field : null;
}

/**
 * Transport-level error code (e.g. ECONNRESET), read from the same two shapes structuredOAuthError()
 * checks: a JobSearchError's details.err_code (this module's getAccessToken() puts the raw err.code
 * there, since JobSearchError's own `.code` is always the fixed literal 'VALIDATION'), or a raw error's
 * own `.code`.
 * @param {unknown} err
 * @returns {string|number|null}
 */
function transportCode(err) {
  if (!err || typeof err !== 'object') return null;
  const anyErr = /** @type {any} */ (err);
  if (anyErr.details && anyErr.details.err_code !== undefined && anyErr.details.err_code !== null) return anyErr.details.err_code;
  if (anyErr.code !== undefined && anyErr.code !== null) return anyErr.code;
  return null;
}

/**
 * Classify a live refresh failure (spec: checking order's final step). The structured OAuth error
 * field is authoritative when present (so invalid_client, access_denied, etc. are visible in
 * broken_refresh_error.code rather than being silently bucketed away); a bare substring match on
 * err.message is the fallback ONLY when no structured field exists.
 * @param {unknown} err
 * @returns {GoogleTokenState}
 */
function classifyRefreshError(err) {
  const structured = structuredOAuthError(err);
  if (structured === 'invalid_grant') return { state: 'broken_invalid_grant' };
  if (structured) return { state: 'broken_refresh_error', code: structured.slice(0, OAUTH_FIELD_MAX) };
  const message = err && typeof err === 'object' && typeof (/** @type {any} */ (err).message) === 'string' ? /** @type {any} */ (err).message : '';
  if (/invalid_grant/.test(message)) return { state: 'broken_invalid_grant' };
  const code = transportCode(err);
  const codeStr = code !== null && code !== undefined ? String(code) : 'unknown';
  return { state: 'broken_refresh_error', code: codeStr.slice(0, OAUTH_FIELD_MAX) };
}

/**
 * File-shape and scope checks only (spec checking order: broken_missing_file -> broken_malformed ->
 * broken_no_refresh_token -> broken_missing_scopes), before any network call. Returns either an early
 * broken_* state or the parsed TokenFile to proceed with a live refresh.
 * @param {string} tokenFile
 * @param {{ gmail?: boolean, gmailRead?: boolean, calendar?: boolean }} need
 * @param {{ readTokenFile?: typeof readTokenFile }} [deps]
 * @returns {{ early: GoogleTokenState } | { t: TokenFile }}
 */
function preflightTokenState(tokenFile, need, deps = {}) {
  const _readTokenFile = deps.readTokenFile ?? readTokenFile;
  /** @type {TokenFile} */
  let t;
  try {
    t = _readTokenFile(tokenFile);
  } catch (err) {
    if (err instanceof JobSearchError && err.code === 'NOT_FOUND') return { early: { state: 'broken_missing_file' } };
    return { early: { state: 'broken_malformed' } };
  }
  const rt = t.refresh_token;
  if (rt === null || rt === undefined || (typeof rt === 'string' && rt.trim() === '')) {
    return { early: { state: 'broken_no_refresh_token' } };
  }
  const missing = computeMissingScopes(t, need);
  if (missing.length) return { early: { state: 'broken_missing_scopes', missing } };
  return { t };
}

/**
 * Like classifyGoogleTokenState, but also returns the live access token on state 'ok' so a single live
 * refresh attempt serves both the classification and the actual API deps a caller needs (e.g.
 * calendar-provider.js, gmail.js's pre-flight): avoids a second live refresh in the same call.
 * classifyGoogleTokenState itself is a thin wrapper around this that drops the token, since the spec's
 * return type for that function is the classification only.
 * @param {string} tokenFile
 * @param {{ gmail?: boolean, gmailRead?: boolean, calendar?: boolean }} need
 * @param {{ readTokenFile?: typeof readTokenFile, makeOAuthClient?: typeof makeOAuthClient, getAccessToken?: typeof getAccessToken }} [deps] test seam
 * @returns {Promise<{ state: GoogleTokenState, accessToken: string|null }>}
 */
export async function classifyAndConnect(tokenFile, need, deps = {}) {
  const pre = preflightTokenState(tokenFile, need, deps);
  if ('early' in pre) return { state: pre.early, accessToken: null };
  const _makeOAuthClient = deps.makeOAuthClient ?? makeOAuthClient;
  const _getAccessToken = deps.getAccessToken ?? getAccessToken;
  /** @type {OAuth2Client} */
  let client;
  try {
    client = _makeOAuthClient(pre.t);
  } catch (err) {
    // makeOAuthClient never throws for a TokenFile that already passed preflightTokenState's field
    // checks in production; this only guards a test-injected fake deps.makeOAuthClient that throws --
    // classified the same as any other pre-refresh shape problem rather than an unhandled rejection.
    return { state: { state: 'broken_malformed' }, accessToken: null };
  }
  try {
    const { token, expiry } = await _getAccessToken(client);
    return { state: { state: 'ok', expiry }, accessToken: token };
  } catch (err) {
    return { state: classifyRefreshError(err), accessToken: null };
  }
}

/**
 * Classify the current Google auth state for `need` (health-check spec, "token state classification").
 * No live network call happens unless the file-shape and scope checks all pass (preflightTokenState);
 * the live refresh, when it happens, is the SAME single attempt classifyAndConnect makes. Never logs or
 * returns token values.
 * @param {string} tokenFile
 * @param {{ gmail?: boolean, gmailRead?: boolean, calendar?: boolean }} need
 * @param {{ readTokenFile?: typeof readTokenFile, makeOAuthClient?: typeof makeOAuthClient, getAccessToken?: typeof getAccessToken }} [deps] test seam
 * @returns {Promise<GoogleTokenState>}
 */
export async function classifyGoogleTokenState(tokenFile, need, deps = {}) {
  const { state } = await classifyAndConnect(tokenFile, need, deps);
  return state;
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
    const anyErr = /** @type {any} */ (err ?? {});
    const why = err && typeof err === 'object' && 'message' in err ? String(anyErr.message).slice(0, 80) : 'unknown';
    // oauth_error preserves the structured Gaxios error body (response.data.error, e.g. "invalid_grant"
    // or "invalid_client") so classifyRefreshError() in this module can classify precisely instead of
    // falling back to a substring match on the message text above.
    const oauthError = anyErr.response && anyErr.response.data && typeof anyErr.response.data.error === 'string' ? anyErr.response.data.error : null;
    throw new JobSearchError('VALIDATION', `google token refresh failed: ${why} (re-run the workspace-mcp auth flow if the grant was revoked)`, {
      details: { err_code: anyErr.code ?? null, oauth_error: oauthError },
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
 * List events on a calendar within a window, paging through `nextPageToken` until either the API stops
 * returning one or `maxResults` events have been collected (spec: dashboard 14-day agenda).
 * `singleEvents=true&orderBy=startTime` so a recurring event expands into its individual instances in
 * chronological order rather than one master event with no date.
 * @param {HttpDeps} deps
 * @param {{ timeMin: string, timeMax: string, maxResults?: number, calendarId?: string }} opts
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function calendarListEvents(deps, opts) {
  const calendarId = opts.calendarId ?? 'primary';
  const maxResults = opts.maxResults ?? 250;
  const url = calendarEventsUrl(calendarId);
  /** @type {Array<Record<string, unknown>>} */
  const items = [];
  /** @type {string|undefined} */
  let pageToken;
  do {
    const params = new URLSearchParams({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.max(1, Math.min(250, maxResults - items.length))),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await deps.fetch(`${url}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${deps.accessToken}` },
    });
    await requireOk(res, 'calendar list');
    const j = await res.json();
    for (const item of Array.isArray(j.items) ? j.items : []) {
      items.push(item);
      if (items.length >= maxResults) break;
    }
    pageToken = items.length < maxResults ? j.nextPageToken : undefined;
  } while (pageToken);
  return items;
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
 * Attach a GoogleTokenState classification to a thrown error as a non-enumerable-ish plain property
 * (`.tokenState`), so a caller that already has its own try/catch around googleHttp() (remind.js,
 * calendar-provider.js) can read the classification off the SAME error instead of re-deriving it or
 * making a second live network attempt. Never changes the error's own code/message -- purely additive.
 * @template {Error} E
 * @param {E} err
 * @param {GoogleTokenState} state
 * @returns {E}
 */
function attachTokenState(err, state) {
  /** @type {any} */ (err).tokenState = state;
  return err;
}

/**
 * Convenience: load the token file, check scopes, and return the HTTP deps plus a scalar info block.
 * Used by remind.js and the followups tool. Every thrown error and the success return also carry a
 * `tokenState` (GoogleTokenState) classification -- see attachTokenState() -- built from the SAME
 * read/scope-check/refresh attempt this function already makes, so a caller never needs a second live
 * refresh just to classify the outcome. Thrown error codes/messages are unchanged from before this
 * classification was added (readTokenFile/assertScopes/getAccessToken still throw exactly as they did).
 * @param {{ tokenFile: string, fetch?: typeof fetch, need: { gmail?: boolean, gmailRead?: boolean, calendar?: boolean } }} opts
 * @returns {Promise<{ deps: HttpDeps, info: TokenInfo, expiry: string|null, tokenState: GoogleTokenState }>}
 */
export async function googleHttp(opts) {
  /** @type {TokenFile} */
  let t;
  try {
    t = readTokenFile(opts.tokenFile);
  } catch (err) {
    throw attachTokenState(/** @type {Error} */ (err), err instanceof JobSearchError && err.code === 'NOT_FOUND' ? { state: 'broken_missing_file' } : { state: 'broken_malformed' });
  }
  const rt = t.refresh_token;
  const noRefreshToken = rt === null || rt === undefined || (typeof rt === 'string' && rt.trim() === '');
  const missing = computeMissingScopes(t, opts.need);
  try {
    assertScopes(t, opts.tokenFile, opts.need);
  } catch (err) {
    throw attachTokenState(/** @type {Error} */ (err), noRefreshToken ? { state: 'broken_no_refresh_token' } : { state: 'broken_missing_scopes', missing });
  }
  const client = makeOAuthClient(t);
  try {
    const { token, expiry } = await getAccessToken(client);
    return { deps: { fetch: opts.fetch ?? fetch, accessToken: token }, info: tokenInfo(t), expiry, tokenState: { state: 'ok', expiry } };
  } catch (err) {
    throw attachTokenState(/** @type {Error} */ (err), classifyRefreshError(err));
  }
}
