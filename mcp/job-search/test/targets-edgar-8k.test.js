// @ts-check
/**
 * src/targets/edgar-8k.js and src/targets/text-extract.js (target finder PR2, plan 14.4 D + 15.2 item 5).
 * Recorded fixtures only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run8k, EIGHT_K_REASONS, EIGHT_K_SOURCE } from '../src/targets/edgar-8k.js';
import { createEdgarClient } from '../src/targets/edgar-client.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import { COMMON_REASONS, OUTCOMES } from '../src/targets/outcomes.js';
import {
  analyzeDeparture, cutItem502, extractCoverDate, parseLooseDate, extractContact, htmlToPlain, findRoles,
} from '../src/targets/text-extract.js';
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
const D = (/** @type {string} */ cik, /** @type {string} */ folder) => `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/form8k.htm`;

function standardRoutes() {
  return [
    { match: /efts\.sec\.gov\/LATEST\/search-index\?.*Item\+5\.02/, file: 'edgar_8k/search_page1.json' },
    { match: D('1111111', '000111111126000101'), file: 'edgar_8k/departure.htm' },
    { match: D('2222222', '000222222226000102'), file: 'edgar_8k/appointment_only.htm' },
    { match: D('3333333', '000333333326000103'), file: 'edgar_8k/both.htm' },
    { match: D('4444444', '000444444426000104'), file: 'edgar_8k/other_officer.htm' },
    { match: D('5555555', '000555555526000105'), file: 'edgar_8k/no_section.htm' },
  ];
}

/** @param {import('./helpers/targets-replay.js').Route[]} routes @param {{ budgets?: Record<string, number> }} [o] */
async function runWith(routes, o = {}) {
  const replay = createReplayFetch(routes);
  const ft = fastTiming();
  const edgar = createEdgarClient({ guard: createFetchGuard({ fetch: replay.fetch, userAgent: UA }), timing: { ...ft.timing, ...(o.budgets ? { budgets: o.budgets } : {}) } });
  const out = await run8k({ edgar, now: NOW, blocked: BLOCKED });
  return { ...out, calls: replay.calls };
}
/** @param {any} item */
const classify = (item) => classifySignal(item.signal, { rules: RULES, now: NOW, blocked: OK_LIST });
/** @param {Array<{ key: string }>} items @param {string} adsh */
const byAdsh = (items, adsh) => /** @type {any} */ (items.find((i) => i.key === `${adsh}|5.02`));

describe('recorded 8-K Item 5.02 run', () => {
  test('every raw item has exactly one outcome from the closed set; counts add up', async () => {
    const { items, stats } = await runWith(standardRoutes());
    assert.equal(stats.raw, 7);
    assert.equal(items.length, 7);
    assert.equal(stats.parsed + stats.unparseable + stats.out_of_scope, 7);
    const allowed = new Set([...EIGHT_K_REASONS, ...COMMON_REASONS, 'ok']);
    for (const it of items) {
      assert.ok(OUTCOMES.includes(it.outcome));
      assert.ok(allowed.has(it.reason), it.reason);
      assert.equal(it.source, EIGHT_K_SOURCE);
    }
    assert.deepEqual(stats.reasons, {
      'parsed:ok': 3,
      'out_of_scope:appointment_only': 1,
      'out_of_scope:item_not_502': 1,
      'unparseable:section_not_found': 1,
      'unparseable:hit_shape_unknown': 1,
    });
    assert.equal(stats.discovery_total, 7);
  });

  test('a clear CTO resignation: parsed, role bound, cover date used, a flagged-unverified target', async () => {
    const { items } = await runWith(standardRoutes());
    const it = byAdsh(items, '0001111111-26-000101');
    assert.equal(it.outcome, 'parsed');
    const s = it.signal;
    assert.equal(s.trigger_kind, 'exec_departure');
    assert.equal(s.company, 'Contoso Industrial Corp');
    assert.equal(s.role, 'Chief Technology Officer');
    assert.equal(s.departure_ambiguous, false);
    assert.equal(s.event_date, '2026-10-01');
    assert.equal(s.filing_date, '2026-10-02');
    assert.equal(s.evidence_source, 'edgar_8k');
    assert.ok(s.text.includes('resigned as Chief Technology Officer'));
    assert.ok(s.text.length <= 4000);
    assert.equal(s.size, undefined);
    assert.equal(it.contact, null, 'the departing officer is never a contact name');
    const v = classify(it);
    assert.deepEqual([v.class, v.rule, v.size_verified], ['target', 'target_all_checks_passed', false]);
  });

  test('appointment-only is out_of_scope; both a departure and an appointment is parsed but ambiguous -> needs-review', async () => {
    const { items } = await runWith(standardRoutes());
    assert.deepEqual([byAdsh(items, '0002222222-26-000102').outcome, byAdsh(items, '0002222222-26-000102').reason], ['out_of_scope', 'appointment_only']);
    const both = byAdsh(items, '0003333333-26-000103');
    assert.equal(both.outcome, 'parsed');
    assert.equal(both.signal.departure_ambiguous, true);
    assert.equal(both.extracted.departure_kind, 'both');
    assert.deepEqual([classify(both).class, classify(both).rule], ['needs-review', 'departure_ambiguous']);
  });

  test('the departure verb must bind to the role-holder: another officer resigning with a CTO mention is ambiguous (15.2 item 5)', async () => {
    const { items } = await runWith(standardRoutes());
    const w = byAdsh(items, '0004444444-26-000104');
    assert.equal(w.outcome, 'parsed');
    assert.equal(w.signal.departure_ambiguous, true);
    assert.equal(classify(w).rule, 'departure_ambiguous');
  });

  test('a document with no Item 5.02 section is section_not_found; items without 5.02 are counted item_not_502; missing items field is hit_shape_unknown', async () => {
    const { items } = await runWith(standardRoutes());
    assert.equal(byAdsh(items, '0005555555-26-000105').reason, 'section_not_found');
    assert.equal(byAdsh(items, '0006666666-26-000106').reason, 'item_not_502');
    assert.equal(byAdsh(items, '0007777777-26-000107').reason, 'hit_shape_unknown');
  });

  test('only GETs to registry hosts; the documents fetched are exactly the 5.02 hits', async () => {
    const { calls } = await runWith(standardRoutes());
    assert.ok(calls.every((c) => c.method === 'GET' && c.headers['user-agent'] === UA));
    const docs = calls.filter((c) => c.url.endsWith('form8k.htm')).map((c) => c.url);
    assert.equal(docs.length, 5);
    assert.ok(calls[0].url.includes('forms=8-K%2C8-K%2FA'));
    assert.ok(calls[0].url.includes('startdt=2026-09-15'), 'a 30-day window');
  });
});

describe('document handling', () => {
  /** @param {string} html @param {Record<string, any>} [hit] */
  async function one(html, hit = {}) {
    const routes = [
      { match: /search-index/, body: searchJson([{ adsh: '0001111111-26-000101', ciks: ['0001111111'], display_names: ['Contoso Industrial Corp  (CIK 0001111111)'], file_date: '2026-10-02', form: '8-K', items: ['5.02'], _id: '0001111111-26-000101:form8k.htm', ...hit }]) },
      { match: /form8k\.htm/, body: html },
    ];
    return runWith(routes);
  }
  const departure = () => fixture('edgar_8k/departure.htm');

  test('a blocked name outside the cut section is still found (full-document scan) and placed first in text', async () => {
    const html = departure().replace('</body>', '<p>Exhibit 99.1 press release issued through Immun\u200Botec Staffing.</p></body>');
    const { items } = await one(html);
    const it = items[0];
    assert.equal(it.outcome, 'parsed');
    assert.ok(it.signal.text.startsWith('[blocked-term Immunotec]'));
    assert.equal(classify(it).rule, 'excl_blocked_suspect');
  });
  test('a very long section is capped at 4000 characters but a late blocked term is still surfaced', async () => {
    const filler = '<p>' + 'The Company continues to operate in the ordinary course. '.repeat(200) + '</p>';
    const html = departure().replace('<p>The Board has begun a search for his successor.</p>', `${filler}<p>Advisicon will assist.</p>`);
    const { items } = await one(html);
    assert.ok(items[0].signal.text.length <= 4000);
    assert.ok(items[0].signal.text.includes('[blocked-term Advisicon]'));
    assert.equal(items[0].extracted.section_truncated, true);
  });
  test('a missing cover date alone is still parsed with event_date null (the classifier then uses the filing date)', async () => {
    const { items } = await one(departure().replace(/Date of Report[^<]*/, 'Report'));
    assert.equal(items[0].outcome, 'parsed');
    assert.equal(items[0].signal.event_date, null);
    assert.equal(items[0].signal.filing_date, '2026-10-02');
    assert.equal(classify(items[0]).class, 'target');
  });
  test('no cover date AND no filing date is unparseable no_date_at_all', async () => {
    const { items } = await one(departure().replace(/Date of Report[^<]*/, 'Report'), { file_date: 'garbage' });
    assert.deepEqual([items[0].outcome, items[0].reason], ['unparseable', 'no_date_at_all']);
  });
  test('an 8-K/A is ingested as its own signal under its own accession, flagged as an amendment', async () => {
    const { items } = await one(departure(), { form: '8-K/A', adsh: '0001111111-26-000150', _id: '0001111111-26-000150:form8k.htm' });
    assert.equal(items[0].key, '0001111111-26-000150|5.02');
    assert.equal(items[0].extracted.amendment, true);
  });
  test('a stale event (older than 120 days) is not-target by the classifier, not by the adapter', async () => {
    const { items } = await one(departure().replace('October 1, 2026', 'May 1, 2026'));
    assert.equal(items[0].signal.event_date, '2026-05-01');
    assert.deepEqual([classify(items[0]).class, classify(items[0]).rule], ['not-target', 'date_stale']);
  });
  test('oversized display names are name_too_long', async () => {
    const { items } = await one(departure(), { display_names: ['N'.repeat(250) + '  (CIK 0001111111)'] });
    assert.equal(items[0].reason, 'name_too_long');
  });
  test('fetch failures are doc_fetch_failed; a budget stop is run_cap', async () => {
    const routes = [
      { match: /search-index/, file: 'edgar_8k/search_page1.json' },
      { match: /form8k\.htm/, status: 404, body: 'gone' },
    ];
    const r = await runWith(routes);
    assert.equal(r.stats.reasons['unparseable:doc_fetch_failed'], 5);
    const capped = await runWith(standardRoutes(), { budgets: { '8k': 2 } });
    assert.equal(capped.stats.reasons['out_of_scope:run_cap'], 3);
    assert.equal(capped.stats.capped, 3);
    assert.equal(capped.items.length, 7);
  });
  test('path traversal in an accession, CIK, or filename never produces a request (plan 15.2 item 8)', async () => {
    const hits = [
      { adsh: '../../etc/passwd', ciks: ['0001111111'], display_names: ['A Co'], file_date: '2026-10-02', form: '8-K', items: ['5.02'], _id: 'x:form8k.htm' },
      { adsh: '0001111111-26-000101', ciks: ['../1'], display_names: ['B Co'], file_date: '2026-10-02', form: '8-K', items: ['5.02'], _id: '0001111111-26-000101:form8k.htm' },
      { adsh: '0001111111-26-000102', ciks: ['0001111111'], display_names: ['C Co'], file_date: '2026-10-02', form: '8-K', items: ['5.02'], _id: '0001111111-26-000102:../../etc/passwd' },
      { adsh: '0001111111-26-000103', ciks: ['0001111111'], display_names: ['D Co'], file_date: '2026-10-02', form: '8-K', items: ['5.02'], _id: '0001111111-26-000103:a/b.htm' },
    ];
    const { items, calls } = await runWith([{ match: /search-index/, body: searchJson(hits) }]);
    assert.deepEqual(items.map((i) => i.reason), ['accession_malformed', 'cik_malformed', 'hit_shape_unknown', 'hit_shape_unknown']);
    assert.equal(calls.length, 1, 'only the discovery request was made');
  });
  test('a blocked or unreachable search skips the adapter; a missing SEC contact skips with zero requests', async () => {
    const blocked = await runWith([{ match: /search-index/, status: 503, body: '' }]);
    assert.equal(blocked.stats.skipped, 'sec_blocked');
    const none = await run8k({ edgar: null, now: NOW, blocked: BLOCKED });
    assert.equal(none.stats.skipped, 'sec_contact_missing');
    assert.equal(none.items.length, 0);
  });
});

describe('analyzeDeparture (verb binds to the role-holder)', () => {
  /** @type {Array<[string, string, boolean]>} */
  const CASES = [
    ['John Smith resigned as Chief Technology Officer, effective immediately.', 'departure', false],
    ['Mr. Lee retired as Chief Information Officer.', 'departure', false],
    ['Chief Data Officer Pat Kim stepped down on October 3.', 'departure', false],
    ['The CTO resigned.', 'departure', false],
    ['The Board appointed Jane Doe as Chief Information Officer.', 'appointment_only', false],
    ['The Board elected Pat Roe as Chief AI Officer and Head of Technology.', 'appointment_only', false],
    ['The Board appointed Jane as CTO following the resignation of the Chief Financial Officer.', 'ambiguous', true],
    ['The Chief Financial Officer resigned. The CTO will assume interim duties.', 'ambiguous', true],
    ['The CTO did not resign and remains with the Company.', 'ambiguous', true],
    ['Sam Ray resigned as Chief Executive Officer; the Chief Technology Officer is unchanged.', 'ambiguous', true],
    ['Priya resigned as Chief Information Officer. Daniel was appointed Chief Information Officer.', 'both', true],
    ['The Company discussed its dividend policy.', 'no_role', false],
    ['', 'no_role', false],
  ];
  for (const [text, kind, ambiguous] of CASES) {
    test(`${JSON.stringify(text.slice(0, 60))} -> ${kind}`, () => {
      const a = analyzeDeparture(text);
      assert.equal(a.kind, kind);
      assert.equal(a.ambiguous, ambiguous);
    });
  }
  test('role phrases cover the documented set and nothing else', () => {
    const roles = (/** @type {string} */ t) => findRoles(t).map((r) => r.phrase.toLowerCase());
    assert.deepEqual(roles('chief technology officer and Chief Information Officer, Chief Digital Officer, Chief Data Officer, Chief AI Officer'), ['chief technology officer', 'chief information officer', 'chief digital officer', 'chief data officer', 'chief ai officer']);
    assert.deepEqual(roles('CTO CIO CDO CAIO head of technology head of IT'), ['cto', 'cio', 'cdo', 'caio', 'head of technology', 'head of it']);
    assert.deepEqual(roles('Chief Financial Officer, chief marketing officer, CFO, COO, VP Engineering'), []);
  });
  test('catastrophic input is cut at the read cap before any regex (time bound)', () => {
    const t0 = Date.now();
    analyzeDeparture('resigned '.repeat(200_000) + 'Chief Technology Officer');
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe('section, date, and contact extraction', () => {
  test('cutItem502 takes the longest Item 5.02 section and stops at the next Item heading or SIGNATURES', () => {
    const plain = ['Index', 'Item 5.02 Departure', 'Item 8.01 Other', 'Body', 'Item 5.02 Departure of Officers', 'The CTO resigned.', 'More text.', 'Item 9.01 Exhibits', 'SIGNATURES'].join('\n');
    const s = cutItem502(plain);
    assert.ok(s && s.startsWith('Item 5.02 Departure of Officers') && s.includes('More text.') && !s.includes('Exhibits'));
    assert.equal(cutItem502('Item 8.01 only'), null);
    assert.ok(cutItem502('Item 5.02 Last section\nSIGNATURES\nx')?.endsWith('Last section'));
  });
  test('cover date: month names, numeric, ISO; impossible dates and a missing label are null', () => {
    assert.equal(extractCoverDate('Date of Report (Date of earliest event reported): October 1, 2026'), '2026-10-01');
    assert.equal(extractCoverDate('Date of Report (Date of earliest event reported): Oct. 1, 2026'), '2026-10-01');
    assert.equal(extractCoverDate('Date of Report: 10/01/2026'), '2026-10-01');
    assert.equal(extractCoverDate('Date of Report: 2026-10-01'), '2026-10-01');
    assert.equal(extractCoverDate('Date of Report: February 30, 2026'), null);
    assert.equal(extractCoverDate('no label here October 1, 2026'), null);
    assert.equal(parseLooseDate('Sept 9, 2026'), '2026-09-09');
    for (const bad of [null, undefined, 5, '', 'soon', '13/45/2026', '2026-13-01']) assert.equal(parseLooseDate(bad), null, String(bad));
  });
  test('contact: a name only when adjacent to a CEO/CTO/CIO/CDO/operating partner title and not tied to departing/media/contact text', () => {
    assert.deepEqual(extractContact('Jane Roe, Chief Executive Officer of Globex, said the deal fuels growth.'), { role: 'Chief Executive Officer', name: 'Jane Roe' });
    assert.deepEqual(extractContact('Our Operating Partner Maria Gomez led the diligence.'), { role: 'Operating Partner', name: 'Maria Gomez' });
    assert.deepEqual(extractContact('Chief Technology Officer Alan Turing will lead the platform team.'), { role: 'Chief Technology Officer', name: 'Alan Turing' });
    assert.equal(extractContact('Robert Vance, Chief Technology Officer, resigned effective October 31.'), null);
    assert.equal(extractContact('Media contact: Alex Smith, Chief Executive Officer'), null);
    assert.equal(extractContact('Former Chief Executive Officer John Adams left in March.'), null);
    assert.equal(extractContact('Robert Vance is the departing CTO.'), null);
    assert.equal(extractContact('The Chief Executive Officer Search Committee met.'), null);
    assert.equal(extractContact(''), null);
    assert.equal(extractContact('Jane Roe, Vice President of Sales, said.'), null);
  });
  test('htmlToPlain keeps line structure, drops scripts/styles, strips format characters', () => {
    const t = htmlToPlain('<html><head><style>x{}</style></head><body><script>evil()</script><p>Item 5.02 Departure</p><div>Line\u200B two</div></body></html>');
    assert.equal(t, 'Item 5.02 Departure\nLine two');
  });
});
