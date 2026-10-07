// @ts-check
/**
 * bin/backfill-detail.js --source=gmail (Gmail intake addendum G3): routed through src/core/gmail-detail.js.
 * A dry run makes no request; a real run returns the phase's stats with an injected fetch (never the network).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { runBackfill, parseArgs } from '../bin/backfill-detail.js';

describe('backfill-detail --source=gmail', () => {
  /** @type {pg.Client} */
  let c;
  before(async () => {
    c = new pg.Client(pgConnectionConfig());
    await c.connect();
    await ensureAuxSchema(c);
  });
  after(async () => { await c.end(); });

  test('parseArgs accepts --source=gmail', () => {
    assert.equal(parseArgs(['--source=gmail']).source, 'gmail');
  });
  test('a dry run makes no request', async () => {
    let fetched = 0;
    const r = /** @type {any} */ (await runBackfill({ dryRun: true, limit: Infinity, ids: null, source: 'gmail' }, { config: loadConfig(), env: {}, fetch: /** @type {any} */ (async () => { fetched++; return new Response(''); }) }, c));
    assert.equal(r.dry_run, true);
    assert.equal(fetched, 0);
  });
  test('a real run returns the gmail description phase stats', async () => {
    const r = /** @type {any} */ (await runBackfill({ dryRun: false, limit: 0, ids: null, source: 'gmail' }, {
      config: loadConfig(), env: {}, fetch: /** @type {any} */ (async () => { throw new Error('must not fetch with limit 0'); }),
      reserveBudget: async () => ({ ok: true, remainingPages: 0, remainingDetails: 1 }),
    }, c));
    assert.equal(r.source, 'gmail');
    assert.equal(r.gmail_detail.enabled, true);
    assert.equal(r.gmail_detail.candidates, 0);
  });
});
