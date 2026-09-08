// @ts-check
/**
 * src/core/db.js's withClient(): fix for the second half of the 2026-09-06 incident. A callback that
 * throws after leaving the connection mid-transaction used to have its client released back to the pool
 * still inside an aborted transaction -- every later query anyone else ran on that same pooled connection
 * then failed with 25P02 ("current transaction is aborted") until the process restarted, regardless of
 * what that later query even was. withClient's finally now unconditionally issues ROLLBACK before
 * release(), which PG accepts as a harmless no-op when no transaction is open.
 *
 * This is the only obtain-and-release site against the shared pool (src/core/db.js's own doc comment on
 * withClient, and its query() function, which uses pg's Pool#query convenience wrapper instead) -- so
 * fixing it here closes the gap for every caller, including src/core/schema.js's ensureAuxSchema.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { withClient, closePool } from '../src/core/db.js';

after(async () => {
  await closePool();
});

describe('withClient rollback-before-release', () => {
  test('a callback that BEGINs and throws leaves the client rollback-clean for the next withClient call', async () => {
    await assert.rejects(
      withClient(async (client) => {
        await client.query('BEGIN');
        // Deliberately abort the transaction server-side (a real check-violation style failure), then
        // throw without ever issuing ROLLBACK ourselves -- exactly what a failed multi-statement
        // migration script inside a BEGIN...COMMIT left the connection in before this fix.
        await assert.rejects(client.query('SELECT 1/0'));
        throw new Error('synthetic failure: simulated aborted transaction');
      }),
      /synthetic failure/,
    );

    // Pool max is 4 by default (getPool()'s own default); with only one withClient in flight at a time
    // here there is a real chance node-postgres hands back the SAME physical connection that was just
    // released, which is exactly the scenario the incident hit. Whether or not it is the same physical
    // connection, this call must succeed -- if the fix were absent, a reused aborted connection would
    // fail this with a 25P02 error instead of returning a row.
    const result = await withClient((client) => client.query('SELECT 1 AS one'));
    assert.equal(result.rows[0].one, 1);
  });

  test('repeated failing withClient calls never poison the pool for a later caller', async () => {
    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        withClient(async (client) => {
          await client.query('BEGIN');
          await assert.rejects(client.query('SELECT 1/0'));
          throw new Error(`synthetic failure ${i}`);
        }),
      );
    }
    const result = await withClient((client) => client.query('SELECT 1 AS one'));
    assert.equal(result.rows[0].one, 1);
  });

  test('a callback that succeeds without ever opening a transaction is unaffected (ROLLBACK with none open is a no-op)', async () => {
    const result = await withClient((client) => client.query('SELECT 2 AS two'));
    assert.equal(result.rows[0].two, 2);
  });
});
