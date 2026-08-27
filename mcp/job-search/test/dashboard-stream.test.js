// @ts-check
/**
 * src/dashboard/stream.js unit tests (pr2-spec-decisions.md "SSE"). Fake response objects stand in for
 * real sockets; deps.withClient is a stub returning canned watermark/run rows so the polling logic is
 * exercised on a fast, deterministic clock (short intervals) rather than the real 2 s/10 s/25 s cadence.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createStreamHub, MAX_STREAMS } from '../src/dashboard/stream.js';

function fakeRes() {
  const res = /** @type {any} */ (new EventEmitter());
  res.chunks = [];
  res.ended = false;
  res.write = (chunk) => {
    if (res.failNextWrite) throw new Error('write failed');
    res.chunks.push(String(chunk));
    return true;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

describe('addStream: capacity cap', () => {
  test('accepts up to MAX_STREAMS, refuses beyond that', () => {
    const hub = createStreamHub({ withClient: async () => ({ rows: [{ events_max: 0, followups_max: 0 }] }) }, { pingMs: 1e9, watermarkMs: 1e9, runPollMs: 1e9 });
    const accepted = [];
    for (let i = 0; i < MAX_STREAMS + 2; i++) {
      const res = fakeRes();
      accepted.push(hub.addStream(res));
    }
    assert.equal(accepted.filter(Boolean).length, MAX_STREAMS);
    assert.equal(accepted.filter((x) => !x).length, 2);
    assert.equal(hub.size(), MAX_STREAMS);
    hub.stopAll();
  });

  test('close/error handlers are registered before the stream joins the set, and remove it', () => {
    const hub = createStreamHub({ withClient: async () => ({ rows: [{ events_max: 0, followups_max: 0 }] }) }, { pingMs: 1e9, watermarkMs: 1e9, runPollMs: 1e9 });
    const res = fakeRes();
    hub.addStream(res);
    assert.equal(hub.size(), 1);
    res.emit('close');
    assert.equal(hub.size(), 0);
    hub.stopAll();
  });

  test('a write failure removes the stream and never throws out of broadcast (via notifyChanged)', () => {
    const hub = createStreamHub({ withClient: async () => ({ rows: [{ events_max: 0, followups_max: 0 }] }) }, { pingMs: 1e9, watermarkMs: 1e9, runPollMs: 1e9 });
    const bad = fakeRes();
    bad.failNextWrite = true;
    const good = fakeRes();
    hub.addStream(bad);
    hub.addStream(good);
    assert.doesNotThrow(() => hub.notifyChanged('events'));
    assert.equal(hub.size(), 1);
    assert.ok(good.chunks.some((c) => c.includes('"kind":"events"')));
    hub.stopAll();
  });
});

describe('watermark polling', () => {
  test('emits changed {kind:"events"} only when the max id actually advances', async () => {
    let eventsMax = 5;
    const deps = { withClient: async (fn) => fn({ query: async () => ({ rows: [{ events_max: eventsMax, followups_max: 0 }] }) }) };
    const hub = createStreamHub(deps, { watermarkMs: 15, pingMs: 1e9, runPollMs: 1e9 });
    const res = fakeRes();
    hub.addStream(res);
    await new Promise((r) => setTimeout(r, 30)); // first poll just establishes the baseline
    assert.equal(res.chunks.filter((c) => c.includes('event: changed')).length, 0);
    eventsMax = 9;
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(res.chunks.some((c) => c.includes('event: changed')));
    hub.stopAll();
  });
});

describe('registerStreamRoute', () => {
  test('refuses a new connection with 503 once the hub is at capacity', async () => {
    const { registerStreamRoute } = await import('../src/dashboard/stream.js');
    const { createRouter } = await import('../src/dashboard/router.js');
    const { DashboardError } = await import('../src/dashboard/http.js');
    const hub = createStreamHub({ withClient: async () => ({ rows: [{ events_max: 0, followups_max: 0 }] }) }, { pingMs: 1e9, watermarkMs: 1e9, runPollMs: 1e9 });
    for (let i = 0; i < MAX_STREAMS; i++) hub.addStream(fakeRes());
    const router = createRouter();
    registerStreamRoute(router, hub);
    const dispatched = router.dispatch('/api/stream', 'GET');
    assert.ok(dispatched && 'route' in dispatched);
    const res = fakeRes();
    await assert.rejects(
      /** @type {any} */ (dispatched).route.handler({ res }),
      (err) => err instanceof DashboardError && err.status === 503 && err.code === 'STREAM_CAPACITY',
    );
    hub.stopAll();
  });
});
