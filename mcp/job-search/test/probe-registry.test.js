// @ts-check
/**
 * src/apply/probe-registry.js (auto-apply PR B): a host-only (no path gate) URL guard for redirect
 * chasing, deliberately separate from src/core/urlguard.js's registry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  registryFrom, classifyProbeUrl, guardProbeUrl, resolveRedirects, MAX_PROBE_REDIRECTS,
} from '../src/apply/probe-registry.js';

const REGISTRY = registryFrom(['boards.greenhouse.io', 'lensa.com']);

/** A lookup stub that always answers with one public address, for tests that never care about DNS. */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
/** A lookup stub that answers with a private address, for the "private IP refused" test. */
const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }];

describe('classifyProbeUrl: host-only gate', () => {
  test('an arbitrary path on a registered host is allowed (no path gate)', () => {
    const v = classifyProbeUrl('https://boards.greenhouse.io/whatever/totally/unrecognized/path?x=1', REGISTRY);
    assert.equal(v.allowed, true);
  });

  test('a subdomain of a registered host matches (dot-boundary suffix)', () => {
    const v = classifyProbeUrl('https://sub.lensa.com/job/123', REGISTRY);
    assert.equal(v.allowed, true);
  });

  test('a host not on the registry is refused', () => {
    const v = classifyProbeUrl('https://evil.example.com/x', REGISTRY);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'host_not_registered');
  });

  test('a suffix-spoof host is refused (never a bare substring match)', () => {
    const v = classifyProbeUrl('https://evil-lensa.com/x', REGISTRY);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'host_not_registered');
  });

  test('http is refused (no httpAllowedHosts escape hatch)', () => {
    const v = classifyProbeUrl('http://boards.greenhouse.io/x', REGISTRY);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'scheme_not_https');
  });

  test('a userinfo-embedded host trick is refused', () => {
    const v = classifyProbeUrl('https://boards.greenhouse.io@evil.com/x', REGISTRY);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'credentials_in_url');
  });

  test('an IP literal host is refused even if numerically public', () => {
    const v = classifyProbeUrl('https://93.184.216.34/x', REGISTRY);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'host_ip_literal');
  });

  test('a malformed URL is refused', () => {
    const v = classifyProbeUrl('not a url', REGISTRY);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'invalid_url');
  });

  test('a nonstandard port is refused', () => {
    const v = classifyProbeUrl('https://boards.greenhouse.io:8443/x', REGISTRY);
    assert.equal(v.allowed, false);
    assert.equal(v.reason, 'nonstandard_port');
  });
});

describe('guardProbeUrl: DNS resolution', () => {
  test('a registered host resolving to a private address is refused', async () => {
    await assert.rejects(
      () => guardProbeUrl('https://boards.greenhouse.io/x', REGISTRY, { lookup: privateLookup }),
      /url refused/,
    );
  });

  test('a registered host resolving to a public address is allowed', async () => {
    const r = await guardProbeUrl('https://boards.greenhouse.io/x', REGISTRY, { lookup: publicLookup });
    assert.equal(r.url.hostname, 'boards.greenhouse.io');
  });
});

describe('resolveRedirects', () => {
  /** @param {string[]} chain sequence of Location headers; the last entry is served as a 200 */
  function fakeFetch(chain) {
    let i = 0;
    return async () => {
      const isLast = i === chain.length - 1;
      const current = chain[i];
      i++;
      if (isLast) {
        return { status: 200, headers: { get: () => null } };
      }
      return { status: 302, headers: { get: (/** @type {string} */ h) => (h.toLowerCase() === 'location' ? chain[i] : null) } };
    };
  }

  test('follows a redirect chain to the final 200', async () => {
    const chain = ['https://lensa.com/job/1', 'https://boards.greenhouse.io/acme/jobs/123'];
    const r = await resolveRedirects('https://lensa.com/job/1', REGISTRY, { fetch: fakeFetch(chain), lookup: publicLookup });
    assert.equal(r.url, 'https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(r.status, 200);
    assert.equal(r.hops, 1);
  });

  test('a chain needing a 6th hop is refused (MAX_PROBE_REDIRECTS = 5)', async () => {
    assert.equal(MAX_PROBE_REDIRECTS, 5);
    // 7 entries: hops 0..5 are redirects (6 of them), hop 6 would be the 7th fetch -- exceeds the cap.
    const chain = Array.from({ length: 7 }, (_, i) => `https://lensa.com/job/${i}`);
    await assert.rejects(
      () => resolveRedirects(chain[0], REGISTRY, { fetch: fakeFetch(chain), lookup: publicLookup }),
      /too many redirects/,
    );
  });

  test('a redirect to an unregistered host is refused mid-chain', async () => {
    const chain = ['https://lensa.com/job/1', 'https://evil.example.com/x'];
    await assert.rejects(
      () => resolveRedirects(chain[0], REGISTRY, { fetch: fakeFetch(chain), lookup: publicLookup }),
      /url refused/,
    );
  });

  test('a redirect with no Location header is refused', async () => {
    const fetchNoLocation = async () => ({ status: 302, headers: { get: () => null } });
    await assert.rejects(
      () => resolveRedirects('https://lensa.com/job/1', REGISTRY, { fetch: fetchNoLocation, lookup: publicLookup }),
      /redirect without location/,
    );
  });
});
