// @ts-check
/**
 * src/core/scan-wait.js (fix for the 2026-09-04 auto-apply/scan race): classifyScanState()'s total
 * classification of the latest ic_scan_runs row, and waitForScan()'s two-deadline poll loop -- all against
 * fakes, no real database, no real clock (a `clock` seam avoids the `Date.now()` monkey-patching gotcha:
 * `new Date()` does not observe an overridden `Date.now`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScanState, localDeadline, waitForScan } from '../src/core/scan-wait.js';

const TZ = 'America/Chicago';
// 2026-09-04 12:00:00Z is 07:00 America/Chicago (CDT, UTC-5) on that date -- comfortably inside the
// 06:55-08:00 window this fix exists for.
const NOON_UTC = new Date('2026-09-04T12:00:00.000Z');

describe('classifyScanState: pure, total classification', () => {
  test('no row at all -> never_started', () => {
    const c = classifyScanState(null, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'never_started');
    assert.equal(c.detail.runId, null);
  });

  test('status ok, started today -> finished_today', () => {
    const c = classifyScanState({ id: 1, status: 'ok', started_at: NOON_UTC, heartbeat_at: NOON_UTC }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'finished_today');
  });

  test('status partial, started today -> finished_today (partial counts as finished)', () => {
    const c = classifyScanState({ id: 1, status: 'partial', started_at: NOON_UTC }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'finished_today');
  });

  test('status ok, started BEFORE local midnight (yesterday) -> never_started, never finished_today', () => {
    const yesterday = new Date(NOON_UTC.getTime() - 25 * 3600000);
    const c = classifyScanState({ id: 1, status: 'ok', started_at: yesterday }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'never_started');
  });

  test('status failed, started today -> failed', () => {
    const c = classifyScanState({ id: 1, status: 'failed', started_at: NOON_UTC }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'failed');
  });

  test('status locked, started today -> failed (locked is treated the same as failed)', () => {
    const c = classifyScanState({ id: 1, status: 'locked', started_at: NOON_UTC }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'failed');
  });

  test('status failed, started before local midnight -> never_started (an old failure does not count today)', () => {
    const yesterday = new Date(NOON_UTC.getTime() - 25 * 3600000);
    const c = classifyScanState({ id: 1, status: 'failed', started_at: yesterday }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'never_started');
  });

  test('status running, fresh heartbeat -> running', () => {
    const c = classifyScanState({ id: 1, status: 'running', started_at: NOON_UTC, heartbeat_at: NOON_UTC }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'running');
  });

  test('status running, heartbeat exactly at the stale threshold -> stalled (>= is stale, spec: "at least this many minutes old")', () => {
    const staleHeartbeat = new Date(NOON_UTC.getTime() - 10 * 60000);
    const c = classifyScanState({ id: 1, status: 'running', started_at: NOON_UTC, heartbeat_at: staleHeartbeat }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'stalled');
  });

  test('status running, heartbeat one minute short of stale -> running', () => {
    const freshEnough = new Date(NOON_UTC.getTime() - 9 * 60000);
    const c = classifyScanState({ id: 1, status: 'running', started_at: NOON_UTC, heartbeat_at: freshEnough }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'running');
  });

  test('status running, heartbeat missing entirely -> stalled (never assumed fresh)', () => {
    const c = classifyScanState({ id: 1, status: 'running', started_at: NOON_UTC, heartbeat_at: null }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'stalled');
  });

  test('a status this classification has never seen a shape for -> unknown, never silently bucketed elsewhere', () => {
    const c = classifyScanState({ id: 1, status: 'quantum', started_at: NOON_UTC }, NOON_UTC, TZ, 10);
    assert.equal(c.state, 'unknown');
  });

  test('every classification carries the run id in detail (except never_started with no row)', () => {
    const c = classifyScanState({ id: 42, status: 'running', started_at: NOON_UTC, heartbeat_at: NOON_UTC }, NOON_UTC, TZ, 10);
    assert.equal(c.detail.runId, 42);
  });
});

describe('localDeadline: HH:MM -> local wall-clock Date', () => {
  test('07:40 America/Chicago on 2026-09-04 CDT is 12:40:00Z', () => {
    const d = localDeadline(NOON_UTC, TZ, '07:40');
    assert.equal(d.toISOString(), '2026-09-04T12:40:00.000Z');
  });
  test('07:55 America/Chicago on 2026-09-04 CDT is 12:55:00Z', () => {
    const d = localDeadline(NOON_UTC, TZ, '07:55');
    assert.equal(d.toISOString(), '2026-09-04T12:55:00.000Z');
  });
});

/** A fake, independently-advanced clock: each call to sleep() also advances it, so waitForScan's own
 * deadline math is fully deterministic without touching the real clock or Date.now. */
function fakeClockAndSleep(startMs) {
  let t = startMs;
  return {
    clock: () => new Date(t),
    sleep: async (ms) => { t += ms; },
  };
}

describe('waitForScan: two-deadline poll loop', () => {
  test('finished_today resolves immediately, no deadline hit, exactly one poll', async () => {
    const client = { async query() { return { rows: [{ id: 1, status: 'ok', started_at: NOON_UTC, heartbeat_at: NOON_UTC }] }; } };
    const { clock, sleep } = fakeClockAndSleep(NOON_UTC.getTime());
    const result = await waitForScan(client, {
      timezone: TZ, softDeadline: localDeadline(NOON_UTC, TZ, '07:40'), hardDeadline: localDeadline(NOON_UTC, TZ, '07:55'),
      pollSeconds: 60, staleHeartbeatMinutes: 10, clock, sleep,
    });
    assert.equal(result.state, 'finished_today');
    assert.equal(result.deadlineHit, null);
    assert.equal(result.polls, 1);
  });

  test('never_started polls until the SOFT deadline, then returns without ever reaching the hard deadline', async () => {
    const client = { async query() { return { rows: [] }; } };
    const { clock, sleep } = fakeClockAndSleep(NOON_UTC.getTime());
    const result = await waitForScan(client, {
      timezone: TZ, softDeadline: localDeadline(NOON_UTC, TZ, '07:40'), hardDeadline: localDeadline(NOON_UTC, TZ, '07:55'),
      pollSeconds: 60, staleHeartbeatMinutes: 10, clock, sleep,
    });
    assert.equal(result.state, 'never_started');
    assert.equal(result.deadlineHit, 'soft');
    assert.ok(result.polls > 1); // it actually polled, not a single-shot
  });

  test('a row that flips from never_started to running mid-wait re-buckets to the HARD deadline', async () => {
    // A tiny indirection so the fake query below can read "now" without importing the clock closure itself.
    const clockRef = { current: NOON_UTC.getTime() };
    let calls = 0;
    const client = {
      async query() {
        calls++;
        // First few polls: no row (never_started). After that: a running row with a fresh heartbeat that
        // tracks along with the fake clock, so it never itself goes stale.
        if (calls <= 2) return { rows: [] };
        return { rows: [{ id: 9, status: 'running', started_at: NOON_UTC, heartbeat_at: new Date(clockRef.current) }] };
      },
    };
    const { clock, sleep } = fakeClockAndSleep(NOON_UTC.getTime());
    const wrappedClock = () => { const d = clock(); clockRef.current = d.getTime(); return d; };
    const result = await waitForScan(client, {
      timezone: TZ, softDeadline: localDeadline(NOON_UTC, TZ, '07:40'), hardDeadline: localDeadline(NOON_UTC, TZ, '07:55'),
      pollSeconds: 60, staleHeartbeatMinutes: 10, clock: wrappedClock, sleep,
    });
    // It must have polled PAST the soft deadline (07:40) since it turned into a running scan by then, and
    // only stopped at the hard deadline (07:55) -- proof the applicable deadline migrated mid-wait.
    assert.equal(result.state, 'running');
    assert.equal(result.deadlineHit, 'hard');
    const hard = localDeadline(NOON_UTC, TZ, '07:55');
    assert.ok(clockRef.current >= hard.getTime());
  });

  test('running with a stale heartbeat polls until the HARD deadline, resolving stalled', async () => {
    const staleHeartbeat = new Date(NOON_UTC.getTime() - 20 * 60000);
    const client = { async query() { return { rows: [{ id: 5, status: 'running', started_at: NOON_UTC, heartbeat_at: staleHeartbeat }] }; } };
    const { clock, sleep } = fakeClockAndSleep(NOON_UTC.getTime());
    const result = await waitForScan(client, {
      timezone: TZ, softDeadline: localDeadline(NOON_UTC, TZ, '07:40'), hardDeadline: localDeadline(NOON_UTC, TZ, '07:55'),
      pollSeconds: 60, staleHeartbeatMinutes: 10, clock, sleep,
    });
    assert.equal(result.state, 'stalled');
    assert.equal(result.deadlineHit, 'hard');
  });

  test('a query error classifies unknown and is bounded by the SOFT deadline', async () => {
    const client = { async query() { throw new Error('db unreachable'); } };
    const { clock, sleep } = fakeClockAndSleep(NOON_UTC.getTime());
    const result = await waitForScan(client, {
      timezone: TZ, softDeadline: localDeadline(NOON_UTC, TZ, '07:40'), hardDeadline: localDeadline(NOON_UTC, TZ, '07:55'),
      pollSeconds: 60, staleHeartbeatMinutes: 10, clock, sleep,
    });
    assert.equal(result.state, 'unknown');
    assert.equal(result.deadlineHit, 'soft');
  });

  test('the soft deadline already past on entry: evaluated exactly once, no sleep/poll at all', async () => {
    let queryCalls = 0;
    const client = { async query() { queryCalls++; return { rows: [] }; } };
    let sleepCalls = 0;
    const pastNoon = new Date(NOON_UTC.getTime() + 3600000); // 08:00 local, an hour past the 07:40 soft deadline
    const result = await waitForScan(client, {
      timezone: TZ, softDeadline: localDeadline(NOON_UTC, TZ, '07:40'), hardDeadline: localDeadline(NOON_UTC, TZ, '07:55'),
      pollSeconds: 60, staleHeartbeatMinutes: 10, clock: () => pastNoon, sleep: async () => { sleepCalls++; },
    });
    assert.equal(result.state, 'never_started');
    assert.equal(result.deadlineHit, 'soft');
    assert.equal(queryCalls, 1);
    assert.equal(sleepCalls, 0);
  });

  test('the hard deadline already past on entry for a running scan: evaluated exactly once, no polling', async () => {
    const wayPast = new Date(NOON_UTC.getTime() + 4 * 3600000); // 11:00 local, well past 07:55
    // Heartbeat tracks the fake clock so this row reads as genuinely "running", not "stalled" -- isolating
    // the assertion under test (single-poll, hard-deadline short-circuit) from heartbeat freshness.
    const client = { async query() { return { rows: [{ id: 1, status: 'running', started_at: NOON_UTC, heartbeat_at: wayPast }] }; } };
    let sleepCalls = 0;
    const result = await waitForScan(client, {
      timezone: TZ, softDeadline: localDeadline(NOON_UTC, TZ, '07:40'), hardDeadline: localDeadline(NOON_UTC, TZ, '07:55'),
      pollSeconds: 60, staleHeartbeatMinutes: 10, clock: () => wayPast, sleep: async () => { sleepCalls++; },
    });
    assert.equal(result.state, 'running');
    assert.equal(result.deadlineHit, 'hard');
    assert.equal(sleepCalls, 0);
  });
});
