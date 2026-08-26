// @ts-check
/**
 * LIVE=1 Greenhouse smoke test: one real boards-api list call for the first
 * enabled board in config/ats-boards.json through the guarded, rate-limited
 * adapter path, then a dry-run runScan on that single board. Skipped unless
 * LIVE=1 is set explicitly. Writes only a dry-run run row.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/core/config.js';
import { buildRegistry, guardedFetch } from '../src/core/urlguard.js';
import { mapJob } from '../src/adapters/greenhouse.js';
import { normalizeListing } from '../src/core/normalize.js';
import { newClient, upsertTestProfile, cleanupScan, runScanWaiting } from './helpers/scan-fixtures.js';

const LIVE = process.env.LIVE === '1';
const PROFILE = `zz-test-smoke-${process.pid}`;
/** @type {import('pg').Client|null} */
let client = null;

before(async () => {
  if (!LIVE) return;
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE });
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['Director', 'Vice President', 'Chief', 'Head of'], phrases: [], locations: [], posted_within_days: 30 });
});
after(async () => {
  if (!client) return;
  try {
    await cleanupScan(client, { profile: PROFILE });
  } finally {
    await client.end();
  }
});

describe('LIVE greenhouse smoke', { skip: !LIVE && 'set LIVE=1 to run against the public Greenhouse API' }, () => {
  test('boards-api list for the first enabled board answers 200 JSON and maps to RawListings', async () => {
    const cfg = loadConfig({ fresh: true });
    const board = cfg.atsBoards.greenhouse.find((b) => b.enabled);
    assert.ok(board, 'at least one enabled greenhouse board');
    const registry = buildRegistry(cfg);
    const r = await guardedFetch(`https://boards-api.greenhouse.io/v1/boards/${board.board}/jobs`, registry, { source: 'greenhouse', headers: { accept: 'application/json' } });
    assert.equal(r.status, 200);
    assert.match(String(r.contentType), /json/);
    const json = JSON.parse(r.text);
    assert.ok(Array.isArray(json.jobs) && json.jobs.length > 0);
    const l = mapJob(json.jobs[0], board);
    assert.ok(l);
    const n = normalizeListing(l);
    assert.equal(n.source, 'greenhouse');
    assert.equal(n.external_id, `greenhouse:${board.board}/${json.jobs[0].id}`);
  });

  test('dry-run scan over greenhouse completes with status ok or partial and a run row', async () => {
    assert.ok(client);
    const cfg = loadConfig({ fresh: true });
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: true, wait: true }, { config: cfg }, { trigger: 'cli', log: () => {} });
    assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    assert.ok(r.stats.pages_by_source.greenhouse >= 1);
    const row = await client.query('SELECT status, dry_run FROM ic_scan_runs WHERE id = $1', [r.run_id]);
    assert.equal(row.rows[0].dry_run, true);
  });
});
