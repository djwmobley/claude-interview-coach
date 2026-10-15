// @ts-check
/**
 * src/targets/edgar-client.js (target finder PR2): SEC contact config, validators, URL builders, request
 * pacing and budgets, and the block-then-abort behavior. Recorded fixtures / fakes only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSecContact, validCik, validAdsh, validFilename, indexUrl, docUrl, submissionsUrl, searchUrl, parseSearchResponse,
  createEdgarClient, EDGAR_BUDGETS, EDGAR_TOTAL_CAP, MIN_REQUEST_GAP_MS, adshFolder,
} from '../src/targets/edgar-client.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import { checkEvidence } from '../src/core/target-evidence.js';
import { createReplayFetch, fastTiming, searchJson, fixture } from './helpers/targets-replay.js';
import { createTargetNetwork } from '../src/targets/index.js';

const UA = 'Test Person test.person@corp.test';

/** @param {string|null} content */
function configDirWith(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-sec-'));
  if (content !== null) fs.writeFileSync(path.join(dir, 'target-sec-contact.json'), content);
  return dir;
}

describe('SEC contact config (gitignored, no default)', () => {
  test('missing file, bad JSON, wrong shape, no email, placeholder email, and header injection are all refused', () => {
    assert.deepEqual(loadSecContact(configDirWith(null)), { ok: false, reason: 'missing' });
    assert.deepEqual(loadSecContact(configDirWith('{nope')), { ok: false, reason: 'invalid' });
    assert.deepEqual(loadSecContact(configDirWith('{"contact": 5}')), { ok: false, reason: 'invalid' });
    assert.deepEqual(loadSecContact(configDirWith('{"contact": "Just A Name"}')), { ok: false, reason: 'no_email' });
    assert.deepEqual(loadSecContact(configDirWith('{"contact": "Your Name your.email@example.com"}')), { ok: false, reason: 'placeholder' });
    assert.equal(loadSecContact(configDirWith(JSON.stringify({ contact: 'A B a@b.co\r\nX-Evil: 1' }))).ok, false);
  });
  test('a name plus an email is accepted and used verbatim as the User-Agent', () => {
    const r = loadSecContact(configDirWith(JSON.stringify({ contact: UA })));
    assert.deepEqual(r, { ok: true, userAgent: UA });
  });
  test('with no valid contact, createTargetNetwork has no EDGAR client and the guard refuses sec.gov', async () => {
    const dir = configDirWith(null);
    const { fetch, calls } = createReplayFetch([{ match: () => true, body: '{}' }]);
    const net = createTargetNetwork({ configDir: dir, fetch });
    assert.equal(net.edgar, null);
    assert.equal(net.sec.ok, false);
    await assert.rejects(net.guard.get('https://www.sec.gov/x'), /sec_contact_missing/);
    assert.equal(calls.length, 0);
  });
  test('the tracked example holds a placeholder that is itself refused, so copying it unedited never reaches SEC', () => {
    const cfg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
    const ex = fs.readFileSync(path.join(cfg, 'target-sec-contact.example.json'), 'utf8');
    assert.deepEqual(loadSecContact(configDirWith(ex)), { ok: false, reason: 'placeholder' });
  });
});

describe('validators and URL building (plan 15.2 item 8)', () => {
  test('cik: 1 to 10 digits only, leading zeros stripped, zero rejected', () => {
    assert.equal(validCik('0001234567'), '1234567');
    assert.equal(validCik(1234567), '1234567');
    assert.equal(validCik('1'), '1');
    for (const bad of ['', '0', '0000000000', '12345678901', '12a', '../1', '1/2', ' ', null, undefined, {}, [], -5, 1.5, '1 2']) assert.equal(validCik(bad), null, JSON.stringify(bad));
  });
  test('accession: exactly NNNNNNNNNN-NN-NNNNNN', () => {
    assert.equal(validAdsh('0001234567-26-000042'), '0001234567-26-000042');
    for (const bad of ['', '12345', '000123456726000042', '0001234567-26-00004', '0001234567-26-0000421', 'a001234567-26-000042', '../0001234567-26-000042', null, 5]) assert.equal(validAdsh(bad), null, String(bad));
    assert.equal(adshFolder('0001234567-26-000042'), '000123456726000042');
  });
  test('filename: no slash, backslash, or "..", plain bounded charset', () => {
    assert.equal(validFilename('primary_doc.xml'), 'primary_doc.xml');
    assert.equal(validFilename('ex99-1.htm'), 'ex99-1.htm');
    for (const bad of ['', '../x.htm', 'a/b.htm', 'a\\b.htm', '..', 'x..y.htm', '.hidden', '-x', 'a b.htm', 'x?y=1', 'x'.repeat(200), null, 5]) assert.equal(validFilename(bad), null, String(bad));
  });
  test('built URLs use the 18-digit folder and pass the evidence registry; fetch URLs stay on registry hosts', () => {
    const idx = indexUrl('1234567', '0001234567-26-000042');
    assert.equal(idx, 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000042/0001234567-26-000042-index.htm');
    assert.equal(checkEvidence(idx, 'edgar_form_d').ok, true);
    assert.equal(docUrl('1234567', '0001234567-26-000042', 'primary_doc.xml'), 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000042/primary_doc.xml');
    assert.equal(submissionsUrl('1234567'), 'https://data.sec.gov/submissions/CIK0001234567.json');
    const s = new URL(searchUrl({ q: '"Item 5.02" & x=1', forms: '8-K', from: 0, empty: undefined }));
    assert.equal(s.host, 'efts.sec.gov');
    assert.equal(s.searchParams.get('q'), '"Item 5.02" & x=1');
    assert.equal(s.searchParams.has('empty'), false);
  });
});

describe('search response parsing', () => {
  test('the recorded Form D page parses; a hit with no _source is shape_ok false', () => {
    const r = parseSearchResponse(fixture('form_d/search_page1.json'));
    assert.equal(r.ok, true);
    assert.equal(r.total, 7);
    assert.equal(r.hits.length, 7);
    assert.equal(r.hits[0].adsh, '0001234567-26-000042');
    assert.deepEqual(r.hits[0].ciks, ['0001234567']);
    assert.equal(r.hits[0].filename, 'primary_doc.xml');
    assert.equal(r.hits[5].shape_ok, false);
    assert.equal(r.hits[0].items, null);
  });
  test('8-K hits carry items; an absent items field stays null (not an empty list)', () => {
    const r = parseSearchResponse(fixture('edgar_8k/search_page1.json'));
    assert.deepEqual(r.hits[0].items, ['5.02', '9.01']);
    assert.equal(r.hits[6].items, null);
  });
  test('unknown top-level shapes are reported, never guessed', () => {
    for (const bad of ['', 'not json', '[]', '{}', '{"hits":{}}', '{"hits":{"hits":"x"}}', 'null']) assert.equal(parseSearchResponse(bad).ok, false, bad);
  });
});

describe('request pacing, budgets, and blocking', () => {
  /** @param {import('./helpers/targets-replay.js').Route[]} routes @param {Record<string, any>} [t] */
  function make(routes, t = {}) {
    const replay = createReplayFetch(routes);
    const ft = fastTiming();
    const guard = createFetchGuard({ fetch: replay.fetch, userAgent: UA });
    const edgar = createEdgarClient({ guard, timing: { ...ft.timing, ...t } });
    return { ...replay, ...ft, guard, edgar };
  }

  test('requests are sequential and at least 250 ms apart', async () => {
    const { edgar, sleeps } = make([{ match: () => true, body: '{}' }]);
    assert.equal(MIN_REQUEST_GAP_MS, 250);
    for (let i = 0; i < 4; i += 1) await edgar.search(`https://efts.sec.gov/LATEST/search-index?q=${i}`, 'discovery_fts');
    assert.equal(sleeps.length, 3, 'the first request needs no wait');
    assert.ok(sleeps.every((ms) => ms >= 250));
  });
  test('budgets: per-source documents and per-source discovery, 200 total; over budget makes no request', async () => {
    assert.deepEqual({ ...EDGAR_BUDGETS }, { form_d: 80, '8k': 45, fts: 45, discovery_form_d: 6, discovery_8k: 6, discovery_fts: 18 });
    assert.equal(Object.values(EDGAR_BUDGETS).reduce((a, b) => a + b, 0), 200);
    assert.equal(EDGAR_TOTAL_CAP, 200);
    const { edgar, calls } = make([{ match: () => true, body: '{}' }]);
    for (let i = 0; i < 18; i += 1) assert.equal((await edgar.search(`https://efts.sec.gov/LATEST/search-index?q=${i}`, 'discovery_fts')).ok, true);
    const over = await edgar.search('https://efts.sec.gov/LATEST/search-index?q=over', 'discovery_fts');
    assert.deepEqual([over.ok, over.reason], [false, 'capped']);
    assert.equal(calls.length, 18);
    assert.equal(edgar.hasBudget('discovery_fts'), false);
    // PR2b: full-text queries cannot use up Form D or 8-K discovery.
    assert.equal(edgar.hasBudget('discovery_form_d'), true);
    assert.equal(edgar.hasBudget('discovery_8k'), true);
    assert.equal((await edgar.search('https://efts.sec.gov/LATEST/search-index?q=fd', 'discovery_form_d')).ok, true);
    assert.equal((await edgar.search('https://efts.sec.gov/LATEST/search-index?q=k8', 'discovery_8k')).ok, true);
    assert.equal(edgar.hasBudget('discovery'), false, 'the old shared discovery budget is gone');
    assert.equal(edgar.hasBudget('form_d'), true);
    assert.equal(edgar.hasBudget('nonsense'), false);
  });
  test('the 200 total cap holds even when each budget still has room', async () => {
    const { edgar, calls } = make([{ match: () => true, body: '{}' }], { budgets: { form_d: 150, '8k': 150, fts: 150, discovery_fts: 150 } });
    let ok = 0;
    for (let i = 0; i < 260; i += 1) if ((await edgar.document(`https://www.sec.gov/Archives/edgar/data/1/000000000000000001/f${i}.htm`, i % 2 ? 'form_d' : '8k')).ok) ok += 1;
    assert.equal(ok, 200);
    assert.equal(calls.length, 200);
  });
  test('429 once: one backoff retry, then success; the Retry-After is honored but capped', async () => {
    const seq = [new Response('', { status: 429, headers: { 'retry-after': '86400' } }), new Response('fine')];
    /** @type {any} */
    const f = async () => seq.shift();
    const ft = fastTiming();
    const client = createEdgarClient({ guard: createFetchGuard({ fetch: f, userAgent: UA }), timing: ft.timing });
    const r = await client.search('https://efts.sec.gov/LATEST/search-index?q=x', 'discovery_fts');
    assert.equal(r.ok, true);
    assert.equal(r.text, 'fine');
    assert.ok(ft.sleeps.includes(30_000), 'capped Retry-After was slept');
    assert.ok(Math.max(...ft.sleeps) <= 30_000);
    assert.equal(client.blocked, false);
  });
  for (const status of [429, 403, 503]) {
    test(`${status} twice: the whole EDGAR side is aborted for the run and nothing else is requested`, async () => {
      const { edgar, calls } = make([{ match: () => true, status, body: 'slow down' }]);
      const first = await edgar.search('https://efts.sec.gov/LATEST/search-index?q=a', 'discovery_fts');
      assert.deepEqual([first.ok, first.reason, first.status], [false, 'blocked', status]);
      assert.equal(calls.length, 2, 'exactly one retry');
      assert.equal(edgar.blocked, true);
      assert.deepEqual(edgar.warnings, ['sec_blocked']);
      const after = await edgar.document('https://www.sec.gov/Archives/edgar/data/1/000000000000000001/x.htm', 'form_d');
      assert.equal(after.reason, 'blocked');
      assert.equal(calls.length, 2, 'no request after the block');
    });
  }
  test('other HTTP errors are reported without blocking the run', async () => {
    const { edgar } = make([{ match: () => true, status: 404, body: 'no' }]);
    const r = await edgar.document('https://www.sec.gov/Archives/edgar/data/1/000000000000000001/x.htm', 'form_d');
    assert.deepEqual([r.ok, r.reason, r.status], [false, 'http_error', 404]);
    assert.equal(edgar.blocked, false);
  });
  test('a refused URL (outside the registry) and a network failure are classified, not thrown', async () => {
    const { edgar } = make([{ match: () => true, body: '{}' }]);
    assert.equal((await edgar.search('https://example.com/x', 'discovery_fts')).reason, 'refused');
    const ft = fastTiming();
    /** @type {any} */
    const boom = async () => { throw new Error('ECONNRESET'); };
    const c2 = createEdgarClient({ guard: createFetchGuard({ fetch: boom, userAgent: UA }), timing: ft.timing });
    assert.equal((await c2.search('https://efts.sec.gov/LATEST/search-index?q=x', 'discovery_fts')).reason, 'network_error');
  });
  test('searchJson helper round-trips through the parser', () => {
    const r = parseSearchResponse(searchJson([{ adsh: '0001234567-26-000001', ciks: ['1'], display_names: ['A'], file_date: '2026-10-01', form: 'D' }], 55));
    assert.equal(r.total, 55);
    assert.equal(r.hits[0].adsh, '0001234567-26-000001');
  });
});
