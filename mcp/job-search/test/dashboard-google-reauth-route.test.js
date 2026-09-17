// @ts-check
/**
 * routes/google.js (GET /api/google/auth's new category/reauth surface) and routes/google-reauth.js
 * (POST /api/google/reauth), exercised at the router-handler level directly (no real HTTP server, no
 * real database, no real Google network call) -- the same "dispatch, then call route.handler(ctx)
 * against a fake res" pattern test/dashboard-router.test.js already uses for router.js itself.
 * classifyGoogleTokenState is stubbed via the deps.classifyGoogleTokenState test seam
 * (src/core/scan-run.js's own established pattern for this exact function) so 'ok' is reachable
 * deterministically without a real Google token or refresh. Lock/last-outcome file paths are always
 * pointed at a fresh tmpdir via deps.reauthLockFile/deps.reauthLastOutcomeFile so no test ever touches
 * the real packageRoot()-derived logs/ paths.
 *
 * Route modules close over the `deps` object passed to register() at registration time (the same
 * convention every other routes/*.js file in this codebase uses -- only the inline /api/health handler
 * in server.js reads ctx.deps). makeCaller() below registers ONE router per test against that test's own
 * deps and returns a bound call() -- this matters for the already_starting test, which needs the
 * in-process guard's closure state to persist across two calls through the SAME registration.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRouter } from '../src/dashboard/router.js';
import { register as registerGoogle, categoryForState } from '../src/dashboard/routes/google.js';
import { register as registerGoogleReauth } from '../src/dashboard/routes/google-reauth.js';

/** @type {string} */
let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-google-reauth-route-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function freshPath(name) {
  return path.join(tmp, `${name}-${process.pid}-${seq++}.json`);
}

/** A response double that captures status/body the way sendJson() writes them. */
function fakeRes() {
  return {
    statusCode: /** @type {number|null} */ (null),
    headers: /** @type {Record<string, string>} */ ({}),
    body: /** @type {any} */ (null),
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
}

/**
 * Registers a fresh router against `deps` and returns a bound caller for it.
 * @param {any} deps
 */
function makeCaller(deps) {
  const r = createRouter();
  registerGoogle(r, deps);
  registerGoogleReauth(r, deps);
  /**
   * @param {string} method
   * @param {string} pathName
   * @param {any} [body]
   */
  return async function call(method, pathName, body = {}) {
    const dispatched = r.dispatch(pathName, method);
    assert.ok(dispatched && 'route' in dispatched, `no route for ${method} ${pathName}`);
    const res = fakeRes();
    // @ts-ignore -- statusCode is written by http.js's sendJson via res.statusCode = status
    await /** @type {any} */ (dispatched).route.handler({ params: /** @type {any} */ (dispatched).params, query: {}, body, deps, req: {}, res, requestId: 'zz-test' });
    return res;
  };
}

/** Fake child_process.spawn: captures the call, or throws for the spawn_failed branch. */
function fakeSpawn(behavior = 'ok') {
  /** @type {Array<{ cmd: string, args: string[], opts: any }>} */
  const calls = [];
  const fn = (cmd, args, opts) => {
    if (behavior === 'throw') throw new Error("spawn ENOENT: no such file or directory, posix_spawn 'node'\nextra line two");
    if (behavior === 'throw-long') throw new Error(`spawn ENOENT: ${'x'.repeat(400)}`);
    calls.push({ cmd, args, opts });
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 4242;
    child.unref = () => {
      child.unrefed = true;
    };
    return child;
  };
  return { fn, calls };
}

function baseDeps(overrides = {}) {
  return {
    env: { GOOGLE_TOKEN_FILE: 'C:\\fake\\token.json' },
    reauthLockFile: freshPath('lock'),
    reauthLastOutcomeFile: freshPath('last'),
    ...overrides,
  };
}

describe('categoryForState (total classification)', () => {
  test('ok -> ok', () => {
    assert.equal(categoryForState('ok'), 'ok');
  });
  test('every known broken_* state -> broken', () => {
    for (const s of ['broken_missing_file', 'broken_malformed', 'broken_no_refresh_token', 'broken_missing_scopes', 'broken_invalid_grant', 'broken_refresh_error']) {
      assert.equal(categoryForState(s), 'broken', s);
    }
  });
  test('an unrecognized state string -> unknown (the safe default, never a silent fall-through)', () => {
    assert.equal(categoryForState('some_future_state_nobody_wrote_a_branch_for'), 'unknown');
    assert.equal(categoryForState(''), 'unknown');
  });
});

describe('GET /api/google/auth', () => {
  test('category "ok" and expiry pass through when classifyGoogleTokenState resolves ok', async () => {
    const deps = baseDeps({ classifyGoogleTokenState: async () => ({ state: 'ok', expiry: '2030-01-01T00:00:00' }) });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.state, 'ok');
    assert.equal(res.body.category, 'ok');
    assert.equal(res.body.expiry, '2030-01-01T00:00:00');
  });

  test('category "broken" for a broken_* state, and expiry is null', async () => {
    const deps = baseDeps({ classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.body.category, 'broken');
    assert.equal(res.body.expiry, null);
  });

  test('category "unknown" when classifyGoogleTokenState returns a state this route does not recognize', async () => {
    const deps = baseDeps({ classifyGoogleTokenState: async () => ({ state: 'brand_new_future_state' }) });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.body.category, 'unknown');
  });

  test('reauth surface: no lock, no last outcome -> running false, everything else null', async () => {
    const deps = baseDeps({ classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.deepEqual(res.body.reauth, { running: false, pid: null, startedAt: null, waitsUntil: null, lastOutcome: null, lastOutcomeAt: null });
  });

  test('reauth surface: a live (non-stale) lock reports running:true with pid/startedAt/waitsUntil', async () => {
    const lockFile = freshPath('lock');
    const startedAt = new Date().toISOString();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: 8000, started_at: startedAt, waitMs: 3600000 }));
    const deps = baseDeps({ reauthLockFile: lockFile, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.body.reauth.running, true);
    assert.equal(res.body.reauth.pid, process.pid);
    assert.equal(res.body.reauth.startedAt, startedAt);
    assert.equal(res.body.reauth.waitsUntil, new Date(new Date(startedAt).getTime() + 3600000).toISOString());
  });

  test('reauth surface: a stale lock (dead pid) reports running:false', async () => {
    const lockFile = freshPath('lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, port: null, started_at: new Date().toISOString(), waitMs: 3600000 }));
    const deps = baseDeps({ reauthLockFile: lockFile, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.body.reauth.running, false);
  });

  test('reauth surface: lastOutcome/lastOutcomeAt surface a prior last.json record', async () => {
    const lastFile = freshPath('last');
    fs.writeFileSync(lastFile, JSON.stringify({ outcome: 'reauthorized', at: '2026-09-17T15:30:00.000Z', pid: 111, port: 8000 }));
    const deps = baseDeps({ reauthLastOutcomeFile: lastFile, classifyGoogleTokenState: async () => ({ state: 'ok', expiry: null }) });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.body.reauth.lastOutcome, 'reauthorized');
    assert.equal(res.body.reauth.lastOutcomeAt, '2026-09-17T15:30:00.000Z');
  });
});

describe('POST /api/google/reauth', () => {
  test('not_configured: no GOOGLE_TOKEN_FILE at all', async () => {
    const deps = baseDeps({ env: {} });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, started: false, state: null, category: null, reason: 'not_configured', pid: null });
  });

  test('already_ok: token already classifies ok', async () => {
    const deps = baseDeps({ classifyGoogleTokenState: async () => ({ state: 'ok', expiry: '2030-01-01T00:00:00' }) });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.reason, 'already_ok');
    assert.equal(res.body.started, false);
    assert.equal(res.body.pid, null);
  });

  test('lock_held: a live, non-stale lock blocks starting a second helper', async () => {
    const lockFile = freshPath('lock');
    const startedAt = new Date().toISOString();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: startedAt, waitMs: 3600000 }));
    const { fn: spawnImpl, calls } = fakeSpawn();
    const deps = baseDeps({ reauthLockFile: lockFile, spawn: spawnImpl, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.reason, 'lock_held');
    assert.equal(res.body.started, false);
    assert.equal(res.body.pid, process.pid);
    assert.equal(res.body.waitsUntil, new Date(new Date(startedAt).getTime() + 3600000).toISOString());
    assert.equal(calls.length, 0, 'never spawns when the lock is held');
  });

  test('a stale lock does not block starting a new helper', async () => {
    const lockFile = freshPath('lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, port: null, started_at: new Date().toISOString(), waitMs: 3600000 }));
    const { fn: spawnImpl, calls } = fakeSpawn();
    const deps = baseDeps({ reauthLockFile: lockFile, spawn: spawnImpl, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.started, true);
    assert.equal(calls.length, 1);
  });

  test('spawns bin/google-reauth.js with the exact argv shape (argv array, never a shell string), including a token path with spaces as a single element', async () => {
    const { fn: spawnImpl, calls } = fakeSpawn();
    const tokenFile = 'C:\\Users\\zz test\\google token.json';
    const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: tokenFile }, spawn: spawnImpl, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.started, true);
    assert.equal(res.body.pid, 4242);
    assert.equal(res.body.reason, null);
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.cmd, process.execPath);
    assert.ok(Array.isArray(c.args));
    assert.match(c.args[0], /bin[\\/]google-reauth\.js$/);
    assert.equal(c.args[1], '--wait-ms');
    assert.equal(c.args[2], '3600000');
    assert.equal(c.args[3], '--token-file');
    // The path-with-spaces token file must arrive as ONE argv element, not split on the space.
    assert.equal(c.args[4], tokenFile);
    assert.equal(c.args.length, 5);
    assert.equal(c.opts.detached, true);
    assert.equal(c.opts.windowsHide, true);
    assert.equal(c.opts.stdio, 'ignore');
    assert.equal('env' in c.opts, false, "no explicit env override -- inherits process.env exactly like scan-run.js's own spawn call");
  });

  test('already_starting: a second POST within 15s of a successful spawn is refused with the same pid, and never spawns twice', async () => {
    const { fn: spawnImpl, calls } = fakeSpawn();
    const deps = baseDeps({ spawn: spawnImpl, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const call = makeCaller(deps);
    const first = await call('POST', '/api/google/reauth');
    assert.equal(first.body.started, true);
    const second = await call('POST', '/api/google/reauth');
    assert.equal(second.body.started, false);
    assert.equal(second.body.reason, 'already_starting');
    assert.equal(second.body.pid, first.body.pid);
    assert.equal(calls.length, 1, 'the guard must prevent a second spawn');
  });

  test('spawn_failed: a throwing spawn returns reason spawn_failed with a capped, single-line message', async () => {
    const { fn: spawnImpl } = fakeSpawn('throw');
    const deps = baseDeps({ spawn: spawnImpl, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.started, false);
    assert.equal(res.body.reason, 'spawn_failed');
    assert.equal(res.body.pid, null);
    assert.ok(typeof res.body.message === 'string');
    assert.ok(res.body.message.length <= 200);
    assert.ok(!res.body.message.includes('\n'), 'message must be single-line');
  });

  test('spawn_failed: a message longer than 200 chars is truncated to exactly 200', async () => {
    const { fn: spawnImpl } = fakeSpawn('throw-long');
    const deps = baseDeps({ spawn: spawnImpl, classifyGoogleTokenState: async () => ({ state: 'broken_invalid_grant' }) });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.reason, 'spawn_failed');
    assert.equal(res.body.message.length, 200);
  });

  test('response is always 200 and reason is always one of the six named branches', async () => {
    for (const [label, deps] of /** @type {[string, any][]} */ ([
      ['not_configured', baseDeps({ env: {} })],
      ['already_ok', baseDeps({ classifyGoogleTokenState: async () => ({ state: 'ok', expiry: null }) })],
    ])) {
      const res = await makeCaller(deps)('POST', '/api/google/reauth');
      assert.equal(res.statusCode, 200, label);
      assert.ok([null, 'not_configured', 'already_ok', 'lock_held', 'already_starting', 'spawn_failed'].includes(res.body.reason), label);
    }
  });
});
