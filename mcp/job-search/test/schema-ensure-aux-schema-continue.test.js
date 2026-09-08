// @ts-check
/**
 * src/core/schema.js's ensureAuxSchema(): each AUX_MIGRATIONS file now runs in its own try/catch (fix
 * for the 2026-09-06 incident's first half). Before this change, one file's failure (a real example: a
 * name-keyed CHECK guard reinstalling a narrower constraint under live data that no longer satisfied it)
 * threw out of the whole loop, leaving every LATER aux-migration file unapplied on that startup, and left
 * the pooled client mid-aborted-transaction for whoever picked it up next (src/core/db.js's withClient
 * fix covers that half; this file covers the schema.js half).
 *
 * This test never touches the real AUX_MIGRATIONS files' own failure modes (those are already exercised,
 * and fixed, by test/migration-guard-definition-compare.test.js). Instead it substitutes a deliberately
 * broken statement in place of one real file's own SQL (016_listing_salary_period.sql, matched by its
 * migration-unique "salary_period" text and swapped for an intentional syntax error) via a thin proxy in
 * front of a real pg.Client, so the failure is a genuine Postgres-side error (real SQLSTATE, real aborted
 * transaction) rather than a synthetic JS throw -- the same shape of failure the incident produced.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema, AUX_MIGRATIONS } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';

/** Proxies a real pg client, substituting a syntax error for the one file whose SQL contains `matchText`. */
class BreakOneFileClient {
  /** @param {pg.Client} real @param {string} matchText */
  constructor(real, matchText) {
    this.real = real;
    this.matchText = matchText;
    this.triggered = false;
  }
  /** @param {string} text @param {unknown[]} [params] */
  async query(text, params) {
    if (!this.triggered && typeof text === 'string' && text.includes(this.matchText)) {
      this.triggered = true;
      // A genuine Postgres-side failure (syntax_error, SQLSTATE 42601) inside this file's own
      // BEGIN...COMMIT, leaving the connection mid-aborted-transaction exactly like the real incident.
      return this.real.query('BEGIN; SELECT this_is_not_a_real_column_or_function_xyz_broken();');
    }
    return this.real.query(text, params);
  }
}

/** @type {pg.Client} */
let realClient;

after(async () => {
  if (realClient) await realClient.end();
  await closePool();
});

describe('ensureAuxSchema: one failing file does not block the rest', () => {
  test('016 deliberately fails; every other AUX_MIGRATIONS file (including 017, which runs after it) still applies, with no thrown error', async () => {
    realClient = new pg.Client(pgConnectionConfig());
    await realClient.connect();
    const proxy = new BreakOneFileClient(realClient, 'salary_period');

    // ensureAuxSchema() catches per-file, so this must never reject at all -- a plain await is the
    // assertion (a thrown/rejected promise fails this test on its own); assert.doesNotReject() would
    // discard the resolved value here (it fulfills with undefined, not the promise's own result).
    const applied = await ensureAuxSchema(/** @type {any} */ (proxy));

    assert.ok(proxy.triggered, 'the substituted failure must actually have fired');
    assert.ok(!applied.includes('016_listing_salary_period.sql'), 'the failing file must be absent from applied');
    for (const f of AUX_MIGRATIONS) {
      if (f === '016_listing_salary_period.sql') continue;
      assert.ok(applied.includes(f), `${f} must still have applied despite 016's failure`);
    }
    // 017 in particular: it runs immediately AFTER the failing file in AUX_MIGRATIONS order, so its
    // success proves the per-file ROLLBACK actually cleared the aborted transaction before the loop
    // moved on, not just that the loop happened to continue.
    assert.ok(applied.includes('017_detail_outcome.sql'), '017 must apply even though it immediately follows the failing file');

    // The same connection, reused directly (not via a fresh client), must be query-able afterward --
    // proves ensureAuxSchema's own ROLLBACK-on-catch left it clean, independent of withClient's fix.
    const direct = await realClient.query('SELECT 1 AS one');
    assert.equal(direct.rows[0].one, 1);
  });

  test('the shared pool (withClient) is unaffected by a prior ensureAuxSchema failure on a different connection', async () => {
    const result = await withClient((client) => client.query('SELECT 2 AS two'));
    assert.equal(result.rows[0].two, 2);
  });
});
