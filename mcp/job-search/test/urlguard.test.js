// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  registryFrom, classifyUrl, classifyAddress, isPrivateV4, isPrivateV6, expandV6, hostNameProblem,
  checkResolvedAddresses, guardUrl, guardedFetch, buildRegistry,
} from '../src/core/urlguard.js';
import { loadConfig } from '../src/core/config.js';

const reg = registryFrom([
  { source: 'greenhouse', domains: ['boards-api.greenhouse.io', 'boards.greenhouse.io'], pathPatterns: ['^/v1/boards/[a-z0-9-]+/jobs(/\\d+)?(\\?|$)', '^/[a-z0-9-]+/jobs/\\d+/?(\\?|$)'] },
  { source: 'linkedin', domains: ['linkedin.com', 'www.linkedin.com'], pathPatterns: ['^/jobs/search/?(\\?|$)', '^/jobs/view/\\d+/?(\\?|$)'] },
  { source: 'workday', domains: ['myworkdayjobs.com'], pathPatterns: ['^/wday/cxs/[a-z0-9_-]+/[a-z0-9_-]+/jobs(\\?|$)'] },
  { source: 'exec:east57th', domains: ['east57th.com', 'www.east57th.com'], pathPatterns: ['^/opportunities(/.*)?$'] },
], ['insecure.example']);

const publicLookup = async () => [{ address: '151.101.1.1', family: 4 }];

describe('urlguard sync classification (total)', () => {
  const cases = [
    ['not a url', 'invalid_url'],
    ['ftp://boards-api.greenhouse.io/v1/boards/x/jobs', 'scheme_not_https'],
    ['http://boards-api.greenhouse.io/v1/boards/x/jobs', 'scheme_not_https'],
    ['https://user:pw@boards-api.greenhouse.io/v1/boards/x/jobs', 'credentials_in_url'],
    ['https://localhost/v1/boards/x/jobs', 'host_localhost'],
    ['https://127.0.0.1/v1/boards/x/jobs', 'host_ip_literal'],
    ['https://[::1]/v1/boards/x/jobs', 'host_ip_literal'],
    ['https://boards.greenhouse.local/x/jobs/1', 'host_forbidden_suffix'],
    ['https://printer.home.arpa/x', 'host_forbidden_suffix'],
    ['https://example.com/v1/boards/x/jobs', 'host_not_registered'],
    ['https://evil-boards-api.greenhouse.io.attacker.com/v1/boards/x/jobs', 'host_not_registered'],
    ['https://boards-api.greenhouse.io/admin', 'path_not_matching'],
    ['https://www.linkedin.com/login', 'path_not_matching'],
    ['https://www.linkedin.com/jobs/view/abc', 'path_not_matching'],
  ];
  for (const [url, reason] of cases) {
    test(`${url} -> ${reason}`, () => {
      const v = classifyUrl(url, reg);
      assert.equal(v.allowed, false);
      assert.equal(v.reason, reason);
    });
  }

  test('positive match: registered host + pattern', () => {
    const v = classifyUrl('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true', reg);
    assert.equal(v.allowed, true);
    assert.equal(v.source, 'greenhouse');
    assert.equal(classifyUrl('https://www.linkedin.com/jobs/view/12345', reg).allowed, true);
    assert.equal(classifyUrl('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/jobs', reg).allowed, true);
    assert.equal(classifyUrl('https://www.east57th.com/opportunities/cto-houston', reg).allowed, true);
  });

  test('http allowed only for hosts in httpAllowedHosts (empty by default in config)', () => {
    const r2 = registryFrom([{ source: 'x', domains: ['insecure.example'], pathPatterns: ['^/'] }], ['insecure.example']);
    assert.equal(classifyUrl('http://insecure.example/a', r2).allowed, true);
    const cfg = loadConfig();
    assert.deepEqual(cfg.adapters.httpAllowedHosts, []);
  });

  test('source scoping: a URL on another adapter host is refused when source is pinned', () => {
    const v = classifyUrl('https://www.linkedin.com/jobs/view/1', reg, { source: 'greenhouse' });
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'host_belongs_to_other_source');
  });

  test('methods: GET ok; POST only for the path-scoped exceptions; others refused', () => {
    assert.equal(classifyUrl('https://www.linkedin.com/jobs/view/1', reg, { method: 'PUT' }).reason, 'method_not_allowed');
    assert.equal(classifyUrl('https://www.linkedin.com/jobs/view/1', reg, { method: 'POST' }).reason, 'post_not_allowed_for_path');
    assert.equal(classifyUrl('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/jobs', reg, { method: 'POST' }).allowed, true);
    assert.equal(classifyUrl('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/jobs', reg, { method: 'DELETE' }).allowed, false);
  });

  test('buildRegistry from the real config registers every adapter with domains and every exec board', () => {
    const r = buildRegistry(loadConfig());
    const names = r.entries.map((e) => e.source);
    for (const n of ['indeed', 'linkedin', 'greenhouse', 'lever', 'workday', 'dayforce', 'exec:east57th', 'exec:kornferry']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('exec'), 'exec adapter has no domains and registers nothing by itself');
  });
});

describe('address classification', () => {
  const priv4 = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1'];
  for (const ip of priv4) test(`v4 private ${ip}`, () => assert.equal(isPrivateV4(ip), true));
  for (const ip of ['8.8.8.8', '151.101.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1']) test(`v4 public ${ip}`, () => assert.equal(isPrivateV4(ip), false));

  const priv6 = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2002:c000:204::1'];
  for (const ip of priv6) test(`v6 private ${ip}`, () => assert.equal(isPrivateV6(ip), true));
  for (const ip of ['2606:4700::6810:84e5', '2a03:2880:f12f:83:face:b00c:0:25de', '::ffff:8.8.8.8']) test(`v6 public ${ip}`, () => assert.equal(isPrivateV6(ip), false));

  test('expandV6 handles :: and embedded v4', () => {
    assert.deepEqual(expandV6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(expandV6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    assert.equal(expandV6('1:2:3'), null);
    assert.equal(expandV6('::1::2'), null);
  });

  test('classifyAddress is total', () => {
    assert.equal(classifyAddress('8.8.8.8'), 'public');
    assert.equal(classifyAddress('10.0.0.1'), 'private');
    assert.equal(classifyAddress('garbage'), 'invalid');
  });

  test('hostNameProblem', () => {
    assert.equal(hostNameProblem('boards.greenhouse.io'), null);
    assert.equal(hostNameProblem('a.localhost'), 'forbidden_suffix');
    assert.equal(hostNameProblem('x.internal'), 'forbidden_suffix');
    assert.equal(hostNameProblem('foo.'), 'trailing_dot');
  });
});

describe('DNS resolution guard', () => {
  test('any private answer refuses; empty and failure refuse', async () => {
    assert.equal((await checkResolvedAddresses('x', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])).reason, 'address_private');
    assert.equal((await checkResolvedAddresses('x', async () => [])).reason, 'dns_empty');
    assert.equal((await checkResolvedAddresses('x', async () => { throw new Error('ENOTFOUND'); })).reason, 'dns_failed');
    assert.equal((await checkResolvedAddresses('x', publicLookup)).ok, true);
  });

  test('guardUrl throws URL_REJECTED with the reason', async () => {
    await assert.rejects(guardUrl('https://boards-api.greenhouse.io/v1/boards/a/jobs', reg, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] }), (e) => e.code === 'URL_REJECTED' && e.details.reason === 'address_private');
    await assert.rejects(guardUrl('https://example.com/', reg, { lookup: publicLookup }), (e) => e.code === 'URL_REJECTED' && e.details.reason === 'host_not_registered');
    const ok = await guardUrl('https://boards-api.greenhouse.io/v1/boards/a/jobs', reg, { lookup: publicLookup });
    assert.equal(ok.source, 'greenhouse');
  });
});

describe('guardedFetch redirects', () => {
  /** @param {Array<{ status: number, location?: string, body?: string }>} script */
  function fakeFetch(script) {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, method: init.method, redirect: init.redirect });
      const step = script[calls.length - 1] ?? { status: 200, body: 'ok' };
      return {
        status: step.status,
        headers: { get: (k) => (k === 'location' ? step.location ?? null : k === 'content-type' ? 'text/plain' : null) },
        text: async () => step.body ?? '',
      };
    };
    return { f, calls };
  }

  test('redirect to a private host is re-checked and refused', async () => {
    const { f } = fakeFetch([{ status: 302, location: 'https://boards-api.greenhouse.io.evil.example/v1/boards/a/jobs' }]);
    await assert.rejects(guardedFetch('https://boards-api.greenhouse.io/v1/boards/a/jobs', reg, { fetch: /** @type {any} */ (f), lookup: publicLookup }), (e) => e.code === 'URL_REJECTED' && e.details.reason === 'host_not_registered');
  });

  test('redirect to an out-of-pattern path on the same host is refused', async () => {
    const { f } = fakeFetch([{ status: 301, location: '/login' }]);
    await assert.rejects(guardedFetch('https://www.linkedin.com/jobs/view/1', reg, { fetch: /** @type {any} */ (f), lookup: publicLookup }), (e) => e.details.reason === 'path_not_matching');
  });

  test('redirect within pattern is followed with manual redirect mode; hops counted; POST becomes GET on 303', async () => {
    const { f, calls } = fakeFetch([{ status: 303, location: '/wday/cxs/acme/careers/jobs?p=2' }, { status: 200, body: '{}' }]);
    const r = await guardedFetch('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/jobs', reg, { fetch: /** @type {any} */ (f), lookup: publicLookup, method: 'POST', body: '{}' });
    assert.equal(r.status, 200);
    assert.equal(r.hops, 1);
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[1].method, 'GET');
  });

  test('redirect loop stops at MAX_REDIRECTS', async () => {
    const { f } = fakeFetch(Array.from({ length: 10 }, () => ({ status: 302, location: '/v1/boards/a/jobs' })));
    await assert.rejects(guardedFetch('https://boards-api.greenhouse.io/v1/boards/a/jobs', reg, { fetch: /** @type {any} */ (f), lookup: publicLookup }), (e) => e.details.reason === 'too_many_redirects');
  });
});
