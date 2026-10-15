// @ts-check
/**
 * src/core/open-dashboard.js: all three modes (reloaded, opened_tab, os_browser), the failure path
 * (every mode exhausted), and the loopback-only guard on cdpUrl. No DB involved -- every network and
 * process boundary is injected (fetchImpl, WebSocketImpl, spawnImpl), so none of this touches a real
 * Chrome, a real CDP endpoint, or the real OS shell.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  openDashboard,
  assertLoopbackCdpUrl,
  assertLaunchableUrl,
  launchOsBrowser,
  launchOsBrowserDiagnosed,
  makeStartUrlLauncher,
  buildWin32LaunchArgv,
  WIN32_MAX_LAUNCH_URL_LENGTH,
} from '../src/core/open-dashboard.js';

const DASHBOARD_URL = 'http://127.0.0.1:7311/';
const CDP_URL = 'http://127.0.0.1:9222';

/** Records every call and answers from a small ordered list of {match, respond|throw}. */
function fetchStub(handlers) {
  /** @type {Array<{ url: string, init: any }>} */
  const calls = [];
  const fn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init });
    const h = handlers.find((x) => x.match(String(url), init));
    if (!h) throw new Error(`fetchStub: no handler matched ${url}`);
    if (h.throw) throw h.throw;
    return h.respond;
  };
  return { fn, calls };
}

/**
 * Fake WebSocket: 'reply' auto-answers Page.reload with a matching id:1 message, 'error' fires a
 * connection error instead of ever opening.
 */
function makeFakeWebSocket(behavior) {
  /** @type {any[]} */
  const created = [];
  class FakeWebSocket {
    /** @param {string} url */
    constructor(url) {
      this.url = url;
      this.sent = /** @type {string[]} */ ([]);
      /** @type {Record<string, Array<(ev: any) => void>>} */
      this._listeners = {};
      created.push(this);
      queueMicrotask(() => {
        if (behavior === 'error') this._emit('error', {});
        else this._emit('open', {});
      });
    }
    /** @param {string} type @param {(ev: any) => void} fn */
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    }
    /** @param {string} data */
    send(data) {
      this.sent.push(data);
      if (behavior === 'reply') {
        const msg = JSON.parse(data);
        queueMicrotask(() => this._emit('message', { data: JSON.stringify({ id: msg.id, result: {} }) }));
      }
      // behavior === 'silent': never responds; not exercised here (would require the real 3s timeout).
    }
    close() {}
    /** @param {string} type @param {any} ev */
    _emit(type, ev) {
      for (const fn of this._listeners[type] ?? []) fn(ev);
    }
  }
  return { WebSocketImpl: /** @type {any} */ (FakeWebSocket), created };
}

/** Fake child_process.spawn: 'spawn' emits a successful spawn asynchronously, 'error' emits ENOENT. */
function fakeSpawn(behavior) {
  /** @type {Array<{ cmd: string, args: string[], opts: any }>} */
  const calls = [];
  const fn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    /** @type {any} */ (child).unref = () => {
      /** @type {any} */ (child).unrefed = true;
    };
    queueMicrotask(() => {
      if (behavior === 'error') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      else child.emit('spawn');
    });
    return child;
  };
  return { fn, calls };
}

/** @returns {{ log: (f: any) => void, lines: any[] }} */
function collectLog() {
  const lines = /** @type {any[]} */ ([]);
  return { log: (f) => lines.push(f), lines };
}

describe('assertLoopbackCdpUrl', () => {
  test('accepts 127.0.0.1, localhost, and ::1', () => {
    assert.doesNotThrow(() => assertLoopbackCdpUrl('http://127.0.0.1:9222'));
    assert.doesNotThrow(() => assertLoopbackCdpUrl('http://localhost:9222'));
    assert.doesNotThrow(() => assertLoopbackCdpUrl('http://[::1]:9222'));
  });
  test('rejects a non-loopback host with VALIDATION', () => {
    assert.throws(() => assertLoopbackCdpUrl('http://evil.example.com:9222'), (/** @type {any} */ e) => e.code === 'VALIDATION');
    assert.throws(() => assertLoopbackCdpUrl('http://10.0.0.5:9222'), (/** @type {any} */ e) => e.code === 'VALIDATION');
  });
  test('rejects an unparseable URL with VALIDATION', () => {
    assert.throws(() => assertLoopbackCdpUrl('not a url'), (/** @type {any} */ e) => e.code === 'VALIDATION');
  });
});

describe('openDashboard', () => {
  test('mode "reloaded": an existing tab at the dashboard origin is reloaded and activated', async () => {
    const target = { id: 'T1', type: 'page', url: DASHBOARD_URL, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1' };
    const { fn: fetchImpl, calls } = fetchStub([
      { match: (u) => u === `${CDP_URL}/json`, respond: { ok: true, status: 200, json: async () => [target] } },
      { match: (u) => u === `${CDP_URL}/json/activate/T1`, respond: { ok: true, status: 200, json: async () => ({}) } },
    ]);
    const { WebSocketImpl, created } = makeFakeWebSocket('reply');
    const { log, lines } = collectLog();
    const r = await openDashboard({ dashboardUrl: DASHBOARD_URL, cdpUrl: CDP_URL, fetchImpl, WebSocketImpl, log });
    assert.deepEqual(r, { ok: true, mode: 'reloaded' });
    assert.equal(created.length, 1);
    assert.equal(JSON.parse(created[0].sent[0]).method, 'Page.reload');
    assert.ok(calls.some((c) => c.url === `${CDP_URL}/json/activate/T1`));
    assert.ok(lines.some((l) => l.evt === 'open_dashboard' && l.mode === 'reloaded' && l.url === DASHBOARD_URL));
  });

  test('mode "opened_tab": no existing tab matches the dashboard origin, so a new one is opened', async () => {
    const otherTarget = { id: 'T2', type: 'page', url: 'http://127.0.0.1:9999/something-else', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T2' };
    const { fn: fetchImpl, calls } = fetchStub([
      { match: (u) => u === `${CDP_URL}/json`, respond: { ok: true, status: 200, json: async () => [otherTarget] } },
      { match: (u, init) => u === `${CDP_URL}/json/new?${DASHBOARD_URL}` && init?.method === 'PUT', respond: { ok: true, status: 200, json: async () => ({}) } },
    ]);
    const { WebSocketImpl } = makeFakeWebSocket('reply');
    const { log, lines } = collectLog();
    const r = await openDashboard({ dashboardUrl: DASHBOARD_URL, cdpUrl: CDP_URL, fetchImpl, WebSocketImpl, log });
    assert.deepEqual(r, { ok: true, mode: 'opened_tab' });
    assert.ok(calls.some((c) => c.url === `${CDP_URL}/json/new?${DASHBOARD_URL}`));
    assert.ok(lines.some((l) => l.evt === 'open_dashboard' && l.mode === 'opened_tab'));
  });

  test('mode "os_browser": the CDP endpoint is unreachable, falls back to the OS default browser', async () => {
    const { fn: fetchImpl } = fetchStub([
      { match: () => true, throw: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9222'), { code: 'ECONNREFUSED' }) },
    ]);
    const { fn: spawnImpl, calls } = fakeSpawn('spawn');
    const { log, lines } = collectLog();
    const r = await openDashboard({ dashboardUrl: DASHBOARD_URL, cdpUrl: CDP_URL, fetchImpl, spawnImpl, platform: 'win32', log });
    assert.deepEqual(r, { ok: true, mode: 'os_browser' });
    assert.equal(calls.length, 1);
    // No cmd.exe (splits at `&`, 2026-09-17) and no PowerShell (Defender blocks encoded PowerShell
    // commands, 2026-10-15): win32 spawns explorer.exe with the URL as a single argv element, no shell.
    assert.equal(calls[0].cmd, 'explorer.exe');
    assert.deepEqual(calls[0].args, [DASHBOARD_URL]);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.shell, false);
    assert.ok(lines.some((l) => l.evt === 'open_dashboard' && l.mode === 'os_browser'));
  });

  test('mode "os_browser" on darwin/linux uses open/xdg-open respectively', async () => {
    const { fn: fetchImpl } = fetchStub([{ match: () => true, throw: new Error('unreachable') }]);
    for (const [platform, cmd] of /** @type {[NodeJS.Platform, string][]} */ ([['darwin', 'open'], ['linux', 'xdg-open']])) {
      const { fn: spawnImpl, calls } = fakeSpawn('spawn');
      const { log } = collectLog();
      const r = await openDashboard({ dashboardUrl: DASHBOARD_URL, cdpUrl: CDP_URL, fetchImpl, spawnImpl, platform, log });
      assert.equal(r.mode, 'os_browser');
      assert.equal(calls[0].cmd, cmd);
      assert.deepEqual(calls[0].args, [DASHBOARD_URL]);
    }
  });

  test('a non-loopback cdpUrl never contacts the network and falls straight through to the OS browser', async () => {
    let fetchCalled = false;
    const fetchImpl = async () => {
      fetchCalled = true;
      throw new Error('should never be called');
    };
    const { fn: spawnImpl } = fakeSpawn('spawn');
    const { log, lines } = collectLog();
    const r = await openDashboard({ dashboardUrl: DASHBOARD_URL, cdpUrl: 'http://evil.example.com:9222', fetchImpl, spawnImpl, platform: 'win32', log });
    assert.equal(fetchCalled, false, 'the loopback guard must reject before any fetch is attempted');
    assert.deepEqual(r, { ok: true, mode: 'os_browser' });
    assert.ok(lines.some((l) => l.evt === 'open_dashboard' && l.mode === 'os_browser'));
  });

  test('failure path: CDP unreachable AND the OS browser spawn fails -- logs open_dashboard_failed, never throws, ok:false', async () => {
    const { fn: fetchImpl } = fetchStub([
      { match: () => true, throw: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
    ]);
    const { fn: spawnImpl } = fakeSpawn('error');
    const { log, lines } = collectLog();
    const r = await openDashboard({ dashboardUrl: DASHBOARD_URL, cdpUrl: CDP_URL, fetchImpl, spawnImpl, platform: 'win32', log });
    assert.deepEqual(r, { ok: false, mode: null });
    const failLine = lines.find((l) => l.evt === 'open_dashboard_failed');
    assert.ok(failLine, JSON.stringify(lines));
    assert.equal(failLine.err_code, 'ENOENT');
    assert.equal(failLine.cdp_err_code, 'ECONNREFUSED');
  });

  test('a matched target with no webSocketDebuggerUrl falls back to the OS browser rather than throwing out', async () => {
    const target = { id: 'T3', type: 'page', url: DASHBOARD_URL };
    const { fn: fetchImpl } = fetchStub([{ match: (u) => u === `${CDP_URL}/json`, respond: { ok: true, status: 200, json: async () => [target] } }]);
    const { fn: spawnImpl } = fakeSpawn('spawn');
    const { log } = collectLog();
    const r = await openDashboard({ dashboardUrl: DASHBOARD_URL, cdpUrl: CDP_URL, fetchImpl, spawnImpl, platform: 'win32', log });
    assert.equal(r.mode, 'os_browser');
  });
});

describe('win32 launch argv (2026-09-17 split-at-& fix; 2026-10-15 no-PowerShell fix)', () => {
  const longUrl = `http://127.0.0.1:7311/?payload=${'x'.repeat(3000)}&tail=end`;
  /** A URL of exactly n chars ending in &tail=end. */
  const urlOfLength = (/** @type {number} */ n) => {
    const head = 'http://127.0.0.1:7311/?payload=';
    const tail = '&tail=end';
    return head + 'x'.repeat(n - head.length - tail.length) + tail;
  };
  const URLS = /** @type {Array<[string, string]>} */ ([
    ['plain dashboard URL', DASHBOARD_URL],
    ['URL with &', 'http://127.0.0.1:7311/?a=1&b=2&c=3'],
    ['URL with %2F', 'http://127.0.0.1:7311/?redirect=http%3A%2F%2Fx%2Fy&z=1'],
    ['URL with %20', 'http://127.0.0.1:7311/?q=a%20b%20c&z=1'],
    ['URL with a single quote', "http://127.0.0.1:7311/?note=it's&c=d"],
    ['mixed &, %2F, %20 and quote', "http://127.0.0.1:7311/?a=1&b=x%2Fy%20z&note=it's%20a%20test&c=d"],
    ['2000-char URL ending in &tail=end', urlOfLength(2000)],
  ]);

  test('fixture sanity: the long URL is 3000+ chars and ends in &tail=end', () => {
    assert.ok(longUrl.length >= 3000);
    assert.ok(longUrl.endsWith('&tail=end'));
    assert.equal(urlOfLength(2000).length, 2000);
    assert.equal(urlOfLength(2001).length, 2001);
  });

  test('length boundary: 2000 chars launches, 2001 is refused with url_too_long', () => {
    assert.doesNotThrow(() => buildWin32LaunchArgv(urlOfLength(2000)));
    assert.throws(() => buildWin32LaunchArgv(urlOfLength(2001)), (/** @type {any} */ e) => e.code === 'VALIDATION' && e.details.reason === 'url_too_long');
    assert.equal(WIN32_MAX_LAUNCH_URL_LENGTH, 2000);
  });

  test('a 3000+ char URL is refused with the distinct url_too_long error and is never spawned', async () => {
    assert.throws(() => buildWin32LaunchArgv(longUrl), (/** @type {any} */ e) => e.code === 'VALIDATION' && e.details.reason === 'url_too_long' && e.details.length === longUrl.length);
    const { fn: spawnImpl, calls } = fakeSpawn('spawn');
    await assert.rejects(
      () => launchOsBrowser({ dashboardUrl: longUrl, spawnImpl, platform: 'win32' }),
      (/** @type {any} */ e) => e.details.reason === 'url_too_long',
    );
    const r = await launchOsBrowserDiagnosed({ url: longUrl, spawnImpl, platform: 'win32' });
    assert.equal(r.spawned, false);
    assert.equal(r.refusedReason, 'url_too_long');
    assert.equal(calls.length, 0);
  });

  test('makeStartUrlLauncher (scan-run.js interactive reauth): launches the short start URL, not the long consent URL', async () => {
    const { fn: spawnImpl, calls } = fakeSpawn('spawn');
    const START = 'http://127.0.0.1:7312/start';
    await makeStartUrlLauncher({ spawnImpl, platform: 'win32' })(longUrl, START);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'explorer.exe');
    assert.deepEqual(calls[0].args, [START]);
    assert.equal(calls[0].opts.shell, false);
    // Without a startUrl it falls back to the url itself, and a too-long one is refused, never spawned.
    await assert.rejects(() => makeStartUrlLauncher({ spawnImpl, platform: 'win32' })(longUrl), (/** @type {any} */ e) => e.details.reason === 'url_too_long');
    assert.equal(calls.length, 1);
  });

  test('invalid input to buildWin32LaunchArgv throws invalid_url instead of building an argv', () => {
    for (const bad of ['javascript:alert(1)', 'not a url', '', null, undefined, 42]) {
      assert.throws(() => buildWin32LaunchArgv(/** @type {any} */ (bad)), (/** @type {any} */ e) => e.details.reason === 'invalid_url');
    }
  });

  test('openDashboard with a too-long dashboardUrl logs open_dashboard_failed and does not throw', async () => {
    const { fn: fetchImpl } = fetchStub([{ match: () => true, throw: new Error('unreachable') }]);
    const { fn: spawnImpl, calls } = fakeSpawn('spawn');
    const { log, lines } = collectLog();
    const r = await openDashboard({ dashboardUrl: longUrl, cdpUrl: CDP_URL, fetchImpl, spawnImpl, platform: 'win32', log });
    assert.deepEqual(r, { ok: false, mode: null });
    assert.equal(calls.length, 0);
    assert.ok(lines.some((l) => l.evt === 'open_dashboard_failed'));
  });

  for (const [label, url] of URLS) {
    test(`buildWin32LaunchArgv: ${label} is a single, byte-equal argv element for explorer.exe`, () => {
      const [cmd, args] = buildWin32LaunchArgv(url);
      assert.equal(cmd, 'explorer.exe');
      assert.equal(args.length, 1);
      assert.equal(args[0], url);
    });

    test(`launchOsBrowser (injected spawn): ${label} spawns explorer.exe with the exact URL, shell false`, async () => {
      const { fn: spawnImpl, calls } = fakeSpawn('spawn');
      await launchOsBrowser({ dashboardUrl: url, spawnImpl, platform: 'win32' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'explorer.exe');
      assert.deepEqual(calls[0].args, [url]);
      assert.equal(calls[0].opts.shell, false);
    });

    test(`launchOsBrowserDiagnosed (injected spawn): ${label} spawns explorer.exe with the exact URL, shell false`, async () => {
      const calls = /** @type {Array<{ cmd: string, args: string[], opts: any }>} */ ([]);
      const spawnImpl = /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
        calls.push({ cmd, args, opts });
        const child = /** @type {any} */ (new EventEmitter());
        child.stderr = null;
        queueMicrotask(() => {
          child.emit('spawn');
          child.emit('exit', 1, null); // explorer.exe commonly exits 1 on success
        });
        return child;
      });
      const r = await launchOsBrowserDiagnosed({ url, spawnImpl, platform: 'win32' });
      assert.equal(r.spawned, true);
      assert.equal(r.error, null);
      assert.equal(r.exitCode, 1, 'a non-zero explorer.exe exit is recorded, not turned into an error');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'explorer.exe');
      assert.deepEqual(calls[0].args, [url]);
      assert.equal(calls[0].opts.shell, false);
    });
  }

  describe('(c) invalid_url branch: assertLaunchableUrl / launchOsBrowser refuse before ever spawning', () => {
    test('assertLaunchableUrl throws VALIDATION with details.reason === "invalid_url" for javascript:, file:, and a non-string', () => {
      for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', /** @type {any} */ (null), /** @type {any} */ (undefined), /** @type {any} */ (42), '']) {
        assert.throws(
          () => assertLaunchableUrl(bad),
          (/** @type {any} */ e) => e.code === 'VALIDATION' && e.details.reason === 'invalid_url',
          `expected invalid_url for ${JSON.stringify(bad)}`,
        );
      }
    });

    test('launchOsBrowser never spawns for a javascript: URL', async () => {
      const { fn: spawnImpl, calls } = fakeSpawn('spawn');
      await assert.rejects(
        () => launchOsBrowser({ dashboardUrl: 'javascript:alert(1)', spawnImpl, platform: 'win32' }),
        (/** @type {any} */ e) => e.code === 'VALIDATION' && e.details.reason === 'invalid_url',
      );
      assert.equal(calls.length, 0);
    });

    test('launchOsBrowser never spawns for a file: URL', async () => {
      const { fn: spawnImpl, calls } = fakeSpawn('spawn');
      await assert.rejects(
        () => launchOsBrowser({ dashboardUrl: 'file:///etc/passwd', spawnImpl, platform: 'win32' }),
        (/** @type {any} */ e) => e.code === 'VALIDATION' && e.details.reason === 'invalid_url',
      );
      assert.equal(calls.length, 0);
    });

    test('launchOsBrowser never spawns for a non-string URL', async () => {
      const { fn: spawnImpl, calls } = fakeSpawn('spawn');
      await assert.rejects(
        () => launchOsBrowser({ dashboardUrl: /** @type {any} */ (null), spawnImpl, platform: 'win32' }),
        (/** @type {any} */ e) => e.code === 'VALIDATION' && e.details.reason === 'invalid_url',
      );
      assert.equal(calls.length, 0);
    });
  });
});
