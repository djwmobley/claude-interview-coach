// @ts-check
/**
 * src/dashboard/public/lib/consent-url.js (spec S5): every REJECT branch individually, plus OPEN.
 * Each REJECT case starts from a known-OPEN URL and breaks exactly one condition.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConsentUrl, openableConsentUrl } from '../src/dashboard/public/lib/consent-url.js';

const EXPECT = Object.freeze({ clientId: 'cid-123.apps.googleusercontent.com', state: 'a'.repeat(64), port: 8001 });

/** @param {Record<string, string|string[]|null>} [over] @param {{ base?: string }} [opts] */
function makeUrl(over = {}, opts = {}) {
  const params = {
    access_type: 'offline',
    prompt: 'consent',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    response_type: 'code',
    client_id: EXPECT.clientId,
    redirect_uri: 'http://localhost:8001/oauth2callback',
    state: EXPECT.state,
    ...over,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else qs.append(k, v);
  }
  return `${opts.base ?? 'https://accounts.google.com/o/oauth2/v2/auth'}?${qs.toString()}`;
}

/** @param {string} url @param {any} [expect] */
function verdict(url, expect = EXPECT) {
  return classifyConsentUrl(url, expect).verdict;
}

describe('classifyConsentUrl: OPEN', () => {
  test('a well-formed v2 consent URL is OPEN', () => {
    assert.equal(verdict(makeUrl()), 'OPEN');
  });
  test('the legacy /o/oauth2/auth path is OPEN', () => {
    assert.equal(verdict(makeUrl({}, { base: 'https://accounts.google.com/o/oauth2/auth' })), 'OPEN');
  });
  test('a 127.0.0.1 redirect_uri is OPEN', () => {
    assert.equal(verdict(makeUrl({ redirect_uri: 'http://127.0.0.1:8001/oauth2callback' })), 'OPEN');
  });
  test('openableConsentUrl returns the url on OPEN and null on REJECT', () => {
    assert.equal(openableConsentUrl(makeUrl(), EXPECT), makeUrl());
    assert.equal(openableConsentUrl('nope', EXPECT), null);
  });
});

describe('classifyConsentUrl: every REJECT condition individually', () => {
  const cases = /** @type {Array<[string, string, any?]>} */ ([
    ['unparseable', 'not a url at all'],
    ['relative string', '/o/oauth2/v2/auth?x=1'],
    ['empty string', ''],
    ['http protocol', makeUrl({}, { base: 'http://accounts.google.com/o/oauth2/v2/auth' })],
    ['javascript scheme', 'javascript:alert(1)'],
    ['wrong host', makeUrl({}, { base: 'https://accounts.google.com.evil.example/o/oauth2/v2/auth' })],
    ['subdomain host', makeUrl({}, { base: 'https://x.accounts.google.com/o/oauth2/v2/auth' })],
    ['username', makeUrl({}, { base: 'https://user@accounts.google.com/o/oauth2/v2/auth' })],
    ['username and password', makeUrl({}, { base: 'https://user:pw@accounts.google.com/o/oauth2/v2/auth' })],
    ['explicit non-default port', makeUrl({}, { base: 'https://accounts.google.com:8443/o/oauth2/v2/auth' })],
    ['explicit default port 443', makeUrl({}, { base: 'https://accounts.google.com:443/o/oauth2/v2/auth' })],
    ['wrong path', makeUrl({}, { base: 'https://accounts.google.com/o/oauth2/v3/auth' })],
    ['path with trailing slash', makeUrl({}, { base: 'https://accounts.google.com/o/oauth2/v2/auth/' })],
    ['missing redirect_uri', makeUrl({ redirect_uri: null })],
    ['duplicate redirect_uri', makeUrl({ redirect_uri: ['http://localhost:8001/oauth2callback', 'http://localhost:8001/oauth2callback'] })],
    ['missing client_id', makeUrl({ client_id: null })],
    ['duplicate client_id', makeUrl({ client_id: [EXPECT.clientId, EXPECT.clientId] })],
    ['missing response_type', makeUrl({ response_type: null })],
    ['duplicate response_type', makeUrl({ response_type: ['code', 'code'] })],
    ['missing state', makeUrl({ state: null })],
    ['duplicate state', makeUrl({ state: [EXPECT.state, EXPECT.state] })],
    ['response_type token', makeUrl({ response_type: 'token' })],
    ['client_id mismatch', makeUrl({ client_id: 'someone-else.apps.googleusercontent.com' })],
    ['state mismatch', makeUrl({ state: 'b'.repeat(64) })],
    ['redirect_uri unparseable', makeUrl({ redirect_uri: 'not a url' })],
    ['redirect_uri https', makeUrl({ redirect_uri: 'https://localhost:8001/oauth2callback' })],
    ['redirect_uri remote host', makeUrl({ redirect_uri: 'http://evil.example:8001/oauth2callback' })],
    ['redirect_uri localhost lookalike', makeUrl({ redirect_uri: 'http://localhost.evil.example:8001/oauth2callback' })],
    ['redirect_uri credentials', makeUrl({ redirect_uri: 'http://u:p@localhost:8001/oauth2callback' })],
    ['redirect_uri port mismatch', makeUrl({ redirect_uri: 'http://localhost:8002/oauth2callback' })],
    ['redirect_uri no port', makeUrl({ redirect_uri: 'http://localhost/oauth2callback' })],
    ['no expectation', makeUrl(), null],
    ['expectation missing clientId', makeUrl(), { state: EXPECT.state, port: EXPECT.port }],
    ['expectation missing state', makeUrl(), { clientId: EXPECT.clientId, port: EXPECT.port }],
    ['expectation non-integer port', makeUrl(), { clientId: EXPECT.clientId, state: EXPECT.state, port: '8001' }],
  ]);
  for (const [name, url, expect] of cases) {
    test(`REJECT: ${name}`, () => {
      const r = classifyConsentUrl(url, expect === undefined ? EXPECT : expect);
      assert.equal(r.verdict, 'REJECT', `${name} should be REJECT (reason ${r.reason})`);
    });
  }
  test('REJECT: non-string url values never throw', () => {
    for (const v of [null, undefined, 42, {}, []]) assert.equal(classifyConsentUrl(v, EXPECT).verdict, 'REJECT');
  });
});
