// @ts-check
/**
 * F13 (carried from the PR4 review): the scan's stats write after the target stages gets an explicit connect
 * and statement timeout. connectDedicated() takes both options; connectBounded() never waits past its limit and
 * closes a connection that arrives late.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectDedicated } from '../src/core/db.js';
import { connectBounded, A8_CONNECT_TIMEOUT_MS, A8_STATEMENT_TIMEOUT_MS } from '../src/core/scan-run.js';

/** @type {Array<{ end: () => Promise<void> }>} */
const open = [];
after(async () => { for (const c of open) await c.end().catch(() => {}); });

describe('connectDedicated timeouts', () => {
  test('a statement timeout cancels a slow query with SQLSTATE 57014', async () => {
    const c = await connectDedicated({ statementTimeoutMs: 100 });
    open.push(c);
    await assert.rejects(c.query('SELECT pg_sleep(2)'), (/** @type {any} */ e) => e.code === '57014');
    assert.equal((await c.query('SELECT 1 AS n')).rows[0].n, 1, 'the connection is still usable');
  });

  test('without options the connection has no statement timeout (the scan lock client keeps its behavior)', async () => {
    const c = await connectDedicated();
    open.push(c);
    assert.equal((await c.query('SHOW statement_timeout')).rows[0].statement_timeout, '0');
    const d = await connectDedicated({ statementTimeoutMs: 15000 });
    open.push(d);
    assert.equal((await d.query('SHOW statement_timeout')).rows[0].statement_timeout, '15s');
  });

  test('the production limits are the documented ones', () => {
    assert.equal(A8_CONNECT_TIMEOUT_MS, 10_000);
    assert.equal(A8_STATEMENT_TIMEOUT_MS, 15_000);
  });
});

describe('connectBounded', () => {
  test('resolves with the connection when it arrives in time', async () => {
    const conn = { end: async () => {} };
    assert.equal(await connectBounded(async () => conn, 1000), conn);
  });

  test('rejects at the limit when the connect hangs, and a connection that arrives late is closed', async () => {
    let release = /** @type {(c: any) => void} */ (() => {});
    let ended = false;
    const late = new Promise((r) => { release = r; });
    const t0 = Date.now();
    await assert.rejects(connectBounded(() => /** @type {any} */ (late), 80), /connect timeout/);
    assert.ok(Date.now() - t0 < 2000);
    release({ end: async () => { ended = true; } });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ended, true, 'the late connection was closed, not leaked');
  });

  test('a connect that throws rejects with that error', async () => {
    await assert.rejects(connectBounded(async () => { throw new Error('refused'); }, 1000), /refused/);
  });
});
