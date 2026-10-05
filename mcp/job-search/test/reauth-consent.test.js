// @ts-check
/**
 * Consent-link handoff file (2026-10-04 reauth consent-link fix, spec S1/S3/S4/S8):
 * src/core/reauth-consent.js plus the parts of src/core/google-reauth.js that write and delete
 * logs/google-reauth.consent.json. Real files in a tmpdir, a real loopback server, injected
 * makeOAuthClient so nothing contacts Google and nothing opens a browser.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { reauthorizeGoogle, readReauthLock } from '../src/core/google-reauth.js';
import {
  consentFileFor, writeConsentFile, deleteOwnConsentFile, readConsentFile, resolveLiveConsent,
  readConfiguredClientId, waitForConsent, reauthPendingMessage,
} from '../src/core/reauth-consent.js';

/** @type {string} */
let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-consent-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function fresh(name) {
  return path.join(tmp, `${name}-${process.pid}-${seq++}`);
}

const CLIENT_ID = 'zz-cid.apps.googleusercontent.com';

function writeToken() {
  const file = fresh('token') + '.json';
  fs.writeFileSync(file, JSON.stringify({ client_id: CLIENT_ID, client_secret: 'zz-secret', refresh_token: 'zz-rt', scopes: [] }));
  return file;
}

const writeTokenWithClient = writeToken;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** A fake OAuth client whose consent URL is a real-shaped Google URL (classifies OPEN). */
function fakeMakeOAuthClient(opts = {}) {
  return (/** @type {string} */ clientId, /** @type {string} */ _secret, /** @type {string} */ redirectUri) => ({
    generateAuthUrl(/** @type {any} */ o) {
      if (opts.throwOnGenerate) throw new Error('generate failed');
      const qs = new URLSearchParams({ access_type: 'offline', scope: 'x', response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: String(o.state) });
      return `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
    },
  });
}

/** @param {number} port @param {string} state */
function googleUrl(port, state, clientId = CLIENT_ID) {
  const qs = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: `http://localhost:${port}/oauth2callback`, state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
}

/**
 * Write a live lock (this process's pid, fresh) + a matching consent record.
 * @param {{ nonce?: string, filePid?: number, fileNonce?: string, expiresAt?: string, lockPid?: number }} [o]
 */
function writeLiveLockAndConsent(o = {}) {
  const lockFile = fresh('lock') + '.lock';
  const consentFile = consentFileFor(lockFile);
  const nonce = o.nonce ?? 'n'.repeat(32);
  const state = 's'.repeat(64);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: o.lockPid ?? process.pid, port: 8001, started_at: new Date().toISOString(), waitMs: 3600000, nonce }));
  const rec = {
    pid: o.filePid ?? process.pid,
    nonce: o.fileNonce ?? nonce,
    port: 8001,
    state,
    url: googleUrl(8001, state),
    created_at: new Date().toISOString(),
    expires_at: o.expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
  };
  fs.writeFileSync(consentFile, JSON.stringify(rec));
  return { lockFile, consentFile, nonce, rec };
}

describe('consentFileFor', () => {
  test('default lock path maps to logs/google-reauth.consent.json; a custom lock gets a sibling', () => {
    assert.match(consentFileFor(), /logs[\\/]google-reauth\.consent\.json$/);
    assert.equal(consentFileFor('/x/y/custom.lock'), '/x/y/custom.lock.consent.json');
  });
});

describe('writeConsentFile', () => {
  test('writes atomically and creates the directory when missing', () => {
    const file = path.join(fresh('dir'), 'sub', 'consent.json');
    const ok = writeConsentFile(file, { nonce: 'a' });
    assert.equal(ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { nonce: 'a' });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['consent.json'], 'no tmp file left behind');
  });

  test('retries the rename on EPERM/EBUSY and succeeds within 3 attempts', () => {
    const file = fresh('consent') + '.json';
    let calls = 0;
    const renameImpl = (/** @type {string} */ a, /** @type {string} */ b) => {
      calls++;
      if (calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' });
      fs.renameSync(a, b);
    };
    assert.equal(writeConsentFile(file, { nonce: 'b' }, { renameImpl }), true);
    assert.equal(calls, 3);
  });

  test('gives up after 3 failed attempts, logs, never throws, leaves no tmp file', () => {
    const file = fresh('consent') + '.json';
    /** @type {any[]} */
    const logs = [];
    const renameImpl = () => {
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    };
    assert.equal(writeConsentFile(file, { nonce: 'c' }, { renameImpl, log: (f) => logs.push(f) }), false);
    assert.equal(logs.some((l) => l.evt === 'google_reauth_consent_write_failed'), true);
    assert.equal(fs.readdirSync(path.dirname(file)).some((n) => n.startsWith(path.basename(file))), false);
  });
});

describe('deleteOwnConsentFile', () => {
  test('deletes only when the nonce matches', () => {
    const file = fresh('consent') + '.json';
    fs.writeFileSync(file, JSON.stringify({ nonce: 'winner' }));
    assert.equal(deleteOwnConsentFile(file, 'loser'), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(deleteOwnConsentFile(file, 'winner'), true);
    assert.equal(fs.existsSync(file), false);
  });
  test('missing file or empty nonce: false, never throws', () => {
    assert.equal(deleteOwnConsentFile(fresh('none'), 'x'), false);
    const file = fresh('consent') + '.json';
    fs.writeFileSync(file, JSON.stringify({ nonce: '' }));
    assert.equal(deleteOwnConsentFile(file, ''), false);
    assert.equal(fs.existsSync(file), true);
  });
});

describe('resolveLiveConsent (S3/S4 file validation)', () => {
  test('matching live lock + unexpired file + OPEN url -> consentUrl', () => {
    const { lockFile, consentFile, rec } = writeLiveLockAndConsent();
    const r = resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID });
    assert.ok(r);
    assert.equal(r.consentUrl, rec.url);
    assert.deepEqual(r.consentExpect, { clientId: CLIENT_ID, state: rec.state, port: 8001 });
  });
  test('stale file: nonce mismatch -> null', () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent({ fileNonce: 'other'.repeat(8) });
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID }), null);
  });
  test('stale file: pid mismatch -> null', () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent({ filePid: process.pid + 1 });
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID }), null);
  });
  test('stale file: expired -> null', () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID }), null);
  });
  test('dead lock (not running) -> null', () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent({ lockPid: 999999, filePid: 999999 });
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID }), null);
  });
  test('client id mismatch or unknown -> null (REJECT)', () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent();
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: 'other-client' }), null);
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: null }), null);
  });
  test('missing file / malformed JSON -> null', () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent();
    fs.writeFileSync(consentFile, '{not json');
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID }), null);
    fs.unlinkSync(consentFile);
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID }), null);
    assert.equal(readConsentFile(consentFile), null);
  });
  test('a lock without a nonce (pre-fix helper) -> null', () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent();
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    delete lock.nonce;
    fs.writeFileSync(lockFile, JSON.stringify(lock));
    assert.equal(resolveLiveConsent({ lock: readReauthLock(lockFile), consentFile, clientId: CLIENT_ID }), null);
  });
});

describe('reauthPendingMessage (S7 scan report line)', () => {
  test('a live helper with a valid consent file: the message carries the link', () => {
    const { lockFile, consentFile, rec } = writeLiveLockAndConsent();
    const msg = reauthPendingMessage({ lockFile, consentFile, tokenFile: writeTokenWithClient() });
    assert.ok(msg.includes(rec.url), msg);
    assert.match(msg, /Gmail resumes next run/);
  });
  test('no live helper / no valid file: the message points at the dashboard instead', () => {
    const lockFile = fresh('lock') + '.lock';
    const msg = reauthPendingMessage({ lockFile, consentFile: consentFileFor(lockFile), tokenFile: writeTokenWithClient() });
    assert.match(msg, /open the dashboard/i);
    assert.ok(!/https:/.test(msg));
  });
  test('never throws on garbage input', () => {
    assert.equal(typeof reauthPendingMessage(/** @type {any} */ ({})), 'string');
  });
});

describe('readConfiguredClientId', () => {
  test('reads client_id from the token file; null when missing/unreadable', () => {
    assert.equal(readConfiguredClientId(writeToken()), CLIENT_ID);
    assert.equal(readConfiguredClientId(fresh('missing')), null);
    assert.equal(readConfiguredClientId(undefined), null);
  });
});

describe('waitForConsent', () => {
  test('returns null at timeout when no file ever appears, without blocking the event loop', async () => {
    const lockFile = fresh('lock') + '.lock';
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const started = Date.now();
    const r = await waitForConsent({ lockFile, consentFile: consentFileFor(lockFile), clientId: CLIENT_ID, nonce: 'x', pid: process.pid, timeoutMs: 250, intervalMs: 20 });
    clearInterval(iv);
    assert.equal(r, null);
    assert.ok(Date.now() - started >= 240);
    assert.ok(ticks >= 5, 'other timers kept running while polling');
  });
  test('resolves once a matching lock + file appear', async () => {
    const lockFile = fresh('lock') + '.lock';
    const consentFile = consentFileFor(lockFile);
    const nonce = 'q'.repeat(32);
    setTimeout(() => {
      const state = 't'.repeat(64);
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), waitMs: 3600000, nonce }));
      fs.writeFileSync(consentFile, JSON.stringify({ pid: process.pid, nonce, port: 8002, state, url: googleUrl(8002, state), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() }));
    }, 60);
    const r = await waitForConsent({ lockFile, consentFile, clientId: CLIENT_ID, nonce, pid: process.pid, timeoutMs: 2000, intervalMs: 20 });
    assert.ok(r);
    assert.match(r.consentUrl, /^https:\/\/accounts\.google\.com\//);
  });
  test('a matching file under a lock with a different nonce is ignored', async () => {
    const { lockFile, consentFile } = writeLiveLockAndConsent({ nonce: 'a'.repeat(32) });
    const r = await waitForConsent({ lockFile, consentFile, clientId: CLIENT_ID, nonce: 'b'.repeat(32), pid: process.pid, timeoutMs: 120, intervalMs: 20 });
    assert.equal(r, null);
  });
});

describe('reauthorizeGoogle: consent file lifecycle (S1)', () => {
  test('writes {pid,nonce,port,state,url,created_at,expires_at} after binding; lock carries the same nonce; deleted on exit', async () => {
    const tokenFile = writeToken();
    const lockFile = fresh('lock') + '.lock';
    const consentFile = consentFileFor(lockFile);
    const port = await freePort();
    const controller = new AbortController();
    /** @type {any} */
    let seen = null;
    /** @type {any} */
    let seenLock = null;
    const result = await reauthorizeGoogle({
      tokenFile, lockFile, signal: controller.signal, timeoutMs: 10000, nonce: 'f'.repeat(32),
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      deps: { makeOAuthClient: fakeMakeOAuthClient() },
      openUrl(url) {
        seen = { url, rec: JSON.parse(fs.readFileSync(consentFile, 'utf8')) };
        seenLock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        controller.abort();
      },
    });
    assert.equal(result.outcome, 'aborted');
    assert.ok(seen);
    const rec = seen.rec;
    assert.deepEqual(Object.keys(rec).sort(), ['created_at', 'expires_at', 'nonce', 'pid', 'port', 'state', 'url']);
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.nonce, 'f'.repeat(32));
    assert.equal(rec.port, port);
    assert.equal(rec.url, seen.url);
    assert.equal(new URL(rec.url).searchParams.get('state'), rec.state);
    assert.equal(Date.parse(rec.expires_at) - Date.parse(rec.created_at), 10000);
    assert.equal(seenLock.nonce, 'f'.repeat(32));
    assert.equal(fs.existsSync(consentFile), false, 'own consent file deleted on exit');
  });

  test('a pre-existing consent file is unlinked right after the lock is acquired', async () => {
    const tokenFile = writeToken();
    const lockFile = fresh('lock') + '.lock';
    const consentFile = consentFileFor(lockFile);
    fs.writeFileSync(consentFile, JSON.stringify({ nonce: 'old', pid: 1 }));
    const port = await freePort();
    const result = await reauthorizeGoogle({
      tokenFile, lockFile, signal: new AbortController().signal, timeoutMs: 10000,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      deps: { makeOAuthClient: fakeMakeOAuthClient({ throwOnGenerate: true }) },
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(fs.existsSync(consentFile), false);
  });

  test('exit deletes only its own file: a file rewritten by someone else mid-run survives', async () => {
    const tokenFile = writeToken();
    const lockFile = fresh('lock') + '.lock';
    const consentFile = consentFileFor(lockFile);
    const port = await freePort();
    const controller = new AbortController();
    await reauthorizeGoogle({
      tokenFile, lockFile, signal: controller.signal, timeoutMs: 10000,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      deps: { makeOAuthClient: fakeMakeOAuthClient() },
      openUrl() {
        fs.writeFileSync(consentFile, JSON.stringify({ nonce: 'someone-else', pid: 1 }));
        controller.abort();
      },
    });
    assert.equal(JSON.parse(fs.readFileSync(consentFile, 'utf8')).nonce, 'someone-else');
  });

  test('a concurrent loser (lock_held) never deletes the winner\'s file', async () => {
    const { lockFile, consentFile, nonce } = writeLiveLockAndConsent();
    const result = await reauthorizeGoogle({ tokenFile: writeToken(), lockFile, signal: new AbortController().signal, nonce: 'l'.repeat(32) });
    assert.equal(result.outcome, 'lock_held');
    assert.equal(JSON.parse(fs.readFileSync(consentFile, 'utf8')).nonce, nonce);
  });

  test('timeout deletes the own consent file immediately (not after the grace window)', async () => {
    const tokenFile = writeToken();
    const lockFile = fresh('lock') + '.lock';
    const consentFile = consentFileFor(lockFile);
    const port = await freePort();
    const result = await reauthorizeGoogle({
      tokenFile, lockFile, signal: new AbortController().signal, timeoutMs: 80,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      deps: { makeOAuthClient: fakeMakeOAuthClient() },
      openUrl() {},
    });
    assert.equal(result.outcome, 'timeout');
    assert.equal(fs.existsSync(consentFile), false);
  });

  test('a failed consent-file write logs and never aborts the helper', async () => {
    const tokenFile = writeToken();
    const lockFile = fresh('lock') + '.lock';
    const blocker = fresh('blocker');
    fs.writeFileSync(blocker, 'a file where a directory should be');
    const port = await freePort();
    const controller = new AbortController();
    /** @type {any[]} */
    const logs = [];
    let opened = false;
    const result = await reauthorizeGoogle({
      tokenFile, lockFile, consentFile: path.join(blocker, 'consent.json'), signal: controller.signal, timeoutMs: 10000,
      redirectUris: [`http://localhost:${port}/oauth2callback`],
      deps: { makeOAuthClient: fakeMakeOAuthClient() },
      log: (f) => logs.push(f),
      openUrl() {
        opened = true;
        controller.abort();
      },
    });
    assert.equal(opened, true, 'the helper carried on to openUrl');
    assert.equal(result.outcome, 'aborted');
    assert.equal(logs.some((l) => l.evt === 'google_reauth_consent_write_failed'), true);
  });
});
