// @ts-check
/**
 * lib/sse.js failure-classification tests, using an injectable fake EventSource (node:test has no
 * global EventSource) and node:test's built-in timer mocking so the retry/poll timers are deterministic
 * rather than real 1s/5s/40s waits. Covers pr3-spec-decisions.md section 5, including rule 4 (added in
 * response to independent review comment 5440498360, nit 2): a 503 STREAM_CAPACITY response never fires
 * `open`, so the observable proxy for it is "failed before ever connecting once" -> immediate fallback
 * to polling on the very first failure, not the normal two-failure grace period.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSseClient } from '../src/dashboard/public/lib/sse.js';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    /** @type {Record<string, Array<(ev: any) => void>>} */
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type, detail) {
    for (const fn of this.listeners[type] ?? []) fn(detail ?? {});
  }

  /** Simulate a real successful connection. */
  triggerOpen() {
    this.readyState = FakeEventSource.OPEN;
    this.emit('open');
  }

  /** Simulate an immediate rejection (503 STREAM_CAPACITY, connection refused): CLOSED without ever opening. */
  triggerImmediateError() {
    this.readyState = FakeEventSource.CLOSED;
    this.emit('error');
  }

  /** Simulate a previously-open connection dropping. */
  triggerDropError() {
    this.readyState = FakeEventSource.CLOSED;
    this.emit('error');
  }
}

/** @param {{}} [opts] */
function makeClient(t, extra = {}) {
  FakeEventSource.instances = [];
  const events = { degraded: [], pollTicks: 0 };
  const client = createSseClient({
    url: '/api/stream',
    onRun: () => {},
    onChanged: () => {},
    onPollTick: () => { events.pollTicks += 1; },
    onDegraded: (d) => events.degraded.push(d),
    EventSourceImpl: /** @type {any} */ (FakeEventSource),
    ...extra,
  });
  return { client, events };
}

describe('createSseClient: rule 4, an immediate rejection before ever connecting skips straight to polling', () => {
  test('a single immediate error (never reached open) triggers polling with no second attempt', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { events } = makeClient(t);
    const first = FakeEventSource.instances[0];
    assert.equal(FakeEventSource.instances.length, 1);

    first.triggerImmediateError();

    // No setTimeout(connect, 1000) should have been scheduled for a retry: polling starts immediately.
    assert.deepEqual(events.degraded, [true]);
    assert.equal(events.pollTicks, 1); // startPolling() calls onPollTick() once synchronously
    assert.equal(FakeEventSource.instances.length, 1, 'no second EventSource should have been created');
  });
});

describe('createSseClient: a connection that DID open still gets the normal two-failure grace period', () => {
  test('one drop after a successful open does not yet fall back; a second one does', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { events } = makeClient(t);
    const first = FakeEventSource.instances[0];
    first.triggerOpen();

    first.triggerDropError();
    assert.deepEqual(events.degraded, [], 'first failure after a real open must not degrade yet');

    // The retry is scheduled via setTimeout(connect, 1000); advance the mocked clock to fire it.
    t.mock.timers.tick(1000);
    assert.equal(FakeEventSource.instances.length, 2, 'a reconnect attempt should have been made');

    const second = FakeEventSource.instances[1];
    second.triggerDropError();
    assert.deepEqual(events.degraded, [true], 'second failure falls back to polling');
  });

  test('a successful reconnect between failures resets the failure count', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const { events } = makeClient(t);
    const first = FakeEventSource.instances[0];
    first.triggerOpen();
    first.triggerDropError();
    t.mock.timers.tick(1000);

    const second = FakeEventSource.instances[1];
    second.triggerOpen();
    second.emit('ping', { data: '{}' }); // any message resets failureCount and marks everConnected

    second.triggerDropError();
    assert.deepEqual(events.degraded, [], 'failure count reset by the successful reconnect; still not degraded');
  });
});
