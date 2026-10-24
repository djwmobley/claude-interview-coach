// @ts-check
/**
 * An OAuth refresh failing with invalid_grant (HTTP 400 at the token endpoint) breaks Gmail read, send AND
 * calendar, because the three share one grant. Drives the real scan-run path: the real google.js token layer
 * runs against an OAuth client double whose refresh rejects with the Gaxios-shaped 400 body.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, fakeGmailAuthDeps, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { getEnv } from '../src/core/config.js';
import { deps as gmailAuthDeps } from '../src/adapters/gmail.js';
import { getAccessToken } from '../src/core/google.js';

const PROFILE = `zz-test-scan-invgrant-${process.pid}`;
/** @type {import('pg').Client} */
let client;

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  await upsertTestProfile(client, PROFILE, { sources: ['gmail'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
  await client.query('DELETE FROM ic_google_capability');
});
after(async () => {
  try {
    await client.query('DELETE FROM ic_google_capability');
    await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  } finally {
    Object.assign(gmailAuthDeps, fakeGmailAuthDeps);
    await client.end();
  }
});

test('invalid_grant from the token endpoint records read, send and calendar BROKEN', async () => {
  // The token file reads as fully scoped; only the refresh fails, exactly as a revoked or expired grant does.
  Object.assign(gmailAuthDeps, {
    readTokenFile: () => ({
      client_id: 'zz-client', client_secret: 'zz-secret', refresh_token: 'zz-refresh', access_token: null, expiry: null, token_uri: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events'],
    }),
    makeOAuthClient: () => ({
      async getAccessToken() {
        const err = /** @type {any} */ (new Error('invalid_grant'));
        err.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
        throw err;
      },
      credentials: {},
    }),
    getAccessToken,
  });
  const deps = offlineDeps({
    fetch: async () => new Response('not found', { status: 404 }),
    env: { ...getEnv(), GOOGLE_TOKEN_FILE: 'zz-test-google-token.json' },
    // Skip the unattended pre-loop reclassification; the adapter's own token layer is what is under test.
    classifyGoogleTokenState: async () => ({ state: 'ok', expiry: '2099-01-01T00:00:00' }),
  });
  await runScanWaiting({ profile: PROFILE, sources: ['gmail'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
  const rows = (await client.query('SELECT capability, broken_since, last_state FROM ic_google_capability ORDER BY capability')).rows;
  assert.deepEqual(rows.map((r) => r.capability), ['calendar', 'read', 'send']);
  for (const r of rows) {
    assert.ok(r.broken_since, `${r.capability} is broken`);
    assert.equal(r.last_state, 'broken_invalid_grant', r.capability);
  }
});
