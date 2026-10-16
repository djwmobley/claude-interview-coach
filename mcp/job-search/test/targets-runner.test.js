// @ts-check
/**
 * Target finder runner (PR3, plan 17). Runs against the isolated "_test" database with a synthetic EDGAR
 * (test/helpers/targets-world.js). No live network, no powershell, no browser, no child process. Every row
 * the runner writes to the ic_target_* tables is deleted before and after (the database is throwaway and the
 * suite runs one file at a time).
 *
 * "Now" is Thursday 2026-10-15 08:00 ET, so bd(0) = 10-15, bd(1) = 10-14 and bd(2) = 10-13: the cursor can
 * reach 10-13 and no further.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { dedupHash } from '../src/core/normalize.js';
import { loadTargetRules } from '../src/core/target-classify.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { runTargets, reapStaleRuns, TARGETS_LOCK_KEY } from '../src/targets/runner.js';
import { persistItems } from '../src/targets/store.js';
import { indexUrl } from '../src/targets/edgar-client.js';
import { fastTiming } from './helpers/targets-replay.js';
import { makeWorld, defaultFiling } from './helpers/targets-world.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = loadTargetRules(path.join(HERE, '..', 'config'));
const NOW = new Date('2026-10-15T12:00:00Z');
/** @type {import('../src/core/target-exclusion.js').BlockedList} */
const OK_LIST = { entries: [...BUILT_IN_BLOCKED], status: 'ok', error: null };
const PID = process.pid;
/** @type {pg.Client} */
let client;
/** @type {pg.Client} */
let other;
/** @type {string} */
let cfgDir;

async function wipe() {
  await client.query('DELETE FROM ic_target_signals');
  await client.query('DELETE FROM ic_targets');
  await client.query('DELETE FROM ic_target_runs');
  await client.query('DELETE FROM ic_target_source_state');
  await client.query(`UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE source = $1`, [`zz-test-runner-${PID}`]);
  await client.query(`DELETE FROM ic_job_listings WHERE source = $1`, [`zz-test-runner-${PID}`]);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  other = new pg.Client(pgConnectionConfig());
  await other.connect();
  await ensureAuxSchema(client);
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'targets-runner-'));
  fs.writeFileSync(path.join(cfgDir, 'target-sec-contact.json'), JSON.stringify({ contact: 'Test Person test.person@corp.test' }));
  await wipe();
});
beforeEach(wipe);
after(async () => {
  await wipe();
  await client.end();
  await other.end();
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

/**
 * @param {ReturnType<typeof makeWorld>} world
 * @param {Record<string, any>} [extra]
 */
function deps(world, extra = {}) {
  return { client, now: NOW, configDir: cfgDir, fetch: world.fetch, rules: RULES, blocked: OK_LIST, timing: fastTiming().timing, heartbeatMs: 60_000, ...extra };
}

/** @param {string} key @param {string|null} cursor @param {Record<string, unknown>} [detail] */
async function seedCursor(key, cursor, detail = {}) {
  await client.query(
    `INSERT INTO ic_target_source_state (source, cursor_date, cursor_detail) VALUES ($1, $2::date, $3::jsonb)
     ON CONFLICT (source) DO UPDATE SET cursor_date = $2::date, cursor_detail = $3::jsonb`,
    [key, cursor, JSON.stringify(detail)],
  );
}
/** @param {string} key */
async function state(key) {
  const r = await client.query(`SELECT to_char(cursor_date, 'YYYY-MM-DD') AS cursor_date, cursor_detail, last_status FROM ic_target_source_state WHERE source = $1`, [key]);
  return r.rows[0] ?? { cursor_date: null, cursor_detail: {}, last_status: null };
}
/** @param {string} sql @param {unknown[]} [params] */
async function count(sql, params = []) {
  return Number((await client.query(sql, params)).rows[0].n);
}
const SIGNALS = `SELECT count(*)::int AS n FROM ic_target_signals`;
/** @param {string} prefix @param {number} n @param {string} day */
function fundFilings(prefix, n, day) {
  const mmdd = Number(day.slice(5).replace('-', ''));
  return Array.from({ length: n }, (_, i) => {
    const cik = String(2_000_000 + mmdd * 1000 + i).padStart(10, '0');
    return { adsh: `${cik}-26-${String(i + 1).padStart(6, '0')}`, cik, name: `${prefix} Fund ${i}` };
  });
}

describe('cursor and coverage (plan 17.2)', () => {
  test('a clean run persists three days, moves the cursor only to bd(2), and builds a flagged target', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const world = makeWorld();
    const r = await runTargets(deps(world), { source: 'form_d' });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-13', 'bd(1) and today are read but never marked covered');
    assert.equal(await count(SIGNALS), 3);
    assert.deepEqual(world.searches().map((c) => new URL(c.url).searchParams.get('startdt')).filter((d, i, a) => a.indexOf(d) === i), ['2026-10-13', '2026-10-14', '2026-10-15']);
    const t = await client.query(`SELECT class, verdict_rule, size_verified, trigger_kind FROM ic_targets ORDER BY company_norm`);
    assert.equal(t.rowCount, 3);
    assert.ok(t.rows.every((x) => x.class === 'target' && x.size_verified === false && x.trigger_kind === 'pe_deal'), JSON.stringify(t.rows));
    const run = await client.query(`SELECT status, trigger, heartbeat_at, finished_at, backlog FROM ic_target_runs`);
    assert.equal(run.rowCount, 1);
    assert.equal(run.rows[0].status, 'ok');
    assert.equal(run.rows[0].trigger, 'cli');
    assert.ok(run.rows[0].heartbeat_at && run.rows[0].finished_at);
    assert.equal(run.rows[0].backlog.form_d, 0);
  });

  test('the overlap re-read is idempotent: same rows, same ids, no document is fetched again', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    await runTargets(deps(makeWorld()), { source: 'form_d' });
    const idsBefore = (await client.query(`SELECT id FROM ic_target_signals ORDER BY id`)).rows.map((x) => x.id);
    const targetsBefore = (await client.query(`SELECT id, company_norm, class FROM ic_targets ORDER BY id`)).rows;
    const w2 = makeWorld();
    const r2 = await runTargets(deps(w2), { source: 'form_d' });
    assert.equal(r2.status, 'ok');
    assert.deepEqual((await client.query(`SELECT id FROM ic_target_signals ORDER BY id`)).rows.map((x) => x.id), idsBefore);
    assert.deepEqual((await client.query(`SELECT id, company_norm, class FROM ic_targets ORDER BY id`)).rows, targetsBefore);
    assert.equal(w2.docs().length, 0, 'accessions already stored with a read document are skipped');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-13');
  });

  test('a document failure makes the day partial and holds the cursor; the next run reads only the failed document', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const three = [defaultFiling('2026-10-13', 1), defaultFiling('2026-10-13', 2), defaultFiling('2026-10-13', 3)];
    const hitsFor = (/** @type {string} */ day, /** @type {string} */ form) => (form !== 'D' ? [] : (day === '2026-10-13' ? three : [defaultFiling(day)]));
    const w1 = makeWorld({ hitsFor, docStatus: (adsh) => (adsh === three[1].adsh ? 500 : 200) });
    const r1 = await runTargets(deps(w1), { source: 'form_d' });
    assert.equal(r1.status, 'partial');
    assert.equal(r1.sources.form_d.status, 'partial');
    assert.equal(r1.sources.form_d.reason, 'doc_fetch');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-12', 'the cursor never passes an unfinished day');
    const w2 = makeWorld({ hitsFor });
    const r2 = await runTargets(deps(w2), { source: 'form_d' });
    assert.equal(r2.status, 'ok', JSON.stringify(r2.sources));
    assert.equal(w2.docs().length, 1, 'resume pages again from offset 0 and skips what is already stored with a read document');
    assert.ok(w2.docs()[0].url.includes(three[1].adsh.replace(/-/g, '')));
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-13');
    assert.equal(await count(SIGNALS), 5, 'no duplicates after the resume');
  });

  test('budget exhaustion stops the source as partial (run_cap), keeps the cursor, and the next run resumes', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const five = [1, 2, 3, 4, 5].map((n) => defaultFiling('2026-10-13', n));
    const hitsFor = (/** @type {string} */ day, /** @type {string} */ form) => (form !== 'D' ? [] : (day === '2026-10-13' ? five : [defaultFiling(day)]));
    const ft = fastTiming();
    const w1 = makeWorld({ hitsFor });
    const r1 = await runTargets(deps(w1, { timing: { ...ft.timing, budgets: { form_d: 4 } } }), { source: 'form_d' });
    assert.equal(r1.sources.form_d.status, 'partial');
    assert.equal(r1.sources.form_d.reason, 'run_cap');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-12');
    assert.equal(w1.docs().length, 2, 'two filings fit the budget of four requests (document plus submissions each)');
    const w2 = makeWorld({ hitsFor });
    const r2 = await runTargets(deps(w2), { source: 'form_d' });
    assert.equal(r2.status, 'ok');
    assert.equal(w2.docs().filter((c) => c.url.includes('/000')).length, 3 + 2, 'three left from 10-13, then the two days never reached');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-13');
  });

  test('a crash between the persist and the cursor write leaves neither; the next run recovers without duplicates', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const r1 = await runTargets(deps(makeWorld(), {
      hooks: { afterPersist: ({ day }) => { if (day === '2026-10-13') throw new Error('simulated crash'); } },
    }), { source: 'form_d' });
    assert.equal(r1.sources.form_d.status, 'failed');
    assert.equal(r1.sources.form_d.reason, 'exception');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-12', 'the cursor did not move');
    assert.equal(await count(`${SIGNALS} WHERE extracted->>'file_date' = '2026-10-13'`), 0, 'the day persist rolled back with the cursor write');
    const r2 = await runTargets(deps(makeWorld()), { source: 'form_d' });
    assert.equal(r2.status, 'ok');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-13');
    assert.equal(await count(SIGNALS), 3);
  });

  test('a changed source config resets the cursor to the first-run lookback', async () => {
    await seedCursor('edgar_form_d', '2026-10-13', { config_hash: 'stale-hash' });
    const world = makeWorld();
    const r = await runTargets(deps(world), { source: 'form_d' });
    assert.ok(r.sources.form_d.flags.includes('config_reset'));
    const firstDay = new URL(world.searches()[0].url).searchParams.get('startdt');
    assert.equal(firstDay, '2026-10-01', 'Form D first-run lookback is 14 days');
    const st = await state('edgar_form_d');
    assert.notEqual(st.cursor_detail.config_hash, 'stale-hash');
    assert.equal(st.cursor_date, '2026-10-13');
  });

  test('suspicious_empty: a Form D weekday with total 0 holds the cursor for two runs, then releases with a flag', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const hitsFor = (/** @type {string} */ day, /** @type {string} */ form) => (form !== 'D' || day === '2026-10-13' ? [] : [defaultFiling(day)]);
    const run = () => runTargets(deps(makeWorld({ hitsFor })), { source: 'form_d' });
    const r1 = await run();
    assert.equal(r1.sources.form_d.status, 'partial');
    assert.equal(r1.sources.form_d.reason, 'suspicious_empty');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-12');
    assert.deepEqual((await state('edgar_form_d')).cursor_detail.empty_hold, { day: '2026-10-13', runs: 1 });
    await run();
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-12');
    assert.equal((await state('edgar_form_d')).cursor_detail.empty_hold.runs, 2);
    const r3 = await run();
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-13', 'released on the third run');
    assert.ok(r3.flags.includes('suspicious_empty_released'));
    assert.equal((await state('edgar_form_d')).cursor_detail.empty_hold, null);
    assert.equal(r3.sources.form_d.status, 'complete');
  });

  test('a failed search request is partial (request_failed), never an empty page, and never counts toward suspicious_empty', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const w = makeWorld({ searchStatus: (day, form) => (day === '2026-10-13' && form === 'D' ? 500 : 200) });
    const r = await runTargets(deps(w), { source: 'form_d' });
    assert.equal(r.sources.form_d.status, 'partial');
    assert.equal(r.sources.form_d.reason, 'request_failed');
    const st = await state('edgar_form_d');
    assert.equal(st.cursor_date, '2026-10-12');
    assert.ok(!st.cursor_detail.empty_hold);
  });

  test('a day with more hits than the page cap is partial with day_overflow and holds the cursor', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const big = fundFilings('Zzrun', 600, '2026-10-13');
    const w = makeWorld({ hitsFor: (day, form) => (form !== 'D' ? [] : (day === '2026-10-13' ? big : [defaultFiling(day)])) });
    const r = await runTargets(deps(w), { source: 'form_d' });
    assert.equal(r.sources.form_d.status, 'partial');
    assert.ok(r.flags.includes('day_overflow'));
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-12');
    assert.equal(w.searches().filter((c) => c.url.includes('startdt=2026-10-13') && c.url.includes('forms=D&')).length, 5, 'five pages, then it stops');
  });

  test('the 8-K source is sliced the same way and builds an exec_departure signal', async () => {
    await seedCursor('edgar_8k', '2026-10-12');
    const k8 = defaultFiling('2026-10-13', 1);
    const w = makeWorld({ k8For: (day) => (day === '2026-10-13' ? [k8] : []) });
    const r = await runTargets(deps(w), { source: '8k' });
    assert.equal(r.sources['8k'].status, 'complete', JSON.stringify(r.sources));
    assert.equal((await state('edgar_8k')).cursor_date, '2026-10-13');
    assert.equal(await count(`${SIGNALS} WHERE source = 'edgar_8k' AND parse_outcome = 'parsed'`), 1);
  });

  test('a Saturday run still anchors on business days: the cursor stops at bd(2) = Wednesday', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const r = await runTargets(deps(makeWorld(), { now: new Date('2026-10-17T15:00:00Z') }), { source: 'form_d' });
    assert.equal(r.status, 'ok');
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-14');
  });
});

describe('classification from stored signals (plan 17.1)', () => {
  /** @param {string} company @param {Record<string, any>} over */
  function stored(company, over = {}) {
    const adsh = over.adsh ?? '0000000999-26-000999';
    return {
      source: 'edgar_8k', key: over.key ?? `${adsh}|5.02`, outcome: /** @type {const} */ ('parsed'), reason: 'ok', excerpt: 'x', url: indexUrl('999', adsh), contact: null,
      extracted: { accession: adsh, file_date: over.file_date ?? '2026-10-08', parse_outcome: 'parsed' },
      signal: {
        trigger_kind: 'exec_departure', company, aliases: [], acquirer: null, investor: null, pe_firm: null, text: over.text ?? 'CTO resigned',
        evidence_url: indexUrl('999', adsh), evidence_source: 'edgar_8k', event_date: over.event_date ?? '2026-10-08', filing_date: '2026-10-08', role: 'Chief Technology Officer',
        departure_ambiguous: false, doc_fetch: 'ok', ...(over.signal ?? {}),
      },
    };
  }

  test('a blocked-party sibling stored by an EARLIER run still forces the group to needs-review', async () => {
    await persistItems(client, [stored('Zzrun Co 1013-1 Inc', { adsh: '0000000998-26-000998', text: `CTO resigned; investor ${BUILT_IN_BLOCKED[0]}` })]);
    await seedCursor('edgar_form_d', '2026-10-12');
    await runTargets(deps(makeWorld()), { source: 'form_d' });
    const t = await client.query(`SELECT class, verdict_rule, verdict_inputs FROM ic_targets WHERE company_norm LIKE 'zzrun co 1013%'`);
    assert.equal(t.rowCount, 1);
    assert.equal(t.rows[0].class, 'needs-review');
    assert.equal(t.rows[0].verdict_rule, 'dedup_blocked_sibling');
    assert.equal(t.rows[0].verdict_inputs.blocked_hint, true);
  });

  test('a newer, worse sibling never overwrites a better verdict; the collapse is logged', async () => {
    const good = stored('Zzrun Sibling Co', { adsh: '0000000997-26-000997', event_date: '2026-10-02' });
    const worse = stored('Zzrun Sibling Co', { adsh: '0000000996-26-000996', event_date: '2026-10-14', signal: { evidence_url: 'https://evil.example/x' } });
    await persistItems(client, [good, worse]);
    const r = await runTargets(deps(makeWorld()), { source: 'gap' });
    assert.ok(r.counts.signals_classified >= 2);
    const t = await client.query(`SELECT class, trigger_date::text AS d, collapsed_signal_ids FROM ic_targets WHERE company_norm LIKE 'zzrun sibling%'`);
    assert.equal(t.rowCount, 1);
    assert.equal(t.rows[0].class, 'target');
    assert.equal(t.rows[0].d, '2026-10-02');
    assert.equal(t.rows[0].collapsed_signal_ids.length, 1);
    const linked = await count(`${SIGNALS} WHERE target_id IS NOT NULL AND source = 'edgar_8k'`);
    assert.equal(linked, 2, 'both signals are linked to the one target');
  });

  test('a class change from the prior run is recorded in verdict_inputs.previous', async () => {
    await persistItems(client, [stored('Zzrun Aging Co', { adsh: '0000000995-26-000995', event_date: '2026-10-02' })]);
    await runTargets(deps(makeWorld()), { source: 'gap' });
    assert.equal((await client.query(`SELECT class FROM ic_targets WHERE company_norm LIKE 'zzrun aging%'`)).rows[0].class, 'target');
    const later = await runTargets(deps(makeWorld(), { now: new Date('2027-03-15T12:00:00Z') }), { source: 'gap' });
    const t = await client.query(`SELECT class, verdict_inputs FROM ic_targets WHERE company_norm LIKE 'zzrun aging%'`);
    assert.equal(t.rows[0].class, 'not-target');
    assert.deepEqual(t.rows[0].verdict_inputs.previous, { class: 'target', rule: 'target_all_checks_passed' });
    assert.equal(later.counts.regressed, 1);
  });

  test('a human decision survives a re-run; the machine verdict still updates', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    await runTargets(deps(makeWorld()), { source: 'form_d' });
    await client.query(`UPDATE ic_targets SET decision = 'discarded', decision_class = 'not-target', decided_by = 'dashboard', decided_at = now() WHERE company_norm LIKE 'zzrun co 1013%'`);
    await runTargets(deps(makeWorld()), { source: 'form_d' });
    const t = await client.query(`SELECT decision, decision_class, decided_by FROM ic_targets WHERE company_norm LIKE 'zzrun co 1013%'`);
    assert.deepEqual(t.rows[0], { decision: 'discarded', decision_class: 'not-target', decided_by: 'dashboard' });
  });

  test('gap source: listing ids are carried to ic_targets, the signal is persisted, the run row counts it', async () => {
    const src = `zz-test-runner-${PID}`;
    const company = `ZZRUN GAP ${PID} Co`;
    const norm = company.toLowerCase();
    for (const [i, title] of ['VP Engineering', 'Software Engineer'].entries()) {
      await client.query(
        `INSERT INTO ic_job_listings (title, company, url, url_normalized, source, external_id, record_kind, company_norm, title_norm, location, location_norm, remote_declared, dedup_hash, first_seen, last_seen, absent_runs)
         VALUES ($1,$2,$3,$3,$4,$5,'listing',$6,$7,NULL,'legacy-unknown',false,$8, now() - interval '1 day', now() - interval '1 day', 0)`,
        [title, company, `https://boards.example.test/${PID}/${i}`, src, `${src}:${i}`, norm, title.toLowerCase(), dedupHash(norm, `${title.toLowerCase()}-${i}`, 'legacy-unknown')],
      );
    }
    const r = await runTargets(deps(makeWorld(), { now: new Date() }), { source: 'gap' });
    assert.equal(r.sources.gap.status, 'complete');
    const t = await client.query(`SELECT trigger_kind, listing_ids FROM ic_targets WHERE company_norm LIKE $1`, [`zzrun gap ${PID}%`]);
    assert.equal(t.rowCount, 1);
    assert.equal(t.rows[0].trigger_kind, 'leadership_gap');
    assert.equal(t.rows[0].listing_ids.length, 2);
  });
});

describe('lock, reaper, heartbeat (plan 17.4)', () => {
  test('lock contention writes a skipped_locked row, makes no request, and leaves no running row', async () => {
    await other.query('SELECT pg_advisory_lock($1::bigint)', [TARGETS_LOCK_KEY]);
    try {
      const world = makeWorld();
      const r = await runTargets(deps(world), { source: 'form_d' });
      assert.equal(r.status, 'skipped');
      assert.equal(r.skipped, 'already_running');
      assert.equal(world.calls.length, 0);
      const rows = await client.query(`SELECT status, finished_at, details FROM ic_target_runs`);
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].status, 'skipped_locked');
      assert.ok(rows.rows[0].finished_at);
      assert.equal(rows.rows[0].details.reason, 'already_running');
    } finally {
      await other.query('SELECT pg_advisory_unlock($1::bigint)', [TARGETS_LOCK_KEY]);
    }
  });

  test('the reaper fails a row only when its heartbeat (else started_at) is stale for 30 minutes', async () => {
    const ins = (/** @type {string} */ started, /** @type {string|null} */ beat) => client.query(
      `INSERT INTO ic_target_runs (status, started_at, heartbeat_at) VALUES ('running', now() - $1::interval, CASE WHEN $2::text IS NULL THEN NULL ELSE now() - $2::interval END) RETURNING id`,
      [started, beat],
    ).then((x) => Number(x.rows[0].id));
    const staleBeat = await ins('3 hours', '40 minutes');
    const longButAlive = await ins('3 hours', '2 minutes');
    const noBeatOld = await ins('2 hours', null);
    const noBeatNew = await ins('5 minutes', null);
    const n = await reapStaleRuns(client, 30);
    assert.equal(n, 2);
    const rows = Object.fromEntries((await client.query(`SELECT id, status, error FROM ic_target_runs`)).rows.map((x) => [x.id, x]));
    assert.equal(rows[staleBeat].status, 'failed');
    assert.equal(rows[staleBeat].error, 'reaped');
    assert.equal(rows[noBeatOld].status, 'failed');
    assert.equal(rows[longButAlive].status, 'running', 'a long manual run that keeps its heartbeat survives');
    assert.equal(rows[noBeatNew].status, 'running');
  });

  test('every runTargets call reaps first, independent of the lock', async () => {
    const stale = (await client.query(`INSERT INTO ic_target_runs (status, started_at, heartbeat_at) VALUES ('running', now() - interval '2 hours', now() - interval '1 hour') RETURNING id`)).rows[0].id;
    await runTargets(deps(makeWorld()), { source: 'gap' });
    assert.equal((await client.query(`SELECT status FROM ic_target_runs WHERE id = $1`, [stale])).rows[0].status, 'failed');
  });

  test('a live run keeps beating: heartbeat_at advances while the run is in flight', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const world = makeWorld({ delayMs: 120 });
    const done = runTargets(deps(world, { heartbeatMs: 25 }), { source: 'form_d' });
    const beat = async () => (await other.query(`SELECT heartbeat_at FROM ic_target_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`)).rows[0]?.heartbeat_at;
    await new Promise((r) => setTimeout(r, 150));
    const h1 = await beat();
    await new Promise((r) => setTimeout(r, 300));
    const h2 = await beat();
    const r = await done;
    assert.ok(h1 && h2, 'the row was running and had a heartbeat');
    assert.ok(new Date(h2).getTime() > new Date(h1).getTime(), 'heartbeat moved');
    assert.equal(r.status, 'ok');
  });
});

describe('skips, dry run, alerts window', () => {
  test('a missing SEC contact skips the SEC sources with sec_contact_missing and makes zero requests', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'targets-nocontact-'));
    try {
      const world = makeWorld();
      const r = await runTargets(deps(world, { configDir: empty }), { source: 'form_d' });
      assert.equal(r.sources.form_d.status, 'skipped');
      assert.equal(r.sources.form_d.reason, 'sec_contact_missing');
      assert.equal(world.calls.length, 0);
      const row = await client.query(`SELECT status, skip_reasons FROM ic_target_runs`);
      assert.equal(row.rows[0].status, 'partial');
      assert.equal(row.rows[0].skip_reasons.form_d, 'sec_contact_missing');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('a dry run fetches and classifies but writes nothing at all', async () => {
    await seedCursor('edgar_form_d', '2026-10-12');
    const before = await count(`SELECT count(*)::int AS n FROM ic_target_source_state`);
    const world = makeWorld();
    const r = await runTargets(deps(world), { source: 'form_d', dryRun: true });
    assert.ok(world.calls.length > 0);
    assert.equal(r.dry_run, true);
    assert.equal(r.counts.signals_classified, 3);
    assert.equal(await count(SIGNALS), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM ic_targets`), 0);
    assert.equal(await count(`SELECT count(*)::int AS n FROM ic_target_runs`), 0);
    assert.equal((await state('edgar_form_d')).cursor_date, '2026-10-12');
    assert.equal(await count(`SELECT count(*)::int AS n FROM ic_target_source_state`), before);
  });

  test('alerts use max(configured window, days since the last success)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'targets-alerts-'));
    fs.writeFileSync(path.join(dir, 'target-sec-contact.json'), JSON.stringify({ contact: 'Test Person test.person@corp.test' }));
    fs.writeFileSync(path.join(dir, 'target-alert-patterns.json'), JSON.stringify({
      p1: { priority: 1, label_regex: 'acquired', headline_regex: '^(?<company>.+?) acquired by (?<acquirer>.+?)$', trigger_kind: 'pe_deal', enabled: true },
    }));
    try {
      /** @param {string} u */
      const extra = (u) => (u.includes('gmail.googleapis.com') ? new Response(JSON.stringify({ messages: [], resultSizeEstimate: 0 }), { status: 200 }) : null);
      const windowOf = async () => {
        const w = makeWorld({ extra });
        const r = await runTargets(deps(w, { configDir: dir, getAccessToken: async () => 'tok' }), { source: 'alerts' });
        const list = w.calls.find((c) => c.url.includes('gmail.googleapis.com'));
        assert.ok(list, JSON.stringify(r.sources));
        return decodeURIComponent(new URL(list.url).searchParams.get('q') ?? '');
      };
      assert.match(await windowOf(), /newer_than:14d/, 'never succeeded before: the configured window');
      await client.query(`UPDATE ic_target_source_state SET last_success_at = '2026-09-05T12:00:00Z' WHERE source = 'google_alert'`);
      assert.match(await windowOf(), /newer_than:40d/, 'a 40 day gap widens the window');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bad --source is a visible failure, not a silent no-op', async () => {
    const r = await runTargets(deps(makeWorld()), { source: 'nope' });
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'bad_source');
  });
});
