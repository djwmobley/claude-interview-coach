// @ts-check
/**
 * src/targets/form-d.js (target finder PR2, plan 14.4 B + 15.2). Recorded fixtures only: the replay fetch
 * serves test/fixtures/targets/ and fails the test on any non-GET call or host outside the registry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runFormD, parseFormDXml, xmlProblem, sizeFromRevenueRange, cleanDisplayName, FORM_D_REASONS, FORM_D_SOURCE,
} from '../src/targets/form-d.js';
import { createEdgarClient } from '../src/targets/edgar-client.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import { COMMON_REASONS, OUTCOMES } from '../src/targets/outcomes.js';
import { NAME_MAX } from '../src/targets/signal-text.js';
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

const DOC = (/** @type {string} */ cik, /** @type {string} */ folder) => `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/primary_doc.xml`;

/** The standard recorded world: search page, five documents, one submissions JSON. */
function standardRoutes() {
  return [
    { match: /efts\.sec\.gov\/LATEST\/search-index\?/, file: 'form_d/search_page1.json' },
    { match: DOC('1234567', '000123456726000042'), file: 'form_d/operating.xml' },
    { match: DOC('2345678', '000234567826000011'), file: 'form_d/fund.xml' },
    { match: DOC('1234567', '000123456726000077'), file: 'form_d/amendment.xml' },
    { match: DOC('3456789', '000345678926000019'), file: 'form_d/decline.xml' },
    { match: 'https://data.sec.gov/submissions/CIK0001234567.json', file: 'data_sec/submissions_1234567.json' },
    { match: 'https://data.sec.gov/submissions/', status: 404, body: 'not found' },
  ];
}

/**
 * @param {import('./helpers/targets-replay.js').Route[]} routes
 * @param {{ budgets?: Record<string, number>, edgarWrap?: (e: any) => any }} [o]
 */
async function runWith(routes, o = {}) {
  const replay = createReplayFetch(routes);
  const ft = fastTiming();
  const guard = createFetchGuard({ fetch: replay.fetch, userAgent: UA });
  const real = createEdgarClient({ guard, timing: { ...ft.timing, ...(o.budgets ? { budgets: o.budgets } : {}) } });
  const edgar = o.edgarWrap ? o.edgarWrap(real) : real;
  const out = await runFormD({ edgar, now: NOW, rules: RULES, blocked: BLOCKED });
  return { ...out, calls: replay.calls, edgar: real };
}

/** @param {any} item */
const classify = (item) => classifySignal(item.signal, { rules: RULES, now: NOW, blocked: OK_LIST });

describe('recorded Form D run', () => {
  test('every raw item gets exactly one outcome with a reason from the closed set; the counts add up', async () => {
    const { items, stats } = await runWith(standardRoutes());
    assert.equal(stats.raw, 7);
    assert.equal(items.length, 7);
    assert.equal(stats.parsed + stats.unparseable + stats.out_of_scope, stats.raw);
    assert.equal(Object.values(stats.reasons).reduce((a, b) => a + b, 0), stats.raw);
    const allowed = new Set([...FORM_D_REASONS, ...COMMON_REASONS, 'ok']);
    for (const it of items) {
      assert.ok(OUTCOMES.includes(it.outcome));
      assert.ok(allowed.has(it.reason), it.reason);
      assert.equal(it.source, FORM_D_SOURCE);
      assert.equal((it.signal !== null), it.outcome === 'parsed');
    }
    assert.deepEqual(
      [stats.parsed, stats.unparseable, stats.out_of_scope],
      [4, 2, 1],
    );
    assert.equal(stats.discovery_total, 14, 'sum of per-form totals (the replay serves the same page for D and D/A)');
    assert.equal(stats.read, 7, 'hits are merged by accession');
    assert.equal(stats.coverage?.source, 'complete');
    assert.deepEqual(stats.reasons, {
      'parsed:ok': 4, 'out_of_scope:fund_like_name_prefilter': 1, 'unparseable:accession_malformed': 1, 'unparseable:hit_shape_unknown': 1,
    });
  });

  test('only GETs to registry hosts happen, with the SEC contact as User-Agent', async () => {
    const { calls } = await runWith(standardRoutes());
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.equal(c.method, 'GET');
      assert.equal(c.headers['user-agent'], UA);
      assert.equal(c.headers.authorization, undefined);
    }
    const searches = calls.filter((c) => c.url.includes('search-index'));
    assert.equal(searches.length, 2, 'one discovery request per form type');
    assert.ok(/forms=D&/.test(searches[0].url), searches[0].url);
    assert.ok(searches[1].url.includes('forms=D%2FA'), searches[1].url);
    assert.ok(calls[0].url.includes('dateRange=custom'));
    assert.ok(calls[0].url.includes('startdt=2026-10-01'));
    assert.ok(calls[0].url.includes('enddt=2026-10-15'));
  });

  test('operating company: mapping, aliases, size, evidence URL, and a flagged-unverified target', async () => {
    const { items } = await runWith(standardRoutes());
    const it = items.find((i) => i.key === '0001234567-26-000042');
    assert.ok(it && it.signal);
    const s = it.signal;
    assert.equal(s.trigger_kind, 'pe_deal');
    assert.equal(s.company, 'Northwind Logistics Inc');
    assert.equal(s.aliases[0], 'Northwind Logistics Inc', 'the issuer legal name is always the first alias');
    assert.ok(s.aliases.includes('Northwind Freight Holdings'), 'previous / former names');
    assert.ok(s.aliases.some((a) => a.includes('CIK 0001234567')), 'raw display names are kept as aliases');
    assert.deepEqual(s.issuer, { name: 'Northwind Logistics Inc', sic: '7372', industry_group: 'Other Technology', fund_signals: { nav_range: false, pooled_group: false } });
    assert.equal(it.extracted.prev_names_dropped, 1, 'the "None" edgarPreviousNameList value is dropped and counted');
    assert.equal(s.investor, 'Example Capital Partners LLC');
    assert.equal(s.acquirer, null);
    assert.equal(s.pe_firm, null);
    assert.equal(s.event_date, '2026-10-05');
    assert.equal(s.filing_date, '2026-10-07');
    assert.equal(s.evidence_url, 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000042/0001234567-26-000042-index.htm');
    assert.equal(s.evidence_source, 'edgar_form_d');
    assert.deepEqual(s.size, { low: 100_000_000, high: null, basis: 'form_d_revenue_range', confidence: 'medium' });
    assert.equal(s.employees, null);
    assert.equal(s.offering_amount, undefined, 'the offering amount is never on the signal');
    assert.equal(it.extracted.offering_amount, '150000000', 'it is kept in extracted only');
    assert.ok(s.text.includes('Jane Q Doe') && s.text.includes('Example Capital Partners LLC'), 'every related person is in text');
    assert.equal(it.contact, null);
    const v = classify(it);
    assert.deepEqual([v.class, v.rule, v.size_verified], ['target', 'target_all_checks_passed', false]);
  });

  test('fund industry group (operating-sounding name, no SIC) goes to the fund path, not target', async () => {
    const { items } = await runWith(standardRoutes());
    const it = items.find((i) => i.key === '0002345678-26-000011');
    assert.ok(it && it.signal);
    assert.equal(it.signal.issuer.industry_group, 'Pooled Investment Fund');
    assert.equal(it.signal.issuer.sic, null);
    assert.deepEqual(it.signal.issuer.fund_signals, { nav_range: false, pooled_group: true });
    assert.equal(classify(it).rule, 'fund_signal_conflict', 'pooled group without a net asset value range is a conflict');
  });

  test('a fund-like display name is pre-filtered, counted, and persisted as out_of_scope', async () => {
    const { items } = await runWith(standardRoutes());
    const it = items.find((i) => i.key === '0009999999-26-000005');
    assert.ok(it);
    assert.deepEqual([it.outcome, it.reason, it.signal], ['out_of_scope', 'fund_like_name_prefilter', null]);
  });

  test('"Decline to Disclose" is size confidence none; with no SIC the classifier says form_d_sic_unavailable', async () => {
    const { items } = await runWith(standardRoutes());
    const it = items.find((i) => i.key === '0003456789-26-000019');
    assert.ok(it && it.signal);
    assert.deepEqual(it.signal.size, { low: null, high: null, basis: 'form_d_revenue_range', confidence: 'none' });
    const v = classify(it);
    assert.deepEqual([v.class, v.rule], ['needs-review', 'form_d_sic_unavailable']);
  });

  test('an amendment is its own signal that supersedes the original accession (plan 15.2 item 10)', async () => {
    const { items } = await runWith(standardRoutes());
    const it = items.find((i) => i.key === '0001234567-26-000077');
    assert.ok(it && it.signal);
    assert.deepEqual(it.supersedes, { source: FORM_D_SOURCE, key: '0001234567-26-000042' });
    assert.equal(it.extracted.amendment, true);
    assert.deepEqual(it.signal.size, { low: 25_000_001, high: 100_000_000, basis: 'form_d_revenue_range', confidence: 'medium' });
    assert.equal(classify(it).class, 'target', 'a straddling range is unverified, not excluded');
    // the original is not marked superseded by itself
    assert.equal(items.find((i) => i.key === '0001234567-26-000042')?.supersedes, undefined);
  });

  test('a hit with a malformed accession and a hit with no _source are counted unparseable, never dropped', async () => {
    const { items } = await runWith(standardRoutes());
    assert.equal(items.filter((i) => i.reason === 'accession_malformed').length, 1);
    assert.equal(items.filter((i) => i.reason === 'hit_shape_unknown').length, 1);
  });
});

describe('XML safety (plan 15.2 item 9)', () => {
  test('a DOCTYPE / ENTITY document is xml_malformed and its entity target never appears in any field', async () => {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0005678901-26-000001', ciks: ['0005678901'], display_names: ['Entity Test Co  (CIK 0005678901)'], file_date: '2026-10-10', form: 'D' }]) },
      { match: DOC('5678901', '000567890126000001'), file: 'form_d/doctype.xml' },
    ];
    const { items } = await runWith(routes);
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].outcome, items[0].reason], ['unparseable', 'xml_malformed']);
    assert.equal(items[0].extracted.xml_problem, 'doctype');
    assert.ok(!JSON.stringify(items).includes('passwd'));
  });
  test('a truncated document is xml_malformed', async () => {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0006789012-26-000001', ciks: ['0006789012'], display_names: ['Truncated Filing Inc'], file_date: '2026-10-10', form: 'D' }]) },
      { match: DOC('6789012', '000678901226000001'), file: 'form_d/malformed.xml' },
    ];
    const { items } = await runWith(routes);
    assert.deepEqual([items[0].outcome, items[0].reason], ['unparseable', 'xml_malformed']);
  });
  test('xmlProblem: accepts well-formed XML, refuses every structural defect', () => {
    assert.equal(xmlProblem('<?xml version="1.0"?><a><b>1</b><c/></a>'), null);
    assert.equal(xmlProblem('<a><![CDATA[ <not a tag> ]]></a>'), null);
    assert.equal(xmlProblem('<a><!-- <x> --><b>1</b></a>'), null);
    const bad = {
      '': 'empty',
      '<!DOCTYPE a><a/>': 'doctype',
      '<!doctype a [<!ENTITY x "y">]><a/>': 'doctype',
      '<a><!ENTITY x "y"></a>': 'doctype',
      '<a><b></a>': 'mismatched_tag',
      '<a><b></b>': 'unclosed_tag',
      '<a/><b/>': 'root_count',
      '<a>1 < 2</a>': 'stray_angle_bracket',
      '<a><!-- never closed </a>': 'unterminated_comment',
      '<a><![CDATA[ never closed </a>': 'unterminated_cdata',
    };
    for (const [xml, reason] of Object.entries(bad)) assert.equal(xmlProblem(xml), reason, xml);
    assert.equal(xmlProblem('<a>' + 'x'.repeat(400 * 1024) + '</a>'), 'too_long');
  });
  test('parseFormDXml returns null for a well-formed document that is not an edgarSubmission', () => {
    assert.equal(parseFormDXml('<other><x/></other>'), null);
  });
  test('a well-formed document of unknown shape is unparseable: unknown_shape', async () => {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0001010101-26-000001', ciks: ['1010101'], display_names: ['Odd Shape Co'], file_date: '2026-10-10', form: 'D' }]) },
      { match: /primary_doc\.xml/, body: '<html><body>maintenance page</body></html>' },
    ];
    const { items } = await runWith(routes);
    assert.deepEqual([items[0].outcome, items[0].reason], ['unparseable', 'unknown_shape']);
  });
});

describe('blocked names (plan 15.2 item 1)', () => {
  /** @param {string} xml @param {string} [display] */
  async function one(xml, display = 'Neutral Holdings Corp  (CIK 0001357911)') {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0001357911-26-000001', ciks: ['0001357911'], display_names: [display], file_date: '2026-10-10', form: 'D' }]) },
      { match: /primary_doc\.xml/, body: xml },
      { match: /submissions/, body: JSON.stringify({ sic: '7372' }) },
    ];
    return runWith(routes);
  }
  const doc = (/** @type {string} */ extra, /** @type {string} */ issuer = 'Neutral Holdings Corp') => `<?xml version="1.0"?><edgarSubmission><submissionType>D</submissionType><primaryIssuer><cik>0001357911</cik><entityName>${issuer}</entityName><entityType>Corporation</entityType></primaryIssuer><offeringData><industryGroup><industryGroupType>Other Technology</industryGroupType></industryGroup><issuerSize><revenueRange>Over $100,000,000</revenueRange></issuerSize><typeOfFiling><dateOfFirstSale><value>2026-10-05</value></dateOfFirstSale></typeOfFiling>${extra}</offeringData></edgarSubmission>`;

  test('a blocked name buried past the free-text cap and the text cap is still found and placed FIRST in text', async () => {
    const padding = 'lorem ipsum dolor sit amet '.repeat(400);
    const { items } = await one(doc(`<clarificationOfResponse>${padding} the parent is Immunotec Holdings</clarificationOfResponse>`));
    const it = items[0];
    assert.equal(it.outcome, 'parsed');
    assert.ok(it.signal.text.startsWith('[blocked-term Immunotec]'), it.signal.text.slice(0, 80));
    assert.ok(it.signal.text.length <= 4000);
    assert.deepEqual(it.extracted.blocked_hits, ['Immunotec']);
    const v = classify(it);
    assert.deepEqual([v.class, v.rule], ['needs-review', 'excl_blocked_suspect']);
  });
  test('zero-width and punctuation obfuscation of the blocked name does not hide it', async () => {
    const { items } = await one(doc('<clarificationOfResponse>sponsor: Ad\u200Bvi-si\u00ADcon Group</clarificationOfResponse>'));
    assert.ok(items[0].extracted.blocked_hits.includes('Advisicon'));
    assert.notEqual(classify(items[0]).class, 'target');
  });
  test('a blocked name that only appears in the raw display name reaches aliases and the exclusion step', async () => {
    const { items } = await one(doc(''), 'Neutral Holdings Corp (formerly Advisicon Staffing)  (CIK 0001357911)');
    const it = items[0];
    assert.ok(it.signal.aliases.some((a) => a.includes('Advisicon')));
    assert.notEqual(classify(it).class, 'target');
  });
  test('the issuer legal name is copied into aliases even when equal to company, and a blocked issuer name is never a target', async () => {
    const { items } = await one(doc('', 'Advisicon Holdings LLC'), 'Acme Staffing Group  (CIK 0001357911)');
    const it = items[0];
    assert.equal(it.signal.aliases[0], 'Advisicon Holdings LLC');
    assert.equal(it.signal.issuer.name, 'Advisicon Holdings LLC');
    const v = classify(it);
    assert.deepEqual([v.class, v.rule], ['not-target', 'excl_blocked_company']);
    // Even if company were something neutral, the always-present alias keeps the legal name in the alias group.
    const neutral = { ...it.signal, company: 'Acme Staffing Group' };
    const v2 = classifySignal(neutral, { rules: RULES, now: NOW, blocked: OK_LIST });
    assert.notEqual(v2.class, 'target');
    assert.equal(v2.rule, 'excl_blocked_company');
  });
  test('the fixture whose only blocked name is the issuer legal name classifies not-target', async () => {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0004567890-26-000001', ciks: ['0004567890'], display_names: ['Acme Staffing Group  (CIK 0004567890)'], file_date: '2026-10-10', form: 'D' }]) },
      { match: DOC('4567890', '000456789026000001'), file: 'form_d/blocked_issuer.xml' },
      { match: /submissions/, body: JSON.stringify({ sic: '7363' }) },
    ];
    const { items } = await runWith(routes);
    assert.notEqual(classify(items[0]).class, 'target');
  });
});

describe('oversized and hostile fields', () => {
  /** @param {string} issuer @param {string} [related] */
  async function oneDoc(issuer, related = '') {
    const xml = `<?xml version="1.0"?><edgarSubmission><submissionType>D</submissionType><primaryIssuer><cik>0001</cik><entityName>${issuer}</entityName></primaryIssuer>${related ? `<relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>${related}</firstName><lastName>X</lastName></relatedPersonName></relatedPersonInfo></relatedPersonsList>` : ''}<offeringData></offeringData></edgarSubmission>`;
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0000000001-26-000001', ciks: ['1'], display_names: ['Short Co'], file_date: '2026-10-10', form: 'D' }]) },
      { match: /primary_doc/, body: xml },
      { match: /submissions/, status: 404, body: '' },
    ];
    return runWith(routes);
  }
  test('an oversized issuer name is unparseable name_too_long (never a truncated lookalike)', async () => {
    const { items } = await oneDoc('A'.repeat(NAME_MAX + 1));
    assert.deepEqual([items[0].outcome, items[0].reason], ['unparseable', 'name_too_long']);
    assert.ok(items[0].signal === null);
  });
  test('an oversized related person name is name_too_long too', async () => {
    const { items } = await oneDoc('Fine Co', 'B'.repeat(NAME_MAX + 5));
    assert.equal(items[0].reason, 'name_too_long');
  });
  test('a missing issuer name is issuer_name_missing', async () => {
    const { items } = await oneDoc('');
    assert.equal(items[0].reason, 'issuer_name_missing');
  });
  test('bidi / zero-width characters in names are stripped from company and aliases', async () => {
    const { items } = await oneDoc('Acme\u202E Corp\u200B Inc');
    assert.equal(items[0].signal.company, 'Acme Corp Inc');
    for (const a of items[0].signal.aliases) assert.ok(!/[\u202E\u200B]/.test(a));
  });
  test('extracted jsonb stays bounded', async () => {
    const { items } = await oneDoc('Fine Co');
    assert.ok(Buffer.byteLength(JSON.stringify(items[0].extracted)) <= 8192);
  });
});

describe('totality over garbage', () => {
  const GARBAGE = [undefined, null, '', 0, -1, NaN, true, {}, [], [[]], 'x'.repeat(5000), '\u200B', '../..', '<!DOCTYPE x>', '0001234567-26-00004', { a: 1 }];
  const FIELDS = ['adsh', 'ciks', 'display_names', 'file_date', 'form'];
  test('garbage in each search-hit field yields exactly one outcome per hit and never throws', async () => {
    const good = { adsh: '0001234567-26-000042', ciks: ['0001234567'], display_names: ['Northwind Logistics Inc'], file_date: '2026-10-07', form: 'D' };
    /** @type {any[]} */
    const hits = [];
    let i = 0;
    for (const f of FIELDS) {
      for (const g of GARBAGE) {
        i += 1;
        hits.push({ ...good, adsh: `0001234567-26-${String(i).padStart(6, '0')}`, [f]: g });
      }
    }
    const routes = [
      { match: /search-index/, body: JSON.stringify({ hits: { total: { value: hits.length }, hits: hits.map((h) => ({ _id: 'x:primary_doc.xml', _source: h })) } }) },
      { match: /primary_doc\.xml/, file: 'form_d/operating.xml' },
      { match: /submissions/, status: 404, body: '' },
    ];
    const { items, stats } = await runWith(routes, { budgets: { form_d: 1000 } });
    // Garbage adsh values are replaced by non-string/empty values, so some distinct hits may share the
    // fallback key; every hit that survives de-duplication still has exactly one item.
    assert.ok(items.length >= hits.length - FIELDS.length * 3, `items ${items.length} of ${hits.length}`);
    assert.equal(stats.raw, items.length);
    const allowed = new Set([...FORM_D_REASONS, ...COMMON_REASONS, 'ok']);
    for (const it of items) {
      assert.ok(OUTCOMES.includes(it.outcome));
      assert.ok(allowed.has(it.reason), `${it.reason}`);
      JSON.stringify(it);
    }
    assert.equal(stats.parsed + stats.unparseable + stats.out_of_scope, stats.raw);
    assert.equal(stats.reasons['unparseable:adapter_exception'] ?? 0, 0, 'garbage is classified, not thrown');
  });
  test('an exception inside an adapter step becomes a counted unparseable adapter_exception and the run continues', async () => {
    let n = 0;
    const { items, stats } = await runWith(standardRoutes(), {
      edgarWrap: (/** @type {any} */ real) => new Proxy(real, {
        get(t, p) {
          if (p === 'document') {
            return async (/** @type {string} */ url, /** @type {string} */ b) => {
              n += 1;
              if (n === 1) throw new Error('boom');
              return t.document(url, b);
            };
          }
          const v = t[p];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      }),
    });
    assert.equal(stats.raw, 7);
    assert.equal(stats.reasons['unparseable:adapter_exception'], 1);
    assert.ok(stats.parsed >= 3, 'the other hits were still processed');
  });
});

describe('caps, skips, and accounting', () => {
  test('no SEC contact: skipped with zero requests', async () => {
    const out = await runFormD({ edgar: null, now: NOW, rules: RULES, blocked: BLOCKED });
    assert.equal(out.stats.skipped, 'sec_contact_missing');
    assert.equal(out.items.length, 0);
    assert.ok(out.stats.warnings.includes('skipped:sec_contact_missing'));
  });
  test('an already-blocked EDGAR client skips the adapter', async () => {
    const { stats, calls } = await runWith(standardRoutes(), { edgarWrap: (/** @type {any} */ e) => ({ ...e, blocked: true, warnings: [], hasBudget: () => true }) });
    assert.equal(stats.skipped, 'sec_blocked');
    assert.equal(calls.length, 0);
  });
  test('a per-run budget stops fetching; the rest are counted out_of_scope run_cap (capped), never dropped', async () => {
    const { items, stats, calls } = await runWith(standardRoutes(), { budgets: { form_d: 3 } });
    assert.equal(stats.raw, 7);
    assert.ok(stats.capped >= 1);
    assert.equal(stats.reasons['out_of_scope:run_cap'], stats.capped);
    const docCalls = calls.filter((c) => /primary_doc|submissions/.test(c.url));
    assert.ok(docCalls.length <= 3, `form_d budget respected: ${docCalls.length}`);
    assert.equal(items.length, 7);
  });
  test('discovery_total versus read is recorded when the search reports more hits than were read', async () => {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0001234567-26-000042', ciks: ['0001234567'], display_names: ['Northwind Logistics Inc'], file_date: '2026-10-07', form: 'D' }], 250) },
      { match: /primary_doc/, file: 'form_d/operating.xml' },
      { match: /submissions/, status: 404, body: '' },
    ];
    const { stats } = await runWith(routes);
    assert.equal(stats.discovery_total, 500, '250 per form request');
    assert.equal(stats.read, 1);
    assert.equal(stats.extra.discovery_not_read, 498, '249 unread per form request');
    assert.equal(stats.coverage?.source, 'partial', 'undercoverage is never reported complete');
    assert.equal(stats.coverage?.forms.D.status, 'partial');
    assert.equal(stats.extra.undercoverage, 1);
  });
  test('an unreadable search response is one counted unparseable hit_shape_unknown', async () => {
    const { items, stats } = await runWith([{ match: /search-index/, body: '<html>captcha</html>' }]);
    assert.equal(stats.raw, 2, 'one per form request');
    assert.equal(items[0].reason, 'hit_shape_unknown');
  });
  test('a blocked search (429 twice) skips the adapter with sec_blocked and warns', async () => {
    const { stats, items } = await runWith([{ match: /search-index/, status: 429, body: 'no' }]);
    assert.equal(stats.skipped, 'sec_blocked');
    assert.equal(items.length, 0);
    assert.ok(stats.warnings.includes('sec_blocked'));
  });
  test('submissions JSON failures degrade to an absent SIC (counted), never to a guessed one', async () => {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0001234567-26-000042', ciks: ['0001234567'], display_names: ['Northwind Logistics Inc'], file_date: '2026-10-07', form: 'D' }]) },
      { match: /primary_doc/, file: 'form_d/operating.xml' },
      { match: /submissions/, body: '{"sic": "abcd"}' },
    ];
    const { items } = await runWith(routes);
    assert.equal(items[0].signal.issuer.sic, null);
    assert.equal(classify(items[0]).rule, 'form_d_sic_unavailable');
  });
});

describe('revenue range to size', () => {
  const T = (/** @type {string} */ r) => { const { recognized, ...s } = sizeFromRevenueRange(r); void recognized; return s; };
  test('the five documented Item 5 ranges, in "-" and "to" spellings', () => {
    const M = 'medium';
    const base = { basis: 'form_d_revenue_range', confidence: M };
    assert.deepEqual(T('$1 - $1,000,000'), { low: 1, high: 1_000_000, ...base });
    assert.deepEqual(T('$1,000,001 to $5,000,000'), { low: 1_000_001, high: 5_000_000, ...base });
    assert.deepEqual(T('$5,000,001 - $25,000,000'), { low: 5_000_001, high: 25_000_000, ...base });
    assert.deepEqual(T('$25,000,001 to $100,000,000'), { low: 25_000_001, high: 100_000_000, ...base });
    assert.deepEqual(T('Over $100,000,000'), { low: 100_000_000, high: null, ...base });
    assert.deepEqual(T('No Revenues'), { low: 0, high: 0, ...base });
  });
  test('decline / not applicable / absent are confidence none; garbage is none and unrecognized', () => {
    const none = { low: null, high: null, basis: 'form_d_revenue_range', confidence: 'none' };
    for (const r of ['Decline to Disclose', 'Not Applicable', 'N/A', '', '   ']) assert.deepEqual(T(r), none, r);
    assert.equal(sizeFromRevenueRange('Decline to Disclose').recognized, true);
    for (const r of ['lots', '$5 - $1', 'Over', 'very large revenue', '$1,000,001 - ']) {
      assert.deepEqual(T(r), none, r);
      assert.equal(sizeFromRevenueRange(r).recognized, false, r);
    }
  });
  test('cleanDisplayName strips the CIK and ticker text', () => {
    assert.equal(cleanDisplayName('Acme Corp  (ACME)  (CIK 0001234567)'), 'Acme Corp');
    assert.equal(cleanDisplayName('Acme Corp (CIK 0001234567)'), 'Acme Corp');
    assert.equal(cleanDisplayName(null), '');
  });
});

void fixture;
