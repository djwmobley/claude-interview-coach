// @ts-check
/**
 * bin/scan.js spawned as a child process with the fixture transport
 * (JOBSEARCH_FIXTURE_MAP) and the test config dir: exit code, stdout JSON
 * summary, run row, JSONL log, --json output, config-lock refusal, and the
 * 9222 refusal of --launch-chrome.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newClient, upsertTestProfile, cleanupScan, CONFIG_DIR, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { parseArgs, launchChrome, cdpReachable } from '../bin/scan.js';
import { computeConfigHash, CONFIG_FILES, writeTriageCandidateLock } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const SCAN = path.join(PKG, 'bin', 'scan.js');
const MAP = path.join(HERE, 'fixtures', 'scan', 'fixture-map.json');
const PROFILE = `zz-test-cli-${process.pid}`;
/** @type {import('pg').Client} */
let client;
/** @type {string} */
let logDir;

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCAN, ...args], {
      cwd: PKG,
      env: { ...process.env, JOBSEARCH_FIXTURE_MAP: MAP, JOBSEARCH_FIXTURE_NOW: FIXTURE_NOW.toISOString(), JOBSEARCH_CONFIG_DIR: CONFIG_DIR, JOBSEARCH_LOG_DIR: logDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** The test config dir has no lock file of its own; write one in the temp log dir and point JOBSEARCH_CONFIG_LOCK at it. */
function writeTestLock() {
  const lockPath = path.join(logDir, 'config.lock.json');
  fs.writeFileSync(lockPath, JSON.stringify({ sha256: computeConfigHash(CONFIG_DIR), files: [], updated_at: new Date().toISOString() }) + '\n');
  return lockPath;
}

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE });
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['Chief', 'Vice President'], phrases: [], locations: ['Houston, TX'] });
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cli-'));
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE });
  } finally {
    await client.end();
  }
});

describe('scan.js CLI', () => {
  test('parseArgs', () => {
    const a = parseArgs(['--profile', 'p', '--sources', 'greenhouse, lever', '--days', '3', '--max-pages', '2', '--dry-run', '--json', '--launch-chrome']);
    assert.equal(a.profile, 'p');
    assert.deepEqual(a.sources, ['greenhouse', 'lever']);
    assert.equal(a.days, 3);
    assert.equal(a.maxPages, 2);
    assert.equal(a.dryRun, true);
    assert.equal(a.json, null);
    assert.equal(a.launchChrome, true);
    assert.equal(parseArgs(['--json', 'out.json']).json, 'out.json');
    assert.equal(parseArgs([]).trigger, 'cli', 'default trigger is cli (dashboard PR 1)');
    assert.equal(parseArgs(['--trigger', 'dashboard']).trigger, 'dashboard');
  });

  test('--accept-config-change no longer exists: parseArgs never sets an acceptConfigChange field (scan-never-skip fix: nothing left for it to override)', () => {
    const a = parseArgs(['--accept-config-change']);
    assert.equal('acceptConfigChange' in a, false);
  });

  test('cdpReachable is exported and reports false for an unreachable port (dashboard PR 1)', async () => {
    assert.equal(typeof cdpReachable, 'function');
    assert.equal(await cdpReachable('http://127.0.0.1:1'), false);
  });

  test('refuses --launch-chrome on port 9222 and on a non-loopback host', async () => {
    await assert.rejects(launchChrome(/** @type {any} */ ({ SCAN_CDP_URL: 'http://127.0.0.1:9222', CHROME_EXECUTABLE: null, SCAN_PROFILE_DIR: 'x' }), () => {}), /9222/);
    await assert.rejects(launchChrome(/** @type {any} */ ({ SCAN_CDP_URL: 'http://10.0.0.5:9333', CHROME_EXECUTABLE: null, SCAN_PROFILE_DIR: 'x' }), () => {}), /loopback/);
  });

  test('launchChrome self-heal wiring (scan-never-skip SPEC 9): a fake probe/list/kill/spawn set proves the guard checks still throw but a real launch/readiness failure never does', async () => {
    const env = /** @type {any} */ ({ SCAN_CDP_URL: 'http://127.0.0.1:9333', CHROME_EXECUTABLE: 'C:\\fake\\chrome.exe', SCAN_PROFILE_DIR: 'C:\\fake\\chrome-scan-profile' });
    // Healthy first probe: launchChrome never lists/kills/spawns.
    let listCalls = 0;
    const r1 = await launchChrome(env, () => {}, {
      probe: async () => true,
      listProcesses: async () => {
        listCalls++;
        return [];
      },
      killTree: async () => true,
    });
    assert.equal(r1.launched, false);
    assert.equal(r1.healed, false);
    assert.equal(r1.warning, null);
    assert.equal(listCalls, 0);

    // Every attempt fails to become ready: launchChrome returns (never throws) with a CHROME_LAUNCH_FAILED
    // warning, matched pids only from listProcesses containing the configured profile dir.
    const killed = [];
    const r2 = await launchChrome(env, () => {}, {
      probe: async () => false,
      listProcesses: async (dir) => {
        assert.equal(dir, env.SCAN_PROFILE_DIR);
        return [123];
      },
      killTree: async (pid) => {
        killed.push(pid);
        return true;
      },
      sleep: async () => {},
    });
    assert.equal(r2.warning.code, 'CHROME_LAUNCH_FAILED');
    assert.equal(r2.warning.severity, 'warning');
    assert.ok(killed.length > 0);
  });

  test('--dry-run --sources greenhouse: exit 0, stdout summary, run row, JSONL log, --json file', async () => {
    const lockPath = writeTestLock();
    let r;
    try {
      const jsonOut = path.join(logDir, 'out.json');
      for (let i = 0; i < 60; i++) {
        r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse', '--json', jsonOut], { JOBSEARCH_CONFIG_LOCK: lockPath });
        const summary = JSON.parse(r.out.trim().split('\n').pop() ?? '{}');
        if (summary.status !== 'locked') break;
        await new Promise((res) => setTimeout(res, 500));
      }
      assert.ok(r);
      const summary = JSON.parse(r.out.trim().split('\n').pop() ?? '{}');
      assert.equal(r.code, 0, `stdout=${r.out} stderr=${r.err}`);
      assert.equal(summary.ok, true);
      assert.equal(summary.status, 'ok');
      assert.ok(summary.run_id > 0);
      assert.ok(summary.stats.fetched >= 1, JSON.stringify(summary.stats));
      assert.equal(r.out.trim().split('\n').length, 1, 'stdout carries exactly one JSON line');
      const row = await client.query('SELECT status, trigger, dry_run, finished_at, stats, config_hash FROM ic_scan_runs WHERE id = $1', [summary.run_id]);
      assert.equal(row.rows[0].status, 'ok');
      assert.equal(row.rows[0].trigger, 'cli');
      assert.equal(row.rows[0].dry_run, true);
      assert.ok(row.rows[0].finished_at);
      assert.equal(row.rows[0].config_hash, computeConfigHash(CONFIG_DIR));
      const logs = fs.readdirSync(logDir).filter((n) => /^scan-\d{4}-\d{2}-\d{2}\.log$/.test(n));
      assert.equal(logs.length, 1);
      const lines = fs.readFileSync(path.join(logDir, logs[0]), 'utf8').trim().split('\n');
      for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), 'every log line is JSON');
      assert.ok(lines.some((l) => l.includes('"evt":"fixture_transport_active"')));
      assert.ok(lines.some((l) => l.includes('"evt":"run_finished"')));
      assert.ok(!lines.some((l) => /"raw"|"html"|<html/i.test(l)), 'no page content in logs');
      const full = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
      assert.equal(full.run_id, summary.run_id);
      assert.ok(Array.isArray(full.rows));
    } finally {
      fs.unlinkSync(lockPath);
    }
  });

  test('--trigger dashboard: closed list accepted, stored on the run row (dashboard PR 1)', async () => {
    const lockPath = writeTestLock();
    let r;
    try {
      for (let i = 0; i < 60; i++) {
        r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse', '--trigger', 'dashboard'], { JOBSEARCH_CONFIG_LOCK: lockPath });
        const summary = JSON.parse(r.out.trim().split('\n').pop() ?? '{}');
        if (summary.status !== 'locked') break;
        await new Promise((res) => setTimeout(res, 500));
      }
      assert.ok(r);
      const summary = JSON.parse(r.out.trim().split('\n').pop() ?? '{}');
      assert.equal(r.code, 0, `stdout=${r.out} stderr=${r.err}`);
      const row = await client.query('SELECT trigger FROM ic_scan_runs WHERE id = $1', [summary.run_id]);
      assert.equal(row.rows[0].trigger, 'dashboard');
    } finally {
      fs.unlinkSync(lockPath);
    }
  });

  test('--trigger outside the closed list is a visible VALIDATION error, exit 1, no run row created', async () => {
    const lockPath = writeTestLock();
    try {
      const before = await client.query(`SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1`, [PROFILE]);
      const r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse', '--trigger', 'bogus'], { JOBSEARCH_CONFIG_LOCK: lockPath });
      assert.equal(r.code, 1, `stdout=${r.out} stderr=${r.err}`);
      const summary = JSON.parse(r.out.trim());
      assert.equal(summary.ok, false);
      assert.equal(summary.code, 'VALIDATION');
      assert.match(summary.message, /--trigger must be one of cli, dashboard/);
      const after = await client.query(`SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1`, [PROFILE]);
      assert.equal(after.rows[0].n, before.rows[0].n, 'no run row created for a rejected --trigger');
    } finally {
      fs.unlinkSync(lockPath);
    }
  });

  test('config lock mismatch: the unattended run NEVER exits, proceeds with the on-disk config, and the run row carries a CONFIG_LOCK_MISMATCH warning while staying status ok (scan-never-skip fix)', async () => {
    // The real config.lock.json does not match the test config dir hash; no lock file override is passed,
    // so this exercises the real mismatch path bin/scan.js hits on every unattended run against a drifted
    // config.
    let r;
    for (let i = 0; i < 60; i++) {
      r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse']);
      if (!/"status":"locked"/.test(r.out)) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(r);
    assert.equal(r.code, 0, `stdout=${r.out} stderr=${r.err}`);
    const summary = JSON.parse(r.out.trim().split('\n').pop() ?? '{}');
    assert.equal(summary.ok, true);
    assert.equal(summary.status, 'ok', 'a run carrying only a warning must stay ok, never partial/failed');
    const q = await client.query('SELECT status, errors FROM ic_scan_runs WHERE id = $1', [summary.run_id]);
    assert.equal(q.rows[0].status, 'ok');
    const warnings = q.rows[0].errors.filter((e) => e.code === 'CONFIG_LOCK_MISMATCH');
    assert.equal(warnings.length, 1, `expected exactly one CONFIG_LOCK_MISMATCH warning, got ${JSON.stringify(q.rows[0].errors)}`);
    assert.equal(warnings[0].severity, 'warning');
    assert.equal(warnings[0].source, null);
    assert.ok(typeof warnings[0].remedy === 'string' && warnings[0].remedy.length > 0);
  });

  test('rubric present, sidecar missing: the run row carries a RUBRIC_UNLOCKED warning and stays ok; rubric absent (the normal test config dir) never carries it (scan-never-skip fix)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cli-rubric-'));
    try {
      for (const name of CONFIG_FILES) fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(tmp, name));
      fs.writeFileSync(path.join(tmp, 'triage-candidate.md'), 'Damian Mobley, CTO, Houston TX.\n');
      // Sidecar deliberately NOT written -- present rubric + missing sidecar is exactly the RUBRIC_UNLOCKED
      // trigger. A matching config.lock.json isolates this from a simultaneous CONFIG_LOCK_MISMATCH.
      const lockPath = path.join(tmp, 'config.lock.json');
      fs.writeFileSync(lockPath, JSON.stringify({ sha256: computeConfigHash(tmp), files: [...CONFIG_FILES], updated_at: new Date().toISOString() }) + '\n');
      let r;
      for (let i = 0; i < 60; i++) {
        r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse'], { JOBSEARCH_CONFIG_DIR: tmp, JOBSEARCH_CONFIG_LOCK: lockPath });
        if (!/"status":"locked"/.test(r.out)) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      assert.ok(r);
      assert.equal(r.code, 0, `stdout=${r.out} stderr=${r.err}`);
      const summary = JSON.parse(r.out.trim().split('\n').pop() ?? '{}');
      assert.equal(summary.status, 'ok');
      const q = await client.query('SELECT status, errors FROM ic_scan_runs WHERE id = $1', [summary.run_id]);
      assert.equal(q.rows[0].status, 'ok');
      const rubricWarnings = q.rows[0].errors.filter((e) => e.code === 'RUBRIC_UNLOCKED');
      assert.equal(rubricWarnings.length, 1);
      assert.equal(rubricWarnings[0].severity, 'warning');
      assert.match(rubricWarnings[0].remedy, /config-lock\.js --write/);

      // Now write the sidecar and rerun: the warning must disappear (present + matching sidecar = locked).
      writeTriageCandidateLock(tmp);
      let r2;
      for (let i = 0; i < 60; i++) {
        r2 = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse'], { JOBSEARCH_CONFIG_DIR: tmp, JOBSEARCH_CONFIG_LOCK: lockPath });
        if (!/"status":"locked"/.test(r2.out)) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      assert.ok(r2);
      assert.equal(r2.code, 0, `stdout=${r2.out} stderr=${r2.err}`);
      const summary2 = JSON.parse(r2.out.trim().split('\n').pop() ?? '{}');
      const q2 = await client.query('SELECT errors FROM ic_scan_runs WHERE id = $1', [summary2.run_id]);
      assert.equal(q2.rows[0].errors.filter((e) => e.code === 'RUBRIC_UNLOCKED').length, 0, 'a locked rubric must never warn');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unknown source exits 1 with a VALIDATION error and no run row (config-lock mismatch never blocks this: it warns and proceeds into source resolution, which is what actually fails)', async () => {
    const before = await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE]);
    const r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'monster']);
    assert.equal(r.code, 1);
    assert.match(r.out, /VALIDATION/);
    const after2 = await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE]);
    assert.equal(after2.rows[0].n, before.rows[0].n);
  });
});
