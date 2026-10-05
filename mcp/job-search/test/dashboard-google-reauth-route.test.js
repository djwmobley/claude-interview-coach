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
import { packageRoot } from '../src/core/config.js';

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
    reauthHelperOutLog: freshPath('helper-out'),
    reauthConsentWaitMs: 60,
    ...overrides,
  };
}

const CLIENT_ID = 'zz-route-cid.apps.googleusercontent.com';

/** A real token file carrying the configured client id (the consent URL's client_id must equal it). */
function writeTokenFile() {
  const file = freshPath('token');
  fs.writeFileSync(file, JSON.stringify({ client_id: CLIENT_ID, client_secret: 's', refresh_token: 'r' }));
  return file;
}

/** @param {number} port @param {string} state */
function googleUrl(port, state) {
  const qs = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: `http://localhost:${port}/oauth2callback`, state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
}

/**
 * Write a live lock (this process's pid) and a consent file next to it.
 * @param {string} lockFile
 * @param {{ nonce?: string, fileNonce?: string, filePid?: number, expiresAt?: string }} [o]
 */
function writeLockAndConsent(lockFile, o = {}) {
  const nonce = o.nonce ?? 'n'.repeat(32);
  const state = 's'.repeat(64);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: 8003, started_at: new Date().toISOString(), waitMs: 3600000, nonce }));
  const url = googleUrl(8003, state);
  fs.writeFileSync(`${lockFile}.consent.json`, JSON.stringify({
    pid: o.filePid ?? process.pid, nonce: o.fileNonce ?? nonce, port: 8003, state, url,
    created_at: new Date().toISOString(), expires_at: o.expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
  }));
  return { url, state, nonce };
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
    assert.deepEqual(res.body.reauth, { running: false, pid: null, startedAt: null, waitsUntil: null, lastOutcome: null, lastOutcomeAt: null, consentUrl: null, consentExpect: null });
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
    // Dashboard-initiated: the operator's own tab is the channel, so the OS-level launch is skipped,
    // and the per-run nonce lets this route match the lock + consent file it just caused.
    assert.equal(c.args[5], '--no-launch');
    assert.equal(c.args[6], '--nonce');
    assert.match(c.args[7], /^[0-9a-f]{32}$/);
    assert.equal(c.args.length, 8);
    assert.equal(c.opts.detached, true);
    assert.equal(c.opts.windowsHide, true);
    // stdout/stderr go to logs/google-reauth-helper.out.log via an fd opened for append.
    assert.equal(c.opts.stdio[0], 'ignore');
    assert.equal(typeof c.opts.stdio[1], 'number');
    assert.equal(c.opts.stdio[2], c.opts.stdio[1]);
    // POST timed out waiting for a consent file (the fake child never writes one).
    assert.equal(res.body.consentUrl, null);
    // cwd is deliberately pinned to packageRoot() (unlike scan-run.js's own spawn, which sets no cwd at
    // all) -- see the route's own comment for why: this asserts against the same packageRoot() the
    // config module itself computes, i.e. the injected package root, not a hardcoded path.
    assert.equal(c.opts.cwd, packageRoot());
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

describe('consent link (2026-10-04 fix, spec S3/S4)', () => {
  const broken = async () => ({ state: 'broken_invalid_grant' });

  test('GET: reauth.consentUrl appears when the lock is live and the file matches its nonce + pid', async () => {
    const lockFile = freshPath('lock');
    const { url, state } = writeLockAndConsent(lockFile);
    const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: writeTokenFile() }, reauthLockFile: lockFile, classifyGoogleTokenState: broken });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.body.reauth.running, true);
    assert.equal(res.body.reauth.consentUrl, url);
    assert.deepEqual(res.body.reauth.consentExpect, { clientId: CLIENT_ID, state, port: 8003 });
  });

  for (const [label, opts] of /** @type {Array<[string, any]>} */ ([
    ['nonce mismatch', { fileNonce: 'x'.repeat(32) }],
    ['pid mismatch', { filePid: process.pid + 1 }],
    ['expired', { expiresAt: new Date(Date.now() - 1000).toISOString() }],
  ])) {
    test(`GET: a stale consent file (${label}) is ignored`, async () => {
      const lockFile = freshPath('lock');
      writeLockAndConsent(lockFile, opts);
      const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: writeTokenFile() }, reauthLockFile: lockFile, classifyGoogleTokenState: broken });
      const res = await makeCaller(deps)('GET', '/api/google/auth');
      assert.equal(res.body.reauth.running, true);
      assert.equal(res.body.reauth.consentUrl, null);
    });

    test(`POST lock_held: a stale consent file (${label}) is ignored`, async () => {
      const lockFile = freshPath('lock');
      writeLockAndConsent(lockFile, opts);
      const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: writeTokenFile() }, reauthLockFile: lockFile, classifyGoogleTokenState: broken });
      const res = await makeCaller(deps)('POST', '/api/google/reauth');
      assert.equal(res.body.reason, 'lock_held');
      assert.equal(res.body.consentUrl, null);
    });
  }

  test('GET: consent URL with a client_id other than the configured one is REJECTED (null)', async () => {
    const lockFile = freshPath('lock');
    writeLockAndConsent(lockFile);
    const other = freshPath('token-other');
    fs.writeFileSync(other, JSON.stringify({ client_id: 'someone-else', client_secret: 's' }));
    const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: other }, reauthLockFile: lockFile, classifyGoogleTokenState: broken });
    const res = await makeCaller(deps)('GET', '/api/google/auth');
    assert.equal(res.body.reauth.consentUrl, null);
  });

  test('POST lock_held returns the existing helper\'s consent URL', async () => {
    const lockFile = freshPath('lock');
    const { url } = writeLockAndConsent(lockFile);
    const { fn: spawnImpl, calls } = fakeSpawn();
    const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: writeTokenFile() }, reauthLockFile: lockFile, spawn: spawnImpl, classifyGoogleTokenState: broken });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.reason, 'lock_held');
    assert.equal(res.body.consentUrl, url);
    assert.equal(calls.length, 0);
  });

  test('POST started: waits for the helper it spawned and returns its consent URL', async () => {
    const lockFile = freshPath('lock');
    const state = 'w'.repeat(64);
    const url = googleUrl(8004, state);
    const spawnImpl = (/** @type {string} */ _cmd, /** @type {string[]} */ args) => {
      const nonce = args[args.indexOf('--nonce') + 1];
      const child = /** @type {any} */ (new EventEmitter());
      child.pid = process.pid;
      child.unref = () => {};
      setTimeout(() => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: 8004, started_at: new Date().toISOString(), waitMs: 3600000, nonce }));
        fs.writeFileSync(`${lockFile}.consent.json`, JSON.stringify({ pid: process.pid, nonce, port: 8004, state, url, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() }));
      }, 80);
      return child;
    };
    const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: writeTokenFile() }, reauthLockFile: lockFile, reauthConsentWaitMs: 3000, spawn: spawnImpl, classifyGoogleTokenState: broken });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.started, true);
    assert.equal(res.body.pid, process.pid);
    assert.equal(res.body.consentUrl, url);
    assert.deepEqual(res.body.consentExpect, { clientId: CLIENT_ID, state, port: 8004 });
  });

  test('POST started: a consent file from a different nonce is never returned; times out to null', async () => {
    const lockFile = freshPath('lock');
    const spawnImpl = () => {
      const child = /** @type {any} */ (new EventEmitter());
      child.pid = process.pid;
      child.unref = () => {};
      // Simulates a different helper winning the lock with its own nonce.
      setTimeout(() => writeLockAndConsent(lockFile, { nonce: 'z'.repeat(32) }), 20);
      return child;
    };
    const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: writeTokenFile() }, reauthLockFile: lockFile, reauthConsentWaitMs: 200, spawn: spawnImpl, classifyGoogleTokenState: broken });
    const res = await makeCaller(deps)('POST', '/api/google/reauth');
    assert.equal(res.body.started, true);
    assert.equal(res.body.consentUrl, null);
  });

  test('helper out log over 1 MB is truncated at spawn; under 1 MB it is kept', async () => {
    const big = freshPath('helper-out-big');
    fs.writeFileSync(big, 'x'.repeat(1024 * 1024 + 10));
    const { fn: spawnImpl } = fakeSpawn();
    await makeCaller(baseDeps({ reauthHelperOutLog: big, spawn: spawnImpl, classifyGoogleTokenState: broken }))('POST', '/api/google/reauth');
    assert.equal(fs.statSync(big).size, 0);

    const small = freshPath('helper-out-small');
    fs.writeFileSync(small, 'keep me');
    const s2 = fakeSpawn();
    await makeCaller(baseDeps({ reauthHelperOutLog: small, spawn: s2.fn, classifyGoogleTokenState: broken }))('POST', '/api/google/reauth');
    assert.equal(fs.readFileSync(small, 'utf8'), 'keep me');
  });

  test('GET /api/google/reauth (lightweight banner poll): running + consentUrl without classifying the token', async () => {
    const lockFile = freshPath('lock');
    const { url } = writeLockAndConsent(lockFile);
    let classified = 0;
    const deps = baseDeps({ env: { GOOGLE_TOKEN_FILE: writeTokenFile() }, reauthLockFile: lockFile, classifyGoogleTokenState: async () => { classified++; return { state: 'broken_invalid_grant' }; } });
    const res = await makeCaller(deps)('GET', '/api/google/reauth');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.running, true);
    assert.equal(res.body.consentUrl, url);
    assert.equal(classified, 0);
  });
});
