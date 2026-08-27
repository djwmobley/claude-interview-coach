// @ts-check
/**
 * src/dashboard/router.js: total classification of (pathname, method) dispatch.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/dashboard/router.js';

describe('router dispatch', () => {
  test('no matching path shape -> null (404)', () => {
    const router = createRouter();
    router.register('GET', '/api/summary', async () => {});
    assert.equal(router.dispatch('/api/nope', 'GET'), null);
  });

  test('matching path, wrong method -> notAllowed with the Allow set', () => {
    const router = createRouter();
    router.register('GET', '/api/listings', async () => {});
    router.register('POST', '/api/listings', async () => {});
    const r = router.dispatch('/api/listings', 'DELETE');
    assert.ok(r && 'notAllowed' in r && r.notAllowed);
    assert.deepEqual(new Set(/** @type {any} */ (r).allow), new Set(['GET', 'POST', 'HEAD']));
  });

  test('exact method match resolves with params extracted', () => {
    const router = createRouter();
    router.register('GET', '/api/listings/:id', async () => {});
    const r = router.dispatch('/api/listings/42', 'GET');
    assert.ok(r && 'route' in r);
    assert.equal(/** @type {any} */ (r).headOnly, false);
    assert.deepEqual(/** @type {any} */ (r).params, { id: '42' });
  });

  test('HEAD on a registered GET route resolves headOnly true', () => {
    const router = createRouter();
    router.register('GET', '/api/health', async () => {});
    const r = router.dispatch('/api/health', 'HEAD');
    assert.ok(r && 'route' in r);
    assert.equal(/** @type {any} */ (r).headOnly, true);
  });

  test('HEAD with no GET route registered at that shape -> notAllowed', () => {
    const router = createRouter();
    router.register('POST', '/api/scans', async () => {});
    const r = router.dispatch('/api/scans', 'HEAD');
    assert.ok(r && 'notAllowed' in r && r.notAllowed);
  });

  test('decodes URI-encoded param segments', () => {
    const router = createRouter();
    router.register('GET', '/api/companies/:norm/moments', async () => {});
    const r = router.dispatch('/api/companies/acme%20co/moments', 'GET');
    assert.equal(/** @type {any} */ (r).params.norm, 'acme co');
  });

  test('path segment count must match exactly (no partial or extra-segment match)', () => {
    const router = createRouter();
    router.register('GET', '/api/listings/:id', async () => {});
    assert.equal(router.dispatch('/api/listings/42/documents', 'GET'), null);
    assert.equal(router.dispatch('/api/listings', 'GET'), null);
  });
});
