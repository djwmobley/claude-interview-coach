// @ts-check
/**
 * bin/triage-backfill.js: cheap, DB-free coverage of the script's own refusal gate. The script's main()
 * never calls connectDedicated() (src/core/db.js) until after loadConfig() and the
 * present/deterministic.enabled checks both pass, so a temp config dir with a real triage.json carrying
 * deterministic.enabled=false exercises the exit-2 refusal path -- including the config load itself --
 * entirely offline: no PG_DSN, no test database, no `claude` binary. This intentionally does not exercise
 * the live run/dry-run-with-runs paths (those need real ic_job_listings/ic_scan_run_items rows and are
 * covered instead by manual/live verification), and does not import anything from src/core/db.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './helpers/scan-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const SCRIPT = path.join(PKG, 'bin', 'triage-backfill.js');
const BASE_CONFIG_FILES = ['adapters.json', 'ats-boards.json', 'ats-apply.json', 'auto-apply.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json'];

/**
 * Temp config dir carrying the six base config files (loadConfig() throws CONFIG_INVALID without them)
 * plus a triage.json with deterministic.enabled explicitly false, so present=true and the script's
 * second refusal check (not the "not present" one) is the one under test.
 */
function buildDisabledTriageConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-backfill-config-'));
  for (const name of BASE_CONFIG_FILES) fs.copyFileSync(path.join(CONFIG_DIR, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, 'triage.json'), JSON.stringify({ deterministic: { enabled: false }, model: { enabled: false } }));
  return dir;
}

/**
 * @param {string[]} args
 * @param {Record<string, string|undefined>} env
 */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: PKG, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

describe('bin/triage-backfill.js', () => {
  test('--dry-run exits 2 with the deterministic-disabled refusal and never reaches connectDedicated (no PG_DSN set)', async () => {
    const dir = buildDisabledTriageConfigDir();
    // PG_DSN deliberately omitted/blanked: if the script reached connectDedicated() before exiting, it
    // would throw a connection error instead of exiting cleanly with code 2, so a clean exit 2 here is
    // itself proof the DB path was never reached.
    const env = { ...process.env, JOBSEARCH_CONFIG_DIR: dir, PG_DSN: '' };
    const r = await runCli(['--dry-run'], env);
    assert.equal(r.code, 2, `expected exit 2, got ${r.code}. stdout=${r.out} stderr=${r.err}`);
    assert.match(r.out, /refusing to run: config\.triage\.deterministic\.enabled is false/);
  });
});
