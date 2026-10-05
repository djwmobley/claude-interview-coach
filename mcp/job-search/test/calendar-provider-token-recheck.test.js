// @ts-check
/**
 * makeCalendarProvider token-file invalidation (2026-10-05): a cached broken (or ok) classification is
 * dropped as soon as the token file's mtime or size differs from what was recorded when the cache entry
 * was set, so a successful re-consent clears the dashboard calendar banner on the next poll instead of
 * after the 5-minute broken cooldown. classifyAndConnect is injected; the token file is a temp fixture.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCalendarProvider } from '../src/core/calendar-provider.js';

/** @type {string} */
let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-calprov-recheck-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Rewrite the file with different content and a clearly different mtime. */
function rewrite(file, content) {
  fs.writeFileSync(file, content);
  const t = new Date(Date.now() + 10000);
  fs.utimesSync(file, t, t);
}

describe('makeCalendarProvider: token file change invalidates the cache', () => {
  test('broken cached, then token file rewritten: the next call re-classifies and returns a provider', async () => {
    const file = path.join(dir, 'token-a.json');
    fs.writeFileSync(file, '{"old":true}');
    let state = /** @type {import('../src/core/google.js').GoogleTokenState} */ ({ state: 'broken_missing_scopes', missing: ['x'] });
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { state, accessToken: state.state === 'ok' ? 'zz-token' : null };
    };
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: file }), { classifyAndConnect: fn, brokenCooldownMs: 5 * 60000 });
    assert.equal(await provider(), null);
    assert.equal(calls, 1);
    state = { state: 'ok', expiry: new Date(Date.now() + 3600000).toISOString() };
    rewrite(file, '{"new":true,"scope":"calendar"}');
    const next = await provider();
    assert.ok(next, 'the rewritten token file invalidated the broken cache');
    assert.equal(calls, 2);
  });

  test('broken cached, token file unchanged: the cooldown is honored (no re-classify)', async () => {
    const file = path.join(dir, 'token-b.json');
    fs.writeFileSync(file, '{"old":true}');
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { state: /** @type {any} */ ({ state: 'broken_invalid_grant' }), accessToken: null };
    };
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: file }), { classifyAndConnect: fn, brokenCooldownMs: 5 * 60000 });
    await provider();
    await provider();
    await provider();
    assert.equal(calls, 1);
  });

  test('ok cached, token file rewritten: the next call re-classifies', async () => {
    const file = path.join(dir, 'token-c.json');
    fs.writeFileSync(file, '{"old":true}');
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { state: /** @type {any} */ ({ state: 'ok', expiry: new Date(Date.now() + 3600000).toISOString() }), accessToken: 'zz' };
    };
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: file }), { classifyAndConnect: fn });
    await provider();
    await provider();
    assert.equal(calls, 1, 'unchanged file: success cache honored');
    rewrite(file, '{"rotated":true,"longer":"content"}');
    await provider();
    assert.equal(calls, 2, 'rewritten file: success cache dropped');
  });

  test('token file deleted after a broken classification invalidates the cache (signature changed)', async () => {
    const file = path.join(dir, 'token-d.json');
    fs.writeFileSync(file, '{"old":true}');
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { state: /** @type {any} */ ({ state: 'broken_invalid_grant' }), accessToken: null };
    };
    const provider = makeCalendarProvider(/** @type {any} */ ({ GOOGLE_TOKEN_FILE: file }), { classifyAndConnect: fn, brokenCooldownMs: 5 * 60000 });
    await provider();
    fs.rmSync(file);
    await provider();
    assert.equal(calls, 2);
  });
});
