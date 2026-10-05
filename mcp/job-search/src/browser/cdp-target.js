// @ts-check
/**
 * Minimal raw Chrome DevTools Protocol client for the assisted LinkedIn Easy Apply flow.
 *
 * Why not Playwright here: playwright-core's connectOverCDP auto-attaches to EVERY existing tab, runs its
 * own utility scripts in them, and its page.route() is network interception -- the Easy Apply tab must
 * carry nothing that could survive a detach and interfere with Damian's own Submit click (spec G4), and the
 * scan side must never attach to an awaiting_submit tab (spec B5). This client talks to the browser-level
 * WebSocket only, attaches to exactly ONE target id on request (Target.attachToTarget, flatten mode),
 * enables no CDP domains, installs no page listeners and no request interception, and detaching
 * (Target.detachFromTarget + closing the socket) leaves the tab exactly as it was.
 *
 * Node 22's global WebSocket is used; `fetchImpl` / `WebSocketImpl` are test seams.
 */
import { JobSearchError } from '../core/errors.js';

/**
 * @typedef {Object} CdpClient
 * @property {(method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>} send
 * @property {() => Promise<Array<{ targetId: string, type: string, url: string, title: string }>>} listPageTargets
 * @property {(targetId: string) => Promise<string>} attach returns the flat-mode sessionId
 * @property {(sessionId: string) => Promise<void>} detach
 * @property {() => void} close close the browser-level socket (never closes any tab)
 */

/**
 * Resolve the browser-level WebSocket URL from the CDP HTTP endpoint (`/json/version`).
 * @param {string} cdpHttpUrl e.g. http://127.0.0.1:9333
 * @param {typeof fetch} fetchImpl
 */
async function browserWsUrl(cdpHttpUrl, fetchImpl) {
  const base = cdpHttpUrl.replace(/\/+$/, '');
  let res;
  try {
    res = await fetchImpl(`${base}/json/version`, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new JobSearchError('BROWSER_UNAVAILABLE', 'cannot reach the scan Chrome DevTools endpoint');
  }
  if (!res.ok) throw new JobSearchError('BROWSER_UNAVAILABLE', `scan Chrome /json/version returned HTTP ${res.status}`);
  const body = /** @type {any} */ (await res.json());
  if (!body || typeof body.webSocketDebuggerUrl !== 'string') throw new JobSearchError('BROWSER_UNAVAILABLE', 'scan Chrome did not report a browser WebSocket URL');
  return body.webSocketDebuggerUrl;
}

/**
 * Connect to the browser-level CDP socket. Either pass `cdpHttpUrl` (production: SCAN_CDP_URL) or
 * `wsUrl` directly (tests launching a throwaway headless Chrome).
 * @param {{ cdpHttpUrl?: string, wsUrl?: string, fetchImpl?: typeof fetch, WebSocketImpl?: any, timeoutMs?: number }} opts
 * @returns {Promise<CdpClient>}
 */
export async function connectCdp(opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const url = opts.wsUrl ?? await browserWsUrl(/** @type {string} */ (opts.cdpHttpUrl), fetchImpl);
  /** @type {any} */
  const ws = new WS(url);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new JobSearchError('BROWSER_UNAVAILABLE', 'CDP socket did not open')), 10000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(undefined); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new JobSearchError('BROWSER_UNAVAILABLE', 'CDP socket error')); }, { once: true });
  });
  let nextId = 1;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  let closed = false;
  ws.addEventListener('message', (/** @type {any} */ ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // protocol events: none are enabled, all ignored
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new JobSearchError('BROWSER_UNAVAILABLE', `CDP error: ${String(msg.error.message ?? 'unknown').slice(0, 200)}`));
    else p.resolve(msg.result ?? {});
  });
  ws.addEventListener('close', () => {
    closed = true;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new JobSearchError('BROWSER_UNAVAILABLE', 'CDP socket closed'));
    }
    pending.clear();
  });

  /** @type {CdpClient['send']} */
  function send(method, params = {}, sessionId) {
    if (closed) return Promise.reject(new JobSearchError('BROWSER_UNAVAILABLE', 'CDP socket closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new JobSearchError('BROWSER_UNAVAILABLE', `CDP ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  return {
    send,
    async listPageTargets() {
      const r = await send('Target.getTargets');
      return (r.targetInfos ?? []).filter((t) => t.type === 'page').map((t) => ({ targetId: t.targetId, type: t.type, url: t.url, title: t.title }));
    },
    async attach(targetId) {
      const r = await send('Target.attachToTarget', { targetId, flatten: true });
      if (!r.sessionId) throw new JobSearchError('BROWSER_UNAVAILABLE', 'attachToTarget returned no session');
      return r.sessionId;
    },
    async detach(sessionId) {
      try {
        await send('Target.detachFromTarget', { sessionId });
      } catch {
        /* already detached or socket gone: the tab is unaffected either way */
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * The set of live page target ids in the browser behind `cdpHttpUrl`, or null when the browser cannot be
 * reached (callers treat null as "unknown", never as "every tab is gone").
 * @param {string} cdpHttpUrl
 * @param {{ connect?: typeof connectCdp }} [deps]
 * @returns {Promise<Set<string>|null>}
 */
export async function livePageTargetIds(cdpHttpUrl, deps = {}) {
  const connect = deps.connect ?? connectCdp;
  let cdp;
  try {
    cdp = await connect({ cdpHttpUrl, timeoutMs: 5000 });
    const targets = await cdp.listPageTargets();
    return new Set(targets.map((t) => t.targetId));
  } catch {
    return null;
  } finally {
    cdp?.close();
  }
}
