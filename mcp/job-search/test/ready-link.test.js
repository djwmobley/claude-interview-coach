// @ts-check
/**
 * src/core/ready-link.js (Ready to apply list, spec 7.1 as amended by A8): readyLinkCheck is a total
 * classification of a candidate apply link, and normalizeTargetKey is the URL key the manual-only lockout
 * and the list's dedup share.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readyLinkCheck, normalizeTargetKey, READY_LINK_REASONS, UNSAFE_LINK_REASONS } from '../src/core/ready-link.js';

describe('readyLinkCheck', () => {
  test('a plain https career page passes and reports its host', () => {
    const r = readyLinkCheck('https://careers.acme.com/jobs/123');
    assert.deepEqual(r, { ok: true, url: 'https://careers.acme.com/jobs/123', host: 'careers.acme.com' });
  });

  test('http is allowed (A8: http(s) only), other schemes are not', () => {
    assert.equal(readyLinkCheck('http://jobs.acme.com/1').ok, true);
    const r = readyLinkCheck('javascript:alert(1)');
    assert.equal(r.ok, false);
    assert.equal(/** @type {any} */ (r).reason, 'bad_scheme');
    assert.equal(/** @type {any} */ (readyLinkCheck('ftp://acme.com/x')).reason, 'bad_scheme');
  });

  test('missing and unparseable links are no_link / invalid_url (not unsafe)', () => {
    assert.equal(/** @type {any} */ (readyLinkCheck(null)).reason, 'no_link');
    assert.equal(/** @type {any} */ (readyLinkCheck('   ')).reason, 'no_link');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://')).reason, 'invalid_url');
    assert.equal(UNSAFE_LINK_REASONS.includes('no_link'), false);
    assert.equal(UNSAFE_LINK_REASONS.includes('invalid_url'), false);
  });

  test('credentials, private hosts, and over-long links are refused', () => {
    assert.equal(/** @type {any} */ (readyLinkCheck('https://user:pw@acme.com/x')).reason, 'credentials_in_url');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://127.0.0.1/x')).reason, 'private_host');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://[::1]/x')).reason, 'private_host');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://localhost/x')).reason, 'private_host');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://box.internal/x')).reason, 'private_host');
    assert.equal(/** @type {any} */ (readyLinkCheck(`https://acme.com/${'a'.repeat(2100)}`)).reason, 'too_long');
  });

  test('tracker and redirector hosts are refused', () => {
    assert.equal(/** @type {any} */ (readyLinkCheck('https://t.ladders.co/f/a/x')).reason, 'tracker_host');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://bit.ly/abc')).reason, 'redirector_host');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://click.mail.acme.com/abc')).reason, 'redirector_host');
    assert.equal(/** @type {any} */ (readyLinkCheck('https://nam02.safelinks.protection.outlook.com/?url=x')).reason, 'redirector_host');
  });

  test('path denylist (A8): account and tracking paths are refused, look-alike job words are not', () => {
    for (const p of ['/unsubscribe', '/optout?x=1', '/email/opt-out', '/preferences', '/one-click/apply', '/oneclick', '/track/123', '/click?id=1', '/confirm', '/account/verify']) {
      assert.equal(/** @type {any} */ (readyLinkCheck(`https://jobs.acme.com${p}`)).reason, 'denied_path', p);
    }
    assert.equal(readyLinkCheck('https://jobs.acme.com/jobs/verification-engineer').ok, true);
    assert.equal(readyLinkCheck('https://jobs.acme.com/jobs/tracking-systems-director').ok, true);
  });

  test('a LinkedIn safety/go wrapper is decoded, then the destination is checked', () => {
    const wrapped = `https://www.linkedin.com/safety/go?url=${encodeURIComponent('https://careers.acme.com/j/9')}`;
    assert.deepEqual(readyLinkCheck(wrapped), { ok: true, url: 'https://careers.acme.com/j/9', host: 'careers.acme.com' });
    const bad = `https://www.linkedin.com/safety/go?url=${encodeURIComponent('https://bit.ly/x')}`;
    assert.equal(/** @type {any} */ (readyLinkCheck(bad)).reason, 'redirector_host');
  });

  test('every failure reason is in READY_LINK_REASONS', () => {
    for (const u of [null, 'x', 'ftp://a.b/c', 'https://u:p@a.com', 'https://10.0.0.1', 'https://bit.ly/x', 'https://a.com/unsubscribe', 'https://t.ladders.co/x']) {
      const r = readyLinkCheck(u);
      if (!r.ok) assert.ok(READY_LINK_REASONS.includes(r.reason), r.reason);
    }
  });
});

describe('normalizeTargetKey', () => {
  test('LinkedIn and Indeed URLs collapse to their canonical job id', () => {
    assert.equal(
      normalizeTargetKey('https://www.linkedin.com/jobs/view/cto-at-acme-4012345678/?trk=abc'),
      normalizeTargetKey('https://linkedin.com/jobs/view/4012345678'),
    );
    assert.equal(
      normalizeTargetKey('https://www.indeed.com/viewjob?jk=abcdef1234567890&from=serp'),
      normalizeTargetKey('https://indeed.com/viewjob?jk=ABCDEF1234567890'),
    );
  });

  test('other hosts: case, www, trailing slash, and tracking params do not change the key', () => {
    assert.equal(normalizeTargetKey('https://WWW.Careers.Acme.com/jobs/1/?utm_source=x'), normalizeTargetKey('https://careers.acme.com/jobs/1'));
  });

  test('unparseable input has no key', () => {
    assert.equal(normalizeTargetKey('not a url'), null);
    assert.equal(normalizeTargetKey(null), null);
  });
});
