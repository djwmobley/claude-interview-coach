// @ts-check
/**
 * Dashboard static asset caching (2026-10-05): after a dashboard restart an open tab kept running stale
 * JS because static assets carried no Cache-Control or validator. Static files and index.html are now
 * served with `Cache-Control: no-cache` plus an ETag and Last-Modified, and a matching If-None-Match
 * revalidation gets a cheap 304. Uses a temp publicRoot and stub deps; no route here touches the DB.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';

/** @type {string} */
let publicRoot;
/** @type {ReturnType<typeof createDashboardServer>} */
let app;
/** @type {number} */
let port;

before(async () => {
  publicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-dashboard-static-'));
  fs.writeFileSync(path.join(publicRoot, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(publicRoot, 'app.js'), 'export const v = 1;\n');
  fs.mkdirSync(path.join(publicRoot, 'lib'));
  fs.writeFileSync(path.join(publicRoot, 'lib', 'x.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(publicRoot, 'style.css'), 'body{}\n');
  const deps = {
    withClient: async () => {
      throw new Error('no db in this test');
    },
    config: {},
    env: {},
    healthBanner: [],
  };
  app = createDashboardServer(/** @type {any} */ (deps), { publicRoot });
  await app.listen(0, '127.0.0.1');
  port = /** @type {any} */ (app.server.address()).port;
});

after(async () => {
  await app.close();
  fs.rmSync(publicRoot, { recursive: true, force: true });
});

/** @param {string} p @param {Record<string,string>} [headers] @param {string} [method] */
async function get(p, headers = {}, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

describe('static assets: revalidate on every load', () => {
  for (const p of ['/', '/index.html', '/app.js', '/lib/x.js', '/style.css']) {
    test(`${p} carries Cache-Control: no-cache, an ETag and Last-Modified`, async () => {
      const r = await get(p);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      assert.match(r.headers.get('etag') ?? '', /^"[0-9a-f]{16,}"$/);
      assert.ok(r.headers.get('last-modified'), 'Last-Modified present');
      assert.ok(!Number.isNaN(Date.parse(/** @type {string} */ (r.headers.get('last-modified')))));
    });
  }

  test('HEAD carries the same validators', async () => {
    const g = await get('/app.js');
    const h = await get('/app.js', {}, 'HEAD');
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('cache-control'), 'no-cache');
    assert.equal(h.headers.get('etag'), g.headers.get('etag'));
  });

  test('If-None-Match with the current ETag returns 304 with no body', async () => {
    const first = await get('/app.js');
    const etag = /** @type {string} */ (first.headers.get('etag'));
    const second = await get('/app.js', { 'If-None-Match': etag });
    assert.equal(second.status, 304);
    assert.equal(second.text, '');
    assert.equal(second.headers.get('etag'), etag);
    assert.equal(second.headers.get('cache-control'), 'no-cache');
  });

  test('a changed file gets a new ETag, and the old ETag no longer matches (full 200 with new content)', async () => {
    const file = path.join(publicRoot, 'lib', 'x.js');
    const before = await get('/lib/x.js');
    fs.writeFileSync(file, 'export const x = 2;\n');
    const after = await get('/lib/x.js', { 'If-None-Match': /** @type {string} */ (before.headers.get('etag')) });
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.get('etag'), before.headers.get('etag'));
    assert.equal(after.text, 'export const x = 2;\n');
  });

  test('If-None-Match list form and the * wildcard are honored; a non-matching tag is not', async () => {
    const etag = /** @type {string} */ ((await get('/style.css')).headers.get('etag'));
    assert.equal((await get('/style.css', { 'If-None-Match': `"deadbeef", ${etag}` })).status, 304);
    assert.equal((await get('/style.css', { 'If-None-Match': `W/${etag}` })).status, 304, 'weak comparison per RFC 9110 for If-None-Match');
    assert.equal((await get('/style.css', { 'If-None-Match': '*' })).status, 304);
    assert.equal((await get('/style.css', { 'If-None-Match': '"deadbeef"' })).status, 200);
  });

  test('a missing static file is still a 404 and does not carry an ETag', async () => {
    const r = await get('/nope.js');
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('etag'), null);
  });

  test('/api/* responses keep Cache-Control: no-store', async () => {
    const r = await get('/api/does-not-exist');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});
