// @ts-check
/**
 * src/targets/fetch-guard.js (target finder PR2, plan 14.6 + 15.2 item 7). No live network: every fetch is
 * an injected fake or the recorded-fixture replay.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFetchGuard, FetchRefused, parseRetryAfter, TARGET_FETCH_HOSTS, SEC_FETCH_HOSTS, DEFAULT_MAX_RETRY_AFTER_MS,
} from '../src/targets/fetch-guard.js';
import { createReplayFetch } from './helpers/targets-replay.js';

const UA = 'Test Person test.person@corp.test';

/** @param {Array<(url: string, init: any) => Response|Promise<Response>>} handlers */
function sequenceFetch(handlers) {
  /** @type {Array<{ url: string, init: any }>} */
  const calls = [];
  /** @type {any} */
  const impl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return h(url, init);
  };
  return { fetch: /** @type {typeof fetch} */ (impl), calls };
}

describe('registry and URL validation (zero I/O on refusal)', () => {
  const REFUSED = [
    ['http://www.sec.gov/x', 'scheme'],
    ['ftp://www.sec.gov/x', 'scheme'],
    ['https://sec.gov/x', 'host'],
    ['https://www.sec.gov.evil.example/x', 'host'],
    ['https://evil-www.sec.gov/x', 'host'],
    ['https://sub.efts.sec.gov/x', 'host'],
    ['https://example.com/x', 'host'],
    ['https://www.sec.gov:8443/x', 'port'],
    ['https://user:pw@www.sec.gov/x', 'credentials'],
    ['https://user@gmail.googleapis.com/x', 'credentials'],
    ['not a url', 'url_invalid'],
    ['', 'url_invalid'],
  ];
  for (const [url, reason] of REFUSED) {
    test(`refuses ${JSON.stringify(url)} as ${reason} before any I/O`, async () => {
      const { fetch, calls } = sequenceFetch([() => new Response('x')]);
      const g = createFetchGuard({ fetch, userAgent: UA });
      await assert.rejects(g.get(url), (e) => e instanceof FetchRefused && e.reason === reason);
      assert.equal(calls.length, 0);
      assert.equal(g.requestCount, 0);
    });
  }
  test('the registry is exactly the three sec.gov hosts plus the Gmail API host', () => {
    assert.deepEqual([...TARGET_FETCH_HOSTS].sort(), ['data.sec.gov', 'efts.sec.gov', 'gmail.googleapis.com', 'www.sec.gov']);
    assert.deepEqual([...SEC_FETCH_HOSTS].sort(), ['data.sec.gov', 'efts.sec.gov', 'www.sec.gov']);
  });
  test('an explicit default port is the same as no port', async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('ok')]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    const r = await g.get('https://www.sec.gov:443/Archives/x');
    assert.equal(r.text, 'ok');
    assert.equal(calls.length, 1);
  });
  test('the refusal records the host, never the full URL', async () => {
    const g = createFetchGuard({ fetch: /** @type {any} */ (async () => new Response('')), userAgent: UA });
    await assert.rejects(g.get('https://example.com/secret?token=abc'), (e) => e instanceof FetchRefused && e.host === 'example.com' && !e.message.includes('token'));
  });
});

describe('GET only', () => {
  test('every request is a GET; the guard exposes no way to choose another verb', async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('{}')]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    await g.get('https://efts.sec.gov/LATEST/search-index?q=x');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(g.get.length <= 2, true);
    assert.deepEqual(Object.keys(g).sort(), ['get', 'hosts', 'maxRequests', 'requestCount', 'validate']);
  });
  test('the replay fetch used by the other target tests fails the test on a non-GET call', async () => {
    const { fetch } = createReplayFetch([{ match: () => true, body: 'x' }]);
    await assert.rejects(fetch('https://www.sec.gov/x', { method: 'POST' }), /non-GET/);
    await assert.rejects(fetch('https://example.com/x', { method: 'GET' }), /outside the registry/);
  });
});

describe('headers per host', () => {
  test('the SEC User-Agent goes only to sec.gov hosts; Gmail gets the bearer and no User-Agent', async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('{}')]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    await g.get('https://www.sec.gov/Archives/x', { bearer: 'tok' });
    await g.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', { bearer: 'tok' });
    assert.equal(calls[0].init.headers['User-Agent'], UA);
    assert.equal(calls[0].init.headers.Authorization, undefined, 'bearer never goes to sec.gov');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer tok');
    assert.equal(calls[1].init.headers['User-Agent'], undefined, 'the SEC contact never goes to Gmail');
  });
  test('a SEC host with no configured contact is refused, not fetched anonymously', async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('x')]);
    const g = createFetchGuard({ fetch, userAgent: null });
    await assert.rejects(g.get('https://www.sec.gov/x'), (e) => e instanceof FetchRefused && e.reason === 'sec_contact_missing');
    assert.equal(calls.length, 0);
    // Gmail still works without a SEC contact.
    await g.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', { bearer: 't' });
    assert.equal(calls.length, 1);
  });
});

describe('redirects', () => {
  test("redirect:'error' mode passes redirect:'error' to fetch and refuses any 3xx that still surfaces", async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('', { status: 302, headers: { location: 'https://www.sec.gov/x' } })]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    await assert.rejects(g.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', { bearer: 't', redirect: 'error' }), (e) => e instanceof FetchRefused && e.reason === 'redirect_unexpected');
    assert.equal(calls[0].init.redirect, 'error');
  });
  test('manual redirects are re-checked against the registry on every hop', async () => {
    const { fetch, calls } = sequenceFetch([
      () => new Response('', { status: 301, headers: { location: 'https://data.sec.gov/y' } }),
      () => new Response('landed'),
    ]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    const r = await g.get('https://www.sec.gov/x');
    assert.equal(r.text, 'landed');
    assert.equal(r.redirects, 1);
    assert.equal(r.host, 'data.sec.gov');
    assert.equal(calls.length, 2);
    assert.equal(g.requestCount, 2, 'each hop is counted');
  });
  test('a redirect to a host outside the registry is refused before it is fetched', async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } })]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    await assert.rejects(g.get('https://www.sec.gov/x'), (e) => e instanceof FetchRefused && e.reason === 'host');
    assert.equal(calls.length, 1);
  });
  test('a redirect to http, to a non-default port, or with credentials is refused', async () => {
    for (const loc of ['http://www.sec.gov/y', 'https://www.sec.gov:444/y', 'https://a:b@www.sec.gov/y']) {
      const { fetch } = sequenceFetch([() => new Response('', { status: 302, headers: { location: loc } })]);
      const g = createFetchGuard({ fetch, userAgent: UA });
      await assert.rejects(g.get('https://www.sec.gov/x'), FetchRefused, loc);
    }
  });
  test('more than two hops is redirect_limit', async () => {
    const { fetch } = sequenceFetch([() => new Response('', { status: 302, headers: { location: 'https://www.sec.gov/next' } })]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    await assert.rejects(g.get('https://www.sec.gov/x'), (e) => e instanceof FetchRefused && e.reason === 'redirect_limit');
  });
  test('Authorization is stripped when a redirect changes host (headers are recomputed per hop)', async () => {
    const { fetch, calls } = sequenceFetch([
      () => new Response('', { status: 302, headers: { location: 'https://www.sec.gov/y' } }),
      () => new Response('ok'),
    ]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    await g.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', { bearer: 'secret-token' });
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-token');
    assert.equal(calls[1].init.headers.Authorization, undefined);
    assert.equal(calls[1].init.headers['User-Agent'], UA);
    assert.equal(calls[0].init.headers['User-Agent'], undefined);
  });
});

describe('request counter, timeout, caps', () => {
  test('a global request cap stops the run before the next I/O', async () => {
    const { fetch, calls } = sequenceFetch([() => new Response('ok')]);
    const g = createFetchGuard({ fetch, userAgent: UA, maxRequests: 3 });
    for (let i = 0; i < 3; i += 1) await g.get(`https://www.sec.gov/${i}`);
    await assert.rejects(g.get('https://www.sec.gov/4'), (e) => e instanceof FetchRefused && e.reason === 'request_cap');
    assert.equal(calls.length, 3);
    assert.equal(g.requestCount, 3);
  });
  test('a request that never answers is aborted at the timeout', async () => {
    /** @type {any} */
    const hang = (/** @type {string} */ _u, /** @type {any} */ init) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
    const g = createFetchGuard({ fetch: hang, userAgent: UA, timeoutMs: 20 });
    await assert.rejects(g.get('https://www.sec.gov/x'), /aborted/);
  });
  test('the body is cut at the byte cap and flagged truncated', async () => {
    const big = 'a'.repeat(5000);
    const { fetch } = sequenceFetch([() => new Response(big)]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    const r = await g.get('https://www.sec.gov/x', { maxBytes: 1000 });
    assert.equal(r.text.length, 1000);
    assert.equal(r.truncated, true);
    const small = await createFetchGuard({ fetch: sequenceFetch([() => new Response('abc')]).fetch, userAgent: UA }).get('https://www.sec.gov/x', { maxBytes: 1000 });
    assert.equal(small.truncated, false);
  });
  test('Retry-After is parsed (seconds or date) and always capped', () => {
    assert.equal(parseRetryAfter('5', 30_000), 5000);
    assert.equal(parseRetryAfter('99999', 30_000), 30_000);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', 30_000, Date.parse('2026-10-21T07:28:00Z')), 30_000);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', 30_000, Date.parse('2026-10-21T07:28:00Z')), 10_000);
    for (const bad of [null, undefined, '', 'soon', '-5', '1e9x']) assert.equal(parseRetryAfter(bad, 30_000), null);
    assert.equal(DEFAULT_MAX_RETRY_AFTER_MS, 30_000);
  });
  test('the capped Retry-After is returned on the response', async () => {
    const { fetch } = sequenceFetch([() => new Response('slow', { status: 429, headers: { 'retry-after': '86400' } })]);
    const g = createFetchGuard({ fetch, userAgent: UA });
    const r = await g.get('https://www.sec.gov/x');
    assert.equal(r.status, 429);
    assert.equal(r.retryAfterMs, 30_000);
  });
});
