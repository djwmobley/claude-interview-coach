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
import { JobSearchError, errFields } from './errors.js';

const RELOAD_TIMEOUT_MS = 3000;

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
function launchOsBrowser({ dashboardUrl, spawnImpl, platform }) {
  return new Promise((resolve, reject) => {
    const [cmd, cmdArgs] = platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', dashboardUrl]]
      : platform === 'darwin'
        ? ['open', [dashboardUrl]]
        : ['xdg-open', [dashboardUrl]];
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawnImpl(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
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
  const fetchImpl = o.fetchImpl ?? fetch;
  const WebSocketImpl = o.WebSocketImpl ?? WebSocket;
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
