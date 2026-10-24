// @ts-check
/**
 * A Gmail auth refusal (401/403) from the alert pass or the intake pass records Gmail READ as broken with the
 * reason, even though the scan reaches its end (sql/029). A clean pass records read OK. Real scan-run against the
 * isolated test database; Gmail is a routed fake fetch, no network.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, fakeGmailAuthDeps, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { getEnv } from '../src/core/config.js';
import { deps as gmailAuthDeps } from '../src/adapters/gmail.js';

const PROFILE = `zz-test-scan-authcap-${process.pid}`;
/** @type {import('pg').Client} */
let client;

before(async () => {
  Object.assign(gmailAuthDeps, fakeGmailAuthDeps);
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  await upsertTestProfile(client, PROFILE, { sources: ['gmail'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
});
beforeEach(async () => { await client.query('DELETE FROM ic_google_capability'); });
after(async () => {
  try {
    await client.query('DELETE FROM ic_google_capability');
    await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  } finally {
    Object.assign(gmailAuthDeps, fakeGmailAuthDeps);
    await client.end();
  }
});

/** @param {'clean'|'intake401'|'intake403'|'alert403'|'alert401'} mode */
function gmailFetch(mode) {
  const json = (/** @type {number} */ status, /** @type {any} */ body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return async (/** @type {any} */ input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'gmail.googleapis.com') return new Response('not found', { status: 404 });
    const q = url.searchParams.get('q') ?? '';
    if (!url.pathname.endsWith('/messages')) return json(404, {});
    if (q.includes('-in:trash')) return mode === 'intake401' ? json(401, {}) : mode === 'intake403' ? json(403, {}) : json(200, { messages: [] });
    if (q.includes('from:') && !q.includes('-from:')) return mode === 'alert403' ? json(403, {}) : mode === 'alert401' ? json(401, {}) : json(200, { messages: [] });
    return json(200, { messages: [] });
  };
}

/** @param {'clean'|'intake401'|'intake403'|'alert403'|'alert401'} mode */
async function scan(mode) {
  const deps = offlineDeps({
    fetch: gmailFetch(mode),
    env: { ...getEnv(), GOOGLE_TOKEN_FILE: 'zz-test-google-token.json' },
    classifyGoogleTokenState: async () => ({ state: 'ok', expiry: '2099-01-01T00:00:00' }),
  });
  await runScanWaiting({ profile: PROFILE, sources: ['gmail'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
  const r = await client.query(`SELECT broken_since, last_good_at, last_state FROM ic_google_capability WHERE capability = 'read'`);
  return r.rows[0] ?? null;
}

describe('Gmail read health from a scan', () => {
  test('a clean pass records read OK', async () => {
    const row = await scan('clean');
    assert.ok(row);
    assert.equal(row.broken_since, null);
    assert.equal(row.last_state, 'ok');
    assert.ok(row.last_good_at);
  });

  test('an intake-pass 401 records read BROKEN with the reason, although the scan reached its end', async () => {
    const row = await scan('intake401');
    assert.ok(row?.broken_since);
    assert.equal(row.last_state, 'auth_401');
  });

  test('an intake-pass 403 records read BROKEN with the reason', async () => {
    const row = await scan('intake403');
    assert.ok(row?.broken_since);
    assert.equal(row.last_state, 'auth_403');
  });

  test('an alert-pass 403 records read BROKEN and the later clean end of the pass does not clear it', async () => {
    const row = await scan('alert403');
    assert.ok(row?.broken_since);
    assert.equal(row.last_state, 'auth_403');
    assert.equal(row.last_good_at, null);
  });

  test('an alert-pass 401 records read BROKEN with the reason', async () => {
    const row = await scan('alert401');
    assert.ok(row?.broken_since);
    assert.equal(row.last_state, 'auth_401');
  });

  test('a clean pass after a failure clears the broken state', async () => {
    await scan('intake401');
    const row = await scan('clean');
    assert.equal(row.broken_since, null);
    assert.equal(row.last_state, 'ok');
  });
});
