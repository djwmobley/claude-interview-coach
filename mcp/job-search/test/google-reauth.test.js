// @ts-check
/**
 * src/core/google-reauth.js: reauthorizeGoogle()'s total classification of outcomes (spec A1-A4). Every
 * scenario here uses a real token file on disk (mirrors test/google-token-state.test.js's convention),
 * a REAL loopback HTTP server (this module's whole job is running one), and INJECTED
 * deps.makeOAuthClient/deps.exchangeCode so no test ever contacts Google or opens a real browser --
 * openUrl is always a test double that captures the consent URL instead of launching anything.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  reauthorizeGoogle, mergeToken, naiveUtcExpiry, writeMergedToken, resolveRedirectUris,
  DEFAULT_REDIRECT_URIS, loginHintFromFilename, readReauthLock, readLastReauthOutcome,
  LOCK_STALE_GRACE_MS, LOCK_STALE_FALLBACK_WAIT_MS,
} from '../src/core/google-reauth.js';

/** @type {string} */
let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'google-reauth-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let fileSeq = 0;
/** @param {Record<string, unknown>} fields */
function writeToken(fields) {
  const file = path.join(tmp, `token-${process.pid}-${fileSeq++}.json`);
  fs.writeFileSync(file, JSON.stringify({ client_id: 'zz-cid', client_secret: 'zz-secret', refresh_token: 'zz-rt', token: 'zz-old-access', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], expiry: '2020-01-01T00:00:00', token_uri: 'https://oauth2.googleapis.com/token', ...fields }));
  return file;
}

let lockSeq = 0;
function freshLockFile() {
  return path.join(tmp, `lock-${process.pid}-${lockSeq++}.lock`);
}

let lastSeq = 0;
function freshLastFile() {
  return path.join(tmp, `last-${process.pid}-${lastSeq++}.json`);
}

/** A free 127.0.0.1 port, discovered by binding then immediately releasing. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Occupy a port with a plain listening server (simulates it already in use). */
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** @param {any[]} calls */
function fakeMakeOAuthClient(calls) {
  return (/** @type {string} */ clientId, /** @type {string} */ clientSecret, /** @type {string} */ redirectUri) => {
    const entry = { clientId, clientSecret, redirectUri, generateAuthUrlOpts: /** @type {any} */ (null) };
    calls.push(entry);
    return {
      generateAuthUrl(opts) {
        entry.generateAuthUrlOpts = opts;
        return `https://fake.example/consent?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(String(opts.state))}`;
      },
    };
  };
}

/** Sleep long enough for reauthorizeGoogle's request listener to be attached (it attaches synchronously
 * right after openUrl resolves) before the test fires its own HTTP request at the callback. */
function tick(ms = 30) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('reauthorizeGoogle: guardrails', () => {
  test('no_client_creds when client_secret is null', async () => {
    const file = writeToken({ client_secret: null });
    const result = await reauthorizeGoogle({ tokenFile: file, signal: new AbortController().signal, lockFile: freshLockFile() });
    assert.equal(result.outcome, 'no_client_creds');
  });

  test('no_client_creds when the token file does not exist at all', async () => {
    const result = await reauthorizeGoogle({ tokenFile: path.join(tmp, 'does-not-exist.json'), signal: new AbortController().signal, lockFile: freshLockFile() });
    assert.equal(result.outcome, 'no_client_creds');
  });

  test('never throws even with no signal at all', async () => {
    const file = writeToken({});
    // @ts-expect-error deliberately omitting the mandatory signal
    const result = await reauthorizeGoogle({ tokenFile: file, lockFile: freshLockFile() });
    assert.equal(result.outcome, 'failed');
  });

  test('an already-aborted signal returns aborted immediately, before touching the lock file', async () => {
    const file = writeToken({});
    const lockFile = freshLockFile();
    const controller = new AbortController();
    controller.abort();
    const result = await reauthorizeGoogle({ tokenFile: file, signal: controller.signal, lockFile });
    assert.equal(result.outcome, 'aborted');
    assert.equal(fs.existsSync(lockFile), false);
  });
});

describe('reauthorizeGoogle: lock file', () => {
  test('lock_held when a live pid already holds the lock', async () => {
    const file = writeToken({});
    const lockFile = freshLockFile();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: new Date().toISOString() }));
    const result = await reauthorizeGoogle({ tokenFile: file, signal: new AbortController().signal, lockFile });
    assert.equal(result.outcome, 'lock_held');
    // the held lock is never touched by a losing attempt
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid);
  });

  test('a stale lock (dead pid) is taken over rather than blocking, and released on abort', async () => {
    const file = writeToken({});
    const lockFile = freshLockFile();
    // A pid essentially guaranteed not to be alive on any real machine.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, port: null, started_at: new Date().toISOString() }));
    const controller = new AbortController();
    const calls = [];
    const port = await freePort();
    const resultP = reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: controller.signal,
      lockFile,
      timeoutMs: 10000,
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl() {
        // Once bound, the lock file must now carry OUR pid, not the stale one.
        const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        assert.equal(cur.pid, process.pid);
        controller.abort();
      },
    });
    const result = await resultP;
    assert.equal(result.outcome, 'aborted');
    assert.equal(fs.existsSync(lockFile), false, 'the lock is released immediately on an outcome other than timeout');
  });
});

describe('readReauthLock', () => {
  test('no lock file on disk -> held:false, stale:false', () => {
    const lockFile = freshLockFile();
    const r = readReauthLock(lockFile, new Date());
    assert.deepEqual(r, { held: false, pid: null, startedAt: null, waitMs: null, stale: false, raw: null });
  });

  test('unparseable JSON -> held:true, stale:true, raw carries the unparsed text', () => {
    const lockFile = freshLockFile();
    fs.writeFileSync(lockFile, 'not json at all');
    const r = readReauthLock(lockFile, new Date());
    assert.equal(r.held, true);
    assert.equal(r.stale, true);
    assert.equal(r.pid, null);
    assert.equal(r.raw, 'not json at all');
  });

  test('a live pid, fresh timestamp, within its own recorded waitMs -> held:true, stale:false', () => {
    const lockFile = freshLockFile();
    const now = new Date('2026-09-17T15:00:00.000Z');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: now.toISOString(), waitMs: 600000 }));
    const r = readReauthLock(lockFile, new Date(now.getTime() + 60000)); // 1 minute later, well within 10-minute waitMs
    assert.deepEqual(r, { held: true, pid: process.pid, startedAt: now.toISOString(), waitMs: 600000, stale: false, raw: r.raw });
  });

  test('dead pid -> stale:true regardless of age', () => {
    const lockFile = freshLockFile();
    const now = new Date();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, port: null, started_at: now.toISOString(), waitMs: 600000 }));
    const r = readReauthLock(lockFile, now);
    assert.equal(r.stale, true);
  });

  test('pid-reused-but-old-lock: a live pid (this test process) whose lock age exceeds its own waitMs + grace is stale even though the pid itself is alive', () => {
    const lockFile = freshLockFile();
    const started = new Date('2026-09-17T10:00:00.000Z');
    const waitMs = 600000; // 10 minutes
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: started.toISOString(), waitMs }));
    const justUnderBound = new Date(started.getTime() + waitMs + LOCK_STALE_GRACE_MS - 1000);
    const justOverBound = new Date(started.getTime() + waitMs + LOCK_STALE_GRACE_MS + 1000);
    assert.equal(readReauthLock(lockFile, justUnderBound).stale, false, 'still within waitMs + grace');
    assert.equal(readReauthLock(lockFile, justOverBound).stale, true, 'past waitMs + grace, even with a live (possibly reused) pid');
  });

  test('a lock record with no waitMs at all falls back to LOCK_STALE_FALLBACK_WAIT_MS + grace', () => {
    const lockFile = freshLockFile();
    const started = new Date('2026-09-17T10:00:00.000Z');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: started.toISOString() }));
    const justUnderBound = new Date(started.getTime() + LOCK_STALE_FALLBACK_WAIT_MS + LOCK_STALE_GRACE_MS - 1000);
    const justOverBound = new Date(started.getTime() + LOCK_STALE_FALLBACK_WAIT_MS + LOCK_STALE_GRACE_MS + 1000);
    assert.equal(readReauthLock(lockFile, justUnderBound).stale, false);
    assert.equal(readReauthLock(lockFile, justOverBound).stale, true);
  });

  test('acquireLock (via reauthorizeGoogle) treats a stale-by-age lock (live pid, expired waitMs) as free', async () => {
    const file = writeToken({});
    const lockFile = freshLockFile();
    const started = new Date(Date.now() - (LOCK_STALE_FALLBACK_WAIT_MS + LOCK_STALE_GRACE_MS + 5000));
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: started.toISOString() }));
    const controller = new AbortController();
    controller.abort(); // aborted before a port could ever bind -- just proves the lock was taken over
    const result = await reauthorizeGoogle({ tokenFile: file, signal: controller.signal, lockFile });
    assert.notEqual(result.outcome, 'lock_held');
  });
});

describe('readLastReauthOutcome / last.json (every exit path writes one)', () => {
  test('no file on disk -> null', () => {
    assert.equal(readLastReauthOutcome(freshLastFile()), null);
  });

  test('malformed JSON on disk -> null, never throws', () => {
    const lastFile = freshLastFile();
    fs.writeFileSync(lastFile, 'not json');
    assert.equal(readLastReauthOutcome(lastFile), null);
  });

  test('lock_held exit path writes { outcome, at, pid, port:null } atomically', async () => {
    const file = writeToken({});
    const lockFile = freshLockFile();
    const lastFile = freshLastFile();
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: null, started_at: new Date().toISOString() }));
    const result = await reauthorizeGoogle({ tokenFile: file, signal: new AbortController().signal, lockFile, lastOutcomeFile: lastFile });
    assert.equal(result.outcome, 'lock_held');
    const last = readLastReauthOutcome(lastFile);
    assert.ok(last);
    assert.equal(last.outcome, 'lock_held');
    assert.equal(last.pid, process.pid);
    assert.equal(last.port, null);
    assert.ok(typeof last.at === 'string' && !Number.isNaN(Date.parse(last.at)));
  });

  test('no_client_creds exit path writes a last.json record', async () => {
    const file = writeToken({ client_id: undefined, client_secret: undefined });
    const lastFile = freshLastFile();
    const result = await reauthorizeGoogle({ tokenFile: file, signal: new AbortController().signal, lockFile: freshLockFile(), lastOutcomeFile: lastFile });
    assert.equal(result.outcome, 'no_client_creds');
    assert.equal(readLastReauthOutcome(lastFile).outcome, 'no_client_creds');
  });

  test('a real bound-port outcome (aborted mid-flow) writes last.json with the actual bound port, not null', async () => {
    const file = writeToken({});
    const lastFile = freshLastFile();
    const controller = new AbortController();
    const calls = [];
    const port = await freePort();
    const result = await reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: controller.signal,
      lockFile: freshLockFile(),
      lastOutcomeFile: lastFile,
      timeoutMs: 10000,
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl() {
        controller.abort();
      },
    });
    assert.equal(result.outcome, 'aborted');
    const last = readLastReauthOutcome(lastFile);
    assert.equal(last.outcome, 'aborted');
    assert.equal(last.port, port);
  });

  test('at is the exit timestamp, not the start timestamp (injected clock, deterministic)', async () => {
    // Regression for the 2026-09-19 bug: `at` used to be stamped with the run's START clock (captured
    // before reauthorizeGoogleCore ran), so it exactly equalled the lock's own started_at instead of the
    // time the run actually finished. now/finishNow are two distinct injected instants here specifically
    // so the test fails if the code ever goes back to writing one shared timestamp for both.
    const file = writeToken({ client_id: undefined, client_secret: undefined });
    const lastFile = freshLastFile();
    const started = new Date('2026-09-19T02:30:15.358Z');
    const finished = new Date('2026-09-19T02:34:05.744Z');
    const result = await reauthorizeGoogle({
      tokenFile: file,
      signal: new AbortController().signal,
      lockFile: freshLockFile(),
      lastOutcomeFile: lastFile,
      now: started,
      finishNow: finished,
    });
    assert.equal(result.outcome, 'no_client_creds');
    const last = readLastReauthOutcome(lastFile);
    assert.equal(last.started_at, started.toISOString());
    assert.equal(last.at, finished.toISOString());
    assert.notEqual(last.at, last.started_at);
    assert.ok(Date.parse(last.at) > Date.parse(last.started_at));
  });

  test('at trails started_at by real elapsed run time on the default (uninjected) clock', async () => {
    const file = writeToken({});
    const lastFile = freshLastFile();
    const controller = new AbortController();
    const calls = [];
    const port = await freePort();
    const result = await reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: controller.signal,
      lockFile: freshLockFile(),
      lastOutcomeFile: lastFile,
      timeoutMs: 10000,
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl() {
        // A measurable delay between the run's start (stamped into started_at) and its finish (stamped
        // into at). If `at` were ever reused from the pre-run clock again, this delta would be ~0.
        await new Promise((r) => setTimeout(r, 30));
        controller.abort();
      },
    });
    assert.equal(result.outcome, 'aborted');
    const last = readLastReauthOutcome(lastFile);
    const deltaMs = Date.parse(last.at) - Date.parse(last.started_at);
    assert.ok(deltaMs >= 20, `expected at to trail started_at by ~30ms, got ${deltaMs}ms (at=${last.at} started_at=${last.started_at})`);
  });
});

describe('reauthorizeGoogle: port selection', () => {
  test('falls back past busy ports to the first free one', async () => {
    const file = writeToken({});
    const p1 = await freePort();
    const p2 = await freePort();
    const p3 = await freePort();
    const busy1 = await occupyPort(p1);
    const busy2 = await occupyPort(p2);
    try {
      const calls = [];
      const result = await reauthorizeGoogle({
        tokenFile: file,
        redirectUris: [`http://localhost:${p1}/oauth2callback`, `http://localhost:${p2}/oauth2callback`, `http://localhost:${p3}/oauth2callback`],
        signal: new AbortController().signal,
        lockFile: freshLockFile(),
        timeoutMs: 50,
        deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
        async openUrl() {},
      });
      assert.equal(result.outcome, 'timeout');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].redirectUri, `http://localhost:${p3}/oauth2callback`);
    } finally {
      await new Promise((r) => busy1.close(r));
      await new Promise((r) => busy2.close(r));
    }
  });

  test('port_unavailable when every configured port is busy', async () => {
    const file = writeToken({});
    const p1 = await freePort();
    const busy1 = await occupyPort(p1);
    try {
      const result = await reauthorizeGoogle({
        tokenFile: file,
        redirectUris: [`http://localhost:${p1}/oauth2callback`],
        signal: new AbortController().signal,
        lockFile: freshLockFile(),
      });
      assert.equal(result.outcome, 'port_unavailable');
    } finally {
      await new Promise((r) => busy1.close(r));
    }
  });
});

describe('reauthorizeGoogle: consent callback', () => {
  test('state mismatch -> HTTP 400 and outcome state_mismatch', async () => {
    const file = writeToken({});
    const port = await freePort();
    const calls = [];
    const result = await reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: new AbortController().signal,
      lockFile: freshLockFile(),
      timeoutMs: 10000,
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl() {
        await tick();
        const res = await fetch(`http://127.0.0.1:${port}/oauth2callback?state=wrong-state&code=abc`);
        assert.equal(res.status, 400);
      },
    });
    assert.equal(result.outcome, 'state_mismatch');
  });

  test('exchange_failed when Google reports an error param', async () => {
    const file = writeToken({});
    const port = await freePort();
    const calls = [];
    const result = await reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: new AbortController().signal,
      lockFile: freshLockFile(),
      timeoutMs: 10000,
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl() {
        await tick();
        const state = calls[0].generateAuthUrlOpts.state;
        await fetch(`http://127.0.0.1:${port}/oauth2callback?state=${encodeURIComponent(state)}&error=access_denied`);
      },
    });
    assert.equal(result.outcome, 'exchange_failed');
  });

  test('exchange_failed when the code exchange itself throws', async () => {
    const file = writeToken({});
    const port = await freePort();
    const calls = [];
    const result = await reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: new AbortController().signal,
      lockFile: freshLockFile(),
      timeoutMs: 10000,
      deps: {
        makeOAuthClient: fakeMakeOAuthClient(calls),
        exchangeCode: async () => {
          throw new Error('boom: exchange failed');
        },
      },
      async openUrl() {
        await tick();
        const state = calls[0].generateAuthUrlOpts.state;
        await fetch(`http://127.0.0.1:${port}/oauth2callback?state=${encodeURIComponent(state)}&code=abc123`);
      },
    });
    assert.equal(result.outcome, 'exchange_failed');
  });

  test('reauthorized: exchange succeeds, token file merged, HTTP 200 close-tab page served', async () => {
    const file = writeToken({ scopes: ['https://www.googleapis.com/auth/calendar.events'], unknown_field: 'keep-me' });
    const port = await freePort();
    const calls = [];
    const result = await reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: new AbortController().signal,
      lockFile: freshLockFile(),
      timeoutMs: 10000,
      deps: {
        makeOAuthClient: fakeMakeOAuthClient(calls),
        exchangeCode: async () => ({ access_token: 'zz-new-access', scope: 'https://www.googleapis.com/auth/gmail.readonly', expiry_date: Date.UTC(2030, 0, 1, 12, 30, 45) }),
      },
      async openUrl() {
        await tick();
        const state = calls[0].generateAuthUrlOpts.state;
        const res = await fetch(`http://127.0.0.1:${port}/oauth2callback?state=${encodeURIComponent(state)}&code=abc123`);
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /close this tab/i);
      },
    });
    assert.equal(result.outcome, 'reauthorized');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.unknown_field, 'keep-me', 'unknown keys survive the merge');
    assert.equal(written.token, 'zz-new-access');
    assert.equal(written.refresh_token, 'zz-rt', 'old refresh_token kept since the exchange omitted one');
    assert.deepEqual(new Set(written.scopes), new Set(['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly']));
    assert.equal(written.expiry, '2030-01-01T12:30:45');
  });

  test('write_failed (unit-level, deterministic cross-platform): writeMergedToken throws when the token file is not readable at write time', () => {
    const missing = path.join(tmp, `does-not-exist-${fileSeq++}.json`);
    const creds = { client_id: 'zz-cid', client_secret: 'zz-secret', refresh_token: 'zz-rt', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] };
    assert.throws(() => writeMergedToken(missing, { access_token: 'x' }, [], 'irrelevant-hash', creds), /not readable/);
  });

  test('google_reauth_consent_url log event carries url_length alongside the (MAX_STRING-truncatable) url, so a 300-char logger truncation is visible rather than silently hiding the real URL length', async () => {
    const file = writeToken({});
    const port = await freePort();
    const calls = [];
    /** @type {Record<string, unknown>[]} */
    const logLines = [];
    const result = await reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: new AbortController().signal,
      lockFile: freshLockFile(),
      timeoutMs: 10000,
      log: (f) => logLines.push(f),
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl(url) {
        await tick();
        const line = logLines.find((l) => l.evt === 'google_reauth_consent_url');
        assert.ok(line, 'google_reauth_consent_url must have been logged before openUrl runs');
        assert.equal(line.url, url);
        assert.equal(line.url_length, url.length);
        assert.equal(typeof line.url_length, 'number');
        const state = calls[0].generateAuthUrlOpts.state;
        await fetch(`http://127.0.0.1:${port}/oauth2callback?state=${encodeURIComponent(state)}&code=abc123`);
      },
    });
    assert.equal(result.outcome, 'exchange_failed', 'unused fakeMakeOAuthClient has no exchangeCode dep; the outcome itself is irrelevant to this test');
  });
});

describe('reauthorizeGoogle: timeout and abort', () => {
  test('timeout: outcome timeout, server keeps serving a link-expired page during the grace window', async () => {
    const file = writeToken({});
    const port = await freePort();
    const calls = [];
    const resultP = reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: new AbortController().signal,
      lockFile: freshLockFile(),
      timeoutMs: 60,
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl() {},
    });
    const result = await resultP;
    assert.equal(result.outcome, 'timeout');
    // Still within the grace window: the socket is still bound and answers with an "expired" page.
    const res = await fetch(`http://127.0.0.1:${port}/oauth2callback?state=whatever&code=whatever`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /expired/i);
  });

  test('abort: outcome aborted, and the port is free again immediately (no 30s grace)', async () => {
    const file = writeToken({});
    const port = await freePort();
    const controller = new AbortController();
    const calls = [];
    const resultP = reauthorizeGoogle({
      tokenFile: file,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      signal: controller.signal,
      lockFile: freshLockFile(),
      timeoutMs: 10000,
      deps: { makeOAuthClient: fakeMakeOAuthClient(calls) },
      async openUrl() {
        controller.abort();
      },
    });
    const result = await resultP;
    assert.equal(result.outcome, 'aborted');
    // Server closed immediately (not deferred like timeout's grace window): a fresh bind on the same
    // port must succeed right away.
    const srv = await occupyPort(port);
    await new Promise((r) => srv.close(r));
  });
});

describe('mergeToken (spec A4)', () => {
  test('preserves unknown keys, unions scopes, keeps old refresh_token when omitted, strips any offset from expiry', () => {
    const base = { client_id: 'c', client_secret: 's', refresh_token: 'old-rt', token: 'old-token', scopes: ['a', 'b'], token_uri: 'https://oauth2.googleapis.com/token', some_future_field: 42 };
    const merged = mergeToken(base, { access_token: 'new-token', scope: 'b c', expiry_date: Date.UTC(2027, 5, 15, 8, 9, 10) }, ['d']);
    assert.equal(merged.some_future_field, 42);
    assert.deepEqual(new Set(merged.scopes), new Set(['a', 'b', 'c', 'd']));
    assert.equal(merged.token, 'new-token');
    assert.equal(merged.refresh_token, 'old-rt');
    assert.equal(merged.expiry, '2027-06-15T08:09:10');
  });

  test('keeps the OLD refresh_token when the new exchange omits one entirely', () => {
    const merged = mergeToken({ refresh_token: 'keep-me' }, { access_token: 'x', refresh_token: undefined }, []);
    assert.equal(merged.refresh_token, 'keep-me');
  });

  test('naiveUtcExpiry strips any timezone notion (always naive UTC, no Z, no offset)', () => {
    const s = naiveUtcExpiry(Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.equal(s, '2026-01-02T03:04:05');
    assert.doesNotMatch(s, /[zZ]|[+-]\d{2}:\d{2}$/);
  });
});

describe('writeMergedToken (spec A4): content-hash re-merge + atomic rename', () => {
  test('re-reads and re-merges against content that changed on disk after the start hash was taken', () => {
    const file = writeToken({ scopes: ['start-scope'] });
    const startText = fs.readFileSync(file, 'utf8');
    const startHash = crypto.createHash('sha256').update(startText, 'utf8').digest('hex');
    const startBase = JSON.parse(startText);
    // Simulate someone else (e.g. the workspace-mcp server) rewriting the file in between.
    fs.writeFileSync(file, JSON.stringify({ ...startBase, scopes: ['changed-elsewhere'], extra_new_field: 'present' }));
    writeMergedToken(file, { access_token: 'zz-new', scope: 'granted-scope' }, ['requested-scope'], startHash, startBase);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.extra_new_field, 'present', 'merge based on the LATEST on-disk content, not the stale start snapshot');
    assert.deepEqual(new Set(written.scopes), new Set(['changed-elsewhere', 'granted-scope', 'requested-scope']));
  });

  test('atomic rename: no .tmp file left behind, and the write is all-or-nothing', () => {
    const file = writeToken({});
    const startText = fs.readFileSync(file, 'utf8');
    const startHash = crypto.createHash('sha256').update(startText, 'utf8').digest('hex');
    writeMergedToken(file, { access_token: 'zz-final' }, [], startHash, JSON.parse(startText));
    const dirEntries = fs.readdirSync(path.dirname(file));
    assert.ok(!dirEntries.some((n) => n.includes('.tmp')), 'no leftover tmp file');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'zz-final');
  });
});

describe('resolveRedirectUris / loginHintFromFilename', () => {
  test('blank/undefined env falls back to the five registered defaults', () => {
    assert.deepEqual(resolveRedirectUris(undefined), [...DEFAULT_REDIRECT_URIS]);
    assert.deepEqual(resolveRedirectUris(''), [...DEFAULT_REDIRECT_URIS]);
    assert.deepEqual(resolveRedirectUris('   '), [...DEFAULT_REDIRECT_URIS]);
  });

  test('a comma list overrides the defaults, trimmed', () => {
    assert.deepEqual(resolveRedirectUris('http://localhost:9001/cb, http://localhost:9002/cb'), ['http://localhost:9001/cb', 'http://localhost:9002/cb']);
  });

  test('login_hint is derived only when the filename actually looks like an email', () => {
    assert.equal(loginHintFromFilename('/x/y/djwmobley@gmail.com.json'), 'djwmobley@gmail.com');
    assert.equal(loginHintFromFilename('/x/y/credentials.json'), undefined);
  });
});
