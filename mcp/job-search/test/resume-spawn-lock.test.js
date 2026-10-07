// @ts-check
/**
 * src/core/resume-spawn-lock.js (Ready list A5): a session advisory lock on a dedicated connection, shared
 * across processes. A second holder is refused while the first holds it, gets it after release, and a
 * bounded acquire gives up after its wait.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { createAdvisoryLock, RESUME_SPAWN_LOCK_KEY, READY_RESUME_RUN_LOCK_KEY } from '../src/core/resume-spawn-lock.js';
import { LOCK_KEY } from '../src/core/scan-run.js';

const connect = async () => {
  const c = new pg.Client(pgConnectionConfig());
  await c.connect();
  return c;
};

describe('createAdvisoryLock', () => {
  test('keys are distinct from the scan lock and from each other', () => {
    assert.notEqual(RESUME_SPAWN_LOCK_KEY, LOCK_KEY);
    assert.notEqual(READY_RESUME_RUN_LOCK_KEY, LOCK_KEY);
    assert.notEqual(RESUME_SPAWN_LOCK_KEY, READY_RESUME_RUN_LOCK_KEY);
  });

  test('second tryAcquire is refused while held, succeeds after release', async () => {
    const key = 990000000 + (process.pid % 100000);
    const a = createAdvisoryLock({ key, connect });
    const b = createAdvisoryLock({ key, connect });
    const h1 = await a.tryAcquire();
    assert.ok(h1);
    assert.equal(await b.tryAcquire(), null);
    await h1.release();
    const h2 = await b.tryAcquire();
    assert.ok(h2);
    await h2.release();
  });

  test('acquire waits up to waitMs, then gives up with null', async () => {
    const key = 991000000 + (process.pid % 100000);
    const a = createAdvisoryLock({ key, connect });
    const h1 = await a.tryAcquire();
    assert.ok(h1);
    const t0 = Date.now();
    const got = await createAdvisoryLock({ key, connect, pollMs: 20 }).acquire({ waitMs: 80 });
    assert.equal(got, null);
    assert.ok(Date.now() - t0 >= 60);
    await h1.release();
  });
});
