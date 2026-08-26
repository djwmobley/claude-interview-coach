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
 */
import { getEnv } from '../core/config.js';
import { JobSearchError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { POST_ALLOWED } from '../core/urlguard.js';

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

/**
 * Decide whether a request may proceed. Pure, exported for tests: total
 * classification over (method, resourceType, host, path).
 * @param {{ method: string, resourceType: string, url: string }} req
 * @returns {{ allow: boolean, reason: string }}
 */
export function routeDecision(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (BLOCKED_RESOURCE_TYPES.has(String(req.resourceType))) return { allow: false, reason: 'resource_blocked' };
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { allow: true, reason: 'read' };
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
 * @property {(opts?: { signal?: AbortSignal }) => Promise<import('playwright-core').Page>} attachPage
 * @property {() => Promise<number>} reconcile close leftover pages from a prior run; returns count closed
 * @property {() => Promise<void>} closeAll close every page this session created, then disconnect
 * @property {() => number} openPages
 */

/** Marker appended to navigations so a later run can recognize our leftovers without reading page content. */
export const PAGE_MARKER = 'ic-job-search';

/**
 * Connect to the scan Chrome. Throws BROWSER_UNAVAILABLE when the CDP
 * endpoint is down so the run degrades to `partial`.
 * @param {{ cdpUrl?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<Session>}
 */
export async function connectSession(opts = {}) {
  const cdpUrl = opts.cdpUrl ?? getEnv().SCAN_CDP_URL;
  let playwright;
  try {
    playwright = await import('playwright-core');
  } catch {
    throw new JobSearchError('BROWSER_UNAVAILABLE', 'playwright-core is not installed');
  }
  let browser;
  try {
    browser = await playwright.chromium.connectOverCDP(cdpUrl, { timeout: opts.timeoutMs ?? 10000 });
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
  /** @type {Set<import('playwright-core').Page>} */
  const pages = new Set();
  let disconnected = false;

  /** @param {import('playwright-core').Page} page */
  async function arm(page) {
    pages.add(page);
    page.on('close', () => pages.delete(page));
    await page.route('**/*', (route) => {
      const r = route.request();
      const d = routeDecision({ method: r.method(), resourceType: r.resourceType(), url: r.url() });
      if (d.allow) return route.continue();
      return route.abort('blockedbyclient');
    });
  }

  // Popups opened by any of our pages are attached and tracked too.
  context.on('page', (p) => {
    if (!pages.has(p) && p.opener && [...pages].some((x) => x === p.opener)) {
      arm(p).catch(() => {});
    }
  });

  /** @type {Session} */
  const session = {
    async attachPage(o = {}) {
      if (disconnected) throw new JobSearchError('BROWSER_UNAVAILABLE', 'session already closed');
      if (o.signal && o.signal.aborted) throw new JobSearchError('INTERNAL', 'run aborted');
      const page = await context.newPage();
      await arm(page);
      if (o.signal) o.signal.addEventListener('abort', () => { page.close().catch(() => {}); }, { once: true });
      log.info({ evt: 'page_attached', open_pages: pages.size });
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
    async closeAll() {
      for (const p of [...pages]) {
        try {
          await p.close();
        } catch {
          /* ignore */
        }
      }
      pages.clear();
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
  };
  return session;
}
