// @ts-check
/**
 * src/targets/edgar-fts.js (target finder PR2, plan 14.4 C + 15.3). Recorded fixtures only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFts, parseFtsQueries, loadFtsQueries, FTS_REASONS, FTS_SOURCE } from '../src/targets/edgar-fts.js';
import { createEdgarClient } from '../src/targets/edgar-client.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import { COMMON_REASONS, OUTCOMES } from '../src/targets/outcomes.js';
import { classifySignal, loadTargetRules } from '../src/core/target-classify.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { createReplayFetch, fastTiming, searchJson } from './helpers/targets-replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, '..', 'config');
const RULES = loadTargetRules(CONFIG_DIR);
const NOW = new Date('2026-10-15T12:00:00Z');
const UA = 'Test Person test.person@corp.test';
const BLOCKED = [...BUILT_IN_BLOCKED];
/** @type {import('../src/core/target-exclusion.js').BlockedList} */
const OK_LIST = { entries: BLOCKED, status: 'ok', error: null };

/** @type {any} */
const Q_PE = { id: 'pe_acquired', priority: 10, q: '"acquired by" "private equity"', forms: '8-K', trigger_kind: 'pe_deal', window_days: 30, enabled: true };

/** @param {import('./helpers/targets-replay.js').Route[]} routes @param {any[]} queries */
async function runWith(routes, queries = [Q_PE]) {
  const replay = createReplayFetch(routes);
  const ft = fastTiming();
  const edgar = createEdgarClient({ guard: createFetchGuard({ fetch: replay.fetch, userAgent: UA }), timing: ft.timing });
  const out = await runFts({ edgar, now: NOW, blocked: BLOCKED, queries });
  return { ...out, calls: replay.calls };
}
const standard = () => [
  { match: /search-index/, file: 'edgar_fts/search_pe.json' },
  { match: 'https://www.sec.gov/Archives/edgar/data/8888888/000888888826000201/ex99.htm', file: 'edgar_fts/doc_pe.htm' },
];
/** @param {any} item */
const classify = (item) => classifySignal(item.signal, { rules: RULES, now: NOW, blocked: OK_LIST });

describe('query config', () => {
  test('the shipped file parses, is a keyed object with integer priorities, and ships with every query DISABLED', () => {
    const r = loadFtsQueries(CONFIG_DIR);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.queries.length >= 1);
    for (const q of r.queries) {
      assert.ok(Number.isInteger(q.priority));
      assert.equal(q.enabled, false, `${q.id}: nothing is enabled until Damian approves a set`);
    }
  });
  test('order comes from priority numbers (ties by id), never file position; "_" keys are comments', () => {
    const base = { q: 'x', forms: '8-K', trigger_kind: 'pe_deal', window_days: 30, enabled: true };
    const r = parseFtsQueries({ _comment: 'hello', b: { ...base, priority: 5 }, a: { ...base, priority: 5 }, c: { ...base, priority: 1 } });
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.queries.map((q) => q.id), ['c', 'a', 'b']);
  });
  test('any invalid entry invalidates the file (visible skip, not a silent drop)', () => {
    const ok = { priority: 1, q: 'x', forms: '8-K', trigger_kind: 'pe_deal', window_days: 30, enabled: true };
    const bad = [
      { a: { ...ok, priority: 1.5 } }, { a: { ...ok, trigger_kind: 'rumor' } }, { a: { ...ok, window_days: 0 } }, { a: { ...ok, forms: '8-K;rm -rf' } },
      { a: { ...ok, q: '' } }, { a: { ...ok, enabled: 'yes' } }, { 'A B': ok }, { a: 5 }, [], null, 'x',
    ];
    for (const b of bad) assert.equal(parseFtsQueries(b).ok, false, JSON.stringify(b));
  });
  test('an invalid config file skips the adapter with a visible reason and zero requests', async () => {
    const dir = fs.mkdtempSync(path.join(fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'x-')), 'cfg-'));
    fs.writeFileSync(path.join(dir, 'target-fts-queries.json'), '{ nope');
    const replay = createReplayFetch([]);
    const edgar = createEdgarClient({ guard: createFetchGuard({ fetch: replay.fetch, userAgent: UA }), timing: fastTiming().timing });
    const out = await runFts({ edgar, now: NOW, blocked: BLOCKED, configDir: dir });
    assert.match(out.stats.skipped ?? '', /^config_invalid/);
    assert.equal(replay.calls.length, 0);
  });
});

describe('recorded full-text run', () => {
  test('every hit gets exactly one outcome; a disabled query is counted query_disabled', async () => {
    const disabled = { ...Q_PE, id: 'off', enabled: false, priority: 99 };
    const { items, stats } = await runWith(standard(), [Q_PE, disabled]);
    assert.equal(stats.raw, 4);
    assert.equal(items.length, 4);
    const allowed = new Set([...FTS_REASONS, ...COMMON_REASONS, 'ok']);
    for (const it of items) {
      assert.ok(OUTCOMES.includes(it.outcome));
      assert.ok(allowed.has(it.reason), it.reason);
      assert.equal(it.source, FTS_SOURCE);
    }
    assert.deepEqual(stats.reasons, {
      'parsed:ok': 1, 'unparseable:hit_shape_unknown': 1, 'unparseable:company_missing': 1, 'out_of_scope:query_disabled': 1,
    });
    assert.equal(stats.discovery_total, 6, 'sum of per-form totals: 8-K and 8-K/A are separate requests');
  });

  test('normal hit: cleaned company, raw names kept as aliases, acquirer from the sentence, windowed text', async () => {
    const { items, calls } = await runWith(standard());
    const it = items.find((i) => i.key === 'pe_acquired|0008888888-26-000201');
    assert.ok(it && it.signal);
    const s = it.signal;
    assert.equal(s.trigger_kind, 'pe_deal');
    assert.equal(s.company, 'Globex Packaging Inc');
    assert.ok(s.aliases.includes('Globex Packaging Holdings'));
    assert.ok(s.aliases.some((a) => a.includes('CIK 0008888888')), 'raw display name kept');
    assert.equal(s.acquirer, 'Meridian Peak Partners');
    assert.equal(s.investor, null);
    assert.equal(s.pe_firm, null);
    assert.equal(s.event_date, null, 'no 8-K cover date in a press release exhibit');
    assert.equal(s.filing_date, '2026-10-08');
    assert.ok(s.text.includes('acquired by Meridian Peak Partners'));
    assert.ok(s.text.length <= 4000);
    assert.equal(s.size, undefined);
    assert.equal(it.contact, null, 'pe_deal carries no contact');
    assert.equal(s.evidence_url, 'https://www.sec.gov/Archives/edgar/data/8888888/000888888826000201/0008888888-26-000201-index.htm');
    const v = classify(it);
    assert.deepEqual([v.class, v.size_verified], ['target', false]);
    const search = calls[0].url;
    assert.ok(search.includes('forms=8-K') && search.includes('dateRange=custom') && search.includes('startdt=2026-09-15') && search.includes('enddt=2026-10-15'));
    assert.ok(search.includes('acquired+by'));
    assert.ok(calls.every((c) => c.method === 'GET'));
  });

  test('a hit with no filename in _id is hit_shape_unknown; a hit with no display names is company_missing', async () => {
    const { items } = await runWith(standard());
    assert.equal(items.find((i) => i.key.endsWith('0009999999-26-000202'))?.reason, 'hit_shape_unknown');
    assert.equal(items.find((i) => i.key.endsWith('0001212121-26-000203'))?.reason, 'company_missing');
  });

  test('FTS contact rule: role only, never a name, for an exec_departure query', async () => {
    const q = { ...Q_PE, id: 'dep', trigger_kind: 'exec_departure', q: '"Chief Technology Officer" resigned' };
    const doc = '<p>Robert Vance, Chief Executive Officer, said the Chief Technology Officer, Alan Turing, resigned effective October 31.</p>';
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0008888888-26-000201', ciks: ['0008888888'], display_names: ['Globex Packaging Inc  (CIK 0008888888)'], file_date: '2026-10-08', form: '8-K', _id: '0008888888-26-000201:ex99.htm' }]) },
      { match: /ex99\.htm/, body: doc },
    ];
    const { items } = await runWith(routes, [q]);
    assert.equal(items[0].outcome, 'parsed');
    assert.equal(items[0].signal.role, 'Chief Technology Officer');
    assert.deepEqual(items[0].contact, { role: 'Chief Technology Officer', name: null });
  });

  test('a blocked name past the window is still found by the full-document scan and placed first', async () => {
    const doc = '<p>' + 'The company is a leader in packaging. '.repeat(300) + 'Acquired by Meridian Peak Partners.</p><p>Formerly part of Adv\u200Bisicon Group.</p>';
    const routes = [
      { match: /search-index/, file: 'edgar_fts/search_pe.json' },
      { match: /ex99\.htm/, body: doc },
    ];
    const { items } = await runWith(routes);
    const it = items.find((i) => i.outcome === 'parsed');
    assert.ok(it);
    assert.ok(it.signal.text.startsWith('[blocked-term Advisicon]'));
    assert.equal(classify(it).rule, 'excl_blocked_suspect');
  });

  test('budget stop is run_cap; a failed read is a flagged needs-review signal; oversized name is name_too_long', async () => {
    const hit = (/** @type {number} */ n, /** @type {string} */ name) => ({ adsh: `0008888888-26-00020${n}`, ciks: ['0008888888'], display_names: [name], file_date: '2026-10-08', form: '8-K', _id: `0008888888-26-00020${n}:ex99.htm` });
    const search = searchJson([hit(1, 'Alpha Freight Systems Inc  (CIK 0008888888)'), hit(2, 'Beta Freight Systems Inc  (CIK 0008888888)'), hit(3, 'N'.repeat(300))]);
    const replay = createReplayFetch([{ match: /search-index/, body: search }, { match: /ex99\.htm/, status: 404, body: '' }]);
    const edgar = createEdgarClient({ guard: createFetchGuard({ fetch: replay.fetch, userAgent: UA }), timing: { ...fastTiming().timing, budgets: { fts: 1 } } });
    const out = await runFts({ edgar, now: NOW, blocked: BLOCKED, queries: [Q_PE] });
    assert.deepEqual(out.stats.reasons, { 'parsed:ok': 1, 'out_of_scope:run_cap': 1, 'unparseable:name_too_long': 1 });
    assert.equal(out.stats.capped, 1);
    const failed = out.items.find((i) => i.outcome === 'parsed');
    assert.ok(failed && failed.signal);
    assert.equal(failed.signal.doc_fetch, 'failed');
    assert.deepEqual(classify(failed).rule, 'doc_fetch_failed');
  });

  test('skips: no SEC contact and a blocked client make zero requests', async () => {
    const none = await runFts({ edgar: null, now: NOW, blocked: BLOCKED, queries: [Q_PE] });
    assert.equal(none.stats.skipped, 'sec_contact_missing');
    const blocked = await runWith([{ match: /search-index/, status: 429, body: '' }]);
    assert.equal(blocked.items.length, 0);
    assert.ok(blocked.stats.warnings.includes('sec_blocked'));
  });

  test('garbage in every hit field yields exactly one outcome per hit and no exception', async () => {
    const GARBAGE = [undefined, null, '', 0, NaN, true, {}, [], 'x'.repeat(3000), '../..', { a: 1 }];
    const good = { ciks: ['0008888888'], display_names: ['Globex Packaging Inc'], file_date: '2026-10-08', form: '8-K' };
    /** @type {any[]} */
    const hits = [];
    let i = 0;
    for (const f of ['adsh', 'ciks', 'display_names', 'file_date', 'form']) {
      for (const g of GARBAGE) { i += 1; hits.push({ ...good, adsh: `0008888888-26-${String(i).padStart(6, '0')}`, [f]: g }); }
    }
    const body = JSON.stringify({ hits: { total: { value: hits.length }, hits: hits.map((h) => ({ _id: `${h.adsh}:ex99.htm`, _source: h })) } });
    const { items, stats } = await runWith([{ match: /search-index/, body }, { match: /ex99\.htm/, file: 'edgar_fts/doc_pe.htm' }]);
    assert.equal(stats.raw, items.length);
    assert.equal(stats.parsed + stats.unparseable + stats.out_of_scope, stats.raw);
    assert.equal(stats.reasons['unparseable:adapter_exception'] ?? 0, 0);
    assert.ok(items.length >= hits.length - 5 * 2);
  });
});
