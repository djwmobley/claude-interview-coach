// @ts-check
/**
 * Gmail job-alert adapter (fetch): reads the owner's Gmail inbox read-only
 * for job-alert digest emails from senders listed in config/alert-senders.json
 * (LinkedIn, Indeed, Lensa, Ladders today) and yields RawListings through the
 * per-sender parsers in gmail-parsers.js.
 *
 *   list    GET https://gmail.googleapis.com/gmail/v1/users/me/messages?q=...&maxResults=50&pageToken=...
 *   get     GET https://gmail.googleapis.com/gmail/v1/users/me/messages/<id>?format=full
 *
 * Auth reuses src/core/google.js exactly as remind.js does: the workspace-mcp
 * OAuth token file is read READ-ONLY, the access token is refreshed in
 * memory, and nothing is ever written back. The adapter never calls a
 * mutating Gmail endpoint (no labels, no mark-read, no archive, no send);
 * every request here is a GET and the URL guard's pathPatterns admit only
 * GET on /gmail/v1/users/me/messages(/<id>)?.
 *
 * Auth failure (missing token file, missing scope, or a 401 on any call)
 * yields exactly one AUTH_UNAVAILABLE warning and the generator returns; it
 * never retries per-message. scan-run.js marks the run partial on that
 * warning the same way it does for BROWSER_UNAVAILABLE.
 *
 * The token provider is an injectable module-level seam (`deps` below) so
 * tests never touch the real token file: they overwrite deps.readTokenFile /
 * deps.makeOAuthClient / deps.getAccessToken with fakes before calling
 * gmail.search().
 */
import { defineAdapter, titleMatches } from './base.js';
import { normalizeTitle, htmlToText } from '../core/normalize.js';
import { readTokenFile, makeOAuthClient, getAccessToken, classifyAndConnect } from '../core/google.js';
import { errFields } from '../core/errors.js';
import { PARSERS, PARSER_INPUT } from './gmail-parsers.js';

export const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
export const LIST_PAGE_SIZE = 50;
/** The mailbox window is decoupled from job freshness (R1): withinWindow on each listing does the real freshness filtering downstream. */
export const MIN_MAILBOX_WINDOW_DAYS = 14;

/**
 * Injectable auth seam. Tests overwrite these three functions with fakes;
 * production code never touches this object.
 */
export const deps = { readTokenFile, makeOAuthClient, getAccessToken };

/**
 * @param {any} payload
 * @param {string} name
 * @returns {string|null}
 */
function headerValue(payload, name) {
  const headers = (payload && Array.isArray(payload.headers)) ? payload.headers : [];
  const h = headers.find((/** @type {any} */ x) => String(x.name ?? '').toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : null;
}

/**
 * The sender address is taken only from the structured From header (R3):
 * the addr-spec inside <...> when present, else the bare header value.
 * Lowercase, exact-match candidate only; never a substring match.
 * @param {string|null} fromHeader
 * @returns {string|null}
 */
export function extractSenderAddress(fromHeader) {
  if (!fromHeader) return null;
  const angle = /<([^<>]+)>/.exec(fromHeader);
  const raw = (angle ? angle[1] : fromHeader).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(raw) ? raw : null;
}

/**
 * base64url (Gmail body.data) -> utf8 text.
 * @param {string} s
 */
function base64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * Recursively walk payload.parts to any depth (R2), collecting the first
 * text/plain and first text/html leaf found.
 * @param {any} part
 * @param {{ text: string|null, html: string|null }} out
 */
export function collectBodyParts(part, out) {
  if (!part) return;
  if (part.mimeType === 'text/plain' && !out.text && part.body && typeof part.body.data === 'string') {
    out.text = base64urlDecode(part.body.data);
  }
  if (part.mimeType === 'text/html' && !out.html && part.body && typeof part.body.data === 'string') {
    out.html = base64urlDecode(part.body.data);
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectBodyParts(p, out);
  }
}

/**
 * @param {any} msg
 * @returns {Date}
 */
function internalDateOf(msg) {
  const ms = Number(msg && msg.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date();
}

export const gmail = defineAdapter({
  name: 'gmail',
  needsBrowser: false,
  dateOrdered: false,
  ignoresQuery: true,
  domains: ['gmail.googleapis.com'],
  pathPatterns: ['^/gmail/v1/users/me/messages(/[0-9a-f]{8,32})?(\\?|$)'],
  blindSpots: [
    'alerts from senders not listed in config/alert-senders.json are invisible; a new job-alert source is a config edit, not a code change',
    'HTML-only or restructured emails whose markup no longer matches the parser silently degrade to fewer or zero parsed listings (visible as PARSE_EMPTY), never a crash of the source',
    'job links behind third-party click trackers (Lensa, the Indeed personalized match email) are stored as opaque residual URLs and are never fetched or resolved to the real posting',
    'duplicate alerts for the same job sent through two different senders (e.g. the same role via Lensa and LinkedIn) are recognized only when their normalized title, company, and location match exactly; text differences beyond that land in the review queue',
    'no listing carries a description; every gmail-sourced row is ineligible for the details-budget detail fetch (this adapter has none) and get_job({fetchIfMissing:true}) is refused for it',
  ],
  async *search(profile, ctx) {
    const tokenFile = ctx.env && ctx.env.GOOGLE_TOKEN_FILE ? ctx.env.GOOGLE_TOKEN_FILE : null;
    if (!tokenFile) {
      yield { kind: 'warning', code: 'AUTH_UNAVAILABLE', message: 'gmail: no GOOGLE_TOKEN_FILE configured' };
      return;
    }
    /** @type {string} */
    let accessToken;
    try {
      // Pre-flight ONLY (auth-health hardening, spec Change 4): classifyAndConnect does the same
      // read/scope-check/refresh this block always did, but the failure entry now carries the
      // classification slug (e.g. broken_missing_scopes, broken_invalid_grant) instead of a generic
      // message -- a MID-run 401 on messages.list/messages.get further below is explicitly out of scope
      // and keeps its existing AUTH_UNAVAILABLE/generic treatment, never re-classified here.
      const { state, accessToken: token } = await classifyAndConnect(tokenFile, { gmailRead: true }, deps);
      if (state.state !== 'ok' || !token) {
        const detail = state.state === 'broken_refresh_error' ? ` (${state.code})`
          : state.state === 'broken_missing_scopes' ? ` (missing ${state.missing.join(', ')})`
          : '';
        yield { kind: 'warning', code: 'AUTH_UNAVAILABLE', message: `gmail: ${state.state}${detail}` };
        return;
      }
      accessToken = token;
    } catch (err) {
      // classifyAndConnect does not normally throw (every branch is caught internally), but a fake
      // deps.readTokenFile/makeOAuthClient/getAccessToken injected by a test could throw synchronously
      // outside its try/catch shape -- preserve the pre-existing generic fallback for that case.
      yield { kind: 'warning', code: 'AUTH_UNAVAILABLE', message: `gmail: ${errFields(err).err_message}` };
      return;
    }

    const senders = (ctx.config.alertSenders ?? []).filter((s) => s.enabled && PARSERS[s.parser]);
    if (senders.length === 0) return;
    const senderMap = new Map(senders.map((s) => [s.address.toLowerCase(), s]));
    const senderClause = senders.map((s) => `from:${s.address}`).join(' OR ');
    const windowDays = Math.max(Number(profile.posted_within_days) || 0, MIN_MAILBOX_WINDOW_DAYS);
    const q = `newer_than:${windowDays}d (${senderClause})`;
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    /** @type {string|null} */
    let pageToken = null;
    for (let pageIndex = 1; pageIndex <= ctx.maxPages; pageIndex++) {
      await ctx.reservePage();
      const listUrl = new URL(GMAIL_MESSAGES_URL);
      listUrl.searchParams.set('q', q);
      listUrl.searchParams.set('maxResults', String(LIST_PAGE_SIZE));
      if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
      const listRes = await ctx.fetchJson(listUrl.toString(), { headers: authHeader });
      if (listRes.status === 401) {
        yield { kind: 'warning', code: 'AUTH_UNAVAILABLE', message: 'gmail: 401 on messages.list; stopping the source for this run' };
        return;
      }
      if (listRes.status !== 200 || !listRes.json) {
        yield { kind: 'warning', code: 'BAD_RESPONSE', message: `gmail: messages.list HTTP ${listRes.status}`, query: q };
        yield { kind: 'batch', query: q, pageIndex, parsed: 0, status: listRes.status };
        break;
      }
      const listJson = /** @type {any} */ (listRes.json);
      const ids = Array.isArray(listJson.messages) ? listJson.messages.map((/** @type {any} */ m) => String(m.id)) : [];
      let parsed = 0;
      let stop = false;
      for (const id of ids) {
        await ctx.reservePage();
        const getUrl = `${GMAIL_MESSAGES_URL}/${id}?format=full`;
        const getRes = await ctx.fetchJson(getUrl, { headers: authHeader });
        if (getRes.status === 401) {
          yield { kind: 'warning', code: 'AUTH_UNAVAILABLE', message: 'gmail: 401 on messages.get; stopping the source for this run' };
          return;
        }
        if (getRes.status !== 200 || !getRes.json) {
          yield { kind: 'warning', code: 'BAD_RESPONSE', message: `gmail message ${id}: messages.get HTTP ${getRes.status}`, query: q };
          continue;
        }
        const msg = /** @type {any} */ (getRes.json);
        const fromHeader = headerValue(msg.payload, 'From');
        const address = extractSenderAddress(fromHeader);
        const senderCfg = address ? senderMap.get(address) : null;
        if (!senderCfg) {
          yield { kind: 'warning', code: 'UNKNOWN_SENDER', message: `gmail message ${id}: From "${fromHeader ?? ''}" is not a configured sender`, query: q };
          continue;
        }
        /** @type {{ text: string|null, html: string|null }} */
        const parts = { text: null, html: null };
        collectBodyParts(msg.payload, parts);
        if (!parts.text && !parts.html) {
          yield { kind: 'warning', code: 'NO_BODY_PART', message: `gmail message ${id} (${senderCfg.address}): no text/plain or text/html part`, query: q };
          continue;
        }
        const wantsHtml = PARSER_INPUT[senderCfg.parser] === 'html';
        const body = wantsHtml ? (parts.html ?? '') : (parts.text ?? (parts.html ? htmlToText(parts.html) : ''));
        const msgDate = internalDateOf(msg);
        /** @type {import('../core/normalize.js').RawListing[]} */
        let listingsForMsg;
        try {
          listingsForMsg = PARSERS[senderCfg.parser](body, msgDate);
        } catch (err) {
          yield { kind: 'warning', code: 'PARSE_ERROR', message: `gmail message ${id} (${senderCfg.address}): parser threw: ${errFields(err).err_message}`, query: q };
          continue;
        }
        if (!Array.isArray(listingsForMsg) || listingsForMsg.length === 0) {
          yield { kind: 'warning', code: 'PARSE_EMPTY', message: `gmail message ${id} (${senderCfg.address}): parser found zero listings`, query: q };
          continue;
        }
        let matched = 0;
        for (const l of listingsForMsg) {
          const titleNorm = normalizeTitle(l.title).title_norm;
          if (!(titleMatches(l.title, profile) || titleMatches(titleNorm, profile))) continue;
          matched++;
          parsed++;
          const d = yield { kind: 'listing', query: q, pageIndex, listing: l };
          if (d && d.stopQuery) {
            stop = true;
            break;
          }
        }
        ctx.log({ evt: 'gmail_message', sender: senderCfg.address, parsed: listingsForMsg.length, matched });
        if (stop) break;
      }
      ctx.log({ evt: 'gmail_page', page_index: pageIndex, messages: ids.length, matched: parsed });
      const d = yield { kind: 'batch', query: q, pageIndex, parsed, status: listRes.status };
      pageToken = typeof listJson.nextPageToken === 'string' ? listJson.nextPageToken : null;
      if (stop || (d && d.stopQuery) || !pageToken) break;
    }
  },
});
