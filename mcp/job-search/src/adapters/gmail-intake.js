// @ts-check
/**
 * Personal mail intake pass (sql/029). Runs inside the Gmail adapter after the alert and discovery passes and
 * returns rows for the scan to persist; it never writes, labels, replies or sends (GET only, through ctx so the
 * URL guard, rate limiter and page budget apply).
 *
 * Staged, so the page budget buys breadth first and depth only where it can change the answer:
 *   1  one list (newer_than:Nd -in:trash -in:sent -in:draft, includeSpamTrash=true) plus a short sent-mail list
 *      (sent thread ids, and the profile address from the newest sent message's From)
 *   2  format=metadata for every id not already settled in ic_mail_intake (capped at cfg.maxMetadata)
 *   3  format=full ONLY for candidates (non-bulk, a known search firm, a title term in the subject, bulk mail with a recruiting cue (read last), or the
 *      LinkedIn InMail sender), capped at cfg.maxBodies; the overflow is reported, never dropped
 * A budget refusal ends the pass early (outcome partial_budget) and keeps what was read.
 *
 * No model reads anything here or downstream of here (test/mail-intake-no-model.test.js).
 */
import { classifyMail, headerMap, parseAddress, normalizeSelf, sanitizeSnippet, summarizeIntake, rulesVersionFor, parseInmail } from '../core/mail-intake.js';
import { decodeMessageBody } from '../core/mail-mime.js';
import { defaultMailIntakeConfig } from '../core/mail-intake-config.js';
import { JobSearchError } from '../core/errors.js';

const MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const META_HEADERS = ['From', 'Reply-To', 'Sender', 'To', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted', 'Content-Type'];
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 20;
const MAX_SENT_PAGES = 3;

/**
 * @param {{ ctx: any, authHeader: Record<string, string>, windowDays: number, registeredAddresses: Set<string>, registeredIds: Set<string>, cfg?: import('../core/mail-intake-config.js').MailIntakeConfig|null }} p
 * @returns {Promise<{ rows: import('../core/mail-intake-store.js').IntakeRow[], rulesVersion: string, stats: Record<string, any> }>}
 */
export async function runMailIntake(p) {
  const cfg = p.cfg ?? defaultMailIntakeConfig();
  const rulesVersion = rulesVersionFor(cfg);
  /** @type {Record<string, any>} */
  const stats = {
    outcome: cfg.enabled === false ? 'disabled' : 'ok', rules_version: rulesVersion, listed: 0, skipped_known: 0, registered: 0, metadata_read: 0,
    metadata_unread: 0, fetch_error: 0, bodies_read: 0, not_read_beyond_cap: 0, body_fetch_error: 0, body_unreadable: 0, self_known: false, sent_threads: 0,
    sent_unavailable: false, counts: {}, top_unsorted: [], top_bulk: [],
  };
  if (cfg.enabled === false) return { rows: [], rulesVersion, stats };

  const { ctx, authHeader } = p;
  const isBudget = (/** @type {unknown} */ err) => /** @type {any} */ (err)?.code === 'BUDGET_EXHAUSTED';
  /** @type {Set<string>} */
  const selfSet = new Set((cfg.selfAddresses ?? []).map((a) => normalizeSelf(a)).filter((a) => a !== null).map(String));
  /** @type {Set<string>} */
  const sentThreads = new Set();
  /** @type {Array<{ input: any, verdict: ReturnType<typeof classifyMail> }>} */
  const entries = [];
  /** @type {import('../core/mail-intake-store.js').IntakeRow[]} */
  const rows = [];
  /** message ids to leave out of persistence this run so the next run retries them */
  const retry = new Set();

  /** @param {string} url @returns {Promise<{ status: number, json: any }>} */
  const get = async (url) => {
    // Honor the run's abort/deadline before every request (the same signal fetchJson passes to the transport).
    if (ctx.signal && ctx.signal.aborted) throw new JobSearchError('CANCELLED', 'run aborted', { details: { source: 'gmail' } });
    await ctx.reservePage();
    const res = await ctx.fetchJson(url, { headers: authHeader });
    return { status: res.status, json: res.json };
  };
  /** @param {string} q @param {boolean} spam @param {string|null} pageToken */
  const listUrl = (q, spam, pageToken) => {
    const u = new URL(MESSAGES_URL);
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', String(LIST_PAGE_SIZE));
    if (spam) u.searchParams.set('includeSpamTrash', 'true');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    return u.toString();
  };
  /** @param {string} id @param {'metadata'|'full'} format */
  const messageUrl = (id, format) => {
    const u = new URL(`${MESSAGES_URL}/${id}`);
    u.searchParams.set('format', format);
    if (format === 'metadata') for (const h of META_HEADERS) u.searchParams.append('metadataHeaders', h);
    return u.toString();
  };

  try {
    // ---- Sent mail: thread ids Damian wrote in, and the profile address ----
    try {
      let token = /** @type {string|null} */ (null);
      let first = true;
      for (let n = 0; n < MAX_SENT_PAGES; n++) {
        const res = await get(listUrl(`in:sent newer_than:${p.windowDays}d`, false, token));
        if (res.status !== 200 || !res.json) {
          stats.sent_unavailable = true;
          break;
        }
        const msgs = Array.isArray(res.json.messages) ? res.json.messages : [];
        if (first && msgs[0]) {
          first = false;
          const meta = await get(messageUrl(String(msgs[0].id), 'metadata'));
          const sf = meta.status === 200 && meta.json ? normalizeSelf(parseAddress(headerMap(meta.json.payload).from).addr) : null;
          if (sf) {
            selfSet.add(sf);
            stats.self_known = true;
          }
        }
        for (const m of msgs) if (m && m.threadId) sentThreads.add(String(m.threadId));
        token = typeof res.json.nextPageToken === 'string' ? res.json.nextPageToken : null;
        if (!token) break;
      }
    } catch (err) {
      // A budget refusal or a cancelled run ends the pass; any other failure only costs the thread/self hints.
      if (isBudget(err) || /** @type {any} */ (err)?.code === 'CANCELLED') throw err;
      stats.sent_unavailable = true;
    }
    stats.sent_threads = sentThreads.size;

    const known = typeof ctx.mailIntakeKnown === 'function' ? await ctx.mailIntakeKnown(rulesVersion) : new Set();

    // ---- List ----
    /** @type {Array<{ id: string, threadId: string|null }>} */
    const todo = [];
    let token = /** @type {string|null} */ (null);
    for (let n = 0; n < MAX_LIST_PAGES; n++) {
      const res = await get(listUrl(`newer_than:${p.windowDays}d -in:trash -in:sent -in:draft`, true, token));
      if (res.status === 401 || res.status === 403) {
        stats.outcome = `auth_${res.status}`;
        break;
      }
      if (res.status !== 200 || !res.json) {
        stats.outcome = `list_http_${res.status}`;
        break;
      }
      const msgs = Array.isArray(res.json.messages) ? res.json.messages : [];
      for (const m of msgs) {
        const id = String(m.id);
        stats.listed++;
        const threadId = m.threadId ? String(m.threadId) : null;
        if (p.registeredIds.has(id)) {
          stats.registered++;
          if (!known.has(id)) rows.push({ message_id: id, thread_id: threadId, bucket: 'registered_alert', signal: null, from_addr: null, from_name: null, reply_to: null, reply_to_differs: false, subject: null, snippet: null, msg_date: null, labels: [], spam: false, body_unreadable: false });
        } else if (known.has(id)) stats.skipped_known++;
        else todo.push({ id, threadId });
      }
      token = typeof res.json.nextPageToken === 'string' ? res.json.nextPageToken : null;
      if (!token || todo.length >= cfg.maxMetadata) break;
    }
    if (todo.length > cfg.maxMetadata) {
      stats.metadata_unread = todo.length - cfg.maxMetadata;
      todo.length = cfg.maxMetadata;
    }

    /** @type {import('../core/mail-intake.js').MailEnv} */
    const env = { selfSet, registered: p.registeredAddresses, sentThreads, cfg };

    // ---- Metadata ----
    try {
      for (const t of todo) {
        const res = await get(messageUrl(t.id, 'metadata'));
        if (res.status === 401 || res.status === 403) {
          stats.outcome = `auth_${res.status}`;
          break;
        }
        if (res.status !== 200 || !res.json) {
          stats.fetch_error++;
          continue;
        }
        stats.metadata_read++;
        const m = res.json;
        const input = {
          id: t.id, threadId: m.threadId ? String(m.threadId) : t.threadId, labelIds: Array.isArray(m.labelIds) ? m.labelIds.map(String) : [],
          snippet: typeof m.snippet === 'string' ? m.snippet : '', internalDate: Number(m.internalDate) || null, headers: headerMap(m.payload), body: null,
        };
        entries.push({ input, verdict: classifyMail(input, env) });
      }
    } catch (err) {
      if (!isBudget(err)) throw err;
      stats.outcome = 'partial_budget';
      stats.metadata_unread += todo.length - stats.metadata_read - stats.fetch_error;
    }

    // ---- Bodies (candidates only, capped) ----
    // Stronger candidates first (stable within a rank, newest first); bulk-with-cue candidates only use what is left of the cap.
    const candidates = [
      ...entries.filter((e) => e.verdict.candidate && !e.verdict.lowPriority),
      ...entries.filter((e) => e.verdict.candidate && e.verdict.lowPriority),
    ];
    stats.not_read_beyond_cap = Math.max(0, candidates.length - cfg.maxBodies);
    if (stats.outcome === 'ok' || stats.outcome === 'partial_budget') {
      try {
        for (const e of candidates.slice(0, cfg.maxBodies)) {
          const res = await get(messageUrl(e.input.id, 'full'));
          if (res.status === 401 || res.status === 403) {
            stats.outcome = `auth_${res.status}`;
            break;
          }
          if (res.status !== 200 || !res.json) {
            stats.body_fetch_error++;
            retry.add(e.input.id);
            continue;
          }
          const d = decodeMessageBody(res.json.payload);
          stats.bodies_read++;
          e.input.body = { text: d.text, unreadable: d.unreadable, calendar: d.calendar };
          e.verdict = classifyMail(e.input, env);
        }
      } catch (err) {
        if (!isBudget(err)) throw err;
        stats.outcome = 'partial_budget';
      }
    }
    // A candidate whose body was not read this run (beyond the cap, a budget stop, or an auth stop) is not
    // persisted, so the next run reads it; the report counts it as "not read beyond the cap".
    for (const e of candidates) if (!e.input.body) retry.add(e.input.id);
  } catch (err) {
    if (!isBudget(err)) throw err;
    stats.outcome = 'partial_budget';
  }

  for (const e of entries) {
    if (retry.has(e.input.id)) continue;
    const { input, verdict } = e;
    const bodyText = input.body && !input.body.unreadable ? input.body.text : '';
    let fromName = verdict.fromName;
    let subject = verdict.subject;
    if (verdict.signal === 'inmail' && bodyText) {
      const parsed = parseInmail(bodyText, verdict.fromName, verdict.subject);
      fromName = parsed.name ?? fromName;
      subject = parsed.subject || subject;
    }
    if (verdict.bodyUnreadable) stats.body_unreadable++;
    rows.push({
      message_id: input.id, thread_id: input.threadId, bucket: verdict.bucket, signal: verdict.signal, from_addr: verdict.fromAddr,
      from_name: fromName ? sanitizeSnippet(fromName, 120) : null, reply_to: verdict.replyTo, reply_to_differs: verdict.replyToDiffers,
      subject: sanitizeSnippet(subject, 200), snippet: sanitizeSnippet(bodyText || input.snippet, cfg.snippetMax),
      msg_date: input.internalDate ? new Date(input.internalDate).toISOString() : null, labels: input.labelIds,
      spam: input.labelIds.includes('SPAM'), body_unreadable: verdict.bodyUnreadable,
    });
  }

  const sum = summarizeIntake(rows.map((r) => ({ bucket: r.bucket, fromAddr: r.from_addr })), cfg.topSenders);
  stats.counts = sum.counts;
  stats.top_unsorted = sum.topUnsorted;
  stats.top_bulk = sum.topBulk;
  return { rows, rulesVersion, stats };
}
