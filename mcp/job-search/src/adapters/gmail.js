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
import { PARSER_SPECS, PARSER_INPUT } from './gmail-parsers.js';
import { discoverySubjectRegex, DISCOVERY_DEFAULT_KEYWORDS } from '../core/config.js';

export const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
export const LIST_PAGE_SIZE = 50;
/** Token states an interactive run (spec A5) may pop a consent window for; anything else (missing file,
 * malformed, a live refresh_error) is never worth interrupting a human for -- it needs the workspace-mcp
 * auth flow re-run, not a quick re-consent. */
const REAUTH_ELIGIBLE_STATES = new Set(['broken_invalid_grant', 'broken_no_refresh_token', 'broken_missing_scopes']);
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
    'alerts from senders not listed in config/alert-senders.json are never parsed; discovery only counts likely alert senders by From/Subject/List-Unsubscribe (English keywords), so an alert without that header or with an unusual subject stays invisible',
    'a template change that defeats both a parser and its job-marker predicate shows only as no_job_markers drift, not a PARSER BROKEN headline',
    'job links behind third-party click trackers are stored as the tracker URL; src/core/gmail-detail.js unwraps them cookie-less after the scan, and destination pages behind the trackers are unmeasured',
    'duplicate alerts for the same job sent through two different senders (e.g. the same role via Lensa and LinkedIn) are recognized only when their normalized title, company, and location match exactly, or when the description phase resolves both to one canonical id',
    'this adapter has no fetchDetail; descriptions come from the gmail description phase (src/core/gmail-detail.js) or, for rows with a canonical LinkedIn/Indeed/ATS id, from that source\'s own fit sweep',
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
      let { state, accessToken: token } = await classifyAndConnect(tokenFile, { gmailRead: true }, deps);
      // Interactive in-run re-auth (spec A5): only when this run is interactive (dashboard/mcp trigger,
      // or --interactive), only for the three states a fresh consent can actually fix, and at most once
      // per run -- ctx.reauthGoogle() itself is a single bound call, never retried here even if the
      // reauth outcome is something other than 'reauthorized'.
      if ((state.state !== 'ok' || !token) && ctx.interactive && typeof ctx.reauthGoogle === 'function' && REAUTH_ELIGIBLE_STATES.has(state.state)) {
        const reauth = await ctx.reauthGoogle();
        if (reauth.outcome === 'reauthorized') {
          const retry = await classifyAndConnect(tokenFile, { gmailRead: true }, deps);
          state = retry.state;
          token = retry.accessToken;
        }
        if (state.state !== 'ok' || !token) {
          yield { kind: 'warning', code: 'AUTH_UNAVAILABLE', message: `gmail: reauth ${reauth.outcome}${reauth.reason ? ` (${reauth.reason})` : ''}` };
          return;
        }
      }
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

    const senders = (ctx.config.alertSenders ?? []).filter((s) => s.enabled && PARSER_SPECS[s.parser]);
    if (senders.length === 0) return;
    const senderMap = new Map(senders.map((s) => [s.address.toLowerCase(), s]));
    const senderClause = senders.map((s) => `from:${s.address}`).join(' OR ');
    const windowDays = Math.max(Number(profile.posted_within_days) || 0, MIN_MAILBOX_WINDOW_DAYS);
    const q = `newer_than:${windowDays}d (${senderClause})`;
    const authHeader = { Authorization: `Bearer ${accessToken}` };
    const intake = ctx.config.alertIntake ?? null;
    const stats = newIntakeStats();
    /** @type {Set<string>} */
    const seenIds = new Set();
    /** @param {string} address @param {any} cfg */
    const bucket = (address, cfg) => {
      if (!stats.by_sender[address]) {
        stats.by_sender[address] = {
          emails: 0, ok: 0, partial: 0, parse_empty: 0, no_job_markers: 0, parse_error: 0, no_body: 0, fetch_error: 0,
          listings: 0, matched: 0, markers: 0, incomplete: 0, dropped: {}, parser: cfg.parser, parser_version: PARSER_SPECS[cfg.parser]?.version ?? null,
        };
      }
      return stats.by_sender[address];
    };

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
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        await ctx.reservePage();
        const getUrl = `${GMAIL_MESSAGES_URL}/${id}?format=full`;
        const getRes = await ctx.fetchJson(getUrl, { headers: authHeader });
        if (getRes.status === 401) {
          yield { kind: 'warning', code: 'AUTH_UNAVAILABLE', message: 'gmail: 401 on messages.get; stopping the source for this run' };
          return;
        }
        // Per-message classification (Gmail intake addendum, total; first match wins).
        if (getRes.status !== 200 || !getRes.json) {
          stats.messages.fetch_error++;
          yield { kind: 'warning', code: 'BAD_RESPONSE', message: `gmail message ${id}: messages.get HTTP ${getRes.status}`, query: q };
          continue;
        }
        const msg = /** @type {any} */ (getRes.json);
        const fromHeader = headerValue(msg.payload, 'From');
        const address = extractSenderAddress(fromHeader);
        const senderCfg = address ? senderMap.get(address) : null;
        if (!senderCfg) {
          stats.messages.unhandled_sender++;
          const key = address ?? '(unparseable)';
          stats.unhandled_senders[key] = (stats.unhandled_senders[key] ?? 0) + 1;
          yield { kind: 'warning', code: 'UNKNOWN_SENDER', message: `gmail message ${id}: From "${fromHeader ?? ''}" is not a configured sender`, query: q };
          continue;
        }
        const b = bucket(senderCfg.address, senderCfg);
        b.emails++;
        /** @type {{ text: string|null, html: string|null }} */
        const parts = { text: null, html: null };
        collectBodyParts(msg.payload, parts);
        if (!parts.text && !parts.html) {
          b.no_body++;
          yield { kind: 'warning', code: 'NO_BODY_PART', message: `gmail message ${id} (${senderCfg.address}): no text/plain or text/html part`, query: q };
          continue;
        }
        const wantsHtml = PARSER_INPUT[senderCfg.parser] === 'html';
        const body = wantsHtml ? (parts.html ?? '') : (parts.text ?? (parts.html ? htmlToText(parts.html) : ''));
        const msgDate = internalDateOf(msg);
        /** @type {import('./gmail-parsers.js').ParseResult} */
        let parsedMsg;
        try {
          parsedMsg = PARSER_SPECS[senderCfg.parser].analyze(body, msgDate, { html: parts.html, sender: senderCfg });
          if (!parsedMsg || !Array.isArray(parsedMsg.listings)) throw new Error('parser returned no listings array');
        } catch (err) {
          b.parse_error++;
          yield { kind: 'warning', code: 'PARSE_ERROR', message: `gmail message ${id} (${senderCfg.address}): parser threw: ${errFields(err).err_message}`, query: q };
          continue;
        }
        const listingsForMsg = parsedMsg.listings;
        b.markers += parsedMsg.markers;
        b.incomplete += parsedMsg.incomplete;
        b.listings += listingsForMsg.length;
        for (const [k, n] of Object.entries(parsedMsg.dropped ?? {})) b.dropped[k] = (b.dropped[k] ?? 0) + n;
        const outcome = classifyMessageOutcome({ listings: listingsForMsg.length, markers: parsedMsg.markers, incomplete: parsedMsg.incomplete });
        b[outcome]++;
        if (outcome === 'parse_error') {
          yield { kind: 'warning', code: 'PARSE_ERROR', message: `gmail message ${id} (${senderCfg.address}): unclassified parse result`, query: q };
          continue;
        }
        if (outcome === 'no_job_markers') continue;
        if (outcome === 'parse_empty') {
          yield { kind: 'warning', code: 'PARSE_EMPTY', message: `gmail message ${id} (${senderCfg.address}): parser found zero listings in ${parsedMsg.markers} job marker${parsedMsg.markers === 1 ? '' : 's'}`, query: q };
          continue;
        }
        if (outcome === 'partial') {
          yield { kind: 'warning', code: 'PARSE_PARTIAL', message: `gmail message ${id} (${senderCfg.address}): ${listingsForMsg.length} listings from ${parsedMsg.markers} job markers (${parsedMsg.incomplete} incomplete)`, query: q };
        }
        let matched = 0;
        for (const l of listingsForMsg) {
          const titleNorm = normalizeTitle(l.title).title_norm;
          if (!(titleMatches(l.title, profile) || titleMatches(titleNorm, profile))) continue;
          matched++;
          b.matched++;
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

    // Unhandled-sender discovery (Gmail intake addendum G2, B8): metadata only, nothing parsed or stored.
    stats.discovery = await runDiscovery({
      ctx, authHeader, windowDays, registered: senders.map((s) => s.address.toLowerCase()), seenIds, cfg: intake?.discovery ?? null, stats,
    });
    yield { kind: 'source_stats', stats };
  },
});

/**
 * Per-message outcome after a parse (Gmail intake addendum, rows 6-9 of the per-message table; rows 1-5
 * are decided before the parse). Total: anything not shaped like counts is parse_error.
 * @param {{ listings: number, markers: number, incomplete: number }} c
 * @returns {'no_job_markers'|'parse_empty'|'partial'|'ok'|'parse_error'}
 */
export function classifyMessageOutcome(c) {
  const ok = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!ok(c.listings) || !ok(c.markers) || !ok(c.incomplete)) return 'parse_error';
  if (c.listings === 0 && c.markers === 0) return 'no_job_markers';
  if (c.listings === 0) return 'parse_empty';
  if (c.incomplete > 0 || c.listings < c.markers) return 'partial';
  return 'ok';
}

function newIntakeStats() {
  return {
    /** @type {Record<string, any>} */
    by_sender: {},
    /** @type {Record<string, number>} */
    unhandled_senders: {},
    messages: { fetch_error: 0, unhandled_sender: 0 },
    /** @type {any} */
    discovery: { outcome: 'disabled' },
  };
}

/**
 * Discovery (G2, B8). One shared keyword list builds both the Gmail subject query and the subject test.
 * Reads metadata only (From, Subject, List-Unsubscribe) for messages not from a registered sender, newest
 * first, at most maxMessages; an address that reaches perSenderMax is excluded from the next list query
 * so one noisy sender never hides the rest. Classification per message (total): unparseable_from,
 * ignored, unhandled_sender (List-Unsubscribe present and the subject matches), not_alert_like. A budget
 * refusal ends it: skipped_budget when nothing was read, partial_budget otherwise; it never fails the
 * source. Outcome 'ok' when it ran to the end, 'disabled' when switched off.
 * @param {{ ctx: any, authHeader: Record<string, string>, windowDays: number, registered: string[], seenIds: Set<string>, cfg: any, stats: ReturnType<typeof newIntakeStats> }} p
 */
async function runDiscovery(p) {
  const d = { outcome: 'disabled', read: 0, unparseable_from: 0, ignored: 0, unhandled_sender: 0, not_alert_like: 0, fetch_error: 0 };
  const cfg = p.cfg;
  if (!cfg || cfg.enabled === false || !(cfg.maxMessages > 0)) return d;
  const keywords = Array.isArray(cfg.keywords) && cfg.keywords.length ? cfg.keywords : [...DISCOVERY_DEFAULT_KEYWORDS];
  const subjectRe = discoverySubjectRegex(keywords);
  const ignored = new Set((cfg.ignoredSenders ?? []).map((/** @type {string} */ s) => s.toLowerCase()));
  const perSenderMax = cfg.perSenderMax ?? 3;
  /** @type {Map<string, number>} */
  const perSender = new Map();
  /** @type {Set<string>} */
  const excluded = new Set(p.registered);
  const isBudget = (/** @type {unknown} */ err) => /** @type {any} */ (err)?.code === 'BUDGET_EXHAUSTED';
  d.outcome = 'ok';
  try {
    for (let round = 0; round < 10 && d.read < cfg.maxMessages; round++) {
      const q = `newer_than:${p.windowDays}d ${[...excluded].map((a) => `-from:${a}`).join(' ')} subject:(${keywords.join(' OR ')})`;
      await p.ctx.reservePage();
      const listUrl = new URL(GMAIL_MESSAGES_URL);
      listUrl.searchParams.set('q', q);
      listUrl.searchParams.set('maxResults', String(Math.min(LIST_PAGE_SIZE, cfg.maxMessages)));
      const listRes = await p.ctx.fetchJson(listUrl.toString(), { headers: p.authHeader });
      if (listRes.status !== 200 || !listRes.json) {
        d.outcome = `list_http_${listRes.status}`;
        return d;
      }
      const ids = (Array.isArray(listRes.json.messages) ? listRes.json.messages : []).map((/** @type {any} */ m) => String(m.id)).filter((id) => !p.seenIds.has(id));
      if (ids.length === 0) return d;
      let saturatedThisRound = false;
      for (const id of ids) {
        if (d.read >= cfg.maxMessages) break;
        p.seenIds.add(id);
        await p.ctx.reservePage();
        d.read++;
        const res = await p.ctx.fetchJson(`${GMAIL_MESSAGES_URL}/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe`, { headers: p.authHeader });
        if (res.status !== 200 || !res.json) {
          d.fetch_error++;
          continue;
        }
        const from = headerValue(res.json.payload, 'From');
        const address = extractSenderAddress(from);
        if (!address) {
          d.unparseable_from++;
          continue;
        }
        if (ignored.has(address)) d.ignored++;
        else if (headerValue(res.json.payload, 'List-Unsubscribe') && subjectRe.test(headerValue(res.json.payload, 'Subject') ?? '')) {
          d.unhandled_sender++;
          p.stats.unhandled_senders[address] = (p.stats.unhandled_senders[address] ?? 0) + 1;
        } else d.not_alert_like++;
        const n = (perSender.get(address) ?? 0) + 1;
        perSender.set(address, n);
        if (n >= perSenderMax && !excluded.has(address)) {
          excluded.add(address);
          saturatedThisRound = true;
        }
      }
      if (!saturatedThisRound) return d;
    }
  } catch (err) {
    if (!isBudget(err)) throw err;
    d.outcome = d.read === 0 ? 'skipped_budget' : 'partial_budget';
  }
  return d;
}
