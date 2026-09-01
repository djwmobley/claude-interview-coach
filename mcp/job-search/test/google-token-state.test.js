// @ts-check
/**
 * classifyGoogleTokenState / classifyAndConnect (auth-health hardening, spec Change 1). Every scenario
 * here uses a real token file written to a tmp dir (fs, matching the readTokenFile convention already
 * used in test/remind.test.js) and an INJECTED getAccessToken (never a real network call), so a live
 * refresh attempt is opt-in per test and its absence/presence is directly assertable.
 *
 * The invalid_grant/invalid_client shapes below mirror a real Gaxios error confirmed empirically
 * against a live expired grant (err.response.data.error === 'invalid_grant', err.message === 'invalid_grant',
 * err.code === 400) -- see this PR's description for the probe. No token value ever appears in any
 * fixture or assertion here.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyGoogleTokenState, readTokenFile, expiryMs, SCOPE_GMAIL_SEND, SCOPE_CALENDAR_EVENTS, SCOPE_CALENDAR_FULL } from '../src/core/google.js';

/** @type {string} */
let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-token-state-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** @param {string} name @param {Record<string, unknown>} fields */
function writeToken(name, fields) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify({ client_id: 'zz-cid', client_secret: 'zz-secret', ...fields }));
  return file;
}

/** A getAccessToken stub that must never be called; throws loudly if it is. */
const refuseRefresh = async () => {
  throw new Error('refuse-refresh: classifyGoogleTokenState must not attempt a live refresh here');
};

describe('classifyGoogleTokenState: file-shape and scope checks (no live network call)', () => {
  test('missing file -> broken_missing_file, no refresh attempted', async () => {
    const state = await classifyGoogleTokenState(path.join(tmp, 'does-not-exist.json'), { gmail: true }, { getAccessToken: refuseRefresh });
    assert.deepEqual(state, { state: 'broken_missing_file' });
  });

  test('malformed JSON -> broken_malformed, no refresh attempted', async () => {
    const file = path.join(tmp, 'bad.json');
    fs.writeFileSync(file, '{ not json');
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: refuseRefresh });
    assert.deepEqual(state, { state: 'broken_malformed' });
  });

  test('missing client_id/client_secret -> broken_malformed', async () => {
    const file = path.join(tmp, 'no-client.json');
    fs.writeFileSync(file, JSON.stringify({ refresh_token: 'rt', scopes: [SCOPE_GMAIL_SEND] }));
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: refuseRefresh });
    assert.deepEqual(state, { state: 'broken_malformed' });
  });

  test('refresh_token "" (empty string) -> broken_no_refresh_token, checked before any network call', async () => {
    const file = writeToken('empty-rt.json', { refresh_token: '', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: refuseRefresh });
    assert.deepEqual(state, { state: 'broken_no_refresh_token' });
  });

  test('refresh_token "   " (whitespace only, post .trim()) -> broken_no_refresh_token', async () => {
    const file = writeToken('ws-rt.json', { refresh_token: '   ', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: refuseRefresh });
    assert.deepEqual(state, { state: 'broken_no_refresh_token' });
  });

  test('refresh_token null/undefined (absent from the file) -> broken_no_refresh_token', async () => {
    const file = writeToken('no-rt.json', { scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: refuseRefresh });
    assert.deepEqual(state, { state: 'broken_no_refresh_token' });
  });

  test('scope string " a  b " (leading space, double space): readTokenFile\'s scopes array has no empty-string elements, and the missing-scope check runs against the filtered array', () => {
    const file = writeToken('scope-string.json', { refresh_token: 'rt', scope: ' a  b ' });
    const t = readTokenFile(file);
    assert.deepEqual(t.scopes, ['a', 'b']);
    assert.ok(!t.scopes.includes(''), 'no empty-string element survives the whitespace split');
  });

  test('combined missing-scopes + dead-grant file: classifies broken_missing_scopes and NEVER attempts the refresh (injected refresh throws if called)', async () => {
    // A token file with a present (but scope-insufficient) refresh_token that WOULD fail invalid_grant
    // if ever actually used -- the point of this test is that the scope check short-circuits before that
    // dead grant is ever touched.
    const file = writeToken('missing-scopes.json', { refresh_token: 'zz-dead-grant-rt', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { calendar: true }, { getAccessToken: refuseRefresh });
    assert.equal(state.state, 'broken_missing_scopes');
    assert.ok('missing' in state && Array.isArray(state.missing));
    assert.ok(/** @type {any} */ (state).missing.includes(SCOPE_CALENDAR_EVENTS));
    assert.ok(/** @type {any} */ (state).missing.includes(SCOPE_CALENDAR_FULL));
  });
});

describe('classifyGoogleTokenState: live refresh outcomes (injected getAccessToken)', () => {
  test('access-token-expired-but-refresh-valid: a successful refresh is ok regardless of the file\'s own (stale) access_token/expiry', async () => {
    const file = writeToken('expired-access-token.json', {
      refresh_token: 'rt', access_token: 'zz-stale-access-token', expiry: '2000-01-01T00:00:00', scopes: [SCOPE_GMAIL_SEND],
    });
    const state = await classifyGoogleTokenState(file, { gmail: true }, {
      getAccessToken: async () => ({ token: 'zz-fresh-token', expiry: '2099-01-01T00:00:00.000Z' }),
    });
    assert.deepEqual(state, { state: 'ok', expiry: '2099-01-01T00:00:00.000Z' });
  });

  test('ok.expiry is always the live post-refresh value, never the raw file field -- naive-UTC file expiry', async () => {
    const file = writeToken('naive-expiry.json', { refresh_token: 'rt', expiry: '2026-08-12T04:36:05', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: async () => ({ token: 'zz-t', expiry: '2030-06-01T00:00:00.000Z' }) });
    assert.deepEqual(state, { state: 'ok', expiry: '2030-06-01T00:00:00.000Z' });
    assert.notEqual(state.expiry, expiryMs('2026-08-12T04:36:05') ? new Date(expiryMs('2026-08-12T04:36:05')).toISOString() : null);
  });

  test('ok.expiry is always the live post-refresh value, never the raw file field -- offset-suffixed file expiry', async () => {
    const file = writeToken('offset-expiry.json', { refresh_token: 'rt', expiry: '2026-08-12T04:36:05+02:00', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: async () => ({ token: 'zz-t', expiry: '2031-01-01T00:00:00.000Z' }) });
    assert.deepEqual(state, { state: 'ok', expiry: '2031-01-01T00:00:00.000Z' });
  });

  test('ok.expiry is always the live post-refresh value, never the raw file field -- unparsable file expiry (expiryMs returns null, classification still succeeds)', async () => {
    const file = writeToken('unparsable-expiry.json', { refresh_token: 'rt', expiry: 'not-a-date', scopes: [SCOPE_GMAIL_SEND] });
    assert.equal(expiryMs('not-a-date'), null);
    const state = await classifyGoogleTokenState(file, { gmail: true }, { getAccessToken: async () => ({ token: 'zz-t', expiry: '2032-01-01T00:00:00.000Z' }) });
    assert.deepEqual(state, { state: 'ok', expiry: '2032-01-01T00:00:00.000Z' });
  });

  test('invalid_grant via .message only (no structured response body)', async () => {
    const file = writeToken('grant1.json', { refresh_token: 'rt', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, {
      getAccessToken: async () => { throw new Error('invalid_grant'); },
    });
    assert.deepEqual(state, { state: 'broken_invalid_grant' });
  });

  test('invalid_grant via a structured response body only, with a generic .message', async () => {
    const file = writeToken('grant2.json', { refresh_token: 'rt', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, {
      getAccessToken: async () => {
        const err = /** @type {any} */ (new Error('Request failed with status code 400'));
        err.response = { data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
        throw err;
      },
    });
    assert.deepEqual(state, { state: 'broken_invalid_grant' });
  });

  test('invalid_client must NOT collapse into broken_invalid_grant', async () => {
    const file = writeToken('client1.json', { refresh_token: 'rt', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, {
      getAccessToken: async () => {
        const err = /** @type {any} */ (new Error('Request failed with status code 401'));
        err.response = { data: { error: 'invalid_client' } };
        throw err;
      },
    });
    assert.deepEqual(state, { state: 'broken_refresh_error', code: 'invalid_client' });
  });

  test('a pure-network error with neither a structured body nor an invalid_grant-shaped message lands in broken_refresh_error with the transport code', async () => {
    const file = writeToken('network1.json', { refresh_token: 'rt', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, {
      getAccessToken: async () => {
        const err = /** @type {any} */ (new Error('connect ECONNRESET'));
        err.code = 'ECONNRESET';
        throw err;
      },
    });
    assert.deepEqual(state, { state: 'broken_refresh_error', code: 'ECONNRESET' });
  });

  test('a refresh failure with neither a structured field, an invalid_grant message, nor an err.code falls back to the literal string "unknown" (never undefined)', async () => {
    const file = writeToken('unknown1.json', { refresh_token: 'rt', scopes: [SCOPE_GMAIL_SEND] });
    const state = await classifyGoogleTokenState(file, { gmail: true }, {
      getAccessToken: async () => { throw new Error('something odd happened'); },
    });
    assert.deepEqual(state, { state: 'broken_refresh_error', code: 'unknown' });
  });

  test('broken_refresh_error.code is capped to 80 chars', async () => {
    const file = writeToken('long-code.json', { refresh_token: 'rt', scopes: [SCOPE_GMAIL_SEND] });
    const longCode = 'x'.repeat(200);
    const state = await classifyGoogleTokenState(file, { gmail: true }, {
      getAccessToken: async () => {
        const err = /** @type {any} */ (new Error('nope'));
        err.code = longCode;
        throw err;
      },
    });
    assert.equal(state.state, 'broken_refresh_error');
    assert.equal(/** @type {any} */ (state).code.length, 80);
  });
});
