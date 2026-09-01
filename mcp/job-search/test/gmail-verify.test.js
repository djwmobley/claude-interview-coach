// @ts-check
/**
 * src/apply/gmail-verify.js (apply pipeline slice 6): the Workday verify-email lookup. A real token file
 * is written to a tmp dir (mirrors test/google-token-state.test.js's own convention) with an INJECTED
 * getAccessToken (never a real network call) and a fake messages.list/messages.get fetch (never real
 * Gmail traffic) -- there is no live Gmail access in this sandboxed environment, and the Google refresh
 * grant is currently invalid_grant regardless (see the PR body's Blind Spots section).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCOPE_GMAIL_READONLY } from '../src/core/google.js';
import { findVerificationMessage, extractVerification, GMAIL_MESSAGES_URL } from '../src/apply/gmail-verify.js';

/** @type {string} */
let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-verify-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** @param {string} name @param {Record<string, unknown>} fields */
function writeToken(name, fields) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify({ client_id: 'zz-cid', client_secret: 'zz-secret', refresh_token: 'zz-rt', scopes: [SCOPE_GMAIL_READONLY], ...fields }));
  return file;
}

const okDeps = { getAccessToken: async () => ({ token: 'zz-access-token', expiry: '2099-01-01T00:00:00.000Z' }) };

/** base64url of a plain-text body carrying a 6-digit code inside a "verification code" sentence. */
const CODE_BODY_B64 = 'SGVsbG8sIHlvdXIgV29ya2RheSB2ZXJpZmljYXRpb24gY29kZSBpcyA1ODM5MjAuIEl0IGV4cGlyZXMgaW4gMTAgbWludXRlcy4';
/** base64url of a plain-text body carrying a verify link, no code. */
const LINK_BODY_B64 = 'UGxlYXNlIGNsaWNrIGhlcmUgdG8gdmVyaWZ5OiBodHRwczovL2V4YW1wbGUud2Q1Lm15d29ya2RheWpvYnMuY29tL3ZlcmlmeT90b2tlbj1hYmMxMjM';
/** base64url of an unrelated body with a bare digit run that must NOT be mistaken for a code. */
const NEITHER_BODY_B64 = 'VGhhbmtzIGZvciBzaG9wcGluZyB3aXRoIHVzLiBZb3VyIG9yZGVyIDQ4MjkxMCBoYXMgc2hpcHBlZC4';

/**
 * @param {{ listStatus?: number, listMessages?: Array<{ id: string }>, getters?: Record<string, { status: number, body: any }> }} o
 */
function fakeFetch(o) {
  /** @type {any[]} */
  const calls = [];
  const fn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, headers: init && init.headers });
    if (url.startsWith(GMAIL_MESSAGES_URL) && url.includes('?')) {
      // could be either list (has q=) or get (has /id?format=full) -- distinguish by path segment count
      const u = new URL(url);
      if (u.pathname === new URL(GMAIL_MESSAGES_URL).pathname) {
        return {
          status: o.listStatus ?? 200,
          json: async () => ({ messages: o.listMessages ?? [] }),
        };
      }
      const id = u.pathname.split('/').pop();
      const entry = (o.getters ?? {})[/** @type {string} */ (id)];
      if (!entry) return { status: 404, json: async () => ({}) };
      return { status: entry.status, json: async () => entry.body };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { fn, calls };
}

describe('extractVerification', () => {
  test('extracts a context-anchored code', () => {
    const r = extractVerification({ text: 'Your verification code is 583920. It expires soon.', html: null });
    assert.equal(r.code, '583920');
    assert.equal(r.link, null);
  });

  test('a bare digit run with no context word is never mistaken for a code', () => {
    const r = extractVerification({ text: 'Your order 482910 has shipped. Tracking: 1234567890.', html: null });
    assert.equal(r.code, null);
  });

  test('extracts a verify/confirm/activate link', () => {
    const r = extractVerification({ text: 'Click here: https://example.wd5.myworkdayjobs.com/verify?token=abc123', html: null });
    assert.equal(r.link, 'https://example.wd5.myworkdayjobs.com/verify?token=abc123');
  });

  test('an HTML-only body is scanned too (tags stripped)', () => {
    const r = extractVerification({ text: null, html: '<p>Your verification code is <b>112233</b></p>' });
    assert.equal(r.code, '112233');
  });

  test('neither code nor link present -> both null, never a throw', () => {
    const r = extractVerification({ text: 'Thanks for shopping with us.', html: null });
    assert.equal(r.code, null);
    assert.equal(r.link, null);
  });
});

describe('findVerificationMessage', () => {
  test('no token file configured -> ok:false, reason no_token_file, no fetch attempted', async () => {
    const { fn, calls } = fakeFetch({});
    const r = await findVerificationMessage({ tokenFile: '', tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter: new Date(), fetch: fn });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_token_file');
    assert.equal(calls.length, 0);
  });

  test('missing token file on disk -> ok:false, reason carries broken_missing_file', async () => {
    const r = await findVerificationMessage({ tokenFile: path.join(tmp, 'does-not-exist.json'), tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter: new Date() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /broken_missing_file/);
  });

  test('token file missing the gmailRead scope -> ok:false, reason carries broken_missing_scopes', async () => {
    const file = writeToken('no-scope.json', { scopes: [] });
    const r = await findVerificationMessage({ tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter: new Date(), deps: okDeps });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /broken_missing_scopes/);
  });

  test('a live refresh error -> ok:false, never throws', async () => {
    const file = writeToken('refresh-error.json', {});
    const r = await findVerificationMessage({
      tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter: new Date(),
      deps: { getAccessToken: async () => { throw new Error('invalid_grant'); } },
    });
    assert.equal(r.ok, false);
  });

  test('messages.list 401 -> ok:false, reason gmail_list_401', async () => {
    const file = writeToken('list-401.json', {});
    const { fn } = fakeFetch({ listStatus: 401 });
    const r = await findVerificationMessage({ tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter: new Date(), fetch: fn, deps: okDeps });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'gmail_list_401');
  });

  test('no messages found -> ok:true, code:null, link:null (not an error, just "not yet")', async () => {
    const file = writeToken('empty.json', {});
    const { fn } = fakeFetch({ listMessages: [] });
    const r = await findVerificationMessage({ tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter: new Date(), fetch: fn, deps: okDeps });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.code, null);
      assert.equal(r.link, null);
    }
  });

  test('finds a code in the newest matching message', async () => {
    const file = writeToken('code.json', {});
    const sentAfter = new Date('2026-09-01T12:00:00Z');
    const { fn } = fakeFetch({
      listMessages: [{ id: 'm1' }],
      getters: { m1: { status: 200, body: { internalDate: String(sentAfter.getTime() + 5000), payload: { mimeType: 'text/plain', body: { data: CODE_BODY_B64 } } } } },
    });
    const r = await findVerificationMessage({ tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter, fetch: fn, deps: okDeps });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.code, '583920');
  });

  test('finds a link when no code is present', async () => {
    const file = writeToken('link.json', {});
    const sentAfter = new Date('2026-09-01T12:00:00Z');
    const { fn } = fakeFetch({
      listMessages: [{ id: 'm1' }],
      getters: { m1: { status: 200, body: { internalDate: String(sentAfter.getTime() + 5000), payload: { mimeType: 'text/plain', body: { data: LINK_BODY_B64 } } } } },
    });
    const r = await findVerificationMessage({ tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter, fetch: fn, deps: okDeps });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.code, null);
      assert.ok(r.link && r.link.includes('verify'));
    }
  });

  test('a message with neither code nor link is skipped, never mistaken for a match', async () => {
    const file = writeToken('neither.json', {});
    const sentAfter = new Date('2026-09-01T12:00:00Z');
    const { fn } = fakeFetch({
      listMessages: [{ id: 'm1' }],
      getters: { m1: { status: 200, body: { internalDate: String(sentAfter.getTime() + 5000), payload: { mimeType: 'text/plain', body: { data: NEITHER_BODY_B64 } } } } },
    });
    const r = await findVerificationMessage({ tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter, fetch: fn, deps: okDeps });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.code, null);
      assert.equal(r.link, null);
    }
  });

  test('a message dated well before sentAfter (stale) is skipped even if it happens to contain a code', async () => {
    const file = writeToken('stale.json', {});
    const sentAfter = new Date('2026-09-01T12:00:00Z');
    const { fn } = fakeFetch({
      listMessages: [{ id: 'old' }],
      getters: { old: { status: 200, body: { internalDate: String(sentAfter.getTime() - 3600000), payload: { mimeType: 'text/plain', body: { data: CODE_BODY_B64 } } } } },
    });
    const r = await findVerificationMessage({ tokenFile: file, tenantHost: 'acme.wd5.myworkdayjobs.com', sentAfter, fetch: fn, deps: okDeps });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.code, null);
  });
});
