// @ts-check
/**
 * The target finder stage of the scan (PR3, plan 17.3 and 17.5), against the isolated "_test" database.
 * Covers the stage in isolation (timeout, throw, no time, weekend, test guard, the ran:false marker at start),
 * the scan integration (a throwing or hanging stage leaves the scan status and exit data untouched), and the
 * report (still built, with the flag and the closed code, and never the raw error text). No network, no
 * shell, no browser; the "runner" the stage drives is a stub in every case but one.
 */
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runTargetsStage } from '../src/targets/stage.js';
import { buildScanReport, buildReportSubject, renderReportText, renderReportMarkdown, renderReportHtml } from '../src/core/report.js';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, makeFixtureFetch, DEFAULT_MAP, FIXTURE_NOW } from './helpers/scan-fixtures.js';

const PID = process.pid;
const PROFILE = `zz-test-tgstage-${PID}`;
/** Wednesday 2026-10-14 10:00 ET. */
const WEEKDAY = new Date('2026-10-14T14:00:00Z');
const SATURDAY = new Date('2026-10-17T14:00:00Z');
/** @type {import('pg').Client} */
let client;
/** @type {import('pg').Client[]} */
const opened = [];

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
});
after(async () => {
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  for (const c of opened) await c.end().catch(() => {});
  await client.end();
});

/** A scan row to write stats.targets into. */
async function scanRow() {
  const r = await client.query(
    `INSERT INTO ic_scan_runs (profile, trigger, status, started_at, finished_at, stats) VALUES ($1, 'cli', 'ok', $2, now(), '{"fetched":1}'::jsonb) RETURNING id`,
    [PROFILE, WEEKDAY],
  );
  return Number(r.rows[0].id);
}
/** @param {number} id */
async function targetsStats(id) {
  return (await client.query('SELECT stats->\'targets\' AS t, status FROM ic_scan_runs WHERE id = $1', [id])).rows[0];
}
const connect = async () => {
  const c = await newClient();
  opened.push(c);
  return c;
};
/** Record every timer delay so a test can prove no zero or negative timeout ever reached a timer. */
function spyTimers() {
  /** @type {number[]} */
  const delays = [];
  const orig = globalThis.setTimeout;
  const m = mock.method(globalThis, 'setTimeout', /** @type {any} */ ((/** @type {any} */ fn, /** @type {any} */ ms, /** @type {any[]} */ ...rest) => {
    delays.push(Number(ms));
    return orig(fn, ms, ...rest);
  }));
  return { delays, restore: () => m.mock.restore() };
}
const base = (/** @type {number} */ runId, /** @type {any} */ extra = {}) => ({
  connect, now: WEEKDAY, runId, scanStartMs: 1_000_000, scanTimeoutMs: 45 * 60_000, nowMs: 1_000_000 + 60_000, fetch: /** @type {any} */ (async () => new Response('')), ...extra,
});

describe('the stage in isolation', () => {
  test('a hung runner hits the hard timeout: ran:false with stage_timeout, written to the scan row, the runner is aborted', async () => {
    const id = await scanRow();
    /** @type {AbortSignal|undefined} */
    let seen;
    const spy = spyTimers();
    const t0 = Date.now();
    try {
      const out = await runTargetsStage(/** @type {any} */ (base(id, {
        maxStageMs: 40, graceMs: 20,
        runTargetsImpl: (/** @type {any} */ deps) => { seen = deps.signal; return new Promise(() => {}); },
      })));
      assert.deepEqual(out, { ran: false, error: 'stage_timeout' });
      assert.ok(Date.now() - t0 < 5000, 'returned promptly');
      assert.equal(seen?.aborted, true, 'the runner is told to stop');
      assert.ok(spy.delays.every((d) => d > 0), `no zero or negative timer: ${spy.delays}`);
    } finally {
      spy.restore();
    }
    assert.deepEqual((await targetsStats(id)).t, { ran: false, error: 'stage_timeout' });
  });

  test('a throwing runner is stage_failed, never an exception to the caller, and the error text is not kept', async () => {
    const id = await scanRow();
    const out = await runTargetsStage(/** @type {any} */ (base(id, { runTargetsImpl: async () => { throw new Error('boom secret=hunter2'); } })));
    assert.deepEqual(out, { ran: false, error: 'stage_failed' });
    assert.deepEqual((await targetsStats(id)).t, { ran: false, error: 'stage_failed' });
  });

  test('a throwing connect is stage_failed too', async () => {
    const id = await scanRow();
    const out = await runTargetsStage(/** @type {any} */ (base(id, { connect: async () => { throw new Error('db down'); } })));
    assert.deepEqual(out, { ran: false, error: 'stage_failed' });
  });

  test('no time left skips with no_time, writes the skip, and starts no timer at all', async () => {
    const id = await scanRow();
    const spy = spyTimers();
    try {
      const out = await runTargetsStage(/** @type {any} */ (base(id, {
        scanStartMs: 0, scanTimeoutMs: 45 * 60_000, nowMs: 41 * 60_000,
        runTargetsImpl: async () => { throw new Error('must not run'); },
      })));
      assert.deepEqual(out, { ran: false, skipped: 'no_time' });
      // PR5b: the connect that records no_time carries its own bound, but no stage deadline timer is started.
      assert.ok(spy.delays.every((d) => d > 0), 'zero or negative never reaches a timer');
      assert.ok(spy.delays.every((d) => d <= 10_000), 'only the bounded connect timer, never a stage deadline');
    } finally {
      spy.restore();
    }
    assert.deepEqual((await targetsStats(id)).t, { ran: false, skipped: 'no_time' });
  });

  test('weekend: skipped without even connecting; under a test runner with no injected fetch: test_guard', async () => {
    const id = await scanRow();
    let connected = 0;
    const out = await runTargetsStage(/** @type {any} */ (base(id, { now: SATURDAY, connect: async () => { connected += 1; return connect(); } })));
    assert.deepEqual(out, { ran: false, skipped: 'weekend' });
    assert.equal(connected, 0);
    const guarded = await runTargetsStage(/** @type {any} */ ({ ...base(id), fetch: undefined, connect: async () => { connected += 1; return connect(); } }));
    assert.deepEqual(guarded, { ran: false, skipped: 'test_guard' });
    assert.equal(connected, 1, 'one short-lived database connection to persist the skip (A8); no network');
    assert.deepEqual((await targetsStats(id)).t, { ran: false, skipped: 'test_guard' });
  });

  test('ran:false is written when the stage starts, and replaced by the result at the end', async () => {
    const id = await scanRow();
    /** @type {any} */
    let during;
    const out = await runTargetsStage(/** @type {any} */ (base(id, {
      runTargetsImpl: async () => {
        during = (await targetsStats(id)).t;
        return {
          status: 'partial', run_id: 9, attention: true, flags: ['config_reset'], counts: { new_targets: 2, new_needs_review: 1, not_target_week: 5 },
          sources: { form_d: { status: 'complete', reason: null, backlog_days: 0 }, '8k': { status: 'partial', reason: 'run_cap', backlog_days: 5 } },
        };
      },
    })));
    assert.deepEqual(during, { ran: false, state: 'started' });
    assert.equal(/** @type {any} */ (out).ran, true);
    assert.equal(/** @type {any} */ (out).new_targets, 2);
    assert.deepEqual((await targetsStats(id)).t, out);
  });

  test('a lost advisory lock comes back as ran:false with already_running', async () => {
    const id = await scanRow();
    const out = await runTargetsStage(/** @type {any} */ (base(id, { runTargetsImpl: async () => ({ status: 'skipped', skipped: 'already_running', run_id: 4 }) })));
    assert.deepEqual(out, { ran: false, skipped: 'already_running', run_id: 4 });
  });
});

describe('the scan integration: the stage can never change the scan', () => {
  const ZZ_MAP = DEFAULT_MAP.filter((m) => m.prefix.includes('zztest') || m.prefix.includes('/gitlab/'));
  const args = () => ({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true });

  test('a throwing stage leaves status and rows alone; stats.targets carries the closed code', async () => {
    const calls = { n: 0 };
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP), runTargetsStage: /** @type {any} */ (async () => { calls.n += 1; throw new Error('kaboom'); }) });
    const r = await runScanWaiting(args(), deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(calls.n, 1);
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.deepEqual(r.stats.targets, { ran: false, error: 'stage_failed' });
    const row = await client.query('SELECT status, finished_at FROM ic_scan_runs WHERE id = $1', [r.run_id]);
    assert.equal(row.rows[0].status, 'ok');
    assert.ok(row.rows[0].finished_at);
  });

  test('a hanging stage times out; the scan finishes ok, and the report is still built and flags [NO TARGETS RUN]', async () => {
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      runTargetsStage: /** @type {any} */ ((/** @type {any} */ p) => runTargetsStage({
        ...p, fetch: async () => new Response(''), maxStageMs: 40, graceMs: 20, nowMs: p.scanStartMs + 1000, runTargetsImpl: () => new Promise(() => {}),
      })),
    });
    const t0 = Date.now();
    const r = await runScanWaiting(args(), deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.ok(Date.now() - t0 < 60_000);
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.deepEqual(r.stats.targets, { ran: false, error: 'stage_timeout' });
    assert.equal((await targetsStats(r.run_id)).status, 'ok');
    assert.deepEqual((await targetsStats(r.run_id)).t, { ran: false, error: 'stage_timeout' });

    // The report is built from the database, so it exists regardless; pin the run to a known weekday.
    await client.query(`UPDATE ic_scan_runs SET started_at = $2, finished_at = now() WHERE id = $1`, [r.run_id, WEEKDAY]);
    const data = await buildScanReport(client, { now: WEEKDAY, timezone: 'America/Chicago', sinceOverride: null });
    assert.equal(data.runs.at(-1)?.run_id, r.run_id);
    assert.equal(/** @type {any} */ (data).noTargetsRun, true);
    assert.match(buildReportSubject(data), /^\[NO TARGETS RUN\] /);
    for (const text of [renderReportText(data), renderReportMarkdown(data), renderReportHtml(data)]) {
      assert.match(text, /targets: \[NO TARGETS RUN\] \(stage_timeout\)/);
    }
  });

  test('A8: the real stage under a test runner with no injected fetch persists test_guard on the scan row, with the skipped key and no reason key', async () => {
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) });
    const r = await runScanWaiting(args(), deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.deepEqual(r.stats.targets, { ran: false, skipped: 'test_guard' });
    const stored = (await targetsStats(r.run_id)).t;
    assert.deepEqual(stored, { ran: false, skipped: 'test_guard' });
    assert.equal('reason' in stored, false);
    await client.query(`UPDATE ic_scan_runs SET started_at = $2, finished_at = now() WHERE id = $1`, [r.run_id, WEEKDAY]);
    const data = await buildScanReport(client, { now: WEEKDAY, timezone: 'America/Chicago', sinceOverride: null });
    for (const text of [renderReportText(data), renderReportMarkdown(data), renderReportHtml(data)]) assert.match(text, /targets: \[NO TARGETS RUN\] \(test_guard\)/);
    assert.match(buildReportSubject(data), /^\[NO TARGETS RUN\] /);
  });

  test('A8: a connect failure and no_time both come back with the existing error / skipped keys, persisted by the scan', async () => {
    const wrap = (/** @type {any} */ over) => offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      runTargetsStage: /** @type {any} */ ((/** @type {any} */ p) => runTargetsStage({ ...p, fetch: async () => new Response(''), ...over(p) })),
    });
    const failed = await runScanWaiting(args(), wrap(() => ({ connect: async () => { throw new Error('db down'); } })), { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.deepEqual(failed.stats.targets, { ran: false, error: 'stage_failed' });
    assert.deepEqual((await targetsStats(failed.run_id)).t, { ran: false, error: 'stage_failed' });

    const spy = spyTimers();
    try {
      const late = await runScanWaiting(args(), wrap((/** @type {any} */ p) => ({ scanTimeoutMs: 1, nowMs: p.scanStartMs + 60 * 60_000 })), { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
      assert.deepEqual(late.stats.targets, { ran: false, skipped: 'no_time' });
      const row = (await targetsStats(late.run_id)).t;
      assert.deepEqual(row, { ran: false, skipped: 'no_time' });
      assert.equal('reason' in row, false);
    } finally {
      spy.restore();
    }
  });

  test('a dry-run scan never calls the stage', async () => {
    const calls = { n: 0 };
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP), runTargetsStage: /** @type {any} */ (async () => { calls.n += 1; return { ran: true }; }) });
    const r = await runScanWaiting({ ...args(), dryRun: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.notEqual(r.status, 'failed');
    assert.equal(calls.n, 0);
  });
});

describe('the report', () => {
  /** @param {string} started @param {any} stats @param {boolean} [dry] */
  async function reportFor(started, stats, dry = false) {
    await client.query('DELETE FROM ic_scan_runs WHERE profile = $1', [PROFILE]);
    await client.query(
      `INSERT INTO ic_scan_runs (profile, trigger, status, started_at, finished_at, stats, dry_run) VALUES ($1, 'cli', 'ok', $2, now(), $3::jsonb, $4)`,
      [PROFILE, started, JSON.stringify(stats), dry],
    );
    return buildScanReport(client, { now: new Date(started), timezone: 'America/Chicago', sinceOverride: null });
  }

  test('a stage that ran with a skipped source: the line, the closed reason, and the [TARGETS PARTIAL] subject flag', async () => {
    const data = await reportFor('2026-10-14T14:00:00Z', {
      targets: {
        ran: true, status: 'partial', attention: true, new_targets: 4, new_needs_review: 1, not_target_week: 12, flags: [],
        sources: { form_d: { status: 'complete', reason: null, backlog_days: 0 }, alerts: { status: 'skipped', reason: 'gmail_auth_expired', backlog_days: null } },
      },
    });
    assert.equal(/** @type {any} */ (data).noTargetsRun, false);
    assert.equal(/** @type {any} */ (data).targetsAttention, true);
    assert.match(buildReportSubject(data), /^\[TARGETS PARTIAL\] /);
    assert.match(renderReportText(data), /targets: 4 new, 1 new needs-review, 12 not-target this week; form_d complete, alerts skipped \(gmail_auth_expired\)/);
  });

  test('A8: a stage that wrote its started marker and never a result renders as the closed code crashed', async () => {
    const data = await reportFor('2026-10-14T14:00:00Z', { targets: { ran: false, state: 'started' } });
    assert.equal(/** @type {any} */ (data).noTargetsRun, true);
    assert.match(buildReportSubject(data), /^\[NO TARGETS RUN\] /);
    for (const text of [renderReportText(data), renderReportMarkdown(data), renderReportHtml(data)]) assert.match(text, /targets: \[NO TARGETS RUN\] \(crashed\)/);
    for (const [stats, code] of [[{ ran: false, skipped: 'test_guard' }, 'test_guard'], [{ ran: false, skipped: 'no_time' }, 'no_time'], [{ ran: false, error: 'stage_failed' }, 'stage_failed'], [{ ran: false, error: 'stage_timeout' }, 'stage_timeout']]) {
      const d = await reportFor('2026-10-14T14:00:00Z', { targets: stats });
      assert.match(renderReportText(d), new RegExp(`targets: \\[NO TARGETS RUN\\] \\(${code}\\)`));
    }
    const raw = await reportFor('2026-10-14T14:00:00Z', { targets: { ran: false, error: 'connect to postgres://user:secret@host failed' } });
    assert.match(renderReportText(raw), /targets: \[NO TARGETS RUN\] \(other\)/, 'raw error text never reaches the digest');
    assert.doesNotMatch(renderReportText(raw), /secret/);
  });

  test('a clean stage adds no flag', async () => {
    const data = await reportFor('2026-10-14T14:00:00Z', { targets: { ran: true, status: 'ok', attention: false, new_targets: 0, new_needs_review: 0, not_target_week: 0, sources: {} } });
    assert.doesNotMatch(buildReportSubject(data), /TARGETS/);
  });

  test('a weekday scan with no targets stats at all is [NO TARGETS RUN]; a weekend scan and a dry-run scan are not', async () => {
    const weekday = await reportFor('2026-10-14T14:00:00Z', { fetched: 1 });
    assert.match(buildReportSubject(weekday), /^\[NO TARGETS RUN\] /);
    assert.match(renderReportText(weekday), /targets: \[NO TARGETS RUN\]/);
    const weekend = await reportFor('2026-10-17T14:00:00Z', { fetched: 1 });
    assert.doesNotMatch(buildReportSubject(weekend), /TARGETS/);
    assert.doesNotMatch(renderReportText(weekend), /NO TARGETS RUN/);
    const dry = await reportFor('2026-10-14T14:00:00Z', { fetched: 1 }, true);
    assert.doesNotMatch(buildReportSubject(dry), /TARGETS/);
  });
});

describe('the draft stage in the scan (PR5, plan 19.2)', () => {
  const ZZ_MAP = DEFAULT_MAP.filter((m) => m.prefix.includes('zztest') || m.prefix.includes('/gitlab/'));
  const args = () => ({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true });

  test('the stage result rides in stats.target_drafts, is persisted, and renders as the drafts clause; stats.targets keeps its shape', async () => {
    const calls = { n: 0 };
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      runTargetDraftStage: /** @type {any} */ (async (/** @type {any} */ p) => { calls.n += 1; assert.equal(typeof p.connect, 'function'); assert.equal(typeof p.scanStartMs, 'number'); return { ran: true, awaiting: 2, parked: 1, claimed: 3 }; }),
    });
    const r = await runScanWaiting(args(), deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(calls.n, 1);
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.deepEqual(r.stats.targets, { ran: false, skipped: 'test_guard' }, 'the targets stats are untouched');
    assert.deepEqual(r.stats.target_drafts, { ran: true, awaiting: 2, parked: 1, claimed: 3 });
    const stored = (await client.query('SELECT stats->\'target_drafts\' AS d FROM ic_scan_runs WHERE id = $1', [r.run_id])).rows[0].d;
    assert.deepEqual(stored, { ran: true, awaiting: 2, parked: 1, claimed: 3 });
    await client.query(`UPDATE ic_scan_runs SET started_at = $2, finished_at = now() WHERE id = $1`, [r.run_id, WEEKDAY]);
    const data = await buildScanReport(client, { now: WEEKDAY, timezone: 'America/Chicago', sinceOverride: null });
    for (const text of [renderReportText(data), renderReportMarkdown(data), renderReportHtml(data)]) assert.match(text, /targets: \[NO TARGETS RUN\] \(test_guard\); drafts: 2 awaiting, 1 parked/);
  });

  test('a throwing draft stage never changes the scan: status ok, no target_drafts stat, targets stats untouched', async () => {
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP), runTargetDraftStage: /** @type {any} */ (async () => { throw new Error('kaboom'); }) });
    const r = await runScanWaiting(args(), deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.equal('target_drafts' in r.stats, false);
    assert.deepEqual(r.stats.targets, { ran: false, skipped: 'test_guard' });
    assert.equal((await client.query('SELECT status FROM ic_scan_runs WHERE id = $1', [r.run_id])).rows[0].status, 'ok');
  });

  test('the real draft stage under a test runner with no injected model skips with test_guard (a test can never start claude)', async () => {
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP) });
    const r = await runScanWaiting(args(), deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.deepEqual(r.stats.target_drafts, { ran: false, skipped: 'test_guard' });
  });

  test('a dry-run scan never calls the draft stage', async () => {
    const calls = { n: 0 };
    const deps = offlineDeps({ fetch: makeFixtureFetch(ZZ_MAP), runTargetDraftStage: /** @type {any} */ (async () => { calls.n += 1; return { ran: true }; }) });
    const r = await runScanWaiting({ ...args(), dryRun: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.notEqual(r.status, 'failed');
    assert.equal(calls.n, 0);
  });

  test('the draft stage still runs when the targets stage failed (they are independent)', async () => {
    const calls = { n: 0 };
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      runTargetsStage: /** @type {any} */ (async () => { throw new Error('boom'); }),
      runTargetDraftStage: /** @type {any} */ (async () => { calls.n += 1; return { ran: false, skipped: 'facts_missing' }; }),
    });
    const r = await runScanWaiting(args(), deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.equal(calls.n, 1);
    assert.deepEqual(r.stats.targets, { ran: false, error: 'stage_failed' });
    assert.deepEqual(r.stats.target_drafts, { ran: false, skipped: 'facts_missing' });
  });
});
