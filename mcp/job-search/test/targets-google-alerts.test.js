// @ts-check
/**
 * src/targets/google-alerts.js (target finder PR2, plan 14.4 E + 14.1 item 1 + 15.2 items 2, 7 + 15.3).
 * Recorded fixtures only: Gmail JSON is built from the hand-recorded HTML fixtures; no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runGoogleAlerts, parseAlertPatterns, loadAlertPatterns, extractAlertItems, canonicalAlertUrl, ALERT_REASONS, ALERT_SOURCE,
  ALERT_MAX_MESSAGES, ALERT_MAX_ITEMS, ALERT_SENDER, makeGmailTokenProvider,
} from '../src/targets/google-alerts.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import { COMMON_REASONS, OUTCOMES } from '../src/targets/outcomes.js';
import { classifySignal, loadTargetRules } from '../src/core/target-classify.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { deps } from '../src/adapters/gmail.js';
import { createReplayFetch, fixture } from './helpers/targets-replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, '..', 'config');
const RULES = loadTargetRules(CONFIG_DIR);
const NOW = new Date('2026-10-15T12:00:00Z');
const BLOCKED = [...BUILT_IN_BLOCKED];
/** @type {import('../src/core/target-exclusion.js').BlockedList} */
const OK_LIST = { entries: BLOCKED, status: 'ok', error: null };
const TOKEN = 'ya29.fake-token';
const MSGS = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const EMAIL_MS = Date.parse('2026-10-12T08:30:00Z');

/** @param {string} s */
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * @param {{ id?: string, from?: string, subject?: string|null, html?: string|null, text?: string, internalDate?: string|number, dateHeader?: string }} o
 */
function gmailMessage(o = {}) {
  const headers = [{ name: 'From', value: o.from ?? `Google Alerts <${ALERT_SENDER}>` }, { name: 'Date', value: o.dateHeader ?? 'Mon, 01 Jan 2024 00:00:00 +0000' }];
  if (o.subject !== null) headers.push({ name: 'Subject', value: o.subject ?? 'Google Alert - private equity acquisition' });
  /** @type {any[]} */
  const parts = [];
  if (o.text !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64url(o.text) } });
  if (o.html !== null) parts.push({ mimeType: 'text/html', body: { data: b64url(o.html ?? fixture('google_alert/three_items.html')) } });
  return JSON.stringify({ id: o.id ?? 'abc12345', internalDate: String(o.internalDate ?? EMAIL_MS), payload: { mimeType: 'multipart/alternative', headers, parts } });
}

/** @type {import('../src/targets/google-alerts.js').CompiledPattern[]} */
const PATTERNS = /** @type {any} */ (parseAlertPatterns({
  pe: { priority: 10, label_regex: 'private equity|acquisition', headline_regex: '^(?<company>.+?) acquired by (?<acquirer>.+?)(?: after .*)?$', trigger_kind: 'pe_deal', enabled: true },
}).ok ? parseAlertPatterns({
  pe: { priority: 10, label_regex: 'private equity|acquisition', headline_regex: '^(?<company>.+?) acquired by (?<acquirer>.+?)(?: after .*)?$', trigger_kind: 'pe_deal', enabled: true },
}) : null).patterns;

/**
 * @param {Array<{ id: string, body: string, status?: number }>} messages
 * @param {{ patterns?: any, token?: string|null, extraRoutes?: any[], listBody?: any, maxRequests?: number }} [o]
 */
async function runWith(messages, o = {}) {
  const routes = [
    ...(o.extraRoutes ?? []),
    { match: (/** @type {string} */ u) => u.startsWith(`${MSGS}?`), body: JSON.stringify(o.listBody ?? { messages: messages.map((m) => ({ id: m.id })), resultSizeEstimate: messages.length }) },
    ...messages.map((m) => ({ match: `${MSGS}/${m.id}?format=full`, body: m.body, status: m.status ?? 200 })),
  ];
  const replay = createReplayFetch(routes);
  const guard = createFetchGuard({ fetch: replay.fetch, userAgent: null, ...(o.maxRequests ? { maxRequests: o.maxRequests } : {}) });
  const token = o.token === undefined ? TOKEN : o.token;
  const out = await runGoogleAlerts({ guard, getAccessToken: async () => token, now: NOW, blocked: BLOCKED, patterns: o.patterns ?? PATTERNS });
  return { ...out, calls: replay.calls };
}
/** @param {any} item */
const classify = (item) => classifySignal(item.signal, { rules: RULES, now: NOW, blocked: OK_LIST });

describe('pattern config', () => {
  test('the shipped file parses and ships every pattern DISABLED', () => {
    const r = loadAlertPatterns(CONFIG_DIR);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.patterns.length >= 1);
    assert.ok(r.patterns.every((p) => p.enabled === false));
  });
  test('priority decides order (ties by id), "_" keys are comments, invalid entries invalidate the file', () => {
    const e = { label_regex: 'x', headline_regex: '(?<company>.+)', trigger_kind: 'pe_deal', enabled: true };
    const r = parseAlertPatterns({ _c: 'hi', b: { ...e, priority: 2 }, a: { ...e, priority: 2 }, z: { ...e, priority: 1 } });
    assert.deepEqual(r.ok && r.patterns.map((p) => p.id), ['z', 'a', 'b']);
    const bad = [
      { a: { ...e, priority: 1, headline_regex: '(unclosed' } },
      { a: { ...e, priority: 1, headline_regex: '(?<victim>.+)' } },
      { a: { ...e, priority: 1.5 } }, { a: { ...e, priority: 1, trigger_kind: 'rumor' } }, { 'Bad Id': { ...e, priority: 1 } },
      { a: { ...e, priority: 1, label_regex: '' } }, [], null, 5,
    ];
    for (const b of bad) assert.equal(parseAlertPatterns(b).ok, false, JSON.stringify(b));
  });
  test('with no enabled pattern the adapter skips and makes zero requests', async () => {
    const shipped = loadAlertPatterns(CONFIG_DIR);
    assert.ok(shipped.ok);
    const { stats, calls } = await runWith([{ id: 'abc12345', body: gmailMessage() }], { patterns: shipped.ok ? shipped.patterns : [] });
    assert.equal(stats.skipped, 'no_enabled_patterns');
    assert.equal(calls.length, 0);
  });
});

describe('item extraction from the recorded template', () => {
  test('three items; unsubscribe / see-more / management links are not items; the linkless item has href null', () => {
    const items = extractAlertItems(fixture('google_alert/three_items.html'));
    assert.equal(items.length, 3);
    assert.equal(items[0].headline, 'Globex Packaging acquired by Meridian Peak Partners');
    assert.ok(items[0].href?.startsWith('https://www.google.com/url?'));
    assert.ok(items[0].snippet.includes('Meridian Peak Partners, a private equity firm'));
    assert.ok(!items[0].snippet.includes('Globex Packaging acquired by Meridian Peak Partners'));
    assert.equal(items[2].href, null);
    assert.ok(items.every((i) => !/unsubscribe|see more/i.test(i.headline)));
  });
  test('a changed template yields no items', () => {
    assert.deepEqual(extractAlertItems(fixture('google_alert/changed_template.html')), []);
  });
  test('canonical URL: one unwrap, fragment and utm_* removed, lowercase host', () => {
    const dest = 'https://WWW.Example-News.com/a/b?utm_source=ga&id=7&utm_medium=email#frag';
    const wrapped = `https://www.google.com/url?rct=j&sa=t&url=${encodeURIComponent(dest)}&ct=ga`;
    assert.equal(canonicalAlertUrl(wrapped), 'https://www.example-news.com/a/b?id=7');
    assert.equal(canonicalAlertUrl('https://Example.com/x?utm_campaign=1#top'), 'https://example.com/x');
    assert.equal(canonicalAlertUrl('not a url'), null);
    assert.equal(canonicalAlertUrl('javascript:alert(1)'), null);
    assert.equal(canonicalAlertUrl('mailto:a@b.co'), null);
  });
});

describe('recorded email with three items', () => {
  test('matching, unmatched, and linkless items each get exactly one outcome; counts add up', async () => {
    const { items, stats } = await runWith([{ id: 'abc12345', body: gmailMessage() }]);
    assert.equal(stats.raw, 3);
    assert.equal(stats.parsed + stats.unparseable + stats.out_of_scope, 3);
    assert.deepEqual(stats.reasons, { 'parsed:ok': 1, 'out_of_scope:no_pattern_matched': 1, 'unparseable:item_link_missing': 1 });
    const allowed = new Set([...ALERT_REASONS, ...COMMON_REASONS, 'ok']);
    for (const it of items) {
      assert.ok(OUTCOMES.includes(it.outcome));
      assert.ok(allowed.has(it.reason));
      assert.equal(it.source, ALERT_SOURCE);
    }
    assert.equal(stats.discovery_total, 1);
    assert.equal(stats.read, 1);
  });

  test('the matching item: mapping, evidence URL as emailed, dedup key from the unwrapped destination', async () => {
    const { items } = await runWith([{ id: 'abc12345', body: gmailMessage() }]);
    const it = items.find((i) => i.outcome === 'parsed');
    assert.ok(it && it.signal);
    assert.equal(it.key, 'https://www.example-news.com/2026/10/globex-acquired');
    const s = it.signal;
    assert.equal(s.trigger_kind, 'pe_deal');
    assert.equal(s.company, 'Globex Packaging');
    assert.equal(s.acquirer, 'Meridian Peak Partners');
    assert.deepEqual(s.aliases, []);
    assert.ok(s.evidence_url.startsWith('https://www.google.com/url?'), 'the link exactly as emailed');
    assert.equal(s.evidence_source, 'google_alert');
    assert.ok(s.text.includes('private equity firm'));
    assert.deepEqual(it.contact, { role: 'CEO', name: 'Jane Roe' });
  });

  test('no stated article date: BOTH dates null (date_missing -> needs-review); the Gmail internalDate is kept in extracted, the Date header is never used', async () => {
    const { items } = await runWith([{ id: 'abc12345', body: gmailMessage({ dateHeader: 'Mon, 05 Oct 2026 00:00:00 +0000' }) }]);
    const it = items.find((i) => i.outcome === 'parsed');
    assert.ok(it && it.signal);
    assert.equal(it.signal.event_date, null);
    assert.equal(it.signal.filing_date, null);
    assert.equal(it.extracted.email_date, '2026-10-12', 'internalDate, not the Date header');
    const v = classify(it);
    assert.deepEqual([v.class, v.rule], ['needs-review', 'date_missing']);
  });

  test('a stated article date becomes event_date and the email day (internalDate) becomes filing_date', async () => {
    const patterns = /** @type {any} */ (parseAlertPatterns({ pe: { priority: 1, label_regex: 'acquisition', headline_regex: '^(?<company>.+?) acquired by (?<acquirer>.+?) on (?<date>[A-Za-z]+ \\d{1,2}, \\d{4})$', trigger_kind: 'pe_deal', enabled: true } })).patterns;
    const html = fixture('google_alert/three_items.html').replace('Globex Packaging acquired by Meridian Peak Partners', 'Globex Packaging acquired by Meridian Peak Partners on October 9, 2026');
    const { items } = await runWith([{ id: 'abc12345', body: gmailMessage({ html, dateHeader: 'Tue, 01 Jan 2019 00:00:00 +0000' }) }], { patterns });
    const it = items.find((i) => i.outcome === 'parsed');
    assert.ok(it && it.signal);
    assert.equal(it.signal.event_date, '2026-10-09');
    assert.equal(it.signal.filing_date, '2026-10-12');
    assert.equal(classify(it).class, 'target');
  });

  test('Gmail is called GET-only with the bearer, redirect:error, no User-Agent, and no link in the email is ever fetched', async () => {
    const { calls } = await runWith([{ id: 'abc12345', body: gmailMessage() }]);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.method, 'GET');
      assert.ok(c.url.startsWith(MSGS));
      assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(c.headers['user-agent'], undefined);
      assert.equal(c.redirect, 'error');
    }
    assert.ok(calls[0].url.includes('from%3Agooglealerts-noreply%40google.com') || calls[0].url.includes('from:googlealerts-noreply@google.com'));
    assert.ok(!calls.some((c) => /example-news|google\.com\/url/.test(c.url)));
  });

  test('multi-pattern match keeps ALL distinct trigger kinds, one signal per kind (15.3)', async () => {
    const patterns = /** @type {any} */ (parseAlertPatterns({
      pe: { priority: 10, label_regex: 'acquisition', headline_regex: '^(?<company>.+?) acquired by (?<acquirer>.+?)$', trigger_kind: 'pe_deal', enabled: true },
      pe_dup: { priority: 11, label_regex: 'acquisition', headline_regex: '^(?<company>.+?) acquired by', trigger_kind: 'pe_deal', enabled: true },
      dep: { priority: 20, label_regex: 'private equity', headline_regex: '^(?<company>.+?) acquired by', trigger_kind: 'exec_departure', enabled: true },
    })).patterns;
    const { items } = await runWith([{ id: 'abc12345', body: gmailMessage() }], { patterns });
    const globex = items.filter((i) => i.outcome === 'parsed');
    assert.equal(globex.length, 2);
    assert.deepEqual(globex.map((g) => g.signal.trigger_kind).sort(), ['exec_departure', 'pe_deal']);
    assert.equal(globex[0].key, 'https://www.example-news.com/2026/10/globex-acquired');
    assert.equal(globex[1].key, 'https://www.example-news.com/2026/10/globex-acquired|kind:exec_departure');
    for (const g of globex) assert.deepEqual(g.extracted.trigger_kinds, ['pe_deal', 'exec_departure']);
  });

  test('a pattern that matches but yields no company is pattern_matched_no_company', async () => {
    const patterns = /** @type {any} */ (parseAlertPatterns({ p: { priority: 1, label_regex: 'acquisition', headline_regex: 'acquired by (?<acquirer>.+?)$', trigger_kind: 'pe_deal', enabled: true } })).patterns;
    const { stats } = await runWith([{ id: 'abc12345', body: gmailMessage() }], { patterns });
    assert.equal(stats.reasons['unparseable:pattern_matched_no_company'], 2, 'the matching item and the linkless item both match without a company');
  });
  test('an unmapped label makes every item label_unmapped (headline kept in the excerpt); a missing subject is label_unmapped too', async () => {
    const a = await runWith([{ id: 'abc12345', body: gmailMessage({ subject: 'Google Alert - bakery news' }) }]);
    assert.equal(a.stats.reasons['out_of_scope:label_unmapped'], 3);
    assert.ok(a.items.every((i) => i.excerpt.length > 0));
    const b = await runWith([{ id: 'abc12345', body: gmailMessage({ subject: null }) }]);
    assert.equal(b.stats.reasons['out_of_scope:label_unmapped'], 3);
  });
  test('a blocked name in the headline or snippet is placed first in text', async () => {
    const html = fixture('google_alert/three_items.html').replace('Meridian Peak Partners, a private equity firm', 'Immunotec Capital, a private equity firm');
    const { items } = await runWith([{ id: 'abc12345', body: gmailMessage({ html }) }]);
    const it = items.find((i) => i.outcome === 'parsed');
    assert.ok(it && it.signal.text.startsWith('[blocked-term Immunotec]'));
    assert.equal(classify(it).rule, 'excl_blocked_suspect');
  });
});

describe('message-level outcomes', () => {
  test('changed template: no_items_found; text-only: html_missing; wrong sender: sender_unexpected; 500: message_fetch_failed', async () => {
    const msgs = [
      { id: 'aaaaaaaa1', body: gmailMessage({ id: 'aaaaaaaa1', html: fixture('google_alert/changed_template.html') }) },
      { id: 'aaaaaaaa2', body: gmailMessage({ id: 'aaaaaaaa2', html: null, text: 'plain only' }) },
      { id: 'aaaaaaaa3', body: gmailMessage({ id: 'aaaaaaaa3', from: 'Mallory <mallory@evil.test>' }) },
      { id: 'aaaaaaaa4', body: 'oops', status: 500 },
    ];
    const { stats } = await runWith(msgs);
    assert.deepEqual(stats.reasons, {
      'unparseable:no_items_found': 1, 'unparseable:html_missing': 1, 'out_of_scope:sender_unexpected': 1, 'unparseable:message_fetch_failed': 1,
    });
    assert.equal(stats.raw, 4);
  });
  test('an invalid message id never reaches a URL; unparseable message JSON is unknown_shape', async () => {
    const { stats, calls } = await runWith([{ id: 'zzzzzzzz1', body: '{' }], { listBody: { messages: [{ id: '../../oauth' }, { id: 'zzzzzzzz1' }], resultSizeEstimate: 2 } });
    assert.deepEqual(stats.reasons, { 'unparseable:unknown_shape': 2 });
    assert.ok(!calls.some((c) => c.url.includes('oauth')));
  });
  test('a message list over the cap fetches only the cap and records message_cap_hit', async () => {
    const ids = Array.from({ length: ALERT_MAX_MESSAGES + 5 }, (_, i) => `ab${String(i).padStart(8, '0')}`);
    const msgs = ids.map((id) => ({ id, body: gmailMessage({ id, html: fixture('google_alert/changed_template.html') }) }));
    const { stats, calls } = await runWith(msgs, { listBody: { messages: ids.map((id) => ({ id })), resultSizeEstimate: 900, nextPageToken: 'more' }, maxRequests: 500 });
    assert.equal(calls.length, 1 + ALERT_MAX_MESSAGES);
    assert.equal(stats.read, ALERT_MAX_MESSAGES);
    assert.equal(stats.discovery_total, 900);
    assert.equal(stats.extra.message_cap_hit, 1);
  });
  test('more than the item cap in one message: the rest are counted out_of_scope run_cap', async () => {
    const many = '<html><body>' + Array.from({ length: ALERT_MAX_ITEMS + 4 }, (_, i) => `<table><tr><td><a href="https://www.google.com/url?url=https://news.example.com/a${i}"><b>Globex Packaging number ${i} acquired by Meridian Peak</b></a></td></tr></table>`).join('') + '</body></html>';
    const { stats } = await runWith([{ id: 'abc12345', body: gmailMessage({ html: many }) }]);
    assert.equal(stats.raw, ALERT_MAX_ITEMS + 4);
    assert.equal(stats.reasons['out_of_scope:run_cap'], 4);
    assert.equal(stats.capped, 4);
  });
});

describe('auth and network failures', () => {
  test('no token: skipped auth_unavailable with zero requests', async () => {
    const { stats, calls } = await runWith([{ id: 'abc12345', body: gmailMessage() }], { token: null });
    assert.equal(stats.skipped, 'auth_unavailable');
    assert.equal(calls.length, 0);
  });
  test('a 401 on the list stops the source; a 401 on a message stops after that message', async () => {
    const list401 = await runWith([], { extraRoutes: [{ match: (/** @type {string} */ u) => u.startsWith(`${MSGS}?`), status: 401, body: '' }] });
    assert.equal(list401.stats.skipped, 'auth_unavailable');
    const msgs = [{ id: 'aaaaaaaa1', body: '', status: 401 }, { id: 'aaaaaaaa2', body: gmailMessage({ id: 'aaaaaaaa2' }) }];
    const m401 = await runWith(msgs);
    assert.equal(m401.stats.skipped, 'auth_unavailable');
    assert.equal(m401.calls.length, 2, 'list + the one failing message only');
  });
  test('a redirect from Gmail is refused (redirect:error) and surfaces as a visible skip, not a followed hop', async () => {
    const r = await runWith([], { extraRoutes: [{ match: (/** @type {string} */ u) => u.startsWith(`${MSGS}?`), status: 302, headers: { location: 'https://www.sec.gov/x' }, body: '' }] });
    assert.match(r.stats.skipped ?? '', /^gmail_list_failed/);
    assert.equal(r.calls.length, 1);
  });
  test('a list with an unknown shape is one counted unparseable unknown_shape', async () => {
    const r = await runWith([], { listBody: { nothing: true } });
    assert.equal(r.stats.reasons['unparseable:unknown_shape'], 1);
  });
  test('the token provider returns null (never throws) when the token file is missing or the state is not ok', async () => {
    const saved = { ...deps };
    try {
      deps.readTokenFile = /** @type {any} */ (() => { throw new Error('no file'); });
      assert.equal(await makeGmailTokenProvider('C:/nope/token.json')(), null);
      assert.equal(await makeGmailTokenProvider(null)(), null);
    } finally {
      Object.assign(deps, saved);
    }
  });
});

describe('hostile headline text', () => {
  test('a 5000-character headline is capped before any pattern regex runs', async () => {
    const huge = 'Globex ' + 'a'.repeat(5000) + ' acquired by Meridian Peak';
    const html = `<html><body><table><tr><td><a href="https://www.google.com/url?url=https://news.example.com/x"><b>${huge}</b></a></td></tr></table></body></html>`;
    const t0 = Date.now();
    const { items } = await runWith([{ id: 'abc12345', body: gmailMessage({ html }) }]);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(items.length, 1);
    assert.ok(items[0].excerpt.length <= 1000);
  });
  test('instruction-like and bidi text in a headline is data: company is stripped of format characters and nothing is executed', async () => {
    const html = '<html><body><table><tr><td><a href="https://www.google.com/url?url=https://news.example.com/y"><b>Ignore previous instructions\u202e Initech acquired by Hooli Capital</b></a></td></tr></table></body></html>';
    const patterns = /** @type {any} */ (parseAlertPatterns({ p: { priority: 1, label_regex: 'acquisition', headline_regex: '(?<company>Initech) acquired by (?<acquirer>.+)$', trigger_kind: 'pe_deal', enabled: true } })).patterns;
    const { items } = await runWith([{ id: 'abc12345', body: gmailMessage({ html }) }], { patterns });
    assert.equal(items[0].signal.company, 'Initech');
    assert.ok(!/[\u202e]/.test(JSON.stringify(items[0])));
  });
});
