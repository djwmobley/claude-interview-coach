// @ts-check
/**
 * makeCalendarProvider (auth-health hardening, spec Change 2): separate TTLs for a success vs a broken
 * classification, the .lastState() accessor, and that a cached broken result never re-attempts a live
 * refresh during its cooldown. classifyAndConnect is injected (opts.classifyAndConnect) so nothing here
 * touches a real token file or the network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeCalendarProvider, DEFAULT_BROKEN_COOLDOWN_MS } from '../src/core/calendar-provider.js';

/** @param {import('../src/core/google.js').GoogleTokenState} state @param {string|null} [accessToken] */
function fakeClassify(state, accessToken = null) {
  const calls = [];
  const fn = async () => {
    calls.push(1);
    return { state, accessToken: state.state === 'ok' ? (accessToken ?? 'zz-fake-token') : null };
  };
  return { fn, calls };
}

describe('makeCalendarProvider: caching and classification', () => {
  test('a successful classification returns a working provider and caches it (no re-classify on the next call)', async () => {
    const expiry = new Date(Date.now() + 3600000).toISOString();
    const { fn, calls } = fakeClassify({ state: 'ok', expiry }, 'zz-token-1');
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '/fake/token.json' }), { classifyAndConnect: fn });
    const first = await provider();
    assert.ok(first, 'first call returns a working provider');
    const second = await provider();
    assert.ok(second, 'second call returns a working provider from cache');
    assert.equal(calls.length, 1, 'the second call must not re-classify while the success cache is fresh');
    assert.deepEqual(provider.lastState(), { state: 'ok', expiry });
  });

  test('GOOGLE_TOKEN_FILE unset: broken_missing_file without ever calling classifyAndConnect', async () => {
    const { fn, calls } = fakeClassify({ state: 'ok', expiry: null });
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '' }), { classifyAndConnect: fn });
    const result = await provider();
    assert.equal(result, null);
    assert.equal(calls.length, 0);
    assert.deepEqual(provider.lastState(), { state: 'broken_missing_file' });
  });

  test('a broken classification is cached for its OWN (shorter) cooldown: repeated calls during the cooldown never re-classify', async () => {
    const { fn, calls } = fakeClassify({ state: 'broken_invalid_grant' });
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '/fake/token.json' }), { classifyAndConnect: fn, brokenCooldownMs: 5 * 60000 });
    const first = await provider();
    assert.equal(first, null);
    assert.equal(calls.length, 1);
    const second = await provider();
    assert.equal(second, null);
    assert.equal(calls.length, 1, 'still cached: the cooldown has not elapsed');
    assert.deepEqual(provider.lastState(), { state: 'broken_invalid_grant' });
  });

  test('the broken cooldown is SHORTER than the success cache window by default (5 min vs up to 50 min)', () => {
    assert.equal(DEFAULT_BROKEN_COOLDOWN_MS, 5 * 60000);
    assert.ok(DEFAULT_BROKEN_COOLDOWN_MS < 50 * 60000);
  });

  test('after the broken cooldown elapses, the next call classifies again', async () => {
    let state = /** @type {import('../src/core/google.js').GoogleTokenState} */ ({ state: 'broken_invalid_grant' });
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { state, accessToken: null };
    };
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '/fake/token.json' }), { classifyAndConnect: fn, brokenCooldownMs: 1 });
    await provider();
    assert.equal(calls, 1);
    // brokenCooldownMs: 1 -- a microtask tick is enough for it to have elapsed.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider();
    assert.equal(calls, 2, 'the cooldown elapsed, so the provider re-classified');
  });

  test('once the success cache genuinely expires (expiry already passed the 60s safety buffer), the next call re-classifies and can transition to broken', async () => {
    // expiry === now means cachedOk.until (exp - 60s) is already in the past the moment it is set, so
    // the SECOND call's cache check fails immediately and it re-classifies -- without needing a real
    // wall-clock wait through a multi-minute TTL.
    /** @type {import('../src/core/google.js').GoogleTokenState} */
    let state = { state: 'ok', expiry: new Date().toISOString() };
    const fn = async () => ({ state, accessToken: state.state === 'ok' ? 'zz-token' : null });
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '/fake/token.json' }), { classifyAndConnect: fn, brokenCooldownMs: 5 * 60000 });
    const ok = await provider();
    assert.ok(ok, 'first call succeeds with a working provider');
    state = { state: 'broken_no_refresh_token' };
    const broken = await provider();
    assert.equal(broken, null, 'the stale success cache was not reused; the provider re-classified and saw the new broken state');
    assert.deepEqual(provider.lastState(), { state: 'broken_no_refresh_token' });
  });

  test('lastState() is null before the provider has ever been called', () => {
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '/fake/token.json' }), { classifyAndConnect: async () => ({ state: { state: 'ok', expiry: null }, accessToken: 'x' }) });
    assert.equal(provider.lastState(), null);
  });

  test('broken_missing_scopes and broken_refresh_error classifications are both surfaced via lastState()', async () => {
    const missing = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '/fake/token.json' }), {
      classifyAndConnect: async () => ({ state: { state: 'broken_missing_scopes', missing: ['https://www.googleapis.com/auth/calendar.events'] }, accessToken: null }),
    });
    await missing();
    assert.deepEqual(missing.lastState(), { state: 'broken_missing_scopes', missing: ['https://www.googleapis.com/auth/calendar.events'] });

    const refreshErr = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: '/fake/token.json' }), {
      classifyAndConnect: async () => ({ state: { state: 'broken_refresh_error', code: 'ECONNRESET' }, accessToken: null }),
    });
    await refreshErr();
    assert.deepEqual(refreshErr.lastState(), { state: 'broken_refresh_error', code: 'ECONNRESET' });
  });
});
