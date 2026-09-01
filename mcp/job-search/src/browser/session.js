// @ts-check
/**
 * Browser session (spec section 4): CDP connect/disconnect against the
 * dedicated scan Chrome, page accounting, and the single page factory.
 *
 * Rules enforced here:
 *   - connectOverCDP(SCAN_CDP_URL) only; never launch, never the 9222 daily driver.
 *   - contexts()[0] of that profile is used as-is. Never context.close(),
 *     never browser.close(), never context.route(): the profile belongs to
 *     the operator, this process only borrows it.
 *   - attachPage() is the only page factory. It installs page.route that
 *     denies every non-GET request except the path-scoped POST exceptions,
 *     blocks images/fonts/media, hooks popups so they are tracked, and
 *     records the page for closing in `finally`.
 *   - Page-count reconciliation at the start of the next run closes
 *     leftovers a killed process left behind (pages whose URL carries our
 *     marker fragment).
 *   - An AbortSignal is threaded through; the run timeout aborts it.
 *
 * Apply pipeline slice 5 (amended spec, per-page route policy): `pages` is a
 * Map<Page, PagePolicy>, not a Set. `attachPage({mode:'scan'})` (the default,
 * unchanged) keeps the abort-all-non-GET policy above; `attachPage({mode:
 * 'apply', tenantHost, atsHosts, uploadHosts})` allows POST/PUT/PATCH only to
 * the tenant host, the ATS's own registered domain set (src/apply/ats-
 * detect.js's hostsForAts), the adapter's declared upload targets (S3/CDN
 * presigned upload hosts -- the amended spec's "upload allow-class"), and the
 * reCAPTCHA verification host (allowlisted so a live challenge's own POST
 * back to Google is never itself the thing that silently breaks a
 * legitimate apply flow; detection/never-solve stays in wall.js). A
 * popup/new page opened from a tracked page INHERITS the opener's policy --
 * a scan-opened popup stays locked down, an apply-opened popup keeps the
 * apply scope -- resolved via the real Playwright `page.opener()` async
 * method (this file's own `pages` Map is the lookup table); an untracked or
 * unresolvable opener defaults to the safe 'scan' policy, never 'apply'.
 * Every apply-mode denial is logged (`apply_route_denied`) and counted on
 * the page's own policy object (`blockedCount`), so a worker/adapter can
 * report how many requests its own run blocked.
 *
 * KNOWN LIMITATION (documented per the amended spec, not fixed by this
 * slice): `page.route` operates on HTTP(S) request/response traffic only --
 * it cannot intercept WebSocket (`wss://`) connections. A page that opens a
 * WebSocket for, e.g., a live-chat widget or a telemetry channel is
 * completely outside this policy's reach in EITHER mode, apply included.
 * This is a real gap for the apply-mode allowlist specifically (a scan page
 * has nothing sensitive to leak over a socket it should not have opened in
 * the first place; an apply page's WebSocket traffic is simply unpoliced).
 * See the PR body's "WebSocket route-policy gap" section for the full
 * write-up; the ship/no-ship call on this gap is the operator's, not this
 * code's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getEnv } from '../core/config.js';
import { JobSearchError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { POST_ALLOWED, hostMatches } from '../core/urlguard.js';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

/**
 * reCAPTCHA verification hosts allowlisted for apply-mode POST (amended spec: "Allowlist recaptcha hosts
 * (www.google.com/recaptcha, www.gstatic.com, recaptcha.net) in apply mode"). Path-scoped for
 * www.google.com/recaptcha.net (only the `/recaptcha/` verification endpoint, never the whole host --
 * google.com serves far more than recaptcha); gstatic is asset-only (script/style GET, already allowed by
 * the universal GET rule below) and is listed here only so a future non-GET gstatic call is not silently
 * refused without a deliberate code review of this list.
 * @param {string} host lowercase
 * @param {string} pathname
 */
function isRecaptchaAllowed(host, pathname) {
  if ((host === 'www.google.com' || host.endsWith('.google.com')) && pathname.startsWith('/recaptcha/')) return true;
  if (host === 'recaptcha.net' || host.endsWith('.recaptcha.net')) return true;
  if (host === 'www.gstatic.com' || host.endsWith('.gstatic.com')) return true;
  return false;
}

/**
 * @typedef {Object} PagePolicy
 * @property {'scan'|'apply'} mode
 * @property {string} [tenantHost] lowercase; required for mode 'apply'
 * @property {string[]} [atsHosts] additional hosts (the ATS's own registered domain set) allowed for
 *   non-GET, mode 'apply' only
 * @property {string[]} [uploadHosts] adapter-declared upload target hosts (S3/CDN presigned upload
 *   hosts), mode 'apply' only -- the amended spec's "upload allow-class"
 * @property {number} blockedCount mutated in place by the route handler; apply mode only (scan mode's
 *   denials are the normal, expected, high-volume case and are not separately counted here)
 */

/**
 * Build and validate a PagePolicy from attachPage's options. Total over `mode`: anything other than the
 * literal string 'apply' is 'scan' (the safe default), never a thrown error for an unrecognized mode --
 * but 'apply' with a missing/blank tenantHost DOES throw, since an apply page with no scope at all would
 * silently deny every non-GET request it makes, which looks identical to "working" until the adapter's
 * own submit step fails for a reason nothing surfaces clearly.
 * @param {{ mode?: string, tenantHost?: string, atsHosts?: string[], uploadHosts?: string[] }} o
 * @returns {PagePolicy}
 */
function buildPolicy(o) {
  if (o.mode !== 'apply') return { mode: 'scan', blockedCount: 0 };
  const tenantHost = typeof o.tenantHost === 'string' ? o.tenantHost.trim().toLowerCase() : '';
  if (!tenantHost) throw new JobSearchError('VALIDATION', 'attachPage({mode:"apply"}) requires a non-empty tenantHost');
  const atsHosts = Array.isArray(o.atsHosts) ? o.atsHosts.filter((h) => typeof h === 'string' && h).map((h) => h.toLowerCase()) : [];
  const uploadHosts = Array.isArray(o.uploadHosts) ? o.uploadHosts.filter((h) => typeof h === 'string' && h).map((h) => h.toLowerCase()) : [];
  return { mode: 'apply', tenantHost, atsHosts, uploadHosts, blockedCount: 0 };
}

/**
 * Decide whether a request may proceed. Pure, exported for tests: total
 * classification over (method, resourceType, url, policy).
 * @param {{ method: string, resourceType: string, url: string }} req
 * @param {PagePolicy} [policy] defaults to the scan policy (backward compatible with slice-4 callers)
 * @returns {{ allow: boolean, reason: string }}
 */
export function routeDecision(req, policy = { mode: 'scan', blockedCount: 0 }) {
  const method = String(req.method || 'GET').toUpperCase();
  if (BLOCKED_RESOURCE_TYPES.has(String(req.resourceType))) return { allow: false, reason: 'resource_blocked' };
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { allow: true, reason: 'read' };

  if (policy.mode === 'apply') {
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return { allow: false, reason: 'method_denied' };
    let u;
    try {
      u = new URL(req.url);
    } catch {
      return { allow: false, reason: 'bad_url' };
    }
    const host = u.hostname.toLowerCase();
    if (isRecaptchaAllowed(host, u.pathname)) return { allow: true, reason: 'recaptcha_allowed' };
    const scoped = [policy.tenantHost, ...(policy.atsHosts ?? []), ...(policy.uploadHosts ?? [])].filter(Boolean);
    if (scoped.some((h) => hostMatches(host, /** @type {string} */ (h)))) return { allow: true, reason: 'apply_scope' };
    return { allow: false, reason: 'apply_scope_denied' };
  }

  // scan mode (unchanged from pre-slice-5 behavior)
  if (method !== 'POST') return { allow: false, reason: 'method_denied' };
  let u;
  try {
    u = new URL(req.url);
  } catch {
    return { allow: false, reason: 'bad_url' };
  }
  const host = u.hostname.toLowerCase();
  for (const p of POST_ALLOWED) {
    const hostOk = (p.source === 'linkedin' && (host === 'linkedin.com' || host.endsWith('.linkedin.com')))
      || (p.source === 'workday' && host.endsWith('.myworkdayjobs.com'));
    if (hostOk && p.pattern.test(u.pathname)) return { allow: true, reason: 'post_exception' };
  }
  return { allow: false, reason: 'post_denied' };
}

/**
 * @typedef {Object} Session
 * @property {(opts?: { mode?: string, tenantHost?: string, atsHosts?: string[], uploadHosts?: string[], signal?: AbortSignal }) => Promise<import('playwright-core').Page>} attachPage
 * @property {() => Promise<number>} reconcile close leftover pages from a prior run (URL-fragment marker); returns count closed
 * @property {(markerFile: string) => Promise<void>} writeTargetMarker overwrite markerFile with this run's tracked pages' CDP target ids
 * @property {(markerFile: string) => Promise<{ attempted: number, closed: number }>} reconcileTargets close every target id recorded in markerFile from a prior run, by CDP target id (apply pipeline slice 5: SPA-navigation-safe, unlike the URL-fragment reconcile above)
 * @property {() => Promise<void>} closeAll close every page this session created, then disconnect
 * @property {() => number} openPages
 * @property {(page: import('playwright-core').Page) => PagePolicy|undefined} policyFor test/worker seam: read back a tracked page's policy (e.g. blockedCount)
 */

/** Marker appended to navigations so a later run can recognize our leftovers without reading page content. */
export const PAGE_MARKER = 'ic-job-search';

/**
 * Connect to the scan Chrome. Throws BROWSER_UNAVAILABLE when the CDP
 * endpoint is down so the run degrades to `partial`.
 * @param {{ cdpUrl?: string, timeoutMs?: number, chromium?: { connectOverCDP: (url: string, opts?: any) => Promise<any> } }} [opts]
 *   `chromium` is a test seam (apply pipeline slice 5): a fake object shaped like playwright-core's own
 *   `chromium` export, so session.js's internal arm/policy/popup-inheritance logic can be unit tested with
 *   in-memory fakes instead of a real CDP connection. Production callers never pass it; the default lazily
 *   imports the real playwright-core module exactly as before.
 * @returns {Promise<Session>}
 */
export async function connectSession(opts = {}) {
  const cdpUrl = opts.cdpUrl ?? getEnv().SCAN_CDP_URL;
  let chromium = opts.chromium;
  if (!chromium) {
    let playwright;
    try {
      playwright = await import('playwright-core');
    } catch {
      throw new JobSearchError('BROWSER_UNAVAILABLE', 'playwright-core is not installed');
    }
    chromium = playwright.chromium;
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: opts.timeoutMs ?? 10000 });
  } catch (err) {
    throw new JobSearchError('BROWSER_UNAVAILABLE', `cannot connect to scan Chrome at the configured SCAN_CDP_URL`, {
      hint: 'start the dedicated scan Chrome (bin/scan.js --launch-chrome) or check SCAN_CDP_URL',
    });
  }
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    await browser.disconnect();
    throw new JobSearchError('BROWSER_UNAVAILABLE', 'scan Chrome has no browser context');
  }
  const context = contexts[0];
  /** @type {Map<import('playwright-core').Page, PagePolicy>} */
  const pages = new Map();
  /** @type {Map<import('playwright-core').Page, string>} CDP targetId per tracked page, best-effort. */
  const targetIds = new Map();
  let disconnected = false;

  /**
   * CDP target id for a page (apply pipeline slice 5's marker-file mechanism, below). Best-effort: any
   * failure (an older CDP surface, a page that closed mid-lookup) returns null rather than throwing --
   * losing target-id tracking for one page degrades reconcileTargets() to "one fewer stale target closed
   * next run," never a hard failure of the run currently in progress.
   * @param {import('playwright-core').Page} page
   * @returns {Promise<string|null>}
   */
  async function lookupTargetId(page) {
    try {
      const cdp = await context.newCDPSession(page);
      const info = await cdp.send('Target.getTargetInfo');
      try {
        await cdp.detach();
      } catch {
        /* ignore */
      }
      return info && info.targetInfo && typeof info.targetInfo.targetId === 'string' ? info.targetInfo.targetId : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {import('playwright-core').Page} page
   * @param {PagePolicy} policy
   */
  async function arm(page, policy) {
    pages.set(page, policy);
    const id = await lookupTargetId(page);
    if (id) targetIds.set(page, id);
    page.on('close', () => {
      pages.delete(page);
      targetIds.delete(page);
    });
    await page.route('**/*', (route) => {
      const r = route.request();
      const d = routeDecision({ method: r.method(), resourceType: r.resourceType(), url: r.url() }, policy);
      if (d.allow) return route.continue();
      if (policy.mode === 'apply') {
        policy.blockedCount = (policy.blockedCount ?? 0) + 1;
        log.warn({ evt: 'apply_route_denied', reason: d.reason, method: r.method(), url: String(r.url()).slice(0, 200), tenant_host: policy.tenantHost ?? null, blocked_count: policy.blockedCount });
      }
      return route.abort('blockedbyclient');
    });
  }

  // Popups opened by any of our tracked pages inherit the OPENER'S OWN policy (scan stays scan, apply
  // keeps its tenant scope). Playwright's real Page.opener() is an async method; a fake test page may also
  // supply a plain property for the same purpose, so both shapes are tolerated. An opener that cannot be
  // resolved, or is not itself a tracked page, falls back to the 'scan' policy -- the safe default, never
  // 'apply' by inference.
  context.on('page', (p) => {
    if (pages.has(p)) return;
    (async () => {
      let opener = null;
      try {
        opener = typeof p.opener === 'function' ? await p.opener() : (p.opener ?? null);
      } catch {
        opener = null;
      }
      const inherited = opener && pages.has(opener) ? /** @type {PagePolicy} */ (pages.get(opener)) : { mode: /** @type {'scan'} */ ('scan'), blockedCount: 0 };
      await arm(p, inherited);
    })().catch(() => {});
  });

  /** @type {Session} */
  const session = {
    async attachPage(o = {}) {
      if (disconnected) throw new JobSearchError('BROWSER_UNAVAILABLE', 'session already closed');
      if (o.signal && o.signal.aborted) throw new JobSearchError('INTERNAL', 'run aborted');
      const policy = buildPolicy(o);
      const page = await context.newPage();
      await arm(page, policy);
      if (o.signal) o.signal.addEventListener('abort', () => { page.close().catch(() => {}); }, { once: true });
      log.info({ evt: 'page_attached', mode: policy.mode, open_pages: pages.size });
      return page;
    },
    async reconcile() {
      let closed = 0;
      for (const p of context.pages()) {
        let u = '';
        try {
          u = p.url();
        } catch {
          continue;
        }
        if (u.includes('#' + PAGE_MARKER)) {
          try {
            await p.close();
            closed++;
          } catch {
            /* already gone */
          }
        }
      }
      if (closed > 0) log.warn({ evt: 'pages_reconciled', closed });
      return closed;
    },
    /**
     * CDP target-id marker file (apply pipeline slice 5, amended spec: "no URL-hash markers -- ATS SPAs
     * rewrite URLs"). Overwrites `markerFile` with the CURRENT set of tracked pages' CDP target ids. A
     * page whose target-id lookup never resolved (lookupTargetId's own best-effort failure) is simply
     * absent from the written list -- not tracked, not reconciled next run, never a thrown error here.
     * @param {string} markerFile
     */
    async writeTargetMarker(markerFile) {
      try {
        fs.mkdirSync(path.dirname(markerFile), { recursive: true });
        fs.writeFileSync(markerFile, JSON.stringify({ target_ids: [...targetIds.values()] }));
      } catch (err) {
        log.warn({ evt: 'target_marker_write_failed', ...(err instanceof Error ? { err_message: err.message.slice(0, 300) } : {}) });
      }
    },
    /**
     * Close every target id recorded in `markerFile` from a PRIOR run (a killed process's own leftovers),
     * via a browser-level CDP session (Browser.newBrowserCDPSession()) so a target with no live Page
     * wrapper in THIS session can still be closed directly by id. Missing marker file, unparsable content,
     * an empty list, or any CDP failure are all treated as "nothing to reconcile" (0 closed) rather than
     * thrown -- this runs at the START of a scan or apply run, before any real work, and must never itself
     * block that work. Clears the marker file's own list to empty afterward so a target this call could
     * not find (already closed independently) is never retried on the next run.
     * @param {string} markerFile
     * @returns {Promise<{ attempted: number, closed: number }>}
     */
    async reconcileTargets(markerFile) {
      /** @type {string[]} */
      let ids = [];
      try {
        const raw = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        if (raw && Array.isArray(raw.target_ids)) ids = raw.target_ids.filter((x) => typeof x === 'string');
      } catch {
        return { attempted: 0, closed: 0 };
      }
      if (ids.length === 0) return { attempted: 0, closed: 0 };
      let cdpSession;
      try {
        cdpSession = await browser.newBrowserCDPSession();
      } catch (err) {
        log.warn({ evt: 'target_reconcile_cdp_session_failed', ...(err instanceof Error ? { err_message: err.message.slice(0, 300) } : {}) });
        return { attempted: ids.length, closed: 0 };
      }
      let closed = 0;
      for (const targetId of ids) {
        try {
          await cdpSession.send('Target.closeTarget', { targetId });
          closed++;
        } catch {
          /* already closed, or never existed -- both are the desired end state */
        }
      }
      try {
        await cdpSession.detach();
      } catch {
        /* ignore */
      }
      try {
        fs.writeFileSync(markerFile, JSON.stringify({ target_ids: [] }));
      } catch {
        /* best effort */
      }
      if (closed > 0) log.warn({ evt: 'targets_reconciled', attempted: ids.length, closed });
      return { attempted: ids.length, closed };
    },
    async closeAll() {
      for (const p of [...pages.keys()]) {
        try {
          await p.close();
        } catch {
          /* ignore */
        }
      }
      pages.clear();
      targetIds.clear();
      if (!disconnected) {
        disconnected = true;
        try {
          await browser.disconnect();
        } catch {
          /* ignore */
        }
      }
      log.info({ evt: 'session_closed' });
    },
    openPages() {
      return pages.size;
    },
    policyFor(page) {
      return pages.get(page);
    },
  };
  return session;
}
