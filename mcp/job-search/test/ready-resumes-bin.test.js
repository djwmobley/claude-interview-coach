// @ts-check
/**
 * bin/ready-resumes.js (R6): it runs after the morning auto-apply run. waitForAutoApply returns at once when
 * no auto-apply marker is live, waits while one is, and gives up (warn and proceed) after its bound. The
 * scheduled task script runs bin/auto-apply.js first, then bin/ready-resumes.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForAutoApply, readyResumesSummaryFile } from '../bin/ready-resumes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('waitForAutoApply', () => {
  test('no marker: not_running immediately', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bin-'));
    assert.equal(await waitForAutoApply({ markerFile: path.join(dir, 'auto-apply-running.json'), waitMs: 1000 }), 'not_running');
  });

  test('a live marker (this process) is waited on, then the wait expires', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bin-'));
    const file = path.join(dir, 'auto-apply-running.json');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    let slept = 0;
    let t = Date.now();
    const r = await waitForAutoApply({ markerFile: file, waitMs: 100, pollMs: 50, now: () => new Date(t), sleep: async (ms) => { slept++; t += ms; } });
    assert.equal(r, 'wait_expired');
    assert.ok(slept >= 2);
  });

  test('the marker disappearing mid-wait returns finished', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-bin-'));
    const file = path.join(dir, 'auto-apply-running.json');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const r = await waitForAutoApply({ markerFile: file, waitMs: 60000, pollMs: 1, sleep: async () => { fs.unlinkSync(file); } });
    assert.equal(r, 'finished');
  });

  test('summary file lives in the log dir', () => {
    assert.equal(readyResumesSummaryFile('/x'), path.join('/x', 'ready-resumes-last.json'));
  });
});

describe('A5 wiring: every production resume runner gets the shared spawn lock', () => {
  test('bin/auto-apply.js and bin/dashboard.js pass spawnLock to every application-mode runner', () => {
    const auto = fs.readFileSync(path.join(HERE, '..', 'bin', 'auto-apply.js'), 'utf8');
    const runnerDeps = auto.match(/const runnerDeps = \{[^\n]*\};/g) ?? [];
    assert.ok(runnerDeps.length >= 3);
    for (const d of runnerDeps) assert.match(d, /spawnLock: createAdvisoryLock\(\{ key: RESUME_SPAWN_LOCK_KEY \}\)/);
    const dash = fs.readFileSync(path.join(HERE, '..', 'bin', 'dashboard.js'), 'utf8');
    assert.match(dash, /spawnLock: resumeSpawnLock/);
    assert.match(dash, /createAdvisoryLock\(\{ key: RESUME_SPAWN_LOCK_KEY \}\)/);
  });
});

describe('scripts/register-auto-apply-task.ps1', () => {
  test('runs bin/auto-apply.js, then bin/ready-resumes.js, in that order', () => {
    const script = fs.readFileSync(path.join(HERE, '..', 'scripts', 'register-auto-apply-task.ps1'), 'utf8');
    const a = script.indexOf('$autoApplyScript\'');
    const b = script.indexOf('$readyResumesScript\'');
    assert.ok(script.includes('bin\\ready-resumes.js'));
    assert.ok(a !== -1 && b !== -1 && a < b, 'auto-apply runs before ready-resumes in the task action');
  });
});
