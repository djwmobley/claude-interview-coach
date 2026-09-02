// @ts-check
/**
 * src/core/watchdog-state.js: the JSON state file contract between bin/watchdog.js (writer) and
 * bin/remind.js's daily banner (reader). Pure filesystem seam, no DB, no network.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultWatchdogStateFile, readWatchdogState, writeWatchdogState, recordWatchdogRun, ackWatchdogRestarts } from '../src/core/watchdog-state.js';

let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-test-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('defaultWatchdogStateFile', () => {
  test('joins logDir with the fixed filename', () => {
    assert.equal(defaultWatchdogStateFile('/a/b'), path.join('/a/b', 'watchdog-state.json'));
  });
});

describe('readWatchdogState: missing/corrupt file is null, never throws', () => {
  test('missing file -> null', () => {
    assert.equal(readWatchdogState(path.join(tmp, 'nope.json')), null);
  });

  test('unparseable JSON -> null', () => {
    const file = path.join(tmp, 'bad.json');
    fs.writeFileSync(file, '{not json');
    assert.equal(readWatchdogState(file), null);
  });

  test('valid JSON but not an object (e.g. a bare array) -> null', () => {
    const file = path.join(tmp, 'array.json');
    fs.writeFileSync(file, '[1,2,3]');
    assert.equal(readWatchdogState(file), null);
  });

  test('a well-formed state round-trips exactly through write/read', () => {
    const file = path.join(tmp, 'good.json');
    const state = { ts: '2026-09-02T00:00:00.000Z', status: 'ok', consecutive_failures: 0, last_restart_at: null, restarts_since_ack: 0, detail: null };
    writeWatchdogState(file, /** @type {any} */ (state));
    assert.deepEqual(readWatchdogState(file), state);
  });
});

describe('recordWatchdogRun: consecutive_failures and restarts_since_ack bookkeeping', () => {
  test('the very first run on a fresh machine (no prior state file) starts counters at zero/null', () => {
    const file = path.join(tmp, 'fresh.json');
    const now = new Date('2026-09-02T08:00:00.000Z');
    const state = recordWatchdogRun(file, { status: 'ok', detail: null }, now);
    assert.deepEqual(state, { ts: now.toISOString(), status: 'ok', consecutive_failures: 0, last_restart_at: null, restarts_since_ack: 0, detail: null });
    assert.deepEqual(readWatchdogState(file), state);
  });

  test('consecutive down/stuck/error runs increment consecutive_failures; an ok or restarted run resets it to 0', () => {
    const file = path.join(tmp, 'consecutive.json');
    let now = new Date('2026-09-02T08:00:00.000Z');
    let s = recordWatchdogRun(file, { status: 'down', detail: 'd1' }, now);
    assert.equal(s.consecutive_failures, 1);
    now = new Date(now.getTime() + 300000);
    s = recordWatchdogRun(file, { status: 'stuck_foreign_process', detail: 'd2' }, now);
    assert.equal(s.consecutive_failures, 2);
    now = new Date(now.getTime() + 300000);
    s = recordWatchdogRun(file, { status: 'error', detail: 'd3' }, now);
    assert.equal(s.consecutive_failures, 3);
    now = new Date(now.getTime() + 300000);
    s = recordWatchdogRun(file, { status: 'ok', detail: null }, now);
    assert.equal(s.consecutive_failures, 0);
    now = new Date(now.getTime() + 300000);
    s = recordWatchdogRun(file, { status: 'down', detail: 'd4' }, now);
    assert.equal(s.consecutive_failures, 1, 'restarts back from zero, not carried over from before the ok run');
  });

  test('restarted increments restarts_since_ack and stamps last_restart_at; ok/down/stuck/error never touch restarts_since_ack', () => {
    const file = path.join(tmp, 'restarts.json');
    let now = new Date('2026-09-02T08:00:00.000Z');
    let s = recordWatchdogRun(file, { status: 'restarted', detail: null }, now);
    assert.equal(s.restarts_since_ack, 1);
    assert.equal(s.last_restart_at, now.toISOString());
    const firstRestartAt = s.last_restart_at;

    now = new Date(now.getTime() + 300000);
    s = recordWatchdogRun(file, { status: 'ok', detail: null }, now);
    assert.equal(s.restarts_since_ack, 1, 'an ok run neither increments nor resets the restart count');
    assert.equal(s.last_restart_at, firstRestartAt, 'last_restart_at is carried forward, not touched by a non-restart run');

    now = new Date(now.getTime() + 300000);
    s = recordWatchdogRun(file, { status: 'restarted', detail: null }, now);
    assert.equal(s.restarts_since_ack, 2);
    assert.equal(s.last_restart_at, now.toISOString());
  });

  test('a corrupt existing state file is treated as absent (counters restart from zero), not carried forward and not fatal', () => {
    const file = path.join(tmp, 'corrupt.json');
    fs.writeFileSync(file, 'not json at all');
    const s = recordWatchdogRun(file, { status: 'down', detail: 'd' }, new Date('2026-09-02T08:00:00.000Z'));
    assert.equal(s.consecutive_failures, 1);
  });
});

describe('ackWatchdogRestarts', () => {
  test('resets restarts_since_ack to 0 and leaves every other field untouched', () => {
    const file = path.join(tmp, 'ack.json');
    const now = new Date('2026-09-02T08:00:00.000Z');
    recordWatchdogRun(file, { status: 'restarted', detail: null }, now);
    recordWatchdogRun(file, { status: 'restarted', detail: null }, new Date(now.getTime() + 300000));
    const before = readWatchdogState(file);
    assert.equal(before?.restarts_since_ack, 2);

    const acked = ackWatchdogRestarts(file, new Date(now.getTime() + 600000));
    assert.equal(acked?.restarts_since_ack, 0);
    assert.equal(acked?.status, before?.status);
    assert.equal(acked?.last_restart_at, before?.last_restart_at);
    assert.equal(acked?.ts, before?.ts, 'ackWatchdogRestarts never rewrites the run timestamp, only the counter');

    assert.deepEqual(readWatchdogState(file), acked);
  });

  test('a missing state file is a no-op that returns null, never throws or creates a file', () => {
    const file = path.join(tmp, 'no-such-file.json');
    assert.equal(ackWatchdogRestarts(file), null);
    assert.equal(fs.existsSync(file), false);
  });
});
