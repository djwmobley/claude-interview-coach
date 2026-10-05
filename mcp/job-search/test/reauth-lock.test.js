// @ts-check
/**
 * Atomic reauth lock (PR #72 follow-up): acquireReauthLock creates logs/google-reauth.lock with an
 * exclusive create, reclaims a stale lock at most once, never reclaims a live one, and
 * releaseOwnLock deletes only a lock carrying the caller's nonce.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireReauthLock, releaseOwnLock } from '../src/core/google-reauth.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reauth-lock-acquirer.mjs');

/** @type {string} */
let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-lock-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
let seq = 0;
const freshLock = () => path.join(tmp, `lock-${process.pid}-${seq++}.lock`);

/** @param {string} lockFile @param {number} startAt @param {string} nonce @returns {Promise<string>} */
function runAcquirer(lockFile, startAt, nonce) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, lockFile, String(startAt), nonce], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`acquirer exit ${code}: ${err}`))));
  });
}

describe('acquireReauthLock', () => {
  test('two concurrent acquirers in separate processes: exactly one wins (5 rounds)', async () => {
    for (let round = 0; round < 5; round++) {
      const lockFile = freshLock();
      const startAt = Date.now() + 700;
      const results = await Promise.all([
        runAcquirer(lockFile, startAt, `a${round}`.padEnd(32, 'a')),
        runAcquirer(lockFile, startAt, `b${round}`.padEnd(32, 'b')),
      ]);
      assert.equal(results.filter((r) => r === 'ok').length, 1, `round ${round}: ${results.join(',')}`);
      assert.equal(results.filter((r) => r === 'held').length, 1, `round ${round}: ${results.join(',')}`);
    }
  });

  test('a fresh lock file carries pid, started_at, waitMs and nonce', () => {
    const lockFile = freshLock();
    assert.equal(acquireReauthLock(lockFile, new Date(), 60000, 'n'.repeat(32)).ok, true);
    const rec = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.waitMs, 60000);
    assert.equal(rec.nonce, 'n'.repeat(32));
    assert.equal(fs.readdirSync(tmp).some((n) => n.startsWith(path.basename(lockFile)) && n.endsWith('.tmp')), false, 'no tmp file left');
  });

  test('a stale lock (dead pid) is reclaimed', () => {
    const lockFile = freshLock();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, started_at: new Date().toISOString(), waitMs: 600000, nonce: 'old' }));
    assert.equal(acquireReauthLock(lockFile, new Date(), 600000, 'mine'.padEnd(32, 'x')).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'mine'.padEnd(32, 'x'));
  });

  test('a stale lock (live pid, past its waitMs + grace) is reclaimed', () => {
    const lockFile = freshLock();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), waitMs: 60000, nonce: 'old' }));
    assert.equal(acquireReauthLock(lockFile, new Date(), 600000, 'mine2'.padEnd(32, 'x')).ok, true);
  });

  test('a live lock is never reclaimed', () => {
    const lockFile = freshLock();
    const live = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), waitMs: 600000, nonce: 'live' });
    fs.writeFileSync(lockFile, live);
    assert.equal(acquireReauthLock(lockFile, new Date(), 600000, 'other'.padEnd(32, 'x')).ok, false);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), live);
  });
});

describe('releaseOwnLock', () => {
  test('a non-owner (different nonce) leaves the lock intact', () => {
    const lockFile = freshLock();
    acquireReauthLock(lockFile, new Date(), 600000, 'owner'.padEnd(32, 'o'));
    releaseOwnLock(lockFile, 'intruder'.padEnd(32, 'i'));
    assert.equal(fs.existsSync(lockFile), true);
    releaseOwnLock(lockFile, '');
    assert.equal(fs.existsSync(lockFile), true);
  });
  test('the owner (matching nonce) removes it', () => {
    const lockFile = freshLock();
    acquireReauthLock(lockFile, new Date(), 600000, 'owner'.padEnd(32, 'o'));
    releaseOwnLock(lockFile, 'owner'.padEnd(32, 'o'));
    assert.equal(fs.existsSync(lockFile), false);
  });
});
