// @ts-check
/**
 * URL-safety guard function tests (pr3-spec-decisions.md section 12 item 6): a table of (url_ok, value)
 * pairs asserting refuse versus allow, including the "absent maps to false" branch and the scheme
 * re-validation branch (javascript:, data:, a relative-looking string).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeHttpUrl, isLinkSafe, hApplicationScreenshot } from '../src/dashboard/public/lib/dom.js';

describe('isSafeHttpUrl(): scheme allow-list is exactly http/https', () => {
  test('allows http and https URLs', () => {
    assert.equal(isSafeHttpUrl('https://example.com/job/1'), true);
    assert.equal(isSafeHttpUrl('http://example.com'), true);
  });

  test('refuses non-http(s) schemes', () => {
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeHttpUrl('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isSafeHttpUrl('vbscript:msgbox(1)'), false);
    assert.equal(isSafeHttpUrl('blob:https://example.com/x'), false);
    assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
  });

  test('refuses a relative-looking string rather than silently resolving it against the page origin', () => {
    assert.equal(isSafeHttpUrl('/jobs/1'), false);
    assert.equal(isSafeHttpUrl('jobs/1'), false);
    assert.equal(isSafeHttpUrl('//example.com/x'), false);
  });

  test('refuses non-string and empty values without throwing', () => {
    assert.equal(isSafeHttpUrl(null), false);
    assert.equal(isSafeHttpUrl(undefined), false);
    assert.equal(isSafeHttpUrl(''), false);
    assert.equal(isSafeHttpUrl(42), false);
    assert.equal(isSafeHttpUrl({}), false);
  });
});

describe('isLinkSafe(): the full guarded href/src decision', () => {
  test('urlOk absent maps to false, regardless of how well-formed the URL is (rule 4)', () => {
    assert.equal(isLinkSafe({ url: 'https://example.com' }), false);
  });

  test('urlOk: false always refuses', () => {
    assert.equal(isLinkSafe({ url: 'https://example.com', urlOk: false }), false);
  });

  test('urlOk: true still re-validates the scheme (rule 5): a server bug claiming url_ok on a bad scheme is still caught', () => {
    assert.equal(isLinkSafe({ url: 'javascript:alert(1)', urlOk: true }), false);
    assert.equal(isLinkSafe({ url: 'data:text/html,x', urlOk: true }), false);
    assert.equal(isLinkSafe({ url: '/relative/path', urlOk: true }), false);
  });

  test('urlOk: true with a genuinely safe http(s) URL allows the link', () => {
    assert.equal(isLinkSafe({ url: 'https://boards.greenhouse.io/acme/jobs/1', urlOk: true }), true);
  });

  test('a truthy but non-boolean urlOk (e.g. the string "true") is never treated as true', () => {
    assert.equal(isLinkSafe({ url: 'https://example.com', urlOk: /** @type {any} */ ('true') }), false);
  });
});

describe('hApplicationScreenshot() guard (apply pipeline slice 5): src must be the exact same-origin application-screenshot path shape', () => {
  // These assertions never reach document.createElement (the guard throws first), so they run fine
  // without a DOM environment -- same testing boundary this file's own precedent (isSafeHttpUrl/
  // isLinkSafe are pure) already establishes; lib/dom.js's actual DOM-construction functions
  // (h/hSvg/hSandboxedIframe/hApplicationScreenshot) have no functional DOM test elsewhere in this repo
  // either, only the grep-based lint check (test/dashboard-lint.test.js) that they are the only callers
  // of document.createElement.
  test('rejects any src not matching /^\\/api\\/applications\\/\\d+\\/screenshot$/', () => {
    assert.throws(() => hApplicationScreenshot({ src: '/api/applications/abc/screenshot', alt: 'x' }), /same-origin/);
    assert.throws(() => hApplicationScreenshot({ src: '/api/applications/1/screenshot?x=1', alt: 'x' }), /same-origin/);
    assert.throws(() => hApplicationScreenshot({ src: 'https://evil.example/api/applications/1/screenshot', alt: 'x' }), /same-origin/);
    assert.throws(() => hApplicationScreenshot({ src: '/api/documents/file?path=x', alt: 'x' }), /same-origin/);
  });
});
