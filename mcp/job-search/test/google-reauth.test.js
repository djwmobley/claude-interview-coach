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
  DEFAULT_REDIRECT_URIS, loginHintFromFilename,
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
