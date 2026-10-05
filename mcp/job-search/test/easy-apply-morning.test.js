// @ts-check
/**
 * src/apply/easy-apply-morning.js (assisted Easy Apply in the morning auto-apply run, spec B4/G9/G10):
 * fake clock throughout. Waits for the 09:00 America/Chicago window before any worker run, never starts
 * at or after 19:00, spaces attempts with a 20-40 minute jitter, skips (stops) while an Easy Apply is in
 * flight or awaiting submit, stops on a tripped breaker or an exhausted daily cap, re-drives a leftover
 * approved linkedin_easy application before drafting a new one, and approves with actor 'apply' (so the
 * ordinary auto-apply daily cap is never consumed by Easy Apply).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runEasyApplyMorning } from '../src/apply/easy-apply-morning.js';

/** @param {string} hhmm local CDT on 2026-10-05 */
const at = (hhmm) => new Date(`2026-10-05T${hhmm}:00-05:00`).getTime();

/**
 * @param {{ start: string, inFlightAfterRun?: boolean, breaker?: boolean, cap?: number, leftover?: number[], workerStatus?: string }} o
 */
function harness(o) {
  let clock = at(o.start);
  const log = /** @type {any[]} */ ([]);
  let inFlight = false;
  let nextId = 500;
  const deps = {
    now: () => new Date(clock),
    sleep: async (/** @type {number} */ ms) => { log.push(['sleep', ms]); clock += ms; },
    rand: () => 0.5,
    timezone: 'America/Chicago',
    config: { autoApply: { linkedin: {} } },
    log: () => {},
    state: {
      breakerTripped: async () => Boolean(o.breaker),
      inFlight: async () => inFlight,
      lastAttemptAt: async () => null,
      capRemaining: async () => o.cap ?? 5,
      leftoverApproved: async () => o.leftover ?? [],
    },
    createApplication: async (/** @type {any} */ row) => { log.push(['create', row.listingId, new Date(clock).toISOString()]); return { id: nextId++ }; },
    draft: async (/** @type {number} */ id) => { log.push(['draft', id]); return { ok: true }; },
    approve: async (/** @type {number} */ id, /** @type {string} */ actor) => { log.push(['approve', id, actor]); },
    runWorker: async (/** @type {number} */ id, /** @type {any} */ opts) => {
      log.push(['worker', id, opts.easyApply.trigger, new Date(clock).toISOString()]);
      if (o.inFlightAfterRun !== false) inFlight = true;
      return { ok: true, status: o.workerStatus ?? 'awaiting_submit' };
    },
  };
  return { deps, log };
}

const rows = [{ listingId: 1, sourceUrl: 'https://www.linkedin.com/jobs/view/1/' }, { listingId: 2, sourceUrl: 'https://www.linkedin.com/jobs/view/2/' }];

describe('runEasyApplyMorning', () => {
  test('waits for 09:00, runs one attempt (trigger morning, approve actor apply), then stops while it awaits submit', async () => {
    const h = harness({ start: '07:00' });
    const out = await runEasyApplyMorning(/** @type {any} */ (rows), /** @type {any} */ (h.deps));
    const worker = h.log.filter((x) => x[0] === 'worker');
    assert.equal(worker.length, 1);
    assert.equal(worker[0][2], 'morning');
    assert.ok(new Date(worker[0][3]).getTime() >= at('09:00'), worker[0][3]);
    assert.deepEqual(h.log.find((x) => x[0] === 'approve'), ['approve', 500, 'apply']);
    assert.equal(h.log.filter((x) => x[0] === 'create').length, 1, 'the second candidate is never drafted while one is in flight');
    assert.equal(out.stopReason, 'easy_apply_in_flight');
  });
  test('at or after 19:00 nothing is drafted or run', async () => {
    const h = harness({ start: '19:00' });
    const out = await runEasyApplyMorning(/** @type {any} */ (rows), /** @type {any} */ (h.deps));
    assert.equal(h.log.filter((x) => x[0] === 'create' || x[0] === 'worker').length, 0);
    assert.equal(out.stopReason, 'outside_window');
  });
  test('attempts are spaced 20-40 minutes apart when Damian clears the slot in between', async () => {
    const h = harness({ start: '09:00', inFlightAfterRun: false, workerStatus: 'needs_human' });
    await runEasyApplyMorning(/** @type {any} */ (rows), /** @type {any} */ (h.deps));
    const worker = h.log.filter((x) => x[0] === 'worker');
    assert.equal(worker.length, 2);
    const gap = new Date(worker[1][3]).getTime() - new Date(worker[0][3]).getTime();
    assert.ok(gap >= 20 * 60000 && gap <= 40 * 60000, String(gap));
  });
  test('a tripped breaker or an exhausted cap runs nothing', async () => {
    for (const o of [{ breaker: true }, { cap: 0 }]) {
      const h = harness({ start: '10:00', ...o });
      const out = await runEasyApplyMorning(/** @type {any} */ (rows), /** @type {any} */ (h.deps));
      assert.equal(h.log.filter((x) => x[0] === 'create' || x[0] === 'worker').length, 0);
      assert.equal(out.stopReason, o.breaker ? 'breaker' : 'easy_apply_daily_cap');
    }
  });
  test('a leftover approved linkedin_easy application is re-driven first, without drafting', async () => {
    const h = harness({ start: '10:00', leftover: [77] });
    await runEasyApplyMorning(/** @type {any} */ (rows), /** @type {any} */ (h.deps));
    assert.deepEqual(h.log.filter((x) => x[0] === 'worker').map((x) => x[1]), [77]);
    assert.equal(h.log.filter((x) => x[0] === 'create').length, 0);
  });
  test('a deferred worker result stops the loop', async () => {
    const h = harness({ start: '10:00', inFlightAfterRun: false, workerStatus: 'deferred' });
    const out = await runEasyApplyMorning(/** @type {any} */ (rows), /** @type {any} */ (h.deps));
    assert.equal(h.log.filter((x) => x[0] === 'worker').length, 1);
    assert.equal(out.stopReason, 'worker_deferred');
  });
});
