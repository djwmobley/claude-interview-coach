// @ts-check
/**
 * Open-or-refresh the dashboard tab after bin/remind.js runs (the operator's daily 08:00 scheduled
 * task): the reminder email regularly gets lost in spam, so the dashboard should show up on screen
 * regardless. Three modes, tried in order, any step failing falls through to the next:
 *
 *   1. reloaded    a tab in the operator's daily-driver Chrome (env DAILY_CDP_URL, default
 *                   http://127.0.0.1:9222 -- NEVER SCAN_CDP_URL, which is the separate, dedicated scan
 *                   browser profile on port 9333) already shows the dashboard origin: reload it via CDP
 *                   (Page.reload) and bring it to the front (/json/activate).
 *   2. opened_tab  no matching tab: open a new one in that same Chrome via /json/new.
 *   3. os_browser  the CDP endpoint is unreachable, refused (see the loopback check below), or any step
 *                   above throws: fall back to launching the OS default browser (detached, so this
 *                   never blocks bin/remind.js's own exit).
 *
 * This module never throws: openDashboard() always resolves, logging `{ evt: 'open_dashboard', mode,
 * url }` on success or `{ evt: 'open_dashboard_failed', ... }` when every mode failed. The caller
 * (bin/remind.js) must never let this change its process exit code -- see runRemind's own exit code,
 * which this function has no way to touch even if it wanted to.
 *
 * Security posture: cdpUrl is only ever contacted (fetch + WebSocket) after assertLoopbackCdpUrl()
 * passes -- a non-loopback DAILY_CDP_URL (misconfiguration or tampering) never gets an HTTP or
 * WebSocket request sent to it; it just falls straight through to the OS-browser fallback, same as an
 * unreachable loopback endpoint would. dashboardUrl is never taken from anywhere this module reads --
 * the caller builds it from the same DASHBOARD_PORT default bin/dashboard.js uses (127.0.0.1, only the
 * port varies), so nothing here ever contacts a non-localhost origin.
 *
 * Everything that talks to the network or spawns a process is injected (fetchImpl, WebSocketImpl,
 * spawnImpl) so tests exercise all three modes and the failure path without touching a real Chrome or
 * the real OS shell.
 */
import { spawn as realSpawn } from 'node:child_process';
import { JobSearchError, errFields } from './errors.js';
import { assertRealBrowserAllowed } from './test-guard.js';

const RELOAD_TIMEOUT_MS = 3000;

/** ShellExecute historically caps URLs near 2083 chars; stay safely under it. Longer URLs are refused. */
export const WIN32_MAX_LAUNCH_URL_LENGTH = 2000;

/**
 * Only 127.0.0.0/8, ::1, and the literal hostname "localhost" are accepted. Anything else throws
 * VALIDATION -- this is a total classification (every hostname is either loopback or refused), not a
 * denylist of hosts to avoid.
 * @param {string} cdpUrl
 */
export function assertLoopbackCdpUrl(cdpUrl) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(cdpUrl);
  } catch {
    throw new JobSearchError('VALIDATION', `open-dashboard: cdpUrl is not a valid URL: ${cdpUrl}`);
  }
  // WHATWG URL keeps the brackets on an IPv6 literal hostname (e.g. "[::1]"); strip them before comparing.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!loopback) {
    throw new JobSearchError('VALIDATION', `open-dashboard: cdpUrl host "${host}" is not loopback; refusing to contact it`, {
      details: { cdp_url: cdpUrl },
    });
  }
}

/** @param {string} url */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Total classification of a launch-target URL (2026-09-17 incident: an unquoted URL handed to `cmd.exe
 * /c start` on win32 got split at every `&`, so Google only ever received `access_type=offline`): only
 * http: and https: may ever be handed to the OS browser launcher. Every other input -- an unparseable
 * string, a non-string, or a parseable-but-non-http(s) scheme such as javascript:/file:/data: -- throws
 * VALIDATION with details.reason === 'invalid_url'. This is a total classification (every input maps to
 * a branch), not a denylist of schemes to avoid.
 * @param {unknown} url
 */
export function assertLaunchableUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new JobSearchError('VALIDATION', 'open-dashboard: launch URL must be a non-empty string', { details: { reason: 'invalid_url' } });
  }
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new JobSearchError('VALIDATION', `open-dashboard: launch URL is not a valid URL (reason: invalid_url): ${url}`, { details: { reason: 'invalid_url' } });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new JobSearchError('VALIDATION', `open-dashboard: launch URL protocol "${u.protocol}" is not http/https; refusing to launch (reason: invalid_url)`, { details: { reason: 'invalid_url' } });
  }
}

/**
 * Build the win32 argv for launching the default browser on `url`: `explorer.exe <url>`, spawned with
 * shell:false and the URL as ONE argv element. No cmd.exe (which split URLs at `&`, 2026-09-17 incident)
 * and no PowerShell (Windows Defender blocks and alerts on powershell.exe with base64-encoded commands, 2026-10-15).
 * Node quotes the element for CreateProcess, explorer.exe hands it to the shell association for http(s),
 * and nothing re-tokenizes it. explorer.exe commonly exits non-zero (typically 1) even when it succeeded,
 * so no caller may treat its exit code as a launch failure.
 * @param {string} url
 * @returns {[string, string[]]}
 */
export function buildWin32LaunchArgv(url) {
  // Total classification: invalid input throws invalid_url, a URL over the limit throws url_too_long,
  // everything else maps to the explorer.exe argv. A refused URL is never launched truncated.
  assertLaunchableUrl(url);
  if (url.length > WIN32_MAX_LAUNCH_URL_LENGTH) {
    throw new JobSearchError(
      'VALIDATION',
      `open-dashboard: launch URL is ${url.length} chars, over the ${WIN32_MAX_LAUNCH_URL_LENGTH}-char limit ShellExecute handles safely; not launching (reason: url_too_long)`,
      { details: { reason: 'url_too_long', length: url.length } },
    );
  }
  return ['explorer.exe', [url]];
}

/**
 * Send Page.reload over the target's own WebSocket debugger URL and wait for the matching response
 * (id:1) or a 3s timeout.
 * @param {string} wsUrl
 * @param {typeof WebSocket} WebSocketImpl
 */
function sendPageReload(wsUrl, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {InstanceType<typeof WebSocket>} */
    let ws;
    const finish = (/** @type {(() => void)|((err: unknown) => void)} */ fn, /** @type {unknown} */ arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed/never opened */
      }
      // @ts-expect-error -- fn is called with 0 or 1 args depending on resolve/reject
      fn(arg);
    };
    const timer = setTimeout(() => {
      finish(reject, new JobSearchError('INTERNAL', 'open-dashboard: Page.reload timed out waiting for a response'));
    }, RELOAD_TIMEOUT_MS);
    try {
      ws = new WebSocketImpl(wsUrl);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
      } catch (err) {
        finish(reject, err);
      }
    });
    ws.addEventListener('message', (/** @type {any} */ ev) => {
      if (settled) return;
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg && msg.id === 1) finish(resolve, undefined);
    });
    ws.addEventListener('error', () => {
      finish(reject, new JobSearchError('INTERNAL', 'open-dashboard: WebSocket error while sending Page.reload'));
    });
  });
}

/**
 * @param {{ dashboardUrl: string, cdpUrl: string, fetchImpl: typeof fetch, WebSocketImpl: typeof WebSocket }} o
 * @returns {Promise<'reloaded'|'opened_tab'>}
 */
async function tryCdp({ dashboardUrl, cdpUrl, fetchImpl, WebSocketImpl }) {
  assertLoopbackCdpUrl(cdpUrl);
  const wantOrigin = new URL(dashboardUrl).origin;

  const listRes = await fetchImpl(`${cdpUrl}/json`);
  if (!listRes.ok) throw new JobSearchError('INTERNAL', `open-dashboard: GET /json HTTP ${listRes.status}`);
  const targets = await listRes.json();
  const match = Array.isArray(targets)
    ? targets.find((/** @type {any} */ t) => t && t.type === 'page' && typeof t.url === 'string' && originOf(t.url) === wantOrigin)
    : null;

  if (match) {
    if (!match.webSocketDebuggerUrl) throw new JobSearchError('INTERNAL', 'open-dashboard: matched target has no webSocketDebuggerUrl');
    await sendPageReload(match.webSocketDebuggerUrl, WebSocketImpl);
    const actRes = await fetchImpl(`${cdpUrl}/json/activate/${encodeURIComponent(match.id)}`);
    if (!actRes.ok) throw new JobSearchError('INTERNAL', `open-dashboard: GET /json/activate HTTP ${actRes.status}`);
    return 'reloaded';
  }

  // CDP's own HTTP endpoint takes the target URL as a raw query-string suffix, not a normal encoded
  // query param: PUT /json/new?http://... is the documented shape.
  const newRes = await fetchImpl(`${cdpUrl}/json/new?${dashboardUrl}`, { method: 'PUT' });
  if (!newRes.ok) throw new JobSearchError('INTERNAL', `open-dashboard: PUT /json/new HTTP ${newRes.status}`);
  return 'opened_tab';
}

/**
 * @param {{ dashboardUrl: string, spawnImpl: typeof import('node:child_process').spawn, platform: NodeJS.Platform }} o
 * @returns {Promise<void>}
 */
export function launchOsBrowser({ dashboardUrl, spawnImpl, platform }) {
  return new Promise((resolve, reject) => {
    // Synchronous throw inside a Promise executor rejects the returned promise; nothing is ever spawned
    // for a URL that fails this check (spec: "do not launch, return/log a refusal with reason invalid_url").
    assertLaunchableUrl(dashboardUrl);
    if (spawnImpl === realSpawn) assertRealBrowserAllowed('open a URL in the OS browser (explorer/open/xdg-open)');
    const [cmd, cmdArgs] = platform === 'win32'
      ? buildWin32LaunchArgv(dashboardUrl)
      : platform === 'darwin'
        ? ['open', [dashboardUrl]]
        : ['xdg-open', [dashboardUrl]];
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      // shell:false is the default already, but spelled out here: this must never re-enter a shell that
      // could reinterpret the argv, on win32 or any other platform.
      child = spawnImpl(cmd, cmdArgs, { detached: true, stdio: 'ignore', shell: false });
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', (err) => reject(err));
    child.once('spawn', () => {
      // Detached and unref'd: bin/remind.js is a short-lived CLI and must exit on its own timeline,
      // never blocked on (or killed alongside) the browser process this just launched.
      child.unref();
      resolve();
    });
  });
}

/**
 * The reauth openUrl used by scan-run.js's interactive path: launches the SHORT loopback start URL the
 * reauth helper serves (its /start 302s to the consent URL), falling back to the url itself only when no
 * startUrl was supplied. A refusal (invalid_url / url_too_long) rejects; reauthorizeGoogle logs it and
 * the run proceeds.
 * @param {{ spawnImpl: typeof import('node:child_process').spawn, platform: NodeJS.Platform }} o
 * @returns {(url: string, startUrl?: string) => Promise<void>}
 */
export function makeStartUrlLauncher({ spawnImpl, platform }) {
  return async (url, startUrl) => {
    await launchOsBrowser({ dashboardUrl: startUrl ?? url, spawnImpl, platform });
  };
}

/**
 * Diagnosed variant of launchOsBrowser (2026-10-04 reauth consent-link fix): instead of a detached,
 * stdio-ignored fire-and-forget spawn (which reports success the moment the launcher starts, even if
 * the launch itself then fails), this waits for the launcher to exit and captures its exit code and
 * stderr so a failed launch leaves evidence in the log (explorer.exe exits non-zero on success, so the
 * code is recorded, never judged). Never rejects; every failure is a field on the
 * resolved result. The launcher (explorer.exe / open / xdg-open) returns as soon as it has handed the URL
 * to the shell, so waiting on it is cheap; `timeoutMs` bounds the wait and kills a hung launcher.
 * @param {{ url: string, spawnImpl: typeof import('node:child_process').spawn, platform: NodeJS.Platform, timeoutMs?: number }} o
 * @returns {Promise<{ spawned: boolean, exitCode: number|null, signal: string|null, stderr: string, error: string|null, timedOut: boolean, refusedReason: string|null }>}
 */
export function launchOsBrowserDiagnosed({ url, spawnImpl, platform, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    const result = { spawned: false, exitCode: /** @type {number|null} */ (null), signal: /** @type {string|null} */ (null), stderr: '', error: /** @type {string|null} */ (null), timedOut: false, refusedReason: /** @type {string|null} */ (null) };
    /** @type {string} */
    let cmd;
    /** @type {string[]} */
    let cmdArgs;
    try {
      assertLaunchableUrl(url);
      [cmd, cmdArgs] = platform === 'win32'
        ? buildWin32LaunchArgv(url)
        : platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    } catch (err) {
      // refusedReason is 'invalid_url' or 'url_too_long': the URL was never launched.
      const reason = /** @type {any} */ (err)?.details?.reason;
      resolve({ ...result, refusedReason: typeof reason === 'string' ? reason : 'invalid_url', error: String(err instanceof Error ? err.message : err).slice(0, 300) });
      return;
    }
    if (spawnImpl === realSpawn) assertRealBrowserAllowed('open a URL in the OS browser (explorer/open/xdg-open)');
    /** @type {any} */
    let child;
    try {
      child = spawnImpl(cmd, cmdArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false });
    } catch (err) {
      resolve({ ...result, error: String(err instanceof Error ? err.message : err).slice(0, 300) });
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stderr: result.stderr.slice(0, 2000) });
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
      finish();
    }, timeoutMs);
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (/** @type {any} */ d) => {
      if (result.stderr.length < 4000) result.stderr += String(d);
    });
    child.once('spawn', () => { result.spawned = true; });
    child.once('error', (/** @type {unknown} */ err) => {
      result.error = String(err instanceof Error ? err.message : err).slice(0, 300);
      finish();
    });
    child.once('exit', (/** @type {number|null} */ code, /** @type {string|null} */ sig) => {
      result.exitCode = code;
      result.signal = sig;
      // Give a trailing stderr chunk one turn to arrive before resolving.
      setImmediate(finish);
    });
  });
}

/**
 * @param {{
 *   dashboardUrl: string,
 *   cdpUrl: string,
 *   fetchImpl?: typeof fetch,
 *   WebSocketImpl?: typeof WebSocket,
 *   spawnImpl?: typeof import('node:child_process').spawn,
 *   platform?: NodeJS.Platform,
 *   log: (fields: Record<string, string|number|boolean|null>) => void,
 * }} o
 * @returns {Promise<{ ok: boolean, mode: 'reloaded'|'opened_tab'|'os_browser'|null }>}
 */
export async function openDashboard(o) {
  // Driving the scan Chrome's tabs over CDP with the real fetch/WebSocket reloads real browser tabs.
  // The guard fires at the moment a real fetch or WebSocket is actually used, so a test that injects only
  // one of them (the other is never reached) is unaffected.
  const fetchImpl = o.fetchImpl ?? /** @type {typeof fetch} */ ((...args) => {
    assertRealBrowserAllowed('drive a real Chrome over CDP (HTTP /json)');
    return fetch(...args);
  });
  const WebSocketImpl = o.WebSocketImpl ?? /** @type {typeof WebSocket} */ (/** @type {unknown} */ (class extends WebSocket {
    /** @param {ConstructorParameters<typeof WebSocket>} args */
    constructor(...args) {
      assertRealBrowserAllowed('drive a real Chrome over CDP (WebSocket reload)');
      super(...args);
    }
  }));
  const spawnImpl = o.spawnImpl ?? /** @type {typeof import('node:child_process').spawn} */ (/** @type {unknown} */ (undefined));
  const platform = o.platform ?? process.platform;

  let cdpErr = null;
  try {
    const mode = await tryCdp({ dashboardUrl: o.dashboardUrl, cdpUrl: o.cdpUrl, fetchImpl, WebSocketImpl });
    o.log({ evt: 'open_dashboard', mode, url: o.dashboardUrl });
    return { ok: true, mode };
  } catch (err) {
    cdpErr = err;
  }

  try {
    await launchOsBrowser({ dashboardUrl: o.dashboardUrl, spawnImpl, platform });
    o.log({ evt: 'open_dashboard', mode: 'os_browser', url: o.dashboardUrl });
    return { ok: true, mode: 'os_browser' };
  } catch (err) {
    const cdpFields = errFields(cdpErr);
    const osFields = errFields(err);
    o.log({
      evt: 'open_dashboard_failed',
      url: o.dashboardUrl,
      err_code: osFields.err_code,
      err_message: osFields.err_message,
      cdp_err_code: cdpFields.err_code,
      cdp_err_message: cdpFields.err_message,
    });
    return { ok: false, mode: null };
  }
}
