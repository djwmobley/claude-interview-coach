// @ts-check
/**
 * Apply pipeline slice 5, amended spec: session.js's per-page route policy (routeDecision's apply-mode
 * branch) and the full session.js integration -- popup policy inheritance in both directions, apply-mode
 * denial logging + blockedCount, and the CDP target-id marker mechanism (writeTargetMarker/
 * reconcileTargets). No real Chrome, no network: connectSession() is exercised end to end against a fake
 * `chromium` object (session.js's own test seam), never a real CDP connection.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeDecision, connectSession } from '../src/browser/session.js';

// ---------------------------------------------------------------------------------------------------
// Pure routeDecision matrix (apply mode). Scan mode's own matrix is already covered by
// test/wall.test.js's "route decision (page.route handler policy)" describe block -- unchanged here.
// ---------------------------------------------------------------------------------------------------

describe('routeDecision: apply mode (amended spec)', () => {
  const applyPolicy = { mode: 'apply', tenantHost: 'boards.greenhouse.io', atsHosts: ['boards-api.greenhouse.io'], uploadHosts: ['upload.example-cdn.test'], blockedCount: 0 };

  test('GET is always allowed regardless of mode (subject to the same resource-type blocking as scan)', () => {
    assert.equal(routeDecision({ method: 'GET', resourceType: 'document', url: 'https://boards.greenhouse.io/acme/jobs/1' }, applyPolicy).allow, true);
    assert.equal(routeDecision({ method: 'GET', resourceType: 'image', url: 'https://boards.greenhouse.io/x.png' }, applyPolicy).allow, false);
  });

  test('POST/PUT/PATCH allowed to the tenant host', () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      assert.equal(routeDecision({ method, resourceType: 'xhr', url: 'https://boards.greenhouse.io/acme/submit' }, applyPolicy).allow, true, method);
    }
  });

  test('POST allowed to a subdomain of the tenant host (hostMatches suffix semantics)', () => {
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://sub.boards.greenhouse.io/x' }, applyPolicy).allow, true);
  });

  test('POST allowed to a declared ATS host', () => {
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://boards-api.greenhouse.io/v1/x' }, applyPolicy).allow, true);
  });

  test('POST allowed to a declared upload target host', () => {
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://upload.example-cdn.test/put' }, applyPolicy).allow, true);
  });

  test('POST denied to an unrelated host', () => {
    const d = routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://evil.example/x' }, applyPolicy);
    assert.equal(d.allow, false);
    assert.equal(d.reason, 'apply_scope_denied');
  });

  test('POST denied to a suffix-spoofed host (greenhouse.io.example.com must not match boards.greenhouse.io)', () => {
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://boards.greenhouse.io.example.com/x' }, applyPolicy).allow, false);
  });

  test('DELETE is denied even to the tenant host (only POST/PUT/PATCH are ever allowed in apply mode)', () => {
    assert.equal(routeDecision({ method: 'DELETE', resourceType: 'xhr', url: 'https://boards.greenhouse.io/x' }, applyPolicy).allow, false);
  });

  test('recaptcha verification host allowlisted for POST, path-scoped on google.com', () => {
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://www.google.com/recaptcha/api2/anchor' }, applyPolicy).allow, true);
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://www.google.com/other/endpoint' }, applyPolicy).allow, false, 'google.com is NOT broadly allowlisted, only /recaptcha/');
    assert.equal(routeDecision({ method: 'POST', resourceType: 'xhr', url: 'https://recaptcha.net/recaptcha/api2/anchor' }, applyPolicy).allow, true);
  });

  test('attachPage({mode:"apply"}) with no tenantHost throws (never silently locks every non-GET request without a scope)', async () => {
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    await assert.rejects(() => session.attachPage({ mode: 'apply' }), /tenantHost/);
    await session.closeAll();
  });
});

// ---------------------------------------------------------------------------------------------------
// Fake playwright-core harness: chromium.connectOverCDP -> browser -> context -> pages, with just enough
// CDP-session surface (Target.getTargetInfo / Target.closeTarget) for session.js's target-id marker
// mechanism, and a context 'page' event for popup-inheritance tests.
// ---------------------------------------------------------------------------------------------------

function makeFakePage() {
  /** @type {Record<string, Array<(...a: any[]) => void>>} */
  const listeners = {};
  /** @type {Array<{ pattern: string, handler: (route: any) => any }>} */
  const routes = [];
  const page = {
    /** @type {any} */
    opener: null,
    _closed: false,
    _targetId: null,
    on(evt, cb) { (listeners[evt] ??= []).push(cb); },
    async route(pattern, handler) { routes.push({ pattern, handler }); },
    async close() {
      page._closed = true;
      for (const cb of listeners.close ?? []) cb();
    },
    url() { return 'https://example.test/#done'; },
    _routes: routes,
    /** Simulate an incoming network request through the LAST-registered route handler. */
    async simulateRequest({ method, resourceType, url }) {
      const entry = routes[routes.length - 1];
      assert.ok(entry, 'no route handler registered on this fake page');
      /** @type {{ allow: boolean|null, aborted: boolean }} */
      const outcome = { allow: null, aborted: false };
      const route = {
        request: () => ({ method: () => method, resourceType: () => resourceType, url: () => url }),
        continue: () => { outcome.allow = true; },
        abort: () => { outcome.allow = false; outcome.aborted = true; },
      };
      await entry.handler(route);
      return outcome;
    },
  };
  return page;
}

function fakeChromium() {
  /** @type {Array<ReturnType<typeof makeFakePage>>} */
  const openedPages = [];
  /** @type {Array<(p: any) => void>} */
  const pageListeners = [];
  let nextTargetId = 1;
  /** @type {string[]} */
  const closedTargetIds = [];

  const context = {
    pages() { return openedPages.filter((p) => !p._closed); },
    async newPage() {
      const page = makeFakePage();
      openedPages.push(page);
      return page;
    },
    on(evt, cb) { if (evt === 'page') pageListeners.push(cb); },
    _firePage(page) { for (const cb of pageListeners) cb(page); },
    async newCDPSession(page) {
      if (!page._targetId) page._targetId = `target-${nextTargetId++}`;
      return {
        async send(method) {
          if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: page._targetId } };
          return {};
        },
        async detach() {},
      };
    },
  };
  const browser = {
    contexts() { return [context]; },
    async disconnect() {},
    async newBrowserCDPSession() {
      return {
        async send(method, params) {
          if (method === 'Target.closeTarget') closedTargetIds.push(params.targetId);
          return {};
        },
        async detach() {},
      };
    },
    _closedTargetIds: closedTargetIds,
  };
  return {
    async connectOverCDP() { return browser; },
    _context: context,
    _browser: browser,
    _openedPages: openedPages,
  };
}

describe('session.js: apply-mode route policy end to end (fakes, no real Chrome)', () => {
  test('scan-mode page still aborts every non-exempt non-GET request (unchanged)', async () => {
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    const page = await session.attachPage({ mode: 'scan' });
    const outcome = await page.simulateRequest({ method: 'POST', resourceType: 'xhr', url: 'https://boards.greenhouse.io/acme/submit' });
    assert.equal(outcome.allow, false);
    await session.closeAll();
  });

  test('apply-mode page allows POST to its own tenant, denies elsewhere, logs and counts every denial', async () => {
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    const page = await session.attachPage({ mode: 'apply', tenantHost: 'boards.greenhouse.io', atsHosts: [], uploadHosts: [] });
    const allowed = await page.simulateRequest({ method: 'POST', resourceType: 'xhr', url: 'https://boards.greenhouse.io/acme/submit' });
    assert.equal(allowed.allow, true);
    const denied1 = await page.simulateRequest({ method: 'POST', resourceType: 'xhr', url: 'https://evil.example/x' });
    assert.equal(denied1.allow, false);
    const denied2 = await page.simulateRequest({ method: 'PUT', resourceType: 'xhr', url: 'https://also-evil.example/x' });
    assert.equal(denied2.allow, false);
    const policy = session.policyFor(page);
    assert.equal(policy.blockedCount, 2, 'apply-mode denials must be counted on the page policy');
    await session.closeAll();
  });

  test('popup opened from a SCAN page inherits the scan policy (stays locked down)', async () => {
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    const openerPage = await session.attachPage({ mode: 'scan' });

    const popup = makeFakePage();
    popup.opener = async () => openerPage;
    chromium._context._firePage(popup);
    // arm() is fired-and-forgotten from the context 'page' listener; give the microtask queue a turn.
    await new Promise((r) => setImmediate(r));

    const outcome = await popup.simulateRequest({ method: 'POST', resourceType: 'xhr', url: 'https://boards.greenhouse.io/acme/submit' });
    assert.equal(outcome.allow, false, 'a scan-opened popup must stay locked down to abort-all-non-GET');
    await session.closeAll();
  });

  test('popup opened from an APPLY page inherits the apply tenant scope', async () => {
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    const openerPage = await session.attachPage({ mode: 'apply', tenantHost: 'boards.greenhouse.io', atsHosts: [], uploadHosts: [] });

    const popup = makeFakePage();
    popup.opener = async () => openerPage;
    chromium._context._firePage(popup);
    await new Promise((r) => setImmediate(r));

    const allowed = await popup.simulateRequest({ method: 'POST', resourceType: 'xhr', url: 'https://boards.greenhouse.io/acme/submit' });
    assert.equal(allowed.allow, true, 'an apply-opened popup must keep the apply tenant scope');
    const denied = await popup.simulateRequest({ method: 'POST', resourceType: 'xhr', url: 'https://evil.example/x' });
    assert.equal(denied.allow, false);
    await session.closeAll();
  });

  test('a popup whose opener cannot be resolved defaults to the scan policy, never apply', async () => {
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    await session.attachPage({ mode: 'apply', tenantHost: 'boards.greenhouse.io', atsHosts: [], uploadHosts: [] });

    const popup = makeFakePage();
    popup.opener = async () => { throw new Error('cannot resolve'); };
    chromium._context._firePage(popup);
    await new Promise((r) => setImmediate(r));

    const outcome = await popup.simulateRequest({ method: 'POST', resourceType: 'xhr', url: 'https://boards.greenhouse.io/acme/submit' });
    assert.equal(outcome.allow, false, 'an unresolvable opener must never be inferred as apply-scoped');
    await session.closeAll();
  });
});

describe('session.js: CDP target-id marker (apply pipeline slice 5, "no URL-hash markers")', () => {
  /** @type {string} */
  let tmpDir;
  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-target-marker-'));
  });
  test.afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writeTargetMarker records the currently tracked pages\' target ids; reconcileTargets closes them and clears the file', async () => {
    const markerFile = path.join(tmpDir, 'apply-page-targets.json');
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    await session.attachPage({ mode: 'apply', tenantHost: 'boards.greenhouse.io', atsHosts: [], uploadHosts: [] });
    await session.writeTargetMarker(markerFile);

    const written = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.equal(written.target_ids.length, 1);

    // A FRESH session (simulating the next run, after a crash) reconciles against the marker file left
    // behind by the run above.
    const chromium2 = fakeChromium();
    const session2 = await connectSession({ cdpUrl: 'x', chromium: chromium2 });
    const result = await session2.reconcileTargets(markerFile);
    assert.equal(result.attempted, 1);
    assert.equal(result.closed, 1);
    assert.deepEqual(chromium2._browser._closedTargetIds, written.target_ids);

    const afterReconcile = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.deepEqual(afterReconcile.target_ids, [], 'the marker file must be cleared after reconciling so a target is never retried');

    await session.closeAll();
    await session2.closeAll();
  });

  test('a missing marker file reconciles to zero, never throws', async () => {
    const chromium = fakeChromium();
    const session = await connectSession({ cdpUrl: 'x', chromium });
    const result = await session.reconcileTargets(path.join(tmpDir, 'does-not-exist.json'));
    assert.deepEqual(result, { attempted: 0, closed: 0 });
    await session.closeAll();
  });
});
