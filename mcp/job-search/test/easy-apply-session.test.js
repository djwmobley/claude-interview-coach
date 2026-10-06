// @ts-check
/**
 * src/browser/session.js tab exemption for assisted Easy Apply (spec B5): reconcile() and
 * reconcileTargets() never close an awaiting_submit target; an unknown exempt set (DB down) closes
 * nothing; a page with no opener or an untracked opener (e.g. the Easy Apply tab, or anything Damian opens
 * from it) is never armed with a route policy nor closed by closeAll; detachLeaveOpen() unroutes and
 * forgets tracked pages without closing them; awaiting rows whose tab is gone are demoted on connect, and
 * an unreadable target list demotes nothing. Fake playwright-core harness, no real Chrome, no DB (the
 * awaitingTabs seam is faked).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectSession, PAGE_MARKER } from '../src/browser/session.js';

/** @param {{ url?: string, targetId?: string }} [o] */
function makePage(o = {}) {
  const page = {
    _closed: false, _targetId: o.targetId ?? null, _routes: /** @type {any[]} */ ([]), _unrouted: 0, opener: /** @type {any} */ (null),
    on() {},
    async route(/** @type {string} */ pattern, /** @type {any} */ h) { page._routes.push([pattern, h]); },
    async unroute() { page._unrouted++; page._routes = []; },
    async close() { page._closed = true; },
    url() { return o.url ?? 'https://example.test/'; },
  };
  return page;
}

/** @param {{ existing?: any[], liveTargets?: any }} [o] */
function fakeChromium(o = {}) {
  const pages = [...(o.existing ?? [])];
  /** @type {Array<(p: any) => void>} */
  const listeners = [];
  let n = 100;
  const closedTargetIds = /** @type {string[]} */ ([]);
  const context = {
    pages() { return pages.filter((p) => !p._closed); },
    // Like real Playwright, newPage() fires the context 'page' event before it resolves.
    async newPage() { const p = makePage(); pages.push(p); for (const cb of listeners) cb(p); return p; },
    on(/** @type {string} */ evt, /** @type {any} */ cb) { if (evt === 'page') listeners.push(cb); },
    fire(/** @type {any} */ p) { pages.push(p); for (const cb of listeners) cb(p); },
    async newCDPSession(/** @type {any} */ page) {
      if (!page._targetId) page._targetId = `T${n++}`;
      return { async send() { return { targetInfo: { targetId: page._targetId } }; }, async detach() {} };
    },
  };
  const browser = {
    contexts() { return [context]; },
    async newBrowserCDPSession() {
      return {
        async send(/** @type {string} */ m, /** @type {any} */ p) {
          if (m === 'Target.closeTarget') closedTargetIds.push(p.targetId);
          if (m === 'Target.getTargets') return o.liveTargets ?? { targetInfos: pages.filter((x) => !x._closed).map((x) => ({ type: 'page', targetId: x._targetId })) };
          return {};
        },
        async detach() {},
      };
    },
  };
  return { chromium: { async connectOverCDP() { return browser; } }, context, closedTargetIds };
}

/** @param {Set<string>|null|Error} exempt */
function tabs(exempt) {
  const demoted = /** @type {any[]} */ ([]);
  return {
    demoted,
    async exemptTargetIds() { if (exempt instanceof Error) throw exempt; return exempt; },
    async demoteMissing(/** @type {Set<string>} */ alive, /** @type {string} */ reason) { demoted.push([alive, reason]); return []; },
  };
}

/** @type {string} */
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-session-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('session.js awaiting_submit tab exemption', () => {
  test('reconcileTargets never closes an exempt target id', async () => {
    const f = fakeChromium();
    const marker = path.join(dir, 'm.json');
    fs.writeFileSync(marker, JSON.stringify({ target_ids: ['AWAIT-1', 'OLD-2'] }));
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Set(['AWAIT-1'])) });
    const r = await s.reconcileTargets(marker);
    assert.deepEqual(f.closedTargetIds, ['OLD-2']);
    assert.equal(r.closed, 1);
  });
  test('an unknown exempt set (lookup failed) closes nothing and keeps the marker file', async () => {
    const f = fakeChromium();
    const marker = path.join(dir, 'm.json');
    fs.writeFileSync(marker, JSON.stringify({ target_ids: ['OLD-2'] }));
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Error('db down')) });
    assert.deepEqual(await s.reconcileTargets(marker), { attempted: 1, closed: 0 });
    assert.deepEqual(f.closedTargetIds, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).target_ids, ['OLD-2']);
    assert.equal(await s.reconcile(), 0);
  });
  test('reconcile() skips a marker-fragment page whose target id is exempt', async () => {
    const awaiting = makePage({ url: `https://www.linkedin.com/jobs/view/1/#${PAGE_MARKER}`, targetId: 'AWAIT-1' });
    const leftover = makePage({ url: `https://example.test/#${PAGE_MARKER}`, targetId: 'OLD-2' });
    const f = fakeChromium({ existing: [awaiting, leftover] });
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Set(['AWAIT-1'])) });
    assert.equal(await s.reconcile(), 1);
    assert.equal(awaiting._closed, false);
    assert.equal(leftover._closed, true);
  });
  test('a new page with no opener (noopener) or an untracked opener is armed with the scan policy and closed by closeAll', async () => {
    const f = fakeChromium();
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Set(['AWAIT-1'])) });
    const noOpener = makePage();
    noOpener.opener = async () => null;
    const stranger = makePage();
    const fromStranger = makePage();
    fromStranger.opener = async () => stranger;
    f.context.fire(noOpener);
    f.context.fire(fromStranger);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(noOpener._routes.length, 1);
    assert.equal(fromStranger._routes.length, 1);
    await s.closeAll();
    assert.equal(noOpener._closed, true);
    assert.equal(fromStranger._closed, true);
  });
  test('a new page whose target id is awaiting_submit is never armed nor closed', async () => {
    const f = fakeChromium();
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Set(['AWAIT-1'])) });
    const awaiting = makePage({ targetId: 'AWAIT-1' });
    awaiting.opener = async () => null;
    f.context.fire(awaiting);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(awaiting._routes.length, 0);
    await s.closeAll();
    assert.equal(awaiting._closed, false);
  });
  test('when the exempt set cannot be read, a new page is armed (fail closed), even an awaiting one', async () => {
    const f = fakeChromium();
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Error('db down')) });
    const p = makePage({ targetId: 'AWAIT-1' });
    p.opener = async () => null;
    f.context.fire(p);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p._routes.length, 1);
    await s.closeAll();
    assert.equal(p._closed, true);
  });
  test('detachLeaveOpen unroutes tracked pages and never closes them', async () => {
    const f = fakeChromium();
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Set()) });
    const p = /** @type {any} */ (await s.attachPage({ mode: 'scan' }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p._routes.length, 1);
    const unroutedBefore = p._unrouted;
    await s.detachLeaveOpen();
    assert.equal(p._unrouted, unroutedBefore + 1);
    assert.equal(p._routes.length, 0);
    assert.equal(p._closed, false);
    assert.equal(s.openPages(), 0);
    await s.closeAll();
    assert.equal(p._closed, false, 'a page handed off by detachLeaveOpen is no longer this session\'s to close');
  });
  test('detachLeaveOpen reports ok, and a failed unroute forgets nothing so closeAll still closes the page (A9)', async () => {
    const f = fakeChromium();
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Set()) });
    const p = /** @type {any} */ (await s.attachPage({ mode: 'scan' }));
    await new Promise((r) => setTimeout(r, 20));
    p.unroute = async () => { throw new Error('page crashed'); };
    const r = await s.detachLeaveOpen();
    assert.deepEqual(r, { ok: false, failed: 1 });
    assert.equal(s.openPages(), 1);
    await s.closeAll();
    assert.equal(p._closed, true);
    const s2 = await connectSession({ cdpUrl: 'x', chromium: fakeChromium().chromium, awaitingTabs: tabs(new Set()) });
    await s2.attachPage({ mode: 'scan' });
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(await s2.detachLeaveOpen(), { ok: true, failed: 0 });
  });
  test('targetIdOf returns the page\'s CDP target id; the marker written after a handoff no longer lists it', async () => {
    const f = fakeChromium();
    const s = await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: tabs(new Set()) });
    const p = /** @type {any} */ (await s.attachPage({ mode: 'scan' }));
    await new Promise((r) => setTimeout(r, 20));
    const id = await s.targetIdOf(p);
    assert.equal(typeof id, 'string');
    assert.equal(id, p._targetId);
    const marker = path.join(dir, 'm.json');
    await s.writeTargetMarker(marker);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).target_ids, [id]);
    await s.detachLeaveOpen();
    await s.writeTargetMarker(marker);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).target_ids, []);
  });
  test('on connect, awaiting rows whose tab is gone are demoted against the live target list', async () => {
    const live = makePage({ targetId: 'LIVE-1' });
    const f = fakeChromium({ existing: [live] });
    const t = tabs(new Set(['GONE-9']));
    await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: t });
    assert.equal(t.demoted.length, 1);
    assert.deepEqual([...t.demoted[0][0]], ['LIVE-1']);
  });
  test('an unreadable target list demotes nothing', async () => {
    const f = fakeChromium({ liveTargets: {} });
    const t = tabs(new Set(['GONE-9']));
    await connectSession({ cdpUrl: 'x', chromium: f.chromium, awaitingTabs: t });
    assert.equal(t.demoted.length, 0);
  });
});

describe('scan Chrome self-heal demotes awaiting_submit tabs (spec B5)', () => {
  test('a relaunch (killed or freshly launched) demotes every awaiting tab; a healthy Chrome demotes nothing', async () => {
    const { launchChrome } = await import('../bin/scan.js');
    const env = /** @type {any} */ ({ SCAN_CDP_URL: 'http://127.0.0.1:9333', CHROME_EXECUTABLE: 'C:\\fake\\chrome.exe', SCAN_PROFILE_DIR: 'C:\\fake\\chrome-scan-profile' });
    /** @type {string[]} */
    const demotes = [];
    const healthy = await launchChrome(env, () => {}, { probe: async () => true, demoteAwaiting: async (/** @type {string} */ reason) => { demotes.push(reason); return []; } });
    assert.equal(healthy.launched, false);
    assert.deepEqual(demotes, []);
    let probes = 0;
    await launchChrome(env, () => {}, {
      probe: async () => (++probes > 1),
      listProcesses: async () => [55],
      killTree: async () => true,
      sleep: async () => {},
      demoteAwaiting: async (/** @type {string} */ reason) => { demotes.push(reason); return []; },
    });
    assert.deepEqual(demotes, ['scan_chrome_restarted']);
  });
});
