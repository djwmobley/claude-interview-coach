// @ts-check
/**
 * src/core/apply-target-persist.js (auto-apply PR B): re-probe cooldown, lifetime cap, dry-run no-write,
 * and resolved/unresolved persistence -- against a fake pg client, no real database.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { persistApplyTargetForListing, LIFETIME_PROBE_ATTEMPTS } from '../src/core/apply-target-persist.js';
import { registryFrom } from '../src/apply/probe-registry.js';

const REGISTRY = registryFrom(['boards.greenhouse.io']);
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeClient() {
  /** @type {any[]} */
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

const NOW = new Date('2026-09-03T12:00:00Z');

describe('persistApplyTargetForListing: skip branches never write', () => {
  test('dry run: no query at all', async () => {
    const client = fakeClient();
    const listing = { id: 1, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/1', apply_probed_at: null, probe_attempts: 0 };
    const r = await persistApplyTargetForListing(client, listing, null, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: true });
    assert.equal(r.outcome, 'skipped_dry_run');
    assert.equal(client.queries.length, 0);
  });

  test('lifetime cap reached: no query', async () => {
    const client = fakeClient();
    const listing = { id: 1, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/1', apply_probed_at: null, probe_attempts: LIFETIME_PROBE_ATTEMPTS };
    const r = await persistApplyTargetForListing(client, listing, null, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false });
    assert.equal(r.outcome, 'skipped_lifetime_cap');
    assert.equal(client.queries.length, 0);
  });

  test('re-probed within the cooldown window: no query', async () => {
    const client = fakeClient();
    const listing = {
      id: 1, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/1',
      apply_probed_at: new Date(NOW.getTime() - 10 * 3600000), // 10h ago, cooldown 48h
      probe_attempts: 1,
    };
    const r = await persistApplyTargetForListing(client, listing, null, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false });
    assert.equal(r.outcome, 'skipped_cooldown');
    assert.equal(client.queries.length, 0);
  });

  test('re-probe allowed once past the cooldown window', async () => {
    const client = fakeClient();
    const listing = {
      id: 1, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/1',
      apply_probed_at: new Date(NOW.getTime() - 49 * 3600000), // 49h ago, cooldown 48h
      probe_attempts: 1,
    };
    const r = await persistApplyTargetForListing(client, listing, null, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false, lookup: publicLookup });
    assert.equal(r.outcome, 'resolved');
    assert.equal(client.queries.length, 1);
  });

  test('no candidate url and no hint at all: no query', async () => {
    const client = fakeClient();
    const listing = { id: 1, url: null, url_normalized: null, apply_probed_at: null, probe_attempts: 0 };
    const r = await persistApplyTargetForListing(client, listing, null, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false });
    assert.equal(r.outcome, 'skipped_no_candidate');
    assert.equal(client.queries.length, 0);
  });
});

describe('persistApplyTargetForListing: real attempts write exactly once', () => {
  test('an exact target resolves and writes apply_url/apply_ats/apply_ats_confidence', async () => {
    const client = fakeClient();
    const listing = { id: 7, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/123', apply_probed_at: null, probe_attempts: 0 };
    const r = await persistApplyTargetForListing(client, listing, null, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false, lookup: publicLookup });
    assert.equal(r.outcome, 'resolved');
    assert.equal(client.queries.length, 1);
    const [{ text, params }] = client.queries;
    assert.match(text, /apply_url = \$2/);
    assert.equal(params[1], 'https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(params[2], 'greenhouse');
    assert.equal(params[3], 'exact');
  });

  test('an easy-apply-only hint with no candidate writes apply_easy_only, never apply_ats', async () => {
    const client = fakeClient();
    const listing = { id: 8, url: null, url_normalized: null, apply_probed_at: null, probe_attempts: 0 };
    const applyDetail = { easyApplyOnly: true, externalApplyUrl: null };
    const r = await persistApplyTargetForListing(client, listing, applyDetail, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false });
    assert.equal(r.outcome, 'resolved');
    assert.equal(client.queries.length, 1);
    assert.match(client.queries[0].text, /apply_easy_only = true/);
    assert.doesNotMatch(client.queries[0].text, /apply_ats = /);
  });

  test('an unresolved candidate still writes the probe attempt and any hint, never apply_ats', async () => {
    const client = fakeClient();
    const listing = { id: 9, url: null, url_normalized: 'https://some-random-company.example.com/careers/42', apply_probed_at: null, probe_attempts: 0 };
    const applyDetail = { applyProbe: { applicantTrackingSystemName: 'unknown', companyName: 'Acme' } };
    const r = await persistApplyTargetForListing(client, listing, applyDetail, { probeRegistry: REGISTRY, reprobeAfterHours: 48, now: NOW, dryRun: false, lookup: publicLookup });
    assert.equal(r.outcome, 'unresolved');
    assert.equal(client.queries.length, 1);
    assert.doesNotMatch(client.queries[0].text, /apply_ats = /);
    assert.match(client.queries[0].text, /apply_ats_hint/);
    assert.match(client.queries[0].text, /probe_attempts = probe_attempts \+ 1/);
  });
});
