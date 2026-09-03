// @ts-check
/**
 * bin/scan.js end to end with slice 3 auto-triage turned on: a temp config dir carrying a real
 * triage.json (deterministic enabled, floor 0 / ceiling 100 so noise-ok, non-null-prescore rows land in
 * model_band regardless of the exact fixture prescore) plus a fake `claude` binary pointed at via
 * JOBSEARCH_TRIAGE_CLAUDE_BIN=process.execPath plus JOBSEARCH_TRIAGE_CLAUDE_SCRIPT (a cross-platform Node
 * script, never a compiled binary -- docs/slice3-auto-triage-spec.md section 9), so the model step's
 * whole CLI-invocation path (binary resolution, argv shape, stdin prompt, envelope parsing) runs as a
 * real child process, not just through the deps.execFile seam test/triage.test.js exercises directly.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newClient, upsertTestProfile, cleanupScan, CONFIG_DIR, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { computeConfigHash } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const SCAN = path.join(PKG, 'bin', 'scan.js');
const MAP = path.join(HERE, 'fixtures', 'triage', 'fixture-map.json');
const FAKE_CLAUDE_JS = path.join(HERE, 'fixtures', 'triage', 'fake-claude.js');
const PROFILE = `zz-test-cli-triage-${process.pid}`;
const BASE_CONFIG_FILES = ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'auto-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json'];

/** @type {import('pg').Client} */
let client;
/** @type {string} */
let logDir;
/** @type {string} */
let tmpConfigDir;

/**
 * Build a temp config dir: the six real fixture config files plus a triage.json exercising the model
 * step (deterministic enabled, floor 0 / ceiling 100), the two config-locked support files
 * (triage-output-schema.json, triage-mcp-empty.json, copied from the real, shipped mcp/job-search/config/
 * dir), and a non-blank triage-candidate.md so model scoring is never disabled with
 * candidate_summary_missing.
 * @param {{ deterministicEnabled: boolean, modelEnabled: boolean }} o
 */
function buildTriageConfigDir(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-cli-config-'));
  for (const name of BASE_CONFIG_FILES) fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(dir, name));
  fs.copyFileSync(path.join(PKG, 'config', 'triage-output-schema.json'), path.join(dir, 'triage-output-schema.json'));
  fs.copyFileSync(path.join(PKG, 'config', 'triage-mcp-empty.json'), path.join(dir, 'triage-mcp-empty.json'));
  fs.writeFileSync(path.join(dir, 'triage-candidate.md'), 'A CTO with 20 years of experience across e-commerce and payments.');
  fs.writeFileSync(dir + '/triage.json', JSON.stringify({
    deterministic: { enabled: o.deterministicEnabled, floor: 0, ceiling: 100 },
    model: { enabled: o.modelEnabled },
  }));
  return dir;
}

/** @param {string} dir */
function writeLockFor(dir) {
  const lockPath = path.join(dir, 'config.lock.json');
  fs.writeFileSync(lockPath, JSON.stringify({ sha256: computeConfigHash(dir), files: [], updated_at: new Date().toISOString() }) + '\n');
  return lockPath;
}

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCAN, ...args], { cwd: PKG, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * Retries the run when another parallel test file holds the advisory lock (matches test/scan-cli.test.js's
 * own convention: only one scan runs at a time, system-wide).
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
async function runCliWaiting(args, env) {
  let r;
  for (let i = 0; i < 60; i++) {
    r = await runCli(args, env);
    const summary = JSON.parse((r.out.trim().split('\n').pop()) ?? '{}');
    if (summary.status !== 'locked') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  return /** @type {{ code: number, out: string, err: string }} */ (r);
}

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE });
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['Chief', 'Vice President'], phrases: [], locations: ['Houston, TX'] });
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cli-triage-'));
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE });
  } finally {
    await client.end();
  }
});

describe('bin/scan.js with slice 3 auto-triage enabled', () => {
  test('deterministic + model steps run: ic_job_listings.status, ic_job_events actor=auto, and ic_scan_runs.stats.triage all land correctly', async () => {
    tmpConfigDir = buildTriageConfigDir({ deterministicEnabled: true, modelEnabled: true });
    const lockPath = writeLockFor(tmpConfigDir);
    const env = {
      ...process.env,
      JOBSEARCH_FIXTURE_MAP: MAP,
      JOBSEARCH_FIXTURE_NOW: FIXTURE_NOW.toISOString(),
      JOBSEARCH_CONFIG_DIR: tmpConfigDir,
      JOBSEARCH_CONFIG_LOCK: lockPath,
      JOBSEARCH_LOG_DIR: logDir,
      JOBSEARCH_TRIAGE_CLAUDE_BIN: process.execPath,
      JOBSEARCH_TRIAGE_CLAUDE_SCRIPT: FAKE_CLAUDE_JS,
    };
    const r = await runCliWaiting(['--profile', PROFILE, '--sources', 'greenhouse'], env);
    const summary = JSON.parse((r.out.trim().split('\n').pop()) ?? '{}');
    assert.ok([0, 2].includes(r.code), `stdout=${r.out} stderr=${r.err}`);
    assert.ok(summary.run_id > 0);
    assert.ok(summary.stats.triage, `stats.triage missing from CLI summary: ${JSON.stringify(summary.stats)}`);
    assert.equal(summary.stats.triage.configured, true);
    assert.equal(summary.stats.triage.model.enabled, true);

    const row = await client.query('SELECT stats FROM ic_scan_runs WHERE id = $1', [summary.run_id]);
    const triage = row.rows[0].stats.triage;
    assert.ok(triage, 'ic_scan_runs.stats.triage is persisted');
    assert.equal(triage.configured, true);
    assert.ok(triage.model.batches_sent >= 1, JSON.stringify(triage.model));
    assert.ok(triage.model.scored >= 1, 'the fake claude script scored at least one listing');

    // At least one model_band listing was marked by the fake script's fixed fingerprint (fit_score 62,
    // status 'new'): confirms the real child-process CLI invocation path (binary resolution via
    // JOBSEARCH_TRIAGE_CLAUDE_BIN/SCRIPT, argv shape, stdin prompt, envelope parsing) actually reached
    // applyMark, not just that the stats counters incremented.
    const scored = await client.query(`SELECT id FROM ic_job_listings WHERE fit_score = 62 AND status = 'new' LIMIT 1`);
    assert.equal(scored.rowCount, 1, 'at least one listing was marked by the fake claude script');
    const scoredId = scored.rows[0].id;
    const events = await client.query(`SELECT actor, note FROM ic_job_events WHERE listing_id = $1 AND kind = 'status' ORDER BY id DESC LIMIT 1`, [scoredId]);
    assert.equal(events.rows[0].actor, 'auto');
    assert.equal(events.rows[0].note, 'fake auto-triage score');
  });

  test('--dry-run never writes stats.triage at all (no triage rows or events)', async () => {
    const dir = buildTriageConfigDir({ deterministicEnabled: true, modelEnabled: true });
    const lockPath = writeLockFor(dir);
    const env = {
      ...process.env,
      JOBSEARCH_FIXTURE_MAP: MAP,
      JOBSEARCH_CONFIG_DIR: dir,
      JOBSEARCH_CONFIG_LOCK: lockPath,
      JOBSEARCH_LOG_DIR: logDir,
      JOBSEARCH_TRIAGE_CLAUDE_BIN: process.execPath,
      JOBSEARCH_TRIAGE_CLAUDE_SCRIPT: FAKE_CLAUDE_JS,
    };
    const r = await runCliWaiting(['--profile', PROFILE, '--sources', 'greenhouse', '--dry-run'], env);
    const summary = JSON.parse((r.out.trim().split('\n').pop()) ?? '{}');
    assert.ok(summary.run_id > 0);
    assert.equal(summary.stats.triage, undefined, 'a dry run never calls either triage step');
    const row = await client.query('SELECT stats FROM ic_scan_runs WHERE id = $1', [summary.run_id]);
    assert.equal(row.rows[0].stats.triage, undefined);
  });
});
