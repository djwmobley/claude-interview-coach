// @ts-check
/**
 * src/core/running-marker.js (activity pill spec item 2): fresh/stale-by-age/stale-by-dead-pid/malformed
 * marker classification, path resolution, and the best-effort write/delete helpers. No database, no
 * network -- a plain temp directory per test file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runningMarkerPath, writeRunningMarker, deleteRunningMarker, isPidAlive, readLiveMarker, STALE_MARKER_MS,
} from '../src/core/running-marker.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'running-marker-test-'));
}

describe('runningMarkerPath()', () => {
  test('joins logDir and "<name>-running.json"', () => {
    assert.equal(runningMarkerPath('/var/log/job-search', 'auto-apply'), path.join('/var/log/job-search', 'auto-apply-running.json'));
    assert.equal(runningMarkerPath('/var/log/job-search', 'confirm'), path.join('/var/log/job-search', 'confirm-running.json'));
  });
});

describe('writeRunningMarker() / deleteRunningMarker()', () => {
  test('writes {pid, started_at, run_id} and creates the directory if missing', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'nested', 'auto-apply-running.json');
    writeRunningMarker(file, { pid: 12345, startedAt: new Date('2026-09-05T06:55:00.000Z'), runId: 42 });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, { pid: 12345, started_at: '2026-09-05T06:55:00.000Z', run_id: 42 });
  });

  test('run_id defaults to null when omitted', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'confirm-running.json');
    writeRunningMarker(file, { pid: 1, startedAt: new Date('2026-09-05T07:45:00.000Z') });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.run_id, null);
  });

  test('deleteRunningMarker() removes an existing file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'auto-apply-running.json');
    writeRunningMarker(file, { pid: 1, startedAt: new Date() });
    assert.ok(fs.existsSync(file));
    deleteRunningMarker(file);
    assert.ok(!fs.existsSync(file));
  });

  test('deleteRunningMarker() on a missing file never throws', () => {
    const dir = tmpDir();
    assert.doesNotThrow(() => deleteRunningMarker(path.join(dir, 'never-written.json')));
  });
});

describe('isPidAlive()', () => {
  test('the current process pid is alive', () => {
    assert.equal(isPidAlive(process.pid), true);
  });

  test('rejects non-integer / non-positive input without ever calling process.kill', () => {
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-5), false);
    assert.equal(isPidAlive(1.5), false);
  });

  test('a pid that does not exist on this machine is not alive', () => {
    // A pid far above any realistic live process id, chosen to make an ESRCH (no such process) far more
    // likely than an accidental collision with something real currently running on the test machine.
    assert.equal(isPidAlive(2 ** 30 - 1), false);
  });
});

describe('readLiveMarker(): fresh marker', () => {
  test('a fresh marker with a live pid is returned', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'auto-apply-running.json');
    const now = new Date('2026-09-05T06:56:00.000Z');
    writeRunningMarker(file, { pid: process.pid, startedAt: new Date('2026-09-05T06:55:00.000Z'), runId: null });
    const marker = readLiveMarker(file, now);
    assert.deepEqual(marker, { pid: process.pid, started_at: '2026-09-05T06:55:00.000Z', run_id: null });
    // A fresh, live marker is never deleted by the read itself.
    assert.ok(fs.existsSync(file));
  });

  test('a missing marker returns null and touches nothing', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'never-written.json');
    assert.equal(readLiveMarker(file, new Date()), null);
  });
});

describe('readLiveMarker(): stale by age', () => {
  test('a marker older than STALE_MARKER_MS is ignored AND deleted', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'auto-apply-running.json');
    const startedAt = new Date('2026-09-05T00:00:00.000Z');
    const now = new Date(startedAt.getTime() + STALE_MARKER_MS + 1000);
    writeRunningMarker(file, { pid: process.pid, startedAt, runId: null });
    assert.equal(readLiveMarker(file, now), null);
    assert.ok(!fs.existsSync(file), 'stale-by-age marker must be deleted, not just ignored');
  });

  test('a marker exactly at the staleness boundary (not yet over) is still live', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'confirm-running.json');
    const startedAt = new Date('2026-09-05T00:00:00.000Z');
    const now = new Date(startedAt.getTime() + STALE_MARKER_MS - 1000);
    writeRunningMarker(file, { pid: process.pid, startedAt, runId: null });
    assert.notEqual(readLiveMarker(file, now), null);
    assert.ok(fs.existsSync(file));
  });
});

describe('readLiveMarker(): stale by dead pid', () => {
  test('a fresh-looking marker whose pid is not alive is ignored AND deleted', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'auto-apply-running.json');
    const now = new Date('2026-09-05T06:56:00.000Z');
    writeRunningMarker(file, { pid: 2 ** 30 - 1, startedAt: new Date('2026-09-05T06:55:00.000Z'), runId: null });
    assert.equal(readLiveMarker(file, now), null);
    assert.ok(!fs.existsSync(file), 'stale-by-dead-pid marker must be deleted, not just ignored');
  });
});

describe('readLiveMarker(): malformed marker', () => {
  function assertMalformedDeleted(dir, file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    assert.equal(readLiveMarker(file, new Date()), null);
    assert.ok(!fs.existsSync(file), `malformed marker must be deleted: ${contents}`);
  }

  test('invalid JSON is deleted', () => {
    const dir = tmpDir();
    assertMalformedDeleted(dir, path.join(dir, 'a.json'), '{not json');
  });

  test('a JSON array (not an object) is deleted', () => {
    const dir = tmpDir();
    assertMalformedDeleted(dir, path.join(dir, 'a.json'), '[1,2,3]');
  });

  test('missing pid is deleted', () => {
    const dir = tmpDir();
    assertMalformedDeleted(dir, path.join(dir, 'a.json'), JSON.stringify({ started_at: new Date().toISOString() }));
  });

  test('non-numeric pid is deleted', () => {
    const dir = tmpDir();
    assertMalformedDeleted(dir, path.join(dir, 'a.json'), JSON.stringify({ pid: '123', started_at: new Date().toISOString() }));
  });

  test('missing started_at is deleted', () => {
    const dir = tmpDir();
    assertMalformedDeleted(dir, path.join(dir, 'a.json'), JSON.stringify({ pid: process.pid }));
  });

  test('unparseable started_at is deleted', () => {
    const dir = tmpDir();
    assertMalformedDeleted(dir, path.join(dir, 'a.json'), JSON.stringify({ pid: process.pid, started_at: 'not-a-date' }));
  });
});
