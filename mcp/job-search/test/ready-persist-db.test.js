// @ts-check
/**
 * Ready to apply list, persistence fixes (spec 7.2 / 7.3, R1) against the real isolated test DB:
 *   T7 persistApplyTargetForListing keeps an unresolved external href in manual_apply_* (never apply_url),
 *      and the resolved and easy-apply branches clear it; a dry run writes nothing.
 *   T8 persistLinkedInApplyState records apply_page_branch/reason on every listing-describing branch, the
 *      repeat counter increments on the same (branch, reason) and resets on a change, challenge/auth_wall
 *      leave the columns alone, and the live-check path (countAttempt false) writes them without counting
 *      a probe attempt.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { persistApplyTargetForListing } from '../src/core/apply-target-persist.js';
import { persistLinkedInApplyState } from '../src/apply/linkedin-button-prepare.js';
import { registryFrom } from '../src/apply/probe-registry.js';

const TAG = `ZZ-TEST-READYPERSIST-${process.pid}`;
const NOW = new Date('2026-10-07T12:00:00Z');
const LATER = new Date('2026-10-08T12:00:00Z');
const REGISTRY = registryFrom(['boards.greenhouse.io']);
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const ids = [];

async function seed(source = 'linkedin') {
  const n = Math.floor(Math.random() * 1e9);
  const url = source === 'linkedin' ? `https://www.linkedin.com/jobs/view/7${n}/` : `https://jobs.example.com/${n}`;
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url, url_normalized, status, probe_attempts)
     VALUES ('Ready Persist', $1, $2, $3, 'listing', $4, 'ready persist', 'country-us', $5, now(), $6, $6, 'new', 0) RETURNING id`,
    [TAG, source, `zz-readypersist-${process.pid}:${n}`, `readypersist co ${n}`, `zz-readypersist-hash-${n}`, url],
  );
  const id = Number(r.rows[0].id);
  ids.push(id);
  return { id, url: null, url_normalized: url, apply_probed_at: null, probe_attempts: 0 };
}
/** @param {number} id */
const row = async (id) => (await client.query('SELECT * FROM ic_job_listings WHERE id = $1', [id])).rows[0];

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
});
after(async () => {
  if (ids.length) {
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await client.end();
});

describe('T7 persistApplyTargetForListing manual_apply_*', () => {
  test('an unresolved external href is kept in manual_apply_*, apply_url stays NULL', async () => {
    const l = await seed('linkedin');
    const r = await persistApplyTargetForListing(client, l, { externalApplyUrl: 'https://careers.acme.com/jobs/77' }, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false, manualOrigin: 'linkedin_href' });
    assert.equal(r.outcome, 'unresolved');
    const x = await row(l.id);
    assert.equal(x.apply_url, null);
    assert.equal(x.manual_apply_url, 'https://careers.acme.com/jobs/77');
    assert.equal(x.manual_apply_host, 'careers.acme.com');
    assert.equal(x.manual_apply_origin, 'linkedin_href');
    assert.ok(x.manual_apply_seen_at);
  });

  test('origin defaults to detail_external; a listing-URL fallback candidate writes nothing manual', async () => {
    const l = await seed('linkedin');
    await persistApplyTargetForListing(client, l, { externalApplyUrl: 'https://careers.acme.com/jobs/78' }, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false });
    assert.equal((await row(l.id)).manual_apply_origin, 'detail_external');
    const other = await seed('ziprecruiter');
    await persistApplyTargetForListing(client, other, null, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false });
    assert.equal((await row(other.id)).manual_apply_url, null);
  });

  test('the resolved branch and the easy-apply branch clear a stale manual link', async () => {
    const l = await seed('linkedin');
    await persistApplyTargetForListing(client, l, { externalApplyUrl: 'https://careers.acme.com/jobs/79' }, { probeRegistry: REGISTRY, reprobeAfterHours: 0, now: NOW, dryRun: false });
    await persistApplyTargetForListing(client, { ...l, probe_attempts: 1 }, { externalApplyUrl: 'https://boards.greenhouse.io/acme/jobs/123' }, { probeRegistry: REGISTRY, reprobeAfterHours: 0, now: LATER, dryRun: false, lookup: publicLookup });
    let x = await row(l.id);
    assert.equal(x.apply_ats, 'greenhouse');
    assert.equal(x.manual_apply_url, null);
    assert.equal(x.manual_apply_host, null);
    const e = await seed('linkedin');
    await persistApplyTargetForListing(client, e, { externalApplyUrl: 'https://careers.acme.com/jobs/80' }, { probeRegistry: REGISTRY, reprobeAfterHours: 0, now: NOW, dryRun: false });
    await persistApplyTargetForListing(client, { ...e, probe_attempts: 1 }, { easyApplyOnly: true }, { probeRegistry: REGISTRY, reprobeAfterHours: 0, now: LATER, dryRun: false });
    x = await row(e.id);
    assert.equal(x.apply_easy_only, true);
    assert.equal(x.manual_apply_url, null);
  });

  test('dry run writes nothing', async () => {
    const l = await seed('linkedin');
    await persistApplyTargetForListing(client, l, { externalApplyUrl: 'https://careers.acme.com/jobs/81' }, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: true });
    assert.equal((await row(l.id)).manual_apply_url, null);
  });
});

describe('T8 persistLinkedInApplyState page-state columns', () => {
  const OPTS = { now: NOW, countAttempt: true, resolveExternal: false, tripBreaker: async () => {} };

  test('no_control twice with the same reason: repeat 1 then 2, first_seen kept; a new reason resets', async () => {
    const l = await seed();
    await persistLinkedInApplyState(client, l, { branch: 'no_control', reason: 'top_card_no_anchor' }, OPTS);
    let x = await row(l.id);
    assert.equal(x.apply_page_branch, 'no_control');
    assert.equal(x.apply_page_reason, 'top_card_no_anchor');
    assert.equal(x.apply_page_repeat, 1);
    assert.equal(new Date(x.apply_page_first_seen_at).toISOString(), NOW.toISOString());
    await persistLinkedInApplyState(client, l, { branch: 'no_control', reason: 'top_card_no_anchor' }, { ...OPTS, now: LATER });
    x = await row(l.id);
    assert.equal(x.apply_page_repeat, 2);
    assert.equal(new Date(x.apply_page_first_seen_at).toISOString(), NOW.toISOString());
    await persistLinkedInApplyState(client, l, { branch: 'unknown', reason: 'other' }, { ...OPTS, now: LATER });
    x = await row(l.id);
    assert.equal(x.apply_page_repeat, 1);
    assert.equal(x.apply_page_branch, 'unknown');
    assert.equal(new Date(x.apply_page_first_seen_at).toISOString(), LATER.toISOString());
  });

  test('easy_apply, closed, load_failure, external all record the branch', async () => {
    for (const branch of ['easy_apply', 'closed', 'load_failure', 'external']) {
      const l = await seed();
      await persistLinkedInApplyState(client, l, { branch, reason: `r_${branch}` }, OPTS);
      assert.equal((await row(l.id)).apply_page_branch, branch, branch);
    }
  });

  test('challenge and auth_wall leave the page-state columns untouched', async () => {
    const l = await seed();
    await persistLinkedInApplyState(client, l, { branch: 'no_control', reason: 'x' }, OPTS);
    for (const branch of ['challenge', 'auth_wall']) {
      await persistLinkedInApplyState(client, l, { branch, reason: 'y' }, OPTS);
      const x = await row(l.id);
      assert.equal(x.apply_page_branch, 'no_control');
      assert.equal(x.apply_page_repeat, 1);
    }
  });

  test('live-check path (countAttempt false) writes the page state without counting a probe attempt', async () => {
    const l = await seed();
    await persistLinkedInApplyState(client, l, { branch: 'no_control', reason: 'z' }, { ...OPTS, countAttempt: false });
    const x = await row(l.id);
    assert.equal(x.apply_page_branch, 'no_control');
    assert.equal(x.probe_attempts, 0);
    assert.equal(x.apply_probed_at, null);
  });
});
