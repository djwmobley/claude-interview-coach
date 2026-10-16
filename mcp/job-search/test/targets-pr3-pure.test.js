// @ts-check
/**
 * Target finder PR3, pure units (plan 17): ET business-day anchors, the total day-coverage classification,
 * closed reason codes, the stage timeout arithmetic, the digest line, the subject flag inputs, the CLI
 * argument parser, and the adapter changes (window, covered, all-names exclusion, invalid-filename partial).
 * No database, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  etDay, addDays, isBusinessDay, businessDayAnchors, sliceDays, backlogDays, businessDaysBetween, isEtWeekday, isYmd,
} from '../src/targets/dates.js';
import {
  assessDay, isCovered, itemCovered, closedReason, configHash, CLOSED_REASONS, PERMANENT_OUT_OF_SCOPE, PERMANENT_UNPARSEABLE,
} from '../src/targets/coverage.js';
import { computeStageTimeout, toStageStats, STAGE_MAX_MS, STAGE_RESERVE_MS } from '../src/targets/stage.js';
import { renderTargetsLine, targetsExpected, buildReportSubject } from '../src/core/report.js';
import { parseArgs, exitCodeFor } from '../bin/targets.js';
import { runFormD } from '../src/targets/form-d.js';
import { run8k } from '../src/targets/edgar-8k.js';
import { runFts } from '../src/targets/edgar-fts.js';
import { chooseDocs, fetchStatusWithInvalid, discoverByForm } from '../src/targets/edgar-shared.js';
import { createEdgarClient } from '../src/targets/edgar-client.js';
import { createFetchGuard } from '../src/targets/fetch-guard.js';
import { classifySignal, loadTargetRules } from '../src/core/target-classify.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { createReplayFetch, fastTiming, searchJson, fixture } from './helpers/targets-replay.js';
import { formDXml } from './helpers/targets-world.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = loadTargetRules(path.join(HERE, '..', 'config'));
const NOW = new Date('2026-10-15T12:00:00Z');
const UA = 'Test Person test.person@corp.test';
/** @type {import('../src/core/target-exclusion.js').BlockedList} */
const OK_LIST = { entries: [...BUILT_IN_BLOCKED], status: 'ok', error: null };

describe('dates (America/New_York, business days)', () => {
  test('etDay uses the ET calendar day, not UTC', () => {
    assert.equal(etDay(new Date('2026-10-16T02:30:00Z')), '2026-10-15', '22:30 ET is still the 15th');
    assert.equal(etDay(new Date('2026-10-15T12:00:00Z')), '2026-10-15');
    assert.equal(etDay(new Date('2026-11-01T05:30:00Z')), '2026-11-01', 'DST end');
  });
  test('anchors skip weekends: Thursday, Monday, Saturday', () => {
    assert.deepEqual(businessDayAnchors('2026-10-15'), { bd0: '2026-10-15', bd1: '2026-10-14', bd2: '2026-10-13' });
    assert.deepEqual(businessDayAnchors('2026-10-12'), { bd0: '2026-10-12', bd1: '2026-10-09', bd2: '2026-10-08' });
    assert.deepEqual(businessDayAnchors('2026-10-17'), { bd0: '2026-10-16', bd1: '2026-10-15', bd2: '2026-10-14' });
  });
  test('slices are business days after the cursor through bd(0); no cursor starts at the lookback', () => {
    assert.deepEqual(sliceDays({ cursor: '2026-10-12', today: '2026-10-15', lookbackDays: 14 }), ['2026-10-13', '2026-10-14', '2026-10-15']);
    assert.deepEqual(sliceDays({ cursor: '2026-10-09', today: '2026-10-13', lookbackDays: 14 }), ['2026-10-12', '2026-10-13'], 'the weekend is not a slice');
    const first = sliceDays({ cursor: null, today: '2026-10-15', lookbackDays: 14 });
    assert.equal(first[0], '2026-10-01');
    assert.equal(first.at(-1), '2026-10-15');
    assert.ok(first.every(isBusinessDay));
    assert.deepEqual(sliceDays({ cursor: 'garbage', today: '2026-10-15', lookbackDays: 1 }), ['2026-10-14', '2026-10-15'], 'an invalid cursor is the first-run case');
  });
  test('backlog counts old-enough days the cursor has not reached', () => {
    assert.equal(backlogDays({ cursor: '2026-10-13', today: '2026-10-15', lookbackDays: 14 }), 0);
    assert.equal(backlogDays({ cursor: '2026-10-08', today: '2026-10-15', lookbackDays: 14 }), 3);
    assert.equal(backlogDays({ cursor: null, today: '2026-10-15', lookbackDays: 14 }), businessDaysBetween('2026-09-30', '2026-10-13').length);
  });
  test('isYmd rejects impossible dates; addDays crosses months', () => {
    assert.equal(isYmd('2026-02-30'), false);
    assert.equal(isYmd('2026-10-15'), true);
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(isEtWeekday(new Date('2026-10-17T15:00:00Z')), false);
  });
});

describe('coverage classification is total and defaults to not covered', () => {
  test('parsed is covered only when doc_fetch is ok or absent', () => {
    assert.equal(isCovered({ outcome: 'parsed', doc_fetch: null }), true);
    assert.equal(isCovered({ outcome: 'parsed', doc_fetch: 'ok' }), true);
    for (const f of ['partial', 'failed', 'weird']) assert.equal(isCovered({ outcome: 'parsed', doc_fetch: f }), false, f);
  });
  test('out_of_scope and unparseable are covered only for the permanent reasons; everything else holds', () => {
    for (const r of PERMANENT_OUT_OF_SCOPE) assert.equal(isCovered({ outcome: 'out_of_scope', reason: r }), true, r);
    for (const r of PERMANENT_UNPARSEABLE) assert.equal(isCovered({ outcome: 'unparseable', reason: r }), true, r);
    for (const r of ['run_cap', 'doc_fetch_failed', 'adapter_exception', 'fetch_refused', 'brand_new_reason', '']) {
      assert.equal(isCovered({ outcome: 'out_of_scope', reason: r }), false, `oos ${r}`);
      assert.equal(isCovered({ outcome: 'unparseable', reason: r }), false, `unp ${r}`);
    }
    assert.equal(isCovered({ outcome: 'weird', reason: 'ok' }), false);
    assert.equal(isCovered({}), false);
  });
  test('itemCovered reads doc_fetch from extracted or the signal', () => {
    assert.equal(itemCovered(/** @type {any} */ ({ outcome: 'parsed', reason: 'ok', extracted: { doc_fetch: 'partial' }, signal: null })), false);
    assert.equal(itemCovered(/** @type {any} */ ({ outcome: 'parsed', reason: 'ok', extracted: {}, signal: { doc_fetch: 'failed' } })), false);
    assert.equal(itemCovered(/** @type {any} */ ({ outcome: 'parsed', reason: 'ok', extracted: {}, signal: {} })), true);
  });
  const fc = (/** @type {any} */ o) => ({ status: 'complete', total: 2, read: 2, distinct: 2, pages: [{ from: 0, hits: 2, ok: true, reason: null }], ...o });
  const stats = (/** @type {any} */ forms, /** @type {any} */ extra = {}) => /** @type {any} */ ({ coverage: { source: Object.values(forms).every((f) => /** @type {any} */ (f).status === 'complete') ? 'complete' : 'partial', forms }, ...extra });
  test('assessDay: complete only when every form is complete and every item covered', () => {
    const ok = assessDay({ stats: stats({ D: fc({}), 'D/A': fc({ total: 0, read: 0, distinct: 0, pages: [{ from: 0, hits: 0, ok: true, reason: null }] }) }), items: [] });
    assert.deepEqual([ok.complete, ok.reasons, ok.total, ok.distinct], [true, [], 2, 2]);
  });
  test('assessDay: distinct hits that differ from the final total are partial', () => {
    const a = assessDay({ stats: stats({ D: fc({ status: 'partial', distinct: 1 }) }), items: [] });
    assert.equal(a.complete, false);
    assert.deepEqual(a.reasons, ['discovery_incomplete']);
  });
  test('assessDay: an aborted request is request_failed, a run_cap or doc failure or exception holds the day', () => {
    const failed = assessDay({ stats: stats({ D: fc({ status: 'none', total: null, read: 0, distinct: 0, pages: [{ from: 0, hits: 0, ok: false, reason: 'http_error' }] }) }), items: [] });
    assert.deepEqual(failed.reasons, ['request_failed']);
    const items = /** @type {any[]} */ ([
      { outcome: 'out_of_scope', reason: 'run_cap', extracted: {} },
      { outcome: 'unparseable', reason: 'doc_fetch_failed', extracted: {} },
      { outcome: 'unparseable', reason: 'adapter_exception', extracted: {} },
      { outcome: 'parsed', reason: 'ok', extracted: { doc_fetch: 'partial' } },
    ]);
    const a = assessDay({ stats: stats({ D: fc({}) }), items });
    assert.deepEqual(a.reasons, ['adapter_exception', 'doc_fetch', 'run_cap']);
    assert.equal(a.uncovered, 4);
  });
  test('assessDay: no coverage at all, and an overflow, are never complete', () => {
    assert.deepEqual(assessDay({ stats: /** @type {any} */ ({ coverage: null }), items: [] }).reasons, ['no_coverage']);
    const o = assessDay({ stats: stats({ D: fc({}) }, { overflow: true }), items: [] });
    assert.equal(o.complete, false);
    assert.ok(o.reasons.includes('day_overflow'));
  });
  test('closedReason maps raw text to a closed code and never echoes raw text', () => {
    assert.equal(closedReason('auth_unavailable'), 'gmail_auth_expired');
    assert.equal(closedReason('config_invalid:bad_query_id:xx'), 'config_invalid');
    assert.equal(closedReason('discovery_http_error'), 'request_failed');
    assert.equal(closedReason('gmail_list_http_500'), 'gmail_unavailable');
    assert.equal(closedReason('sec_blocked'), 'sec_blocked');
    assert.equal(closedReason('ECONNRESET to 10.0.0.1 secret=abc'), 'other');
    assert.equal(closedReason(undefined), 'other');
    for (const r of ['a', 'b c', 'secret token']) assert.ok(CLOSED_REASONS.includes(closedReason(r)));
  });
  test('configHash is stable and order independent for object keys, and sensitive to values', () => {
    assert.equal(configHash({ a: 1, b: [1, 2] }), configHash({ b: [1, 2], a: 1 }));
    assert.notEqual(configHash({ a: 1 }), configHash({ a: 2 }));
    assert.notEqual(configHash({ q: 'x', forms: '8-K' }), configHash({ q: 'x', forms: '8-K,10-K' }));
  });
});

describe('stage timeout arithmetic (D2)', () => {
  const MIN = 60_000;
  test('the smaller of 8 minutes and (scan deadline minus 5 minutes)', () => {
    assert.deepEqual(computeStageTimeout({ scanStartMs: 0, scanTimeoutMs: 90 * MIN, nowMs: 10 * MIN }), { ok: true, timeoutMs: STAGE_MAX_MS });
    assert.deepEqual(computeStageTimeout({ scanStartMs: 0, scanTimeoutMs: 90 * MIN, nowMs: 80 * MIN }), { ok: true, timeoutMs: 5 * MIN }, 'scan deadline 90, now 80, reserve 5 leaves 5 minutes');
    assert.equal(STAGE_RESERVE_MS, 5 * MIN);
  });
  test('no time left is no_time, and a zero, negative, NaN or sub-millisecond result never becomes a timer', () => {
    for (const nowMs of [85 * MIN, 85 * MIN + 1, 90 * MIN, 200 * MIN]) {
      const r = computeStageTimeout({ scanStartMs: 0, scanTimeoutMs: 90 * MIN, nowMs });
      assert.deepEqual(r, { ok: false, reason: 'no_time' }, String(nowMs));
    }
    assert.deepEqual(computeStageTimeout({ scanStartMs: 0, scanTimeoutMs: 90 * MIN, nowMs: 85 * MIN - 0.5 }), { ok: false, reason: 'no_time' });
    assert.deepEqual(computeStageTimeout({ scanStartMs: Number.NaN, scanTimeoutMs: 90 * MIN, nowMs: 0 }), { ok: false, reason: 'no_time' });
    assert.deepEqual(computeStageTimeout({ scanStartMs: 0, scanTimeoutMs: Number.POSITIVE_INFINITY, nowMs: 0, maxMs: 0 }), { ok: false, reason: 'no_time' });
  });
});

describe('stage stats and the digest line (F8)', () => {
  const ran = {
    ran: true, status: 'partial', new_targets: 3, new_needs_review: 2, not_target_week: 40, flags: ['suspicious_empty_released'],
    sources: {
      form_d: { status: 'complete', reason: null, backlog_days: 0 },
      '8k': { status: 'partial', reason: 'run_cap', backlog_days: 4 },
      fts: { status: 'disabled', reason: null, backlog_days: null },
      alerts: { status: 'skipped', reason: 'gmail_auth_expired', backlog_days: null },
      gap: { status: 'complete', reason: null, backlog_days: null },
    },
  };
  test('the line carries counts, per-source status, closed reasons, backlog, and the over-3 flag', () => {
    assert.equal(
      renderTargetsLine(ran),
      'targets: 3 new, 2 new needs-review, 40 not-target this week; form_d complete, 8k partial (run_cap, backlog 4d [OVER 3 DAYS]), alerts skipped (gmail_auth_expired); flags: suspicious_empty_released',
    );
    assert.equal(renderTargetsLine({ ran: true, status: 'ok', sources: { gap: { status: 'partial', reason: 'run_cap', backlog_days: null } } }), 'targets: 0 new, 0 new needs-review, 0 not-target this week; gap partial (run_cap)');
  });
  test('[NO TARGETS RUN] when expected and missing or ran:false, with a closed code only', () => {
    assert.equal(renderTargetsLine(undefined), 'targets: [NO TARGETS RUN]');
    assert.equal(renderTargetsLine({ ran: false, error: 'stage_timeout' }), 'targets: [NO TARGETS RUN] (stage_timeout)');
    assert.equal(renderTargetsLine({ ran: false, skipped: 'already_running' }), 'targets: [NO TARGETS RUN] (already_running)');
    assert.equal(renderTargetsLine({ ran: false, error: 'ECONNRESET at 10.1.2.3 password=hunter2' }), 'targets: [NO TARGETS RUN] (other)', 'raw error text never reaches the digest');
    assert.equal(renderTargetsLine(undefined, { expected: false }), null);
    assert.equal(renderTargetsLine({ ran: false, skipped: 'weekend' }, { expected: false }), null);
  });
  test('a failed run says so; raw flag text is not echoed', () => {
    assert.match(renderTargetsLine({ ran: true, status: 'failed', error: 'exception', sources: {} }) ?? '', /run failed \(exception\)/);
    assert.match(renderTargetsLine({ ran: true, status: 'ok', sources: {}, flags: ['evil <b>'] }) ?? '', /flags: other$/);
  });
  test('targetsExpected: weekday and not dry only', () => {
    assert.equal(targetsExpected({ started_at: '2026-10-15T12:00:00Z', dry_run: false }, 'America/Chicago'), true);
    assert.equal(targetsExpected({ started_at: '2026-10-17T12:00:00Z', dry_run: false }, 'America/Chicago'), false);
    assert.equal(targetsExpected({ started_at: '2026-10-15T12:00:00Z', dry_run: true }, 'America/Chicago'), false);
    assert.equal(targetsExpected({ started_at: 'garbage' }, 'America/Chicago'), false);
  });
  test('the subject carries the flag: no run first, else attention, else nothing', () => {
    const base = /** @type {any} */ ({ dayKey: '2026-10-15', runs: [], worstStatus: 'ok', lookAtThese: { rows: [] }, reviewQueue: { total: 0 } });
    assert.match(buildReportSubject({ ...base, noTargetsRun: true, targetsAttention: true }), /^\[NO TARGETS RUN\] Job scan report/);
    assert.match(buildReportSubject({ ...base, targetsAttention: true }), /^\[TARGETS PARTIAL\] Job scan report/);
    assert.doesNotMatch(buildReportSubject(base), /TARGETS/);
  });
  test('toStageStats keeps only closed codes and whitelisted flags', () => {
    const s = /** @type {any} */ (toStageStats({
      status: 'partial', run_id: 7, attention: true, flags: ['fts_q1:config_reset', 'window_14d', 'junk'],
      counts: { new_targets: 1, new_needs_review: 2, not_target_week: 3 },
      sources: { alerts: { status: 'skipped', reason: 'auth_unavailable', backlog_days: null, flags: ['x'] } },
    }));
    assert.equal(s.ran, true);
    assert.deepEqual(s.flags, ['config_reset']);
    assert.equal(s.sources.alerts.reason, 'gmail_auth_expired');
    assert.deepEqual(toStageStats({ status: 'skipped', skipped: 'already_running', run_id: 3 }), { ran: false, skipped: 'already_running', run_id: 3 });
    assert.deepEqual(toStageStats(null), { ran: false, error: 'stage_failed' });
  });
});

describe('bin/targets.js arguments', () => {
  test('parses --source and --dry-run; rejects an unknown source or argument visibly', () => {
    assert.deepEqual(parseArgs(['--source', 'form_d', '--dry-run']), { source: 'form_d', dryRun: true, help: false, error: null });
    assert.match(parseArgs(['--source', 'bogus']).error ?? '', /--source must be one of/);
    assert.match(parseArgs(['--source']).error ?? '', /--source must be one of/);
    assert.match(parseArgs(['--wat']).error ?? '', /unknown argument/);
    assert.equal(parseArgs([]).source, null);
  });
  test('exit codes: ok and skipped 0, partial 2, anything else 1', () => {
    assert.deepEqual(['ok', 'skipped', 'partial', 'failed', undefined].map((status) => exitCodeFor({ status })), [0, 0, 2, 1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Adapter changes
// ---------------------------------------------------------------------------------------------------------

/** @param {import('./helpers/targets-replay.js').Route[]} routes */
function mk(routes) {
  const replay = createReplayFetch(routes);
  const ft = fastTiming();
  const edgar = createEdgarClient({ guard: createFetchGuard({ fetch: replay.fetch, userAgent: UA }), timing: ft.timing });
  return { edgar, calls: replay.calls };
}

describe('adapter window, covered, and all-names exclusion (D5)', () => {
  const rules = RULES;
  test('Form D: window override sets startdt = enddt; a covered accession makes no document request', async () => {
    const hit = { adsh: '0001234567-26-000042', ciks: ['0001234567'], display_names: ['Northwind Logistics Inc  (CIK 0001234567)'], file_date: '2026-10-13', form: 'D' };
    const { edgar, calls } = mk([
      { match: /search-index\?.*forms=D&/, body: searchJson([hit]) },
      { match: /forms=D%2FA/, body: searchJson([]) },
    ]);
    const out = await runFormD({ edgar, now: NOW, rules, blocked: [...BUILT_IN_BLOCKED], window: { start: '2026-10-13', end: '2026-10-13' }, covered: (adsh) => adsh === hit.adsh });
    assert.equal(out.items.length, 0, 'covered accessions are skipped, not re-fetched');
    assert.equal(out.stats.extra.covered_skip, 1);
    assert.equal(calls.filter((c) => c.url.includes('primary_doc')).length, 0);
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('startdt'), '2026-10-13');
    assert.equal(u.searchParams.get('enddt'), '2026-10-13');
  });

  test('Form D: a blocked name that is only the SIXTH display name is still excluded; storage stays capped at five', async () => {
    const names = ['Zeta One Inc', 'Zeta Two Inc', 'Zeta Three Inc', 'Zeta Four Inc', 'Zeta Five Inc', `${BUILT_IN_BLOCKED[1]} Capital Partners`];
    const hit = { adsh: '0001234567-26-000043', ciks: ['0001234567'], display_names: names.map((n) => `${n}  (CIK 0001234567)`), file_date: '2026-10-13', form: 'D', sics: ['7372'] };
    const { edgar } = mk([
      { match: /forms=D&/, body: searchJson([hit]) },
      { match: /forms=D%2FA/, body: searchJson([]) },
      { match: /primary_doc\.xml/, body: formDXml({ name: 'Zeta One Inc', cik: '0001234567' }) },
      { match: /submissions/, status: 404, body: '' },
    ]);
    const out = await runFormD({ edgar, now: NOW, rules, blocked: [...BUILT_IN_BLOCKED] });
    const it = out.items[0];
    assert.equal(it.outcome, 'parsed');
    assert.deepEqual(it.extracted.display_names, names.slice(0, 5).map((n) => `${n} (CIK 0001234567)`), 'only five are stored');
    assert.ok(it.extracted.blocked_hits.length > 0, 'but the sixth was scanned');
    const v = classifySignal(it.signal, { rules: RULES, now: NOW, blocked: OK_LIST });
    assert.notEqual(v.class, 'target');
    assert.match(v.rule, /^excl_blocked/);
  });

  test('8-K: a blocked name that is only the ELEVENTH display name is still excluded; storage stays capped at ten', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Co Filer ${i} Inc`).concat([`${BUILT_IN_BLOCKED[1]} Holdings`]);
    const hit = { _id: '0001111111-26-000101:form8k.htm', adsh: '0001111111-26-000101', ciks: ['0001111111'], display_names: names.map((n) => `${n}  (CIK 0001111111)`), file_date: '2026-10-13', form: '8-K', file_type: '8-K', items: ['5.02'] };
    const { edgar } = mk([
      { match: /forms=8-K&/, body: searchJson([hit]) },
      { match: /forms=8-K%2FA/, body: searchJson([]) },
      { match: /form8k\.htm/, body: fixture('edgar_8k/departure.htm') },
    ]);
    const out = await run8k({ edgar, now: NOW, blocked: [...BUILT_IN_BLOCKED] });
    const it = out.items[0];
    assert.equal(it.outcome, 'parsed');
    assert.equal(it.extracted.display_names.length, 10);
    assert.ok(it.extracted.blocked_hits.length > 0);
    const v = classifySignal(it.signal, { rules: RULES, now: NOW, blocked: OK_LIST });
    assert.match(v.rule, /^excl_blocked/);
  });

  test('FTS: a blocked name that is only the ELEVENTH display name is still excluded', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Co Filer ${i} Inc`).concat([`${BUILT_IN_BLOCKED[1]} Holdings`]);
    const hit = { _id: '0001111111-26-000102:doc.htm', adsh: '0001111111-26-000102', ciks: ['0001111111'], display_names: names.map((n) => `${n}  (CIK 0001111111)`), file_date: '2026-10-13', form: '8-K', file_type: '8-K' };
    const { edgar } = mk([
      { match: /forms=8-K&/, body: searchJson([hit]) },
      { match: /forms=8-K%2FA/, body: searchJson([]) },
      { match: /doc\.htm/, body: '<html><body>The company was acquired by Harbor Capital Partners in a merger.</body></html>' },
    ]);
    const out = await runFts({ edgar, now: NOW, blocked: [...BUILT_IN_BLOCKED], queries: [{ id: 'q', priority: 1, q: 'acquired', forms: '8-K', trigger_kind: 'pe_deal', window_days: 30, enabled: true }] });
    const it = out.items[0];
    assert.equal(it.outcome, 'parsed');
    assert.ok(it.extracted.blocked_hits.length > 0);
    assert.match(classifySignal(it.signal, { rules: RULES, now: NOW, blocked: OK_LIST }).rule, /^excl_blocked/);
  });
});

describe('invalid-filename hit documents (D6)', () => {
  test('chooseDocs counts an invalid filename; the 3-per-accession cap does not', () => {
    const hit = (/** @type {string} */ filename, /** @type {string} */ type) => /** @type {any} */ ({ adsh: 'a', form: '8-K', filename, file_type: type });
    const bad = chooseDocs([hit('ok1.htm', '8-K'), hit('../evil.htm', 'EX-99.1')]);
    assert.equal(bad.invalid, 1);
    assert.equal(bad.chosen.length, 1);
    const capped = chooseDocs([hit('a.htm', '8-K'), hit('b.htm', 'EX-99.1'), hit('c.htm', 'EX-99.2'), hit('d.htm', 'EX-10')]);
    assert.deepEqual([capped.invalid, capped.unread, capped.chosen.length], [0, 1, 3]);
  });
  test('fetchStatusWithInvalid: ok becomes partial; partial and failed are unchanged', () => {
    assert.equal(fetchStatusWithInvalid('ok', 1), 'partial');
    assert.equal(fetchStatusWithInvalid('ok', 0), 'ok');
    assert.equal(fetchStatusWithInvalid('failed', 2), 'failed');
    assert.equal(fetchStatusWithInvalid('partial', 1), 'partial');
  });
  test('8-K: an invalid hit filename counts in unread_hit_docs and makes the filing needs-review; the cap alone does not', async () => {
    const mkHit = (/** @type {string} */ id, /** @type {string} */ type) => ({ _id: id, adsh: '0001111111-26-000101', ciks: ['0001111111'], display_names: ['Contoso Industrial Corp  (CIK 0001111111)'], file_date: '2026-10-13', form: '8-K', file_type: type, items: ['5.02'] });
    const routes = (/** @type {any[]} */ hits) => [
      { match: /forms=8-K&/, body: searchJson(hits) },
      { match: /forms=8-K%2FA/, body: searchJson([]) },
      { match: /form8k\.htm/, body: fixture('edgar_8k/departure.htm') },
      { match: /ex\d+\.htm/, body: '<html><body>exhibit</body></html>' },
    ];
    const withInvalid = await run8k({ edgar: mk(routes([mkHit('0001111111-26-000101:form8k.htm', '8-K'), mkHit('0001111111-26-000101:..%2Fevil.htm', 'EX-99.1')])).edgar, now: NOW, blocked: [...BUILT_IN_BLOCKED] });
    const a = withInvalid.items[0];
    assert.equal(a.extracted.doc_fetch, 'partial');
    assert.equal(a.extracted.unread_hit_docs, 1);
    assert.equal(a.signal?.doc_fetch, 'partial');
    assert.equal(classifySignal(a.signal, { rules: RULES, now: NOW, blocked: OK_LIST }).rule, 'doc_fetch_failed_partial');
    const capOnly = await run8k({ edgar: mk(routes([mkHit('0001111111-26-000101:form8k.htm', '8-K'), mkHit('0001111111-26-000101:ex991.htm', 'EX-99.1'), mkHit('0001111111-26-000101:ex992.htm', 'EX-99.2'), mkHit('0001111111-26-000101:ex993.htm', 'EX-99.3')])).edgar, now: NOW, blocked: [...BUILT_IN_BLOCKED] });
    const b = capOnly.items[0];
    assert.equal(b.extracted.doc_fetch, 'ok');
    assert.equal(b.extracted.unread_hit_docs, 1, 'informational only');
    assert.notEqual(classifySignal(b.signal, { rules: RULES, now: NOW, blocked: OK_LIST }).rule, 'doc_fetch_failed_partial');
  });
});

describe('discovery coverage: distinct hits versus the final total', () => {
  test('a short page whose total is larger is partial; equal is complete; a page past the cap flags overflow', async () => {
    const page = (/** @type {number} */ n, /** @type {number} */ from) => searchJson(Array.from({ length: n }, (_, i) => ({ adsh: `0000000001-26-${String(from + i + 1).padStart(6, '0')}`, ciks: ['1'], display_names: ['X  (CIK 1)'], file_date: '2026-10-13', form: 'D' })), 250);
    const run = async (/** @type {string} */ body, /** @type {number} */ maxPages) => {
      const { edgar } = mk([{ match: () => true, body }]);
      return discoverByForm({ edgar, forms: ['D'], params: { dateRange: 'custom' }, budget: 'discovery_form_d', maxPages });
    };
    const short = await run(page(40, 0), 5);
    assert.equal(short.coverage.forms.D.status, 'partial', '40 hits seen, 250 reported');
    assert.equal(short.coverage.forms.D.distinct, 40);
    const eq = await run(searchJson([{ adsh: '0000000001-26-000001', ciks: ['1'], display_names: ['X  (CIK 1)'], file_date: '2026-10-13', form: 'D' }], 1), 5);
    assert.equal(eq.coverage.forms.D.status, 'complete');
    assert.equal(eq.overflow, false);
    const full = await run(page(100, 0), 1);
    assert.equal(full.overflow, true, 'one page of 100 cannot hold a total of 250');
  });
});
