// @ts-check
/**
 * Unit tests for src/core/ratelimit.js's makeRateLimiter, focused on the detail-pacing fix (spec item 2):
 * waitDetail() draws its jittered gap from detailDelayMs (falling back to delayMs when unset), while
 * wait() always uses delayMs -- and the two share one serialized chain/lastAt per key so a phase switch on
 * the same key never bursts. No real timers: sleep/random/now are all injected and fully deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRateLimiter, jitter, backoffDelay, isRetryableStatus } from '../src/core/ratelimit.js';

function fakeClock() {
  let clock = 0;
  /** @type {number[]} */
  const sleeps = [];
  const sleep = async (/** @type {number} */ ms) => {
    sleeps.push(ms);
    clock += ms;
  };
  return { sleep, sleeps, now: () => clock };
}

test('waitDetail falls back to delayMs when detailDelayMs is not configured', async () => {
  const { sleep, sleeps, now } = fakeClock();
  const limiter = makeRateLimiter({ delayMs: [500, 500], sleep, random: () => 0, now });
  await limiter.wait('k'); // first call ever for this key: no previous lastAt, no sleep
  await limiter.waitDetail('k'); // falls back to delayMs since detailDelayMs is absent
  assert.deepEqual(sleeps, [500]);
});

test('waitDetail draws its own range from detailDelayMs, independent of delayMs', async () => {
  const { sleep, sleeps, now } = fakeClock();
  const limiter = makeRateLimiter({ delayMs: [9000, 9000], detailDelayMs: [200, 200], sleep, random: () => 0, now });
  await limiter.wait('k'); // first call ever: no sleep
  await limiter.waitDetail('k'); // must use detailDelayMs (200), never delayMs (9000)
  assert.deepEqual(sleeps, [200]);
});

test('wait() after waitDetail() on the same key still uses delayMs (they share one lastAt/chain per key)', async () => {
  const { sleep, sleeps, now } = fakeClock();
  const limiter = makeRateLimiter({ delayMs: [1000, 1000], detailDelayMs: [100, 100], sleep, random: () => 0, now });
  await limiter.waitDetail('k'); // first call ever: no sleep
  await limiter.wait('k'); // ordinary list-page wait, must use delayMs
  assert.deepEqual(sleeps, [1000]);
});

test('waitDetail on a DIFFERENT key never waits on the first key\'s timestamp (per-key isolation preserved)', async () => {
  const { sleep, sleeps, now } = fakeClock();
  const limiter = makeRateLimiter({ delayMs: [1000, 1000], detailDelayMs: [50, 50], sleep, random: () => 0, now });
  await limiter.wait('a');
  await limiter.waitDetail('b'); // different key: no previous lastAt for 'b', no sleep
  assert.deepEqual(sleeps, []);
});

test('makeRateLimiter still exposes withRetry/stats unchanged (backward compatibility)', async () => {
  const { sleep, now } = fakeClock();
  const limiter = makeRateLimiter({ delayMs: [0, 0], backoff: { maxDelayMs: 1000, retries: 1 }, sleep, random: () => 0, now });
  const res = await limiter.withRetry('host', async () => ({ status: 200 }));
  assert.equal(res.status, 200);
  assert.deepEqual(limiter.stats(), { waits: 1, retries: 0, aborted: 0 });
});

// Pure helper functions (jitter/backoffDelay/isRetryableStatus) are unchanged by this fix; a couple of
// smoke checks pin that this file's edits did not disturb them.
test('jitter/backoffDelay/isRetryableStatus smoke checks', () => {
  assert.equal(jitter([100, 100]), 100);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(200), false);
  assert.equal(backoffDelay(0, { maxDelayMs: 100000, baseMs: 5000 }), 5000);
});
