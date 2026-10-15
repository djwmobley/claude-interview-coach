// @ts-check
/**
 * PR2b: SEC EDGAR live-shape fixes (plan section 16). Recorded fixtures only (test/fixtures/targets/live/ holds
 * trimmed copies of the 2026-10-15 live captures; documents the captures did not include are small synthetic
 * bodies built in the test). No network, no powershell, no browsers.
 *
 * Covers: one discovery request per form type, per-form coverage, per-source discovery budgets, one signal per
 * accession with up to 3 documents read in the specified order, doc-fetch failure verdicts, union of display
 * names and blocked-name exclusion, the primary filer CIK rule, Form D previous names, relatedPersonName
 * parties, fund signals, and the new classifier reasons.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFormD, classifyParty, splitPreviousNames, parseFormDXml } from '../src/targets/form-d.js';
import { run8k } from '../src/targets/edgar-8k.js';
import { runFts } from '../src/targets/edgar-fts.js';
import { createEdgarClient } from '../src/targets/edgar-client.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import {
  formsToRequests, chooseDocs, primaryFiler, cikInDisplayName, mergeCoverage,
} from '../src/targets/edgar-shared.js';
import { classifySignal, loadTargetRules } from '../src/core/target-classify.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { createReplayFetch, fastTiming, searchJson, fixture } from './helpers/targets-replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = loadTargetRules(path.join(HERE, '..', 'config'));
const NOW = new Date('2026-10-15T12:00:00Z');
const UA = 'Test Person test.person@corp.test';
const BLOCKED = [...BUILT_IN_BLOCKED];
/** @type {import('../src/core/target-exclusion.js').BlockedList} */
const OK_LIST = { entries: BLOCKED, status: 'ok', error: null };
/** @param {any} item */
const classify = (item) => classifySignal(item.signal, { rules: RULES, now: NOW, blocked: OK_LIST });

/**
 * @param {import('./helpers/targets-replay.js').Route[]} routes
 * @param {Record<string, number>} [budgets]
 */
function makeEdgar(routes, budgets) {
  const replay = createReplayFetch(routes);
  const ft = fastTiming();
  const edgar = createEdgarClient({ guard: createFetchGuard({ fetch: replay.fetch, userAgent: UA }), timing: { ...ft.timing, ...(budgets ? { budgets } : {}) } });
  return { edgar, calls: replay.calls };
}

// ---------------------------------------------------------------------------
// Discovery: one request per form, coverage, separate budgets
// ---------------------------------------------------------------------------

describe('formsToRequests', () => {
  test('every base form is followed by its amendment form; explicit amendments are not duplicated', () => {
    assert.deepEqual(formsToRequests('D'), ['D', 'D/A']);
    assert.deepEqual(formsToRequests('D,D/A'), ['D', 'D/A']);
    assert.deepEqual(formsToRequests('8-K'), ['8-K', '8-K/A']);
    assert.deepEqual(formsToRequests('8-K/A'), ['8-K/A']);
    assert.deepEqual(formsToRequests(' 8-K , 10-K '), ['8-K', '8-K/A', '10-K', '10-K/A']);
    assert.deepEqual(formsToRequests(''), []);
  });
});

describe('Form D discovery', () => {
  const docFund = 'https://www.sec.gov/Archives/edgar/data/2157441/000215744126000002/primary_doc.xml';
  const docOp = 'https://www.sec.gov/Archives/edgar/data/2145349/000214534926000002/primary_doc.xml';
  const routes = () => [
    { match: /search-index\?.*forms=D&/, file: 'live/formd_search_D.json' },
    { match: /search-index\?.*forms=D%2FA/, file: 'live/formd_search_DA.json' },
    { match: docFund, file: 'live/formd_fund_da.xml' },
    { match: docOp, file: 'live/formd_operating_da.xml' },
    { match: /submissions/, status: 404, body: '' },
  ];

  test('one request per form type, D then D/A, merged by accession; coverage is complete and per form', async () => {
    const { edgar, calls } = makeEdgar(routes());
    const { items, stats } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    const searches = calls.filter((c) => c.url.includes('search-index'));
    assert.equal(searches.length, 2);
    assert.ok(/forms=D&/.test(searches[0].url) && searches[1].url.includes('forms=D%2FA'));
    assert.equal(items.length, 4, '5 hits, one shared accession merged');
    assert.equal(new Set(items.map((i) => i.key)).size, 4);
    assert.equal(stats.coverage?.source, 'complete');
    assert.deepEqual(Object.keys(stats.coverage?.forms ?? {}), ['D', 'D/A']);
    assert.deepEqual(stats.coverage?.forms['D/A'], { status: 'complete', total: 3, read: 3, pages: [{ from: 0, hits: 3, ok: true, reason: null }] });
    assert.equal(stats.discovery_total, 5);
  });

  test('the live D/A amendment is its own signal and supersedes the original', async () => {
    const { edgar } = makeEdgar([
      ...routes().slice(0, 1),
      { match: /forms=D%2FA/, body: searchJson([{ adsh: '0002145349-26-000002', ciks: ['0002145349'], display_names: ['Persentic Inc  (CIK 0002145349)'], file_date: '2026-10-15', form: 'D/A', file_type: 'D/A', sics: ['7372'] }]) },
      routes()[3], routes()[4],
    ]);
    const { items } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    const it = items.find((i) => i.key === '0002145349-26-000002');
    assert.ok(it && it.signal);
    assert.equal(it.extracted.amendment, true);
    assert.deepEqual(it.supersedes, { source: 'edgar_form_d', key: '0002145349-26-000001' });
    assert.equal(it.signal.issuer.sic, '7372', 'the SIC from the search index is the fallback when the submissions fetch fails');
  });

  test('a failed D/A request makes the source partial, never complete; the D hits are still processed', async () => {
    const { edgar } = makeEdgar([
      { match: /forms=D&/, file: 'live/formd_search_D.json' },
      { match: /forms=D%2FA/, status: 500, body: 'err' },
      { match: /primary_doc/, status: 404, body: '' },
      { match: /submissions/, status: 404, body: '' },
    ]);
    const { stats } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    assert.equal(stats.coverage?.source, 'partial');
    assert.equal(stats.coverage?.forms.D.status, 'complete');
    assert.equal(stats.coverage?.forms['D/A'].status, 'none');
    assert.deepEqual(stats.coverage?.forms['D/A'].pages, [{ from: 0, hits: 0, ok: false, reason: 'http_error' }]);
    assert.equal(stats.extra.undercoverage, 1);
    assert.ok(stats.warnings.includes('discovery_http_error'));
    assert.ok(stats.raw >= 2);
  });

  test('more hits than pages read is partial, per page; a 3-page cap per form', async () => {
    const page = (/** @type {number} */ n) => searchJson(Array.from({ length: 100 }, (_, i) => ({ adsh: `0000000${n}-26-${String(i + 1).padStart(6, '0')}`, ciks: ['0000000001'], display_names: ['Big Fund LP'], file_date: '2026-10-10', form: 'D' })), 3115);
    const { edgar, calls } = makeEdgar([
      { match: /forms=D&.*from=0/, body: page(1) }, { match: /forms=D&.*from=100/, body: page(2) }, { match: /forms=D&.*from=200/, body: page(3) },
      { match: /forms=D%2FA/, body: searchJson([], 0) },
    ]);
    const { stats } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    const searches = calls.filter((c) => c.url.includes('search-index'));
    assert.equal(searches.length, 4, '3 pages of D, 1 page of D/A');
    assert.equal(stats.coverage?.forms.D.status, 'partial');
    assert.equal(stats.coverage?.forms.D.pages.length, 3);
    assert.equal(stats.coverage?.forms['D/A'].status, 'complete');
    assert.equal(stats.coverage?.source, 'partial');
    assert.equal(stats.extra.discovery_not_read, 3115 - 300);
  });

  test('a blocked first request skips the source with sec_blocked and carries the warning', async () => {
    const { edgar } = makeEdgar([{ match: /search-index/, status: 429, body: '' }]);
    const { stats } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    assert.equal(stats.skipped, 'sec_blocked');
    assert.ok(stats.warnings.includes('sec_blocked'));
  });
});

describe('separate discovery budgets per source', () => {
  test('full-text queries cannot use up Form D or 8-K discovery', async () => {
    const q = (/** @type {string} */ id) => ({ id, priority: 1, q: 'merger', forms: '8-K', trigger_kind: /** @type {const} */ ('pe_deal'), window_days: 30, enabled: true });
    const { edgar, calls } = makeEdgar([
      { match: /forms=D/, file: 'live/formd_search_D.json' },
      { match: /forms=8-K/, body: searchJson([], 0) },
      { match: /./, body: searchJson([], 0) },
    ], { discovery_fts: 2 });
    const fts = await runFts({ edgar, now: NOW, blocked: BLOCKED, queries: [q('a'), q('b'), q('c')] });
    assert.equal(edgar.hasBudget('discovery_fts'), false);
    assert.equal(fts.stats.coverage?.source, 'partial', 'queries b and c got no discovery');
    assert.equal(fts.stats.coverage?.forms['b:8-K'].status, 'none');
    const before = calls.length;
    const fd = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    const k8 = await run8k({ edgar, now: NOW, blocked: BLOCKED });
    assert.ok(calls.length > before, 'Form D and 8-K still ran discovery');
    assert.equal(fd.stats.coverage?.forms.D.pages[0].ok, true);
    assert.equal(k8.stats.coverage?.forms['8-K'].pages[0].ok, true);
  });
});

describe('8-K discovery', () => {
  test('8-K then 8-K/A, one request each, merged; the real 8-K/A (amendment) with a co-registrant filer is handled', async () => {
    const { edgar, calls } = makeEdgar([
      { match: /forms=8-K&/, file: 'live/8k_search_8K.json' },
      { match: /forms=8-K%2FA/, file: 'live/8k_search_8KA.json' },
      { match: /cmt-20260928\.htm/, file: 'live/8k_cmt_doc.htm' },
      { match: /Archives/, status: 404, body: '' },
    ]);
    const { items, stats } = await run8k({ edgar, now: NOW, blocked: BLOCKED });
    const searches = calls.filter((c) => c.url.includes('search-index'));
    assert.equal(searches.length, 2);
    assert.equal(stats.coverage?.source, 'complete');
    assert.equal(items.length, 3);
    const vici = items.find((i) => i.key === '0001705696-26-000094|5.02');
    assert.ok(vici && vici.signal);
    assert.equal(vici.signal.company, 'VICI PROPERTIES INC.', 'primary filer is ciks[0]');
    assert.ok(vici.signal.aliases.some((a) => a.includes('VICI Properties L.P.')), 'the co-registrant is an alias');
    assert.equal(vici.extracted.amendment, true);
    const cmt = items.find((i) => i.key === '0001026655-26-000067|5.02');
    assert.ok(cmt);
    assert.equal(cmt.outcome, 'out_of_scope', 'the real CMT amendment is not a CTO-class departure');
    assert.deepEqual(cmt.extracted.evidence, [{ doc_type: '8-K/A', filename: 'cmt-20260928.htm', ok: true, reason: null, truncated: false }]);
  });

  test('a 8-K accession with several hit documents yields ONE signal and records each document read', async () => {
    const hit = (/** @type {string} */ file, /** @type {string} */ type) => ({ _id: `0004444444-26-000300:${file}`, adsh: '0004444444-26-000300', ciks: ['0004444444'], display_names: ['Fabrikam Systems Inc  (CIK 0004444444)'], file_date: '2026-10-09', form: '8-K', file_type: type, items: ['5.02', '9.01'] });
    const main = '<p>Item 5.02 Departure</p><p>Pat Smith resigned as Chief Technology Officer effective October 1, 2026.</p><p>Item 9.01 Exhibits</p>';
    const { edgar, calls } = makeEdgar([
      { match: /forms=8-K&/, body: searchJson([hit('ex991.htm', 'EX-99.1'), hit('form8k.htm', '8-K')]) },
      { match: /forms=8-K%2FA/, body: searchJson([]) },
      { match: /form8k\.htm/, body: main },
      { match: /ex991\.htm/, body: '<p>Press release.</p>' },
    ]);
    const { items } = await run8k({ edgar, now: NOW, blocked: BLOCKED });
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.outcome, 'parsed');
    const docCalls = calls.filter((c) => !c.url.includes('search-index')).map((c) => c.url.split('/').pop());
    assert.deepEqual(docCalls, ['form8k.htm', 'ex991.htm'], 'the filing form first, then EX-99');
    assert.deepEqual(it.extracted.evidence.map((/** @type {any} */ e) => [e.doc_type, e.filename]), [['8-K', 'form8k.htm'], ['EX-99.1', 'ex991.htm']]);
    assert.equal(it.signal.role, 'Chief Technology Officer');
    assert.equal(it.signal.doc_fetch, 'ok');
    assert.equal(it.signal.unread_hit_docs, 0);
  });

  test('8-K: when the exhibit fails to fetch, the filing is flagged partial and never passes as clean or out_of_scope', async () => {
    const hit = (/** @type {string} */ file, /** @type {string} */ type) => ({ _id: `0004444444-26-000300:${file}`, adsh: '0004444444-26-000300', ciks: ['0004444444'], display_names: ['Fabrikam Systems Inc  (CIK 0004444444)'], file_date: '2026-10-09', form: '8-K', file_type: type, items: ['5.02'] });
    const main = '<p>Item 5.02 Departure</p><p>Pat Smith resigned as Chief Technology Officer effective October 1, 2026.</p><p>Item 9.01 Exhibits</p>';
    const { edgar } = makeEdgar([
      { match: /forms=8-K&/, body: searchJson([hit('form8k.htm', '8-K'), hit('ex991.htm', 'EX-99.1')]) },
      { match: /forms=8-K%2FA/, body: searchJson([]) },
      { match: /form8k\.htm/, body: main },
      { match: /ex991\.htm/, status: 404, body: '' },
    ]);
    const { items } = await run8k({ edgar, now: NOW, blocked: BLOCKED });
    assert.equal(items[0].outcome, 'parsed');
    assert.equal(items[0].signal.doc_fetch, 'partial');
    assert.deepEqual([classify(items[0]).class, classify(items[0]).rule], ['needs-review', 'doc_fetch_failed_partial']);
    assert.deepEqual(items[0].extracted.evidence.map((/** @type {any} */ e) => e.ok), [true, false]);
  });

  test('8-K: a partly read filing whose section is in the unread document is parsed (flagged), not section_not_found', async () => {
    const hit = (/** @type {string} */ file, /** @type {string} */ type) => ({ _id: `0004444444-26-000300:${file}`, adsh: '0004444444-26-000300', ciks: ['0004444444'], display_names: ['Fabrikam Systems Inc  (CIK 0004444444)'], file_date: '2026-10-09', form: '8-K', file_type: type, items: ['5.02'] });
    const { edgar } = makeEdgar([
      { match: /forms=8-K&/, body: searchJson([hit('form8k.htm', '8-K'), hit('ex991.htm', 'EX-99.1')]) },
      { match: /forms=8-K%2FA/, body: searchJson([]) },
      { match: /form8k\.htm/, status: 500, body: '' },
      { match: /ex991\.htm/, body: '<p>Press release only.</p>' },
    ]);
    const { items } = await run8k({ edgar, now: NOW, blocked: BLOCKED });
    assert.equal(items[0].outcome, 'parsed');
    assert.equal(classify(items[0]).rule, 'doc_fetch_failed_partial');
  });
});

// ---------------------------------------------------------------------------
// Full-text search: grouping by accession
// ---------------------------------------------------------------------------

describe('full-text search grouping', () => {
  /** @type {any} */
  const Q = { id: 'pe', priority: 1, q: '"acquired by"', forms: '8-K', trigger_kind: 'pe_deal', window_days: 30, enabled: true };
  const A = '0005555555-26-000400';
  /** @param {string} file @param {string} type @param {Record<string, any>} [x] */
  const hit = (file, type, x = {}) => ({ _id: `${A}:${file}`, adsh: A, ciks: ['0005555555'], display_names: ['Contoso Dynamics Inc  (CIK 0005555555)'], file_date: '2026-10-09', form: '8-K', file_type: type, items: ['1.01'], ...x });
  const doc = (/** @type {string} */ s) => `<p>${s}</p>`;
  /**
   * @param {any[]} hits
   * @param {Record<string, string|number>} docs filename -> body, or an HTTP status number
   */
  async function run(hits, docs) {
    const routes = [
      { match: /search-index/, body: searchJson(hits) },
      ...Object.entries(docs).map(([f, b]) => (typeof b === 'number' ? { match: new RegExp(`/${f.replace(/\./g, '\\.')}$`), status: b, body: '' } : { match: new RegExp(`/${f.replace(/\./g, '\\.')}$`), body: b })),
      { match: /Archives/, status: 404, body: '' },
    ];
    const { edgar, calls } = makeEdgar(routes);
    const out = await runFts({ edgar, now: NOW, blocked: BLOCKED, queries: [Q] });
    return { ...out, calls: calls.filter((c) => !c.url.includes('search-index')).map((c) => c.url.split('/').pop()) };
  }

  test('real exhibit hits: one signal per accession, EX-99.* first, each document recorded with type and filename', async () => {
    const { edgar, calls } = makeEdgar([
      { match: /search-index/, file: 'live/fts_search.json' },
      { match: /d140608dex991\.htm$/, body: doc('Parent acquired by Meridian Peak Partners in a take private.') },
      { match: /d140608dex21\.htm$/, body: doc('Agreement and Plan of Merger.') },
      { match: /Archives/, status: 404, body: '' },
    ]);
    const { items } = await runFts({ edgar, now: NOW, blocked: BLOCKED, queries: [Q] });
    assert.equal(items.length, 4, 'six hits, four accessions');
    const ccc = items.find((i) => i.key === 'pe|0001193125-26-422320');
    assert.ok(ccc && ccc.signal);
    assert.equal(ccc.signal.company, 'CCC Intelligent Solutions Holdings Inc.');
    assert.deepEqual(ccc.extracted.evidence.map((/** @type {any} */ e) => [e.doc_type, e.filename]), [['EX-99.1', 'd140608dex991.htm'], ['EX-2.1', 'd140608dex21.htm']]);
    assert.equal(ccc.signal.acquirer, 'Meridian Peak Partners');
    assert.equal(ccc.signal.unread_hit_docs, 0);
    const order = calls.filter((c) => c.url.includes('d140608')).map((c) => c.url.split('/').pop());
    assert.deepEqual(order, ['d140608dex991.htm', 'd140608dex21.htm']);
    assert.ok(ccc.signal.text.includes('[EX-99.1 d140608dex991.htm]'));
  });

  test('up to 3 documents, order: filing form, EX-99.*, rest in hit order; the remainder is counted as unread_hit_docs', async () => {
    const hits = [hit('ex101.htm', 'EX-10.1'), hit('ex21.htm', 'EX-2.1'), hit('ex991.htm', 'EX-99.1'), hit('main.htm', '8-K')];
    const r = await run(hits, { 'main.htm': doc('main acquired by Foo Capital'), 'ex991.htm': doc('press'), 'ex101.htm': doc('credit agreement'), 'ex21.htm': doc('merger agreement') });
    assert.equal(r.items.length, 1);
    assert.deepEqual(r.calls, ['main.htm', 'ex991.htm', 'ex101.htm']);
    const s = r.items[0].signal;
    assert.equal(s.unread_hit_docs, 1);
    assert.equal(r.items[0].extracted.unread_hit_docs, 1);
    assert.equal(classify(r.items[0]).rule, 'target_all_checks_passed', 'unread_hit_docs is informational and does not force review');
  });

  test('chooseDocs: pure ordering table', () => {
    const mk = (/** @type {string} */ f, /** @type {string} */ t) => /** @type {any} */ ({ filename: f, file_type: t, form: '8-K' });
    const r = chooseDocs([mk('a.htm', 'EX-3'), mk('b.htm', 'EX-99.2'), mk('c.htm', '8-K'), mk('d.htm', 'EX-99.1'), mk('e.htm', 'EX-4')]);
    assert.deepEqual(r.chosen.map((c) => c.filename), ['c.htm', 'b.htm', 'd.htm']);
    assert.equal(r.unread, 2);
    const noMain = chooseDocs([mk('a.htm', 'EX-3'), mk('b.htm', 'EX-99.1')]);
    assert.deepEqual(noMain.chosen.map((c) => c.filename), ['b.htm', 'a.htm']);
    const bad = chooseDocs([mk('../x.htm', '8-K'), mk('a/b.htm', 'EX-99.1')]);
    assert.deepEqual([bad.chosen.length, bad.invalid], [0, 2]);
  });

  test('every chosen document failed: doc_fetch failed, needs-review doc_fetch_failed', async () => {
    const r = await run([hit('main.htm', '8-K'), hit('ex991.htm', 'EX-99.1')], { 'main.htm': 500, 'ex991.htm': 404 });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].outcome, 'parsed');
    assert.equal(r.items[0].signal.doc_fetch, 'failed');
    assert.deepEqual([classify(r.items[0]).class, classify(r.items[0]).rule], ['needs-review', 'doc_fetch_failed']);
    assert.deepEqual(r.items[0].extracted.evidence.map((/** @type {any} */ e) => e.ok), [false, false]);
  });

  test('some chosen documents failed: doc_fetch partial, needs-review doc_fetch_failed_partial', async () => {
    const r = await run([hit('main.htm', '8-K'), hit('ex991.htm', 'EX-99.1')], { 'main.htm': doc('main acquired by Foo Capital'), 'ex991.htm': 404 });
    assert.equal(r.items[0].signal.doc_fetch, 'partial');
    assert.deepEqual([classify(r.items[0]).class, classify(r.items[0]).rule], ['needs-review', 'doc_fetch_failed_partial']);
  });

  test('all chosen documents read: doc_fetch ok and a clean verdict', async () => {
    const r = await run([hit('main.htm', '8-K')], { 'main.htm': doc('Contoso was acquired by Foo Capital.') });
    assert.equal(r.items[0].signal.doc_fetch, 'ok');
    assert.equal(classify(r.items[0]).class, 'target');
  });

  test('a blocked name only in the THIRD chosen document is found, placed first, and sends the signal to review', async () => {
    const hits = [hit('ex101.htm', 'EX-10.1'), hit('ex991.htm', 'EX-99.1'), hit('main.htm', '8-K')];
    const r = await run(hits, { 'main.htm': doc('neutral acquired by Foo Capital'), 'ex991.htm': doc('neutral press release'), 'ex101.htm': doc('Guarantor: Adv​isicon Staffing LLC') });
    assert.deepEqual(r.calls, ['main.htm', 'ex991.htm', 'ex101.htm']);
    const it = r.items[0];
    assert.deepEqual(it.extracted.blocked_hits, ['Advisicon']);
    assert.ok(it.signal.text.startsWith('[blocked-term Advisicon]'));
    assert.deepEqual([classify(it).class, classify(it).rule], ['needs-review', 'excl_blocked_suspect']);
  });

  test('company names: display names are unioned across every hit; a blocked name in any one of them keeps the signal from being a clean target', async () => {
    const hits = [
      hit('main.htm', '8-K', { display_names: ['Contoso Dynamics Inc  (CIK 0005555555)', 'Contoso Sub LLC  (CIK 0006666666)'], ciks: ['0005555555', '0006666666'] }),
      hit('ex991.htm', 'EX-99.1', { display_names: ['Contoso Dynamics Inc  (CIK 0005555555)', 'Immunotec Research Unit  (CIK 0007777777)'], ciks: ['0005555555', '0007777777'] }),
    ];
    const r = await run(hits, { 'main.htm': doc('acquired by Foo Capital'), 'ex991.htm': doc('press') });
    const s = r.items[0].signal;
    assert.equal(s.company, 'Contoso Dynamics Inc');
    assert.ok(s.aliases.some((a) => a.includes('Contoso Sub LLC')) && s.aliases.some((a) => a.includes('Immunotec Research Unit')));
    assert.notEqual(classify(r.items[0]).class, 'target');
    assert.ok(r.items[0].extracted.blocked_hits.includes('Immunotec'));
  });

  test('a blocked name that only appears in a name extracted from a document is scanned too', async () => {
    const r = await run([hit('main.htm', '8-K')], { 'main.htm': doc('Contoso was acquired by Advisicon Holdings Group.') });
    assert.ok(r.items[0].extracted.blocked_hits.includes('Advisicon'));
    assert.notEqual(classify(r.items[0]).class, 'target');
  });

  test('primary filer CIK rule: ciks[0] and its own display name are the company; the others are co-registrants', () => {
    const h = (/** @type {string[]} */ ciks, /** @type {string[]} */ names) => /** @type {any} */ ({ ciks, display_names: names });
    const reversed = primaryFiler([h(['0002222222', '0001111111'], ['Alpha Holdings Inc  (CIK 0001111111)', 'Beta Corp  (CIK 0002222222)'])]);
    assert.equal(reversed.cik, '2222222');
    assert.equal(reversed.primary_name, 'Beta Corp  (CIK 0002222222)');
    assert.deepEqual(reversed.co_names, ['Alpha Holdings Inc  (CIK 0001111111)']);
    const noMatch = primaryFiler([h(['0009999999'], ['Gamma Co'])]);
    assert.equal(noMatch.primary_name, 'Gamma Co', 'falls back to display_names[0]');
    const conflict = primaryFiler([h(['0001'], ['A  (CIK 0000001)']), h(['0002'], ['B  (CIK 0000002)'])]);
    assert.deepEqual([conflict.cik, conflict.conflict], ['1', true]);
    assert.equal(primaryFiler([h([], [])]).cik, null);
    assert.equal(cikInDisplayName('X Corp  (CCC)  (CIK 0001818201)'), '1818201');
    assert.equal(cikInDisplayName('no cik here'), null);
  });

  test('primary filer rule end to end: the evidence URL and company follow ciks[0]', async () => {
    const hits = [hit('main.htm', '8-K', { display_names: ['Alpha Holdings Inc  (CIK 0001111111)', 'Beta Systems Corp  (CIK 0002222222)'], ciks: ['0002222222', '0001111111'] })];
    const r = await run(hits, { 'main.htm': doc('acquired by Foo Capital') });
    assert.equal(r.items[0].signal.company, 'Beta Systems Corp');
    assert.ok(r.items[0].signal.evidence_url.includes('/data/2222222/') || r.items[0].signal.evidence_url.includes('/2222222/'));
    assert.ok(r.items[0].signal.aliases.some((a) => a.includes('Alpha Holdings Inc')));
  });

  test('FTS coverage is keyed per query and form; an incomplete page set is partial', async () => {
    const { edgar } = makeEdgar([{ match: /search-index/, body: searchJson([hit('main.htm', '8-K')], 900) }, { match: /Archives/, body: doc('x') }]);
    const { stats } = await runFts({ edgar, now: NOW, blocked: BLOCKED, queries: [Q] });
    assert.deepEqual(Object.keys(stats.coverage?.forms ?? {}), ['pe:8-K', 'pe:8-K/A']);
    assert.equal(stats.coverage?.source, 'partial');
    assert.equal(stats.extra.undercoverage, 1);
  });

  test('mergeCoverage: complete only when every form of every part is complete', () => {
    const c = (/** @type {'complete'|'partial'|'none'} */ s) => ({ status: s, total: 1, read: 1, pages: [] });
    assert.equal(mergeCoverage([{ source: 'complete', forms: { a: c('complete') } }, { source: 'complete', forms: { b: c('complete') } }]).source, 'complete');
    assert.equal(mergeCoverage([{ source: 'complete', forms: { a: c('complete') } }, { source: 'partial', forms: { b: c('none') } }]).source, 'partial');
    assert.equal(mergeCoverage([]).source, 'partial');
  });
});

// ---------------------------------------------------------------------------
// Form D: previous names, parties, fund sizing
// ---------------------------------------------------------------------------

describe('Form D previous names (rule C)', () => {
  test('the real fixtures: "None" in issuer and edgar lists is dropped and counted; nothing is added to aliases', () => {
    const d = parseFormDXml(fixture('live/formd_fund_da.xml'));
    assert.ok(d);
    assert.deepEqual(d.previous_names, ['None', 'None']);
    assert.deepEqual(splitPreviousNames(d.previous_names), { kept: [], dropped: 2 });
  });
  test('splitPreviousNames: no letter or digit, none, n/a (any case, trimmed) are dropped; real names survive', () => {
    const r = splitPreviousNames(['  none ', 'N/A', 'n/a', '-', '', '   ', '---', '.', 'None Of The Above Corp', 'Acme 2', '12345', 'Café Ltd']);
    assert.deepEqual(r.kept, ['None Of The Above Corp', 'Acme 2', '12345', 'Café Ltd']);
    assert.equal(r.dropped, 8);
  });

  const hitOf = (/** @type {string} */ name) => searchJson([{ adsh: '0003210000-26-000001', ciks: ['0003210000'], display_names: [`${name}  (CIK 0003210000)`], file_date: '2026-10-10', form: 'D', sics: ['7372'] }]);
  const docWith = (/** @type {string} */ prev, /** @type {string} */ extra = '') => fixture('live/formd_operating_da.xml')
    .replace('<entityName>Persentic Inc</entityName>', `<entityName>Persentic Inc</entityName><issuerPreviousNameList>${prev}</issuerPreviousNameList>${extra}`);
  async function one(xml, name = 'Persentic Inc') {
    const { edgar } = makeEdgar([
      { match: /forms=D&/, body: hitOf(name) }, { match: /forms=D%2FA/, body: searchJson([]) },
      { match: /primary_doc\.xml/, body: xml }, { match: /submissions/, status: 404, body: '' },
    ]);
    return runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
  }

  test('a blocked name that exists ONLY in a raw previous name is found before the drop filter and keeps the signal from being a target', async () => {
    const { items, stats } = await one(docWith('<value>None</value><value>Advisicon Labs</value><value>n/a</value>'));
    const it = items[0];
    assert.equal(it.outcome, 'parsed');
    assert.ok(it.extracted.blocked_hits.includes('Advisicon'));
    assert.ok(it.signal.text.startsWith('[blocked-term Advisicon]'));
    assert.ok(it.signal.aliases.includes('Advisicon Labs'), 'the survivor is an alias too');
    assert.equal(it.extracted.prev_names_dropped, 4, 'the fixture own two None values plus the injected None and n/a');
    assert.equal(stats.extra.prev_names_dropped, 4);
    assert.notEqual(classify(it).class, 'target');
  });
  test('a blocked name hidden behind a value the filter would drop is impossible: the raw value is scanned first', async () => {
    const { items } = await one(docWith('<value>Adv​isicon</value>'));
    assert.ok(items[0].extracted.blocked_hits.includes('Advisicon'));
  });
  test('only the issuer and edgar previous-name lists are read; other <value> elements are not previous names', () => {
    const d = parseFormDXml(fixture('live/formd_operating_da.xml'));
    assert.ok(d);
    assert.deepEqual(d.previous_names, ['None', 'None']);
  });
});

describe('Form D related parties (rule D)', () => {
  test('entity by firstName without a letter: lastName plus middleName', () => {
    assert.deepEqual(classifyParty({ first: '-', middle: '', last: 'American VO Manager LLC' }), { name: 'American VO Manager LLC', is_entity: true, kind: 'entity' });
    assert.deepEqual(classifyParty({ first: ' - ', middle: 'Series VI', last: 'Acme Ventures' }), { name: 'Acme Ventures Series VI', is_entity: true, kind: 'entity' });
    assert.equal(classifyParty({ first: '', middle: '', last: 'Solo Name' }).kind, 'entity');
    assert.equal(classifyParty({ first: '123', middle: '', last: 'Numbered' }).kind, 'entity');
  });
  test('entity by whole-word marker in the joined name; partial words do not count', () => {
    for (const m of ['LLC', 'L.L.C.', 'LP', 'L.P.', 'LLP', 'Inc', 'Inc.', 'Corp', 'Corp.', 'Ltd', 'Fund', 'Partners', 'Capital', 'Holdings', 'Management', 'Trust', 'GP', 'llc', 'capital']) {
      assert.equal(classifyParty({ first: 'Pat', middle: '', last: `Smith ${m}` }).kind, 'entity', m);
    }
    for (const w of ['Corporal', 'Fundamental', 'Participants', 'Capitalist', 'Gpt', 'Trusty', 'Income']) {
      assert.equal(classifyParty({ first: 'Pat', middle: '', last: w }).kind, 'unclassified_party', w);
    }
  });
  test('unmarked person names are unclassified_party and are never discarded', () => {
    assert.deepEqual(classifyParty({ first: 'Eric', middle: 'J', last: 'Newman' }), { name: 'Eric J Newman', is_entity: false, kind: 'unclassified_party' });
  });

  test('the real fund fixture: "-" firstName parties are entities, the person is unclassified, all stay in evidence and text', async () => {
    const { edgar } = makeEdgar([
      { match: /forms=D&/, body: searchJson([{ adsh: '0002157441-26-000002', ciks: ['0002157441'], display_names: ['American Ventures QP Opportunity  (CIK 0002157441)'], file_date: '2026-10-15', form: 'D/A', sics: ['6799'] }]) },
      { match: /forms=D%2FA/, body: searchJson([]) },
      { match: /primary_doc\.xml/, file: 'live/formd_fund_da.xml' }, { match: /submissions/, status: 404, body: '' },
    ]);
    const { items } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    const it = items[0];
    assert.deepEqual(it.extracted.parties, [
      { name: 'American VO Manager LLC', kind: 'entity' }, { name: 'American VO IM LLC', kind: 'entity' }, { name: 'Eric Newman', kind: 'unclassified_party' },
    ]);
    assert.deepEqual(it.extracted.sponsor_candidates, ['American VO Manager LLC', 'American VO IM LLC']);
    assert.equal(it.signal.investor, 'American VO Manager LLC');
    assert.ok(it.signal.text.includes('Eric Newman (unclassified_party)'));
    assert.ok(it.signal.text.includes('American VO IM LLC (entity)'));
  });

  test('a blocked name in an entity party and one in a person party both reach exclusion', async () => {
    const xmlFor = (/** @type {string} */ first, /** @type {string} */ last) => fixture('live/formd_operating_da.xml').replace('<firstName>Peter</firstName>', `<firstName>${first}</firstName>`).replace('<lastName>Kozodoy</lastName>', `<lastName>${last}</lastName>`);
    for (const [first, last] of [['-', 'Immunotec Holdings LLC'], ['Jordan', 'Advisicon']]) {
      const { edgar } = makeEdgar([
        { match: /forms=D&/, body: searchJson([{ adsh: '0002145349-26-000002', ciks: ['0002145349'], display_names: ['Persentic Inc  (CIK 0002145349)'], file_date: '2026-10-15', form: 'D', sics: ['7372'] }]) },
        { match: /forms=D%2FA/, body: searchJson([]) },
        { match: /primary_doc\.xml/, body: xmlFor(first, last) }, { match: /submissions/, status: 404, body: '' },
      ]);
      const { items } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
      assert.ok(items[0].extracted.blocked_hits.length >= 1, `${first} ${last}`);
      assert.deepEqual([classify(items[0]).class, classify(items[0]).rule], ['needs-review', 'excl_blocked_suspect']);
    }
  });
});

describe('Form D fund sizing (rule E)', () => {
  const base = (/** @type {string} */ xml, extraHit = {}) => makeEdgar([
    { match: /forms=D&/, body: searchJson([{ adsh: '0002157441-26-000002', ciks: ['0002157441'], display_names: ['American Ventures QP Opportunity  (CIK 0002157441)'], file_date: '2026-10-15', form: 'D/A', sics: ['6799'], ...extraHit }]) },
    { match: /forms=D%2FA/, body: searchJson([]) },
    { match: /primary_doc\.xml/, body: xml }, { match: /submissions/, status: 404, body: '' },
  ]);
  const fund = () => fixture('live/formd_fund_da.xml');
  const noNav = (/** @type {string} */ xml) => xml.replace(/<aggregateNetAssetValueRange>[^<]*<\/aggregateNetAssetValueRange>/, '');
  const notPooled = (/** @type {string} */ xml) => xml.replace('Pooled Investment Fund', 'Other Technology');
  async function go(xml, extraHit) {
    const { edgar } = base(xml, extraHit);
    return (await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED })).items[0];
  }

  test('both fund signals (NAV range present AND pooled investment fund): not-target fund_issuer', async () => {
    const it = await go(fund());
    assert.deepEqual(it.signal.issuer.fund_signals, { nav_range: true, pooled_group: true });
    assert.deepEqual([classify(it).class, classify(it).rule], ['not-target', 'fund_issuer']);
  });
  test('exactly one fund signal: needs-review fund_signal_conflict (either one)', async () => {
    const a = await go(noNav(fund()));
    assert.deepEqual(a.signal.issuer.fund_signals, { nav_range: false, pooled_group: true });
    assert.deepEqual([classify(a).class, classify(a).rule], ['needs-review', 'fund_signal_conflict']);
    const b = await go(notPooled(fund()));
    assert.deepEqual(b.signal.issuer.fund_signals, { nav_range: true, pooled_group: false });
    assert.deepEqual([classify(b).class, classify(b).rule], ['needs-review', 'fund_signal_conflict']);
  });
  test('neither fund signal and issuerSize missing / unrecognized / Decline to Disclose: unknown size, target with size_verified=false', async () => {
    const op = fixture('live/formd_operating_da.xml');
    for (const range of ['Decline to Disclose', 'Somewhere Between Big and Small', '']) {
      const it = await go(op.replace('<revenueRange>No Revenues</revenueRange>', `<revenueRange>${range}</revenueRange>`), { display_names: ['Persentic Inc  (CIK 0002145349)'], adsh: '0002145349-26-000002', ciks: ['0002145349'], sics: ['7372'] });
      assert.equal(it.signal.size.confidence, 'none', range);
      const v = classify(it);
      assert.deepEqual([v.class, v.rule, v.size_verified], ['target', 'target_all_checks_passed', false], range);
    }
    const missing = await go(op.replace(/<issuerSize>[\s\S]*?<\/issuerSize>/, ''), { display_names: ['Persentic Inc  (CIK 0002145349)'], adsh: '0002145349-26-000002', ciks: ['0002145349'], sics: ['7372'] });
    const v = classify(missing);
    assert.deepEqual([v.class, v.size_verified], ['target', false]);
  });
  test('exclusion runs before a not-target fund outcome: a blocked fund name is excl_blocked_company, and the blocked hit is recorded on the row', async () => {
    const xml = fund().replace('American Ventures QP Opportunity Fund LLC, Series VI Strategic Space', 'Advisicon Opportunity Fund LLC');
    const it = await go(xml);
    assert.ok(it.extracted.blocked_hits.includes('Advisicon'));
    assert.deepEqual([classify(it).class, classify(it).rule], ['not-target', 'excl_blocked_company']);
  });
  test('a blocked party inside an otherwise clear fund issuer is reviewed rather than silently excluded as a fund', async () => {
    const xml = fund().replace('American VO IM LLC', 'Advisicon IM LLC');
    const it = await go(xml);
    assert.ok(it.extracted.blocked_hits.includes('Advisicon'));
    assert.deepEqual([classify(it).class, classify(it).rule], ['needs-review', 'excl_blocked_suspect']);
  });
  test('the fund-like display name prefilter still skips the document but records blocked hits in the names', async () => {
    const { edgar, calls } = makeEdgar([
      { match: /forms=D&/, body: searchJson([{ adsh: '0002157441-26-000002', ciks: ['0002157441'], display_names: ['Advisicon Growth Fund LP  (CIK 0002157441)'], file_date: '2026-10-15', form: 'D' }]) },
      { match: /forms=D%2FA/, body: searchJson([]) },
    ]);
    const { items } = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
    assert.deepEqual([items[0].outcome, items[0].reason], ['out_of_scope', 'fund_like_name_prefilter']);
    assert.deepEqual(items[0].extracted.blocked_hits, ['Advisicon']);
    assert.equal(calls.filter((c) => c.url.includes('primary_doc')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

describe('classifier: new reasons are total', () => {
  const base = {
    doc_fetch: 'ok', trigger_kind: 'pe_deal', company: 'Northwind Logistics', acquirer: 'Example Capital', event_date: '2026-09-20',
    evidence_url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000042/0001234567-26-000042-index.htm', evidence_source: 'edgar_8k',
    size: { low: 120000000, high: 300000000, basis: 'stated', confidence: 'high' }, text: 'Example Capital completed its acquisition.',
  };
  const v = (/** @type {Record<string, any>} */ patch) => classifySignal({ ...base, ...patch }, { rules: RULES, now: NOW, blocked: OK_LIST });
  test('doc_fetch: failed, partial, unknown value, ok, absent', () => {
    assert.equal(v({ doc_fetch: 'failed' }).rule, 'doc_fetch_failed');
    assert.equal(v({ doc_fetch: 'partial' }).rule, 'doc_fetch_failed_partial');
    for (const bad of [7, 'weird', '', true, {}, [], 'OK', 'Partial']) {
      const r = v({ doc_fetch: bad });
      assert.deepEqual([r.class, r.rule, r.inputs.invalid_field], ['needs-review', 'signal_field_invalid', 'doc_fetch'], String(bad));
    }
    const missing = v({ doc_fetch: undefined });
    assert.equal(missing.rule, 'signal_field_invalid', 'missing doc_fetch on an EDGAR document source');
    assert.equal(v({ doc_fetch: null }).rule, 'signal_field_invalid');
    assert.equal(v({ evidence_source: 'listings', evidence_url: 'https://boards.example.com/n/jobs/1', doc_fetch: undefined }).class, 'target', 'non-document sources do not carry doc_fetch');
    assert.equal(v({ evidence_source: 'listings', evidence_url: 'https://boards.example.com/n/jobs/1', doc_fetch: 'weird' }).rule, 'signal_field_invalid', 'a present value is always validated');
    assert.equal(v({ doc_fetch: 'ok' }).rule, 'target_all_checks_passed');
  });
  test('a blocked company still wins over a failed document read (exclusion first)', () => {
    const r = v({ company: 'Advisicon Holdings', doc_fetch: 'failed' });
    assert.deepEqual([r.class, r.rule], ['not-target', 'excl_blocked_company']);
  });
  test('fund signals: every combination, with garbage values treated as absent', () => {
    const f = (/** @type {any} */ fs) => v({ evidence_source: 'edgar_form_d', issuer: { name: 'Northwind Logistics Holdings', sic: '4731', fund_signals: fs } });
    assert.equal(f({ nav_range: true, pooled_group: true }).rule, 'fund_issuer');
    assert.equal(f({ nav_range: true, pooled_group: false }).rule, 'fund_signal_conflict');
    assert.equal(f({ nav_range: false, pooled_group: true }).rule, 'fund_signal_conflict');
    assert.equal(f({ nav_range: false, pooled_group: false }).rule, 'target_all_checks_passed');
    for (const bad of [{ nav_range: 'yes', pooled_group: 1 }, {}, null, undefined, 'x', [], { nav_range: true }]) assert.equal(f(bad).rule, 'signal_field_invalid', JSON.stringify(bad));
  });
  test('a fund-like name or SIC 6799 with clean fund signals still goes to the legacy fund path', () => {
    const ns = { nav_range: false, pooled_group: false };
    assert.equal(v({ evidence_source: 'edgar_form_d', issuer: { name: 'Northwind Growth Fund LP', sic: '4731', fund_signals: ns } }).rule, 'form_d_fund_issuer');
    assert.equal(v({ evidence_source: 'edgar_form_d', issuer: { name: 'Northwind Logistics Holdings', sic: '6799', fund_signals: ns } }).rule, 'form_d_fund_issuer');
  });
  test('an unregistered rule drift still degrades to needs-review, never to a pass', () => {
    const rules = { ...RULES, verdict_rules: RULES.verdict_rules.filter((x) => x.rule !== 'doc_fetch_failed') };
    const r = classifySignal({ ...base, doc_fetch: 'failed' }, { rules, now: NOW, blocked: OK_LIST });
    assert.deepEqual([r.class, r.rule], ['needs-review', 'classifier_error']);
  });
});
