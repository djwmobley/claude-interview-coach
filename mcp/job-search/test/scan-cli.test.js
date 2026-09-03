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
import { computeConfigHash } from '../src/core/config.js';

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
    const a = parseArgs(['--profile', 'p', '--sources', 'greenhouse, lever', '--days', '3', '--max-pages', '2', '--dry-run', '--json', '--launch-chrome', '--accept-config-change']);
    assert.equal(a.profile, 'p');
    assert.deepEqual(a.sources, ['greenhouse', 'lever']);
    assert.equal(a.days, 3);
    assert.equal(a.maxPages, 2);
    assert.equal(a.dryRun, true);
    assert.equal(a.json, null);
    assert.equal(a.launchChrome, true);
    assert.equal(a.acceptConfigChange, true);
    assert.equal(parseArgs(['--json', 'out.json']).json, 'out.json');
    assert.equal(parseArgs([]).trigger, 'cli', 'default trigger is cli (dashboard PR 1)');
    assert.equal(parseArgs(['--trigger', 'dashboard']).trigger, 'dashboard');
  });

  test('cdpReachable is exported and reports false for an unreachable port (dashboard PR 1)', async () => {
    assert.equal(typeof cdpReachable, 'function');
    assert.equal(await cdpReachable('http://127.0.0.1:1'), false);
  });

  test('refuses --launch-chrome on port 9222 and on a non-loopback host', async () => {
    await assert.rejects(launchChrome(/** @type {any} */ ({ SCAN_CDP_URL: 'http://127.0.0.1:9222', CHROME_EXECUTABLE: null, SCAN_PROFILE_DIR: 'x' }), () => {}), /9222/);
    await assert.rejects(launchChrome(/** @type {any} */ ({ SCAN_CDP_URL: 'http://10.0.0.5:9333', CHROME_EXECUTABLE: null, SCAN_PROFILE_DIR: 'x' }), () => {}), /loopback/);
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

  test('config lock mismatch refuses the run with exit 1 unless --accept-config-change', async () => {
    // The real config.lock.json does not match the test config dir hash.
    const r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse']);
    assert.equal(r.code, 1, r.out + r.err);
    const out = JSON.parse(r.out.trim());
    assert.equal(out.code, 'CONFIG_LOCK_MISMATCH');
    // The mismatch refusal happens before runScan() would insert its own run row (spec: no run row
    // means report.js's noScan check never fires, producing a bare [NO SCAN] digest with no reason).
    // bin/scan.js's recordConfigLockMismatchRun writes a lightweight already-finished 'failed' row with
    // the CONFIG_LOCK_MISMATCH error so the daily report can render a loud [LOCK MISMATCH] instead.
    const q = await client.query(
      `SELECT status, errors FROM ic_scan_runs WHERE profile = $1 AND started_at > now() - interval '5 seconds' ORDER BY id DESC LIMIT 1`,
      [PROFILE],
    );
    assert.equal(q.rows.length, 1, 'a failed run row should be written for a config-lock mismatch');
    assert.equal(q.rows[0].status, 'failed');
    assert.equal(q.rows[0].errors.length, 1);
    assert.equal(q.rows[0].errors[0].code, 'CONFIG_LOCK_MISMATCH');
    // This test config dir never includes the gitignored triage-candidate.md (real repos and CI alike),
    // so checkConfigLock()'s detail always takes the "missing" branch here.
    assert.match(q.rows[0].errors[0].message, /missing config file\(s\): triage-candidate\.md/);
    let r2;
    for (let i = 0; i < 60; i++) {
      r2 = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'greenhouse', '--accept-config-change']);
      if (!/"status":"locked"/.test(r2.out)) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(r2);
    assert.equal(r2.code, 0, r2.out + r2.err);
  });

  test('unknown source exits 1 with a VALIDATION error and no run row', async () => {
    const before = await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE]);
    const r = await runCli(['--profile', PROFILE, '--dry-run', '--sources', 'monster', '--accept-config-change']);
    assert.equal(r.code, 1);
    assert.match(r.out, /VALIDATION/);
    const after2 = await client.query('SELECT count(*)::int AS n FROM ic_scan_runs WHERE profile = $1', [PROFILE]);
    assert.equal(after2.rows[0].n, before.rows[0].n);
  });
});
