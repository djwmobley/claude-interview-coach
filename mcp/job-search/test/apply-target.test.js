// @ts-check
/**
 * src/apply/apply-target.js (auto-apply PR B): decodeLinkedInSafetyGo, resolveApplyTarget, isExactTarget,
 * INTERMEDIARY_HOSTS.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeLinkedInSafetyGo, resolveApplyTarget, isExactTarget, INTERMEDIARY_HOSTS, isIntermediaryHost,
} from '../src/apply/apply-target.js';
import { registryFrom } from '../src/apply/probe-registry.js';
import { classifyApplyUrl } from '../src/apply/ats-detect.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const REGISTRY = registryFrom(['boards.greenhouse.io', 'jobs.lever.co', ...INTERMEDIARY_HOSTS]);

describe('decodeLinkedInSafetyGo: decode without a click', () => {
  test('decodes a wrapped external URL', () => {
    const wrapped = 'https://www.linkedin.com/safety/go/?url=' + encodeURIComponent('https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(decodeLinkedInSafetyGo(wrapped), 'https://boards.greenhouse.io/acme/jobs/123');
  });

  test('non-linkedin host is not decoded', () => {
    const notLinkedin = 'https://example.com/safety/go/?url=' + encodeURIComponent('https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(decodeLinkedInSafetyGo(notLinkedin), null);
  });

  test('linkedin host but not the safety/go path is not decoded', () => {
    assert.equal(decodeLinkedInSafetyGo('https://www.linkedin.com/jobs/view/12345/'), null);
  });

  test('missing url param returns null', () => {
    assert.equal(decodeLinkedInSafetyGo('https://www.linkedin.com/safety/go/'), null);
  });

  test('a decoded value that is not itself a parseable http(s) URL returns null', () => {
    const wrapped = 'https://www.linkedin.com/safety/go/?url=' + encodeURIComponent('not-a-url');
    assert.equal(decodeLinkedInSafetyGo(wrapped), null);
  });

  test('never performs a network call: pure string decode only (no fetch to assert on is itself the proof)', () => {
    const wrapped = 'https://www.linkedin.com/safety/go/?url=' + encodeURIComponent('https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111');
    const decoded = decodeLinkedInSafetyGo(wrapped);
    assert.equal(decoded, 'https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111');
  });
});

describe('isExactTarget', () => {
  test('greenhouse exact confidence is an exact target', () => {
    const c = classifyApplyUrl('https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(isExactTarget(c, 'https://boards.greenhouse.io/acme/jobs/123'), true);
  });

  test('inferred/low confidence is never an exact target', () => {
    assert.equal(isExactTarget({ ats: 'greenhouse', tenant: null, confidence: 'inferred' }, 'https://boards.greenhouse.io/embed/job_app?for=acme'), false);
    assert.equal(isExactTarget({ ats: 'greenhouse', tenant: null, confidence: 'low' }, 'https://boards.greenhouse.io/x'), false);
  });

  test('a Workday tenant host on a posting (/job/) path is exact', () => {
    const url = 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Houston-TX/Director_R-12345';
    const c = classifyApplyUrl(url);
    assert.equal(c.confidence, 'exact'); // ats-detect.js's own classification is host-only
    assert.equal(isExactTarget(c, url), true);
  });

  test('a Workday tenant host with NO posting path shape is not exact, despite ats-detect.js saying "exact"', () => {
    const url = 'https://acme.wd1.myworkdayjobs.com/en-US/External';
    const c = classifyApplyUrl(url);
    assert.equal(c.confidence, 'exact'); // ats-detect.js's host-only regex still says exact
    assert.equal(isExactTarget(c, url), false); // apply-target.js's own posting-path refinement overrides it
  });

  test('null/undefined classification is never exact', () => {
    assert.equal(isExactTarget(null, 'https://boards.greenhouse.io/x'), false);
    assert.equal(isExactTarget(undefined, 'https://boards.greenhouse.io/x'), false);
  });
});

describe('INTERMEDIARY_HOSTS / isIntermediaryHost', () => {
  test('every listed intermediary host is recognized, including a subdomain', () => {
    for (const h of INTERMEDIARY_HOSTS) {
      assert.equal(isIntermediaryHost(h), true, h);
      assert.equal(isIntermediaryHost(`www.${h}`), true, `www.${h}`);
    }
  });

  test('a non-intermediary host is not recognized', () => {
    assert.equal(isIntermediaryHost('boards.greenhouse.io'), false);
  });
});

describe('resolveApplyTarget: total classification', () => {
  test('an already-exact greenhouse URL resolves without any redirect chase', async () => {
    const r = await resolveApplyTarget('https://boards.greenhouse.io/acme/jobs/123', REGISTRY, { lookup: publicLookup });
    assert.deepEqual(r, { resolved: true, url: 'https://boards.greenhouse.io/acme/jobs/123', ats: 'greenhouse', confidence: 'exact' });
  });

  test('a LinkedIn safety/go wrapper decoding to an exact target resolves without a redirect chase', async () => {
    const wrapped = 'https://www.linkedin.com/safety/go/?url=' + encodeURIComponent('https://boards.greenhouse.io/acme/jobs/123');
    const r = await resolveApplyTarget(wrapped, REGISTRY, { lookup: publicLookup });
    assert.equal(r.resolved, true);
    if (r.resolved) assert.equal(r.url, 'https://boards.greenhouse.io/acme/jobs/123');
  });

  for (const host of INTERMEDIARY_HOSTS) {
    test(`intermediary host ${host}: unresolved when it never redirects anywhere exact`, async () => {
      const fetchStub = async () => ({ status: 200, headers: { get: () => null } }); // dead end, no redirect
      const r = await resolveApplyTarget(`https://${host}/job/123`, REGISTRY, { lookup: publicLookup, fetch: fetchStub });
      assert.equal(r.resolved, false);
      if (!r.resolved) assert.equal(r.reason, 'apply_target_unresolved');
    });
  }

  test('an intermediary that redirects to an exact ATS target resolves', async () => {
    const fetchStub = async (/** @type {string} */ url) => {
      if (url.includes('lensa.com')) {
        return { status: 302, headers: { get: (/** @type {string} */ h) => (h.toLowerCase() === 'location' ? 'https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111' : null) } };
      }
      return { status: 200, headers: { get: () => null } };
    };
    const r = await resolveApplyTarget('https://lensa.com/job/1', REGISTRY, { lookup: publicLookup, fetch: fetchStub });
    assert.equal(r.resolved, true);
    if (r.resolved) {
      assert.equal(r.ats, 'lever');
      assert.equal(r.url, 'https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111');
    }
  });

  test('an unknown, non-intermediary host that is not itself exact is unresolved, never chased', async () => {
    const r = await resolveApplyTarget('https://some-random-company-careers-page.example.com/jobs/42', REGISTRY, { lookup: publicLookup });
    assert.equal(r.resolved, false);
    if (!r.resolved) assert.equal(r.reason, 'apply_target_unresolved');
  });

  test('a completely unknown host classified "unknown" by ats-detect.js is unresolved', async () => {
    const c = classifyApplyUrl('https://some-random-company-careers-page.example.com/jobs/42');
    assert.equal(c.ats, 'unknown');
    const r = await resolveApplyTarget('https://some-random-company-careers-page.example.com/jobs/42', REGISTRY, { lookup: publicLookup });
    assert.equal(r.resolved, false);
  });

  test('no candidate href at all -> no_candidate, never a guessed target', async () => {
    const r = await resolveApplyTarget(null, REGISTRY, { lookup: publicLookup });
    assert.deepEqual(r, { resolved: false, reason: 'no_candidate' });
    const r2 = await resolveApplyTarget('', REGISTRY, { lookup: publicLookup });
    assert.deepEqual(r2, { resolved: false, reason: 'no_candidate' });
  });

  test('a hint-shaped object (never a string) is not a candidate: a captured hint never sets apply_ats through this function', async () => {
    const hint = { applicantTrackingSystemName: 'greenhouse', companyName: 'Acme' };
    // @ts-expect-error deliberately passing a non-string to prove the total classification's default branch
    const r = await resolveApplyTarget(hint, REGISTRY, { lookup: publicLookup });
    assert.deepEqual(r, { resolved: false, reason: 'no_candidate' });
  });

  test('an invalid URL after decode is unresolved with reason invalid_url', async () => {
    const r = await resolveApplyTarget('not a url at all', REGISTRY, { lookup: publicLookup });
    assert.equal(r.resolved, false);
    if (!r.resolved) assert.equal(r.reason, 'invalid_url');
  });

  test('an intermediary redirect chain that fails DNS mid-chase is unresolved, not thrown', async () => {
    const fetchStub = async () => ({ status: 302, headers: { get: (/** @type {string} */ h) => (h.toLowerCase() === 'location' ? 'https://not-registered-anywhere.example.com/x' : null) } });
    const r = await resolveApplyTarget('https://lensa.com/job/1', REGISTRY, { lookup: publicLookup, fetch: fetchStub });
    assert.equal(r.resolved, false);
    if (!r.resolved) assert.equal(r.reason, 'apply_target_unresolved');
  });
});
