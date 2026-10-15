// @ts-check
/**
 * Target finder source E: Google Alerts email parser (plan 14.4 E as amended by 14.1 item 1 and 15.2/15.3).
 *
 * This is its OWN module. It is not an alert-senders.json parser: GMAIL_PARSER_NAMES is a closed enum of
 * job-listing parsers, and a news item must never enter ic_job_listings. It reuses only the low-level gmail
 * helpers (extractSenderAddress, collectBodyParts, GMAIL_MESSAGES_URL, and the injectable auth `deps`).
 *
 *   - Gmail GET only, through the fetch guard, redirect:'error', bearer token sent only to
 *     gmail.googleapis.com. The OAuth token refresh happens in src/core/google.js (documented exception).
 *   - No link inside an email is ever fetched. The destination URL is only a dedup key and the evidence URL.
 *   - Routing comes from config/target-alert-patterns.json, never from email text. Regexes are compiled from
 *     that file only; they run on a 500-character headline and a 200-character label.
 *   - Dates (15.2 item 2): the Gmail internalDate (never the Date header) is the email date. A headline with
 *     no stated article date gets NULL event and filing dates (classifier: date_missing -> needs-review);
 *     the email date is kept in `extracted.email_date` only. With a stated article date, event_date is that
 *     date and filing_date is the email date.
 *   - A multi-pattern match keeps ALL distinct trigger kinds: one signal per kind (lowest priority number
 *     wins within a kind), the extra kinds under key "<key>|kind:<kind>".
 */
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'cheerio';
import { z } from 'zod';
import { getEnv } from '../core/config.js';
import { normalizeCompany } from '../core/normalize.js';
import { classifyAndConnect } from '../core/google.js';
import { unwrapGoogleAlertUrl } from '../core/target-evidence.js';
import { extractSenderAddress, collectBodyParts, GMAIL_MESSAGES_URL, deps } from '../adapters/gmail.js';
import { createCollector } from './outcomes.js';
import {
  sanitizeName, sanitizeText, makeExcerpt, boundExtracted, findBlockedHits, buildSignalText, contentHash, DOC_READ_MAX,
} from './signal-text.js';
import { parseLooseDate, extractContact } from './text-extract.js';

export const ALERT_SOURCE = 'google_alert';
export const ALERT_PARSER_VERSION = 'alert-1';
export const ALERT_SENDER = 'googlealerts-noreply@google.com';
export const ALERT_PATTERNS_FILE = 'target-alert-patterns.json';
export const ALERT_REASONS = Object.freeze([
  'html_missing', 'no_items_found', 'item_link_missing', 'pattern_matched_no_company', 'unknown_shape',
  'label_unmapped', 'no_pattern_matched', 'run_cap', 'message_fetch_failed', 'sender_unexpected',
]);
export const ALERT_MAX_MESSAGES = 60;
export const ALERT_MAX_ITEMS = 50;
export const ALERT_WINDOW_DAYS = 14;
const GROUPS = Object.freeze(['company', 'acquirer', 'investor', 'pe_firm', 'role', 'date']);
const MESSAGE_ID_RE = /^[0-9a-f]{8,32}$/;

export const alertPatternSchema = z.object({
  priority: z.number().int(),
  label_regex: z.string().min(1).max(300),
  headline_regex: z.string().min(1).max(500),
  trigger_kind: z.enum(['pe_deal', 'exec_departure', 'leadership_gap']),
  enabled: z.boolean(),
});

/**
 * @typedef {Object} CompiledPattern
 * @property {string} id
 * @property {number} priority
 * @property {RegExp} label
 * @property {RegExp} headline
 * @property {'pe_deal'|'exec_departure'|'leadership_gap'} trigger_kind
 * @property {boolean} enabled
 */

/**
 * Parse and compile the keyed pattern object. Keys starting with "_" are comments. Any invalid entry,
 * uncompilable regex, or unknown named group makes the whole file invalid (adapter skipped, visibly).
 * @param {unknown} raw
 * @returns {{ ok: true, patterns: CompiledPattern[] } | { ok: false, reason: string }}
 */
export function parseAlertPatterns(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_an_object' };
  /** @type {CompiledPattern[]} */
  const patterns = [];
  for (const [id, v] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    if (!/^[a-z0-9_]{1,40}$/.test(id)) return { ok: false, reason: `bad_pattern_id:${id.slice(0, 40)}` };
    const p = alertPatternSchema.safeParse(v);
    if (!p.success) return { ok: false, reason: `invalid_pattern:${id}` };
    let label; let headline;
    try {
      label = new RegExp(p.data.label_regex, 'i');
      headline = new RegExp(p.data.headline_regex, 'i');
    } catch {
      return { ok: false, reason: `bad_regex:${id}` };
    }
    for (const g of [...p.data.headline_regex.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1])) {
      if (!GROUPS.includes(g)) return { ok: false, reason: `unknown_group:${id}:${g.slice(0, 20)}` };
    }
    patterns.push({ id, priority: p.data.priority, label, headline, trigger_kind: p.data.trigger_kind, enabled: p.data.enabled });
  }
  patterns.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return { ok: true, patterns };
}

/** @param {string} [configDir] */
export function loadAlertPatterns(configDir = getEnv().JOBSEARCH_CONFIG_DIR) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, ALERT_PATTERNS_FILE), 'utf8'));
  } catch {
    return /** @type {const} */ ({ ok: false, reason: 'missing_or_unparseable' });
  }
  return parseAlertPatterns(raw);
}

/**
 * Production token provider: the existing gmail auth module, read-only scope check, refresh in memory.
 * @param {string|null|undefined} tokenFile
 * @returns {() => Promise<string|null>}
 */
export function makeGmailTokenProvider(tokenFile) {
  return async () => {
    if (!tokenFile) return null;
    try {
      const { state, accessToken } = await classifyAndConnect(tokenFile, { gmailRead: true }, deps);
      return state.state === 'ok' && accessToken ? accessToken : null;
    } catch {
      return null;
    }
  };
}

/**
 * @typedef {Object} AlertItem
 * @property {string} headline
 * @property {string|null} href exactly as emailed, or null
 * @property {string} snippet
 */

/**
 * Items are anchors with at least 15 characters of text that are either a Google redirect, a direct
 * http(s) link, or carry no href at all (link missing). Google management links (unsubscribe, feedback,
 * "see more results") and mailto links are not items. The snippet is the text of the item's enclosing table
 * minus the headline.
 * @param {string} html
 * @returns {AlertItem[]}
 */
export function extractAlertItems(html) {
  const $ = load(html.slice(0, DOC_READ_MAX));
  /** @type {AlertItem[]} */
  const items = [];
  for (const a of $('a').toArray()) {
    const headline = sanitizeText($(a).text(), 500);
    if (headline.length < 15) continue;
    const hrefRaw = $(a).attr('href');
    const href = typeof hrefRaw === 'string' && hrefRaw.trim() ? hrefRaw.trim().slice(0, 2048) : null;
    if (href) {
      let u;
      try { u = new URL(href); } catch { u = null; }
      if (!u) continue;
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      const host = u.hostname.toLowerCase();
      const isGoogle = host === 'google.com' || host.endsWith('.google.com');
      if (isGoogle && !(u.pathname === '/url' && (u.searchParams.get('url') || u.searchParams.get('q')))) continue;
    }
    const block = $(a).parents('table').first();
    const blockText = sanitizeText(block.length ? block.text() : $(a).parent().text(), 1200);
    const snippet = sanitizeText(blockText.replace(headline, ' '), 600);
    items.push({ headline, href, snippet });
  }
  return items;
}

/**
 * Canonical dedup key target: destination URL after ONE unwrap, fragment and utm_* removed, lowercase host.
 * @param {string} href
 * @returns {string|null}
 */
export function canonicalAlertUrl(href) {
  const dest = unwrapGoogleAlertUrl(href) ?? href;
  let u;
  try { u = new URL(dest); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
  return u.toString();
}

/** @param {any} payload @param {string} name @returns {string|null} */
function header(payload, name) {
  const hs = payload && Array.isArray(payload.headers) ? payload.headers : [];
  const h = hs.find((/** @type {any} */ x) => String(x?.name ?? '').toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : null;
}

/** @param {unknown} ms @returns {string|null} UTC day of a Gmail internalDate */
function internalDay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * @param {Object} ctx
 * @param {import('./fetch-guard.js').FetchGuard} ctx.guard
 * @param {() => Promise<string|null>} ctx.getAccessToken
 * @param {Date} ctx.now
 * @param {string[]} ctx.blocked
 * @param {number} [ctx.blockedMinLength]
 * @param {CompiledPattern[]} [ctx.patterns] injected instead of reading the file
 * @param {string} [ctx.configDir]
 * @param {number} [ctx.windowDays]
 */
export async function runGoogleAlerts(ctx) {
  const c = createCollector(ALERT_SOURCE, ALERT_REASONS, ALERT_PARSER_VERSION);
  let patterns = ctx.patterns;
  if (!patterns) {
    const loaded = loadAlertPatterns(ctx.configDir);
    if (!loaded.ok) { c.skip(`config_invalid:${loaded.reason}`); return { items: c.items, stats: c.stats }; }
    patterns = loaded.patterns;
  }
  const enabled = patterns.filter((p) => p.enabled);
  if (enabled.length === 0) { c.skip('no_enabled_patterns'); return { items: c.items, stats: c.stats }; }
  const token = await ctx.getAccessToken();
  if (!token) { c.skip('auth_unavailable'); return { items: c.items, stats: c.stats }; }

  const listUrl = new URL(GMAIL_MESSAGES_URL);
  listUrl.searchParams.set('q', `from:${ALERT_SENDER} newer_than:${ctx.windowDays ?? ALERT_WINDOW_DAYS}d`);
  listUrl.searchParams.set('maxResults', String(ALERT_MAX_MESSAGES));
  /** @type {any} */
  let list;
  try {
    const r = await ctx.guard.get(listUrl.toString(), { bearer: token, accept: 'application/json', redirect: 'error' });
    if (r.status === 401) { c.skip('auth_unavailable'); return { items: c.items, stats: c.stats }; }
    if (r.status !== 200) { c.skip(`gmail_list_http_${r.status}`); return { items: c.items, stats: c.stats }; }
    list = JSON.parse(r.text);
  } catch (err) {
    c.skip(`gmail_list_failed:${err instanceof Error ? sanitizeText(err.message, 60) : 'error'}`);
    return { items: c.items, stats: c.stats };
  }
  const ids = Array.isArray(list?.messages) ? list.messages.map((/** @type {any} */ m) => (m && typeof m.id === 'string' ? m.id : '')) : null;
  if (!ids) { c.add('unparseable', 'unknown_shape', { key: 'list', extracted: { issue: 'messages_array_missing' } }); return { items: c.items, stats: c.stats }; }
  c.stats.discovery_total = typeof list.resultSizeEstimate === 'number' ? list.resultSizeEstimate : ids.length;
  if (typeof list.nextPageToken === 'string' && list.nextPageToken) {
    c.bump('message_cap_hit');
    c.warn(`message_cap_hit:${ALERT_MAX_MESSAGES}`);
  }

  let authDead = false;
  for (const id of ids.slice(0, ALERT_MAX_MESSAGES)) {
    if (authDead) break;
    c.stats.read += 1;
    await c.guard(`msg:${MESSAGE_ID_RE.test(id) ? id : contentHash(id).slice(0, 16)}`, () => processMessage(id));
  }
  return { items: c.items, stats: c.stats };

  /** @param {string} id */
  async function processMessage(id) {
    if (!MESSAGE_ID_RE.test(id)) { c.add('unparseable', 'unknown_shape', { key: `msg:bad:${contentHash(id).slice(0, 16)}`, extracted: { issue: 'message_id_invalid' } }); return; }
    const msgKey = `msg:${id}`;
    const r = await ctx.guard.get(`${GMAIL_MESSAGES_URL}/${id}?format=full`, { bearer: token, accept: 'application/json', redirect: 'error' });
    if (r.status === 401) { authDead = true; c.skip('auth_unavailable'); return; }
    if (r.status !== 200) { c.add('unparseable', 'message_fetch_failed', { key: msgKey, extracted: { status: r.status } }); return; }
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(r.text); } catch { c.add('unparseable', 'unknown_shape', { key: msgKey, extracted: { issue: 'message_json' } }); return; }
    const sender = extractSenderAddress(header(msg?.payload, 'From'));
    if (sender !== ALERT_SENDER) { c.add('out_of_scope', 'sender_unexpected', { key: msgKey, extracted: { sender } }); return; }
    const subject = sanitizeText(header(msg.payload, 'Subject') ?? '', 300);
    const lm = /^\s*Google Alert\s*[-\u2013\u2014]\s*(.+)$/i.exec(subject);
    const label = lm ? sanitizeText(lm[1], 200) : null;
    /** @type {{ text: string|null, html: string|null }} */
    const parts = { text: null, html: null };
    collectBodyParts(msg.payload, parts);
    if (!parts.html) { c.add('unparseable', 'html_missing', { key: msgKey, extracted: { label } }); return; }
    const emailDay = internalDay(msg.internalDate);
    const found = extractAlertItems(parts.html);
    if (found.length === 0) { c.add('unparseable', 'no_items_found', { key: msgKey, extracted: { label, email_date: emailDay } }); return; }
    for (const [idx, item] of found.entries()) {
      const idxKey = `${msgKey}|idx:${idx}`;
      if (idx >= ALERT_MAX_ITEMS) { c.add('out_of_scope', 'run_cap', { key: idxKey, extracted: { label } }); continue; }
      await c.guard(idxKey, () => processItem(item, idxKey, label, emailDay));
    }
  }

  /**
   * @param {AlertItem} item
   * @param {string} idxKey
   * @param {string|null} label
   * @param {string|null} emailDay
   */
  async function processItem(item, idxKey, label, emailDay) {
    const keyBase = item.href ? (canonicalAlertUrl(item.href) ?? idxKey) : idxKey;
    const base = { label, email_date: emailDay, headline: item.headline };
    const labelHits = enabled.filter((p) => label !== null && p.label.test(label));
    if (labelHits.length === 0) {
      c.add('out_of_scope', 'label_unmapped', { key: keyBase, url: null, excerpt: makeExcerpt(item.headline), extracted: base });
      return;
    }
    // Lowest priority number wins within a trigger kind; every distinct kind is kept.
    /** @type {Map<string, { pattern: CompiledPattern, groups: Record<string, string|undefined> }>} */
    const byKind = new Map();
    for (const p of labelHits) {
      if (byKind.has(p.trigger_kind)) continue;
      const m = p.headline.exec(item.headline.slice(0, 500));
      if (m) byKind.set(p.trigger_kind, { pattern: p, groups: { ...(m.groups ?? {}) } });
    }
    if (byKind.size === 0) {
      c.add('out_of_scope', 'no_pattern_matched', { key: keyBase, excerpt: makeExcerpt(item.headline), extracted: base });
      return;
    }
    const ordered = [...byKind.values()].sort((a, b) => a.pattern.priority - b.pattern.priority || a.pattern.id.localeCompare(b.pattern.id));
    const allKinds = ordered.map((o) => o.pattern.trigger_kind);
    for (const [n, o] of ordered.entries()) {
      const key = n === 0 ? keyBase : `${keyBase}|kind:${o.pattern.trigger_kind}`;
      buildSignal(item, o, key, base, allKinds, emailDay);
    }
  }

  /**
   * @param {AlertItem} item
   * @param {{ pattern: CompiledPattern, groups: Record<string, string|undefined> }} o
   * @param {string} key
   * @param {Record<string, unknown>} base
   * @param {string[]} allKinds
   * @param {string|null} emailDay
   */
  function buildSignal(item, o, key, base, allKinds, emailDay) {
    const extractedBase = { ...base, pattern_id: o.pattern.id, trigger_kinds: allKinds };
    /** @param {string} g */
    const field = (g) => sanitizeName(o.groups[g] ?? '');
    const fields = Object.fromEntries(['company', 'acquirer', 'investor', 'pe_firm', 'role'].map((g) => [g, field(g)]));
    if (Object.values(fields).some((f) => f.too_long)) { c.add('unparseable', 'name_too_long', { key, extracted: extractedBase }); return; }
    if (!fields.company.value) { c.add('unparseable', 'pattern_matched_no_company', { key, excerpt: makeExcerpt(item.headline), extracted: extractedBase }); return; }
    if (!item.href) { c.add('unparseable', 'item_link_missing', { key, excerpt: makeExcerpt(item.headline), extracted: extractedBase }); return; }
    const articleDate = o.groups.date ? parseLooseDate(sanitizeText(o.groups.date, 40)) : null;
    const eventDate = articleDate;
    const filingDate = articleDate ? emailDay : null;
    const scan = findBlockedHits(`${item.headline} ${item.snippet} ${item.href}`, ctx.blocked, { minLength: ctx.blockedMinLength });
    const text = buildSignalText(scan.hits, [item.headline, item.snippet]);
    const contact = extractContact(`${item.headline}. ${item.snippet}`);
    const signal = {
      trigger_kind: o.pattern.trigger_kind,
      company: fields.company.value,
      aliases: [],
      acquirer: fields.acquirer.value || null,
      investor: fields.investor.value || null,
      pe_firm: fields.pe_firm.value || null,
      text,
      evidence_url: item.href,
      evidence_source: 'google_alert',
      event_date: eventDate,
      filing_date: filingDate,
      role: fields.role.value || null,
    };
    c.add('parsed', 'ok', {
      key,
      signal,
      contact,
      url: item.href,
      excerpt: makeExcerpt(`${item.headline} ${item.snippet}`),
      extracted: boundExtracted({
        ...extractedBase,
        trigger_kind: o.pattern.trigger_kind,
        company: fields.company.value,
        company_norm: normalizeCompany(fields.company.value).company_norm,
        alias_norms: [],
        event_date: eventDate,
        filing_date: filingDate,
        article_date_stated: Boolean(articleDate),
        blocked_hits: scan.hits.map((h) => h.entry),
      }),
    });
  }
}
