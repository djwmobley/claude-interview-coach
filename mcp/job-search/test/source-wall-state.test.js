// @ts-check
/**
 * Why a source is off: sql/028 (idempotent, no backfill), wall.js recordWall / reenableSource (one atomic
 * statement, capped history, dry-run refusal), and source-state.js (the sentence every surface shows).
 * Runs against the shared bootstrapped test database; every row uses a zz-test source name.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { AUX_MIGRATIONS } from '../src/core/schema.js';
import { MIGRATIONS as BOOTSTRAP_MIGRATIONS } from '../bin/bootstrap-test-db.js';
import { recordWall, reenableSource, backoffFor, WALL_HISTORY_MAX } from '../src/browser/wall.js';
import { describeDisabledSource, countedWalls, collectDisabledSourceStates } from '../src/core/source-state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = '028_source_wall_reason.sql';
const SQL = fs.readFileSync(path.join(HERE, '..', 'sql', FILE), 'utf8');
const TAG = `zz-test-wallstate-${process.pid}`;
const DAY = 86400000;
/** @type {pg.Client} */
let client;
let seq = 0;
/** A fresh source name per test so tests never share a row. */
const fresh = () => `${TAG}-${++seq}`;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
});
after(async () => {
  await client.query('DELETE FROM ic_source_state WHERE source LIKE $1', [`${TAG}%`]);
  await client.end();
});

/** @param {string} source */
async function row(source) {
  return (await client.query('SELECT * FROM ic_source_state WHERE source = $1', [source])).rows[0];
}

describe('sql/028_source_wall_reason.sql', () => {
  test('registered in bin/migrate.js, schema.js AUX_MIGRATIONS and bootstrap-test-db.js, after 027', () => {
    const migrateSrc = fs.readFileSync(path.join(HERE, '..', 'bin', 'migrate.js'), 'utf8');
    assert.ok(migrateSrc.includes(`'${FILE}'`));
    assert.ok(AUX_MIGRATIONS.includes(FILE));
    assert.ok(BOOTSTRAP_MIGRATIONS.includes(FILE));
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) < AUX_MIGRATIONS.indexOf('029_mail_intake.sql'), 'later migrations come after 028');
    assert.ok(AUX_MIGRATIONS.indexOf(FILE) > AUX_MIGRATIONS.indexOf('027_target_drafts.sql'));
  });

  test('applying it twice more is safe, adds the seven columns, and nullability is as specified', async () => {
    await client.query(SQL);
    await client.query(SQL);
    const cols = (await client.query(`SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'ic_source_state'`)).rows;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    for (const c of ['last_wall_kind', 'last_wall_detail', 'last_wall_url', 'last_wall_snapshot', 'last_wall_run_id', 'reset_at']) {
      assert.equal(byName[c]?.is_nullable, 'YES', c);
    }
    assert.equal(byName.wall_history.is_nullable, 'NO');
    assert.equal(byName.wall_history.data_type, 'jsonb');
    assert.equal(byName.reset_at.data_type, 'timestamp with time zone');
  });

  test('no backfill: a row written before the migration keeps NULL reasons and an empty history after it runs again', async () => {
    const s = fresh();
    await client.query(`INSERT INTO ic_source_state (source, consecutive_walls, manual_disable) VALUES ($1, 3, true)`, [s]);
    await client.query(SQL);
    const r = await row(s);
    assert.equal(r.last_wall_kind, null);
    assert.equal(r.reset_at, null);
    assert.deepEqual(r.wall_history, []);
    assert.equal(r.manual_disable, true);
    assert.equal(r.consecutive_walls, 3);
  });
});

describe('recordWall', () => {
  test('first wall stores the reason, the 24 h backoff and a one-entry history; the snapshot is a basename', async () => {
    const s = fresh();
    const now = new Date(Date.now() - 10 * DAY);
    const w = await recordWall(client, s, now, { kind: 'unhydrated_after_retry', detail: 'no_cards_no_shell_after_reload after one reload', url: 'https://www.linkedin.com/jobs/search/', snapshot: 'C:\\logs\\linkedin-snapshots\\2165-abc-p1.html', runId: 2165 });
    assert.deepEqual(w, { consecutiveWalls: 1, hours: 24, manual: false });
    const r = await row(s);
    assert.equal(r.consecutive_walls, 1);
    assert.equal(r.manual_disable, false);
    assert.equal(new Date(r.disabled_until).getTime(), now.getTime() + DAY);
    assert.equal(r.last_wall_kind, 'unhydrated_after_retry');
    assert.equal(r.last_wall_snapshot, '2165-abc-p1.html');
    assert.equal(String(r.last_wall_run_id), '2165');
    assert.equal(r.wall_history.length, 1);
    assert.equal(r.wall_history[0].kind, 'unhydrated_after_retry');
    assert.equal(r.wall_history[0].snapshot, '2165-abc-p1.html');
    assert.equal(new Date(r.wall_history[0].at).getTime(), now.getTime());
    assert.match(r.wall_history[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/, 'microsecond precision');
  });

  test('a path-shaped snapshot is reduced to its last segment; a non-numeric run id is dropped', async () => {
    const s = fresh();
    await recordWall(client, s, new Date(), { kind: 'k', snapshot: '../../etc/passwd', runId: 'abc' });
    const r = await row(s);
    assert.equal(r.last_wall_snapshot, 'passwd');
    assert.equal(r.last_wall_run_id, null);
  });

  test('the backoff written by the single statement matches backoffFor() for walls 1 to 5', async () => {
    const s = fresh();
    const now = new Date(Date.now() - 5 * DAY);
    for (let n = 1; n <= 5; n++) {
      const w = await recordWall(client, s, now, { kind: 'k' });
      const r = await row(s);
      const b = backoffFor(n);
      assert.equal(w.consecutiveWalls, n);
      assert.equal(r.manual_disable, b.manual, `manual at wall ${n}`);
      if (b.manual) assert.equal(r.disabled_until, null);
      else assert.equal(new Date(r.disabled_until).getTime(), now.getTime() + /** @type {number} */ (b.hours) * 3600000, `hours at wall ${n}`);
    }
  });

  test('the history is capped at the last 5, oldest dropped, order kept', async () => {
    const s = fresh();
    const base = Date.now() - 20 * DAY;
    for (let i = 1; i <= 8; i++) await recordWall(client, s, new Date(base + i * DAY), { kind: `k${i}` });
    const h = (await row(s)).wall_history;
    assert.equal(WALL_HISTORY_MAX, 5);
    assert.deepEqual(h.map((/** @type {any} */ e) => e.kind), ['k4', 'k5', 'k6', 'k7', 'k8']);
  });

  test('concurrent walls are atomic: six writers on six connections lose no count and keep a 5-entry history', async () => {
    const s = fresh();
    const clients = await Promise.all(Array.from({ length: 6 }, async () => {
      const c = new pg.Client(pgConnectionConfig());
      await c.connect();
      return c;
    }));
    try {
      const base = Date.now() - 30 * DAY;
      const results = await Promise.all(clients.map((c, i) => recordWall(c, s, new Date(base + i * 1000), { kind: `c${i}` })));
      assert.deepEqual(results.map((r) => r.consecutiveWalls).sort(), [1, 2, 3, 4, 5, 6]);
      const r = await row(s);
      assert.equal(r.consecutive_walls, 6);
      assert.equal(r.manual_disable, true);
      assert.equal(r.wall_history.length, 5);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  test('without the optional argument the other sources behave as before: NULL reason, a history entry with null fields', async () => {
    const s = fresh();
    const w = await recordWall(client, s, new Date(Date.now() - DAY));
    assert.equal(w.consecutiveWalls, 1);
    const r = await row(s);
    assert.equal(r.last_wall_kind, null);
    assert.equal(r.wall_history.length, 1);
    assert.equal(r.wall_history[0].kind, null);
  });

  test('a dry run is refused loudly and writes nothing', async () => {
    const s = fresh();
    await assert.rejects(recordWall(client, s, new Date(), { dryRun: true, kind: 'k' }), /dry run/);
    assert.equal(await row(s), undefined);
  });
});

describe('reenableSource and the count after a reset', () => {
  test('re-enable resets the counter and both flags, stamps reset_at, keeps the history and the last-wall audit', async () => {
    const s = fresh();
    const base = Date.now() - 6 * DAY;
    for (let i = 0; i < 3; i++) await recordWall(client, s, new Date(base + i * DAY), { kind: 'unhydrated_after_retry', detail: 'd' });
    assert.equal((await row(s)).manual_disable, true);
    const stored = await reenableSource(client, s);
    assert.equal(stored, s);
    const r = await row(s);
    assert.equal(r.consecutive_walls, 0);
    assert.equal(r.manual_disable, false);
    assert.equal(r.disabled_until, null);
    assert.ok(r.reset_at instanceof Date && Math.abs(r.reset_at.getTime() - Date.now()) < 60000);
    assert.equal(r.wall_history.length, 3, 'history kept');
    assert.equal(r.last_wall_kind, 'unhydrated_after_retry', 'audit kept');
    assert.deepEqual(countedWalls(r), [], 'nothing before reset_at counts');
    assert.equal((await collectDisabledSourceStates(client)).filter((x) => x.source === s).length, 0, 'enabled: no line');
  });

  test('after a reset, N and the dates count only walls recorded after reset_at', async () => {
    const s = fresh();
    const base = Date.now() - 6 * DAY;
    for (let i = 0; i < 3; i++) await recordWall(client, s, new Date(base + i * DAY), { kind: 'throttle_or_block', detail: 'old' });
    await reenableSource(client, s);
    const later = new Date(Date.now() + 120000);
    await recordWall(client, s, later, { kind: 'unknown', detail: 'shell_no_cards' });
    const rows = (await collectDisabledSourceStates(client)).filter((x) => x.source === s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 1);
    assert.deepEqual(rows[0].dates, [later.toISOString().slice(0, 10)]);
    assert.equal(rows[0].manual, false);
    assert.match(rows[0].text, /^paused until \S+ after 1 failed scan: unknown, shell_no_cards$/);
  });

  test('a re-enable DURING a run, then a wall: the wall is stamped at record time (database now), so N = 1 after the reset', async () => {
    const s = fresh();
    const runStart = Date.now() - 20 * 60000; // the run began 20 minutes ago
    for (let i = 0; i < 3; i++) await recordWall(client, s, new Date(runStart - (3 - i) * DAY), { kind: 'throttle_or_block', detail: 'old' });
    await reenableSource(client, s); // someone re-enables mid-run
    const w = await recordWall(client, s, null, { kind: 'unhydrated_after_retry', detail: 'late wall' }); // scan-run passes no run-start time
    assert.equal(w.consecutiveWalls, 1);
    const r = await row(s);
    const cmp = await client.query(`SELECT (wall_history->-1->>'at')::timestamptz > reset_at AS after FROM ic_source_state WHERE source = $1`, [s]);
    assert.equal(cmp.rows[0].after, true, 'stamped after reset_at at full (microsecond) precision');
    assert.ok(Math.abs(new Date(r.last_wall_at).getTime() - Date.now()) < 60000, 'last_wall_at is the record time, not the run start');
    const d = (await collectDisabledSourceStates(client)).find((x) => x.source === s);
    assert.ok(d);
    assert.equal(d.count, 1);
    assert.match(d.text, /^paused until \S+ after 1 failed scan: unhydrated_after_retry, late wall$/);
  });

  test('a rolled-back re-enable leaves the row as it was', async () => {
    const s = fresh();
    await recordWall(client, s, new Date(), { kind: 'k' });
    const failing = { async query(/** @type {string} */ sql) { if (/INSERT INTO ic_source_state/.test(sql)) throw new Error('boom'); return client.query(sql); } };
    await assert.rejects(reenableSource(/** @type {any} */ (failing), s), /boom/);
    assert.equal((await row(s)).consecutive_walls, 1);
  });
});

describe('describeDisabledSource: the sentence', () => {
  const hist = (/** @type {string[]} */ ats, kind = 'unhydrated_after_retry') => ats.map((at) => ({ at, kind, detail: 'd', url: null, snapshot: null, run_id: null }));
  /** @param {any} o */
  const base = (o = {}) => ({ source: 'linkedin', manual_disable: true, disabled_until: null, consecutive_walls: 3, last_wall_at: '2026-10-12T14:00:00Z', last_wall_kind: 'unhydrated_after_retry', last_wall_detail: 'no_cards_no_shell_after_reload after one reload', reset_at: null, wall_history: hist(['2026-10-08T14:00:00Z', '2026-10-09T14:00:00Z', '2026-10-12T14:00:00Z']), ...o });

  test('latched: "auto-disabled after N failed scans (dates): reason"', () => {
    const d = describeDisabledSource(base());
    assert.equal(d.text, 'auto-disabled after 3 failed scans (2026-10-08, 2026-10-09, 2026-10-12): unhydrated_after_retry, no_cards_no_shell_after_reload after one reload');
    assert.equal(d.manual, true);
    assert.equal(d.count, 3);
  });
  test('one failed scan is singular', () => {
    assert.match(describeDisabledSource(base({ consecutive_walls: 1, wall_history: hist(['2026-10-12T14:00:00Z']) })).text, /^auto-disabled after 1 failed scan \(2026-10-12\): /);
  });
  test('paused: "paused until <time> after N failed scan(s): reason"', () => {
    const d = describeDisabledSource(base({ manual_disable: false, disabled_until: '2026-10-13T14:00:00Z', consecutive_walls: 1, wall_history: hist(['2026-10-12T14:00:00Z']) }));
    assert.equal(d.text, 'paused until 2026-10-13T14:00:00.000Z after 1 failed scan: unhydrated_after_retry, no_cards_no_shell_after_reload after one reload');
    assert.equal(d.manual, false);
    assert.equal(d.until, '2026-10-13T14:00:00.000Z');
  });
  test('a NULL reason renders "reason not recorded" in both forms', () => {
    assert.match(describeDisabledSource(base({ last_wall_kind: null, last_wall_detail: null })).text, /: reason not recorded$/);
    assert.match(describeDisabledSource(base({ manual_disable: false, disabled_until: '2026-10-13T14:00:00Z', last_wall_kind: null })).text, /: reason not recorded$/);
  });
  test('only history entries after reset_at count; the dates follow', () => {
    const d = describeDisabledSource(base({ consecutive_walls: 1, reset_at: '2026-10-09T20:00:00Z' }));
    assert.equal(d.count, 1);
    assert.deepEqual(d.dates, ['2026-10-12']);
  });
  test('a row from before sql/028 (no history) falls back to the counter and the last wall date', () => {
    const d = describeDisabledSource(base({ wall_history: [], last_wall_kind: null }));
    assert.equal(d.text, 'auto-disabled after 3 failed scans (2026-10-12, earlier dates not recorded): reason not recorded');
  });
  test('a legacy row with 2 walls and no history that takes its 3rd wall reads "3 failed scans", not 1', async () => {
    const s = fresh();
    await client.query(`INSERT INTO ic_source_state (source, consecutive_walls, disabled_until, last_wall_at) VALUES ($1, 2, now() + interval '1 hour', now() - interval '3 days')`, [s]);
    await recordWall(client, s, null, { kind: 'unknown', detail: 'third wall' });
    const d = (await collectDisabledSourceStates(client)).find((x) => x.source === s);
    assert.ok(d);
    assert.equal(d.count, 3);
    assert.equal(d.dates.length, 1);
    assert.match(d.text, /^auto-disabled after 3 failed scans \(\d{4}-\d{2}-\d{2}, earlier dates not recorded\): unknown, third wall$/);
  });
  test('malformed history entries are skipped, never thrown on', () => {
    const d = describeDisabledSource(base({ consecutive_walls: 1, wall_history: [null, 5, { at: 'nope' }, { at: '2026-10-12T14:00:00Z' }] }));
    assert.equal(d.count, 1);
  });
  test('a latch with no failed scans on record says so instead of "after 0 failed scans"', () => {
    const d = describeDisabledSource(base({ wall_history: [], consecutive_walls: 0, last_wall_at: null, last_wall_kind: null }));
    assert.equal(d.text, 'disabled with no failed scans on record: reason not recorded');
  });
  test('a detail-wall key renders sensibly', () => {
    const d = describeDisabledSource(base({ consecutive_walls: 1, source: 'linkedin:detail', last_wall_kind: 'detail_blocked', last_wall_detail: 'blocked:cloudflare', wall_history: hist(['2026-10-12T14:00:00Z'], 'detail_blocked') }));
    assert.equal(d.source, 'linkedin:detail');
    assert.equal(d.text, 'auto-disabled after 1 failed scan (2026-10-12): detail_blocked, blocked:cloudflare');
  });
});
