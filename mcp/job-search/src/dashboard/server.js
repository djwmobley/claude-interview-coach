// @ts-check
/**
 * Dashboard HTTP server assembly (dashboard PR 2, plan "Server" section). Never imports src/server.js or
 * src/core/stdout-hygiene.js (plan constraint) -- everything this file needs comes from src/core/* helper
 * modules that are already safe for a second, non-MCP process to import.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRouter } from './router.js';
import { createStreamHub, registerStreamRoute } from './stream.js';
import { checkConfigLock } from '../core/config.js';
import { checkHost, checkContentType, checkOrigin, readJsonBody, applyBaseHeaders, sendJson, mapError, newRequestId, MAX_BODY_BYTES } from './http.js';
import { register as registerSummary } from './routes/summary.js';
import { register as registerListings } from './routes/listings.js';
import { register as registerFollowups } from './routes/followups.js';
import { register as registerReview } from './routes/review.js';
import { register as registerScans } from './routes/scans.js';
import { register as registerReport } from './routes/report.js';
import { register as registerCalendar } from './routes/calendar.js';
import { register as registerDocuments } from './routes/documents.js';
import { register as registerMemory } from './routes/memory.js';
import { register as registerAnalytics } from './routes/analytics.js';
import { register as registerSources } from './routes/sources.js';

/**
 * @typedef {Object} RouteContext
 * @property {Record<string, string>} params
 * @property {Record<string, string>} query
 * @property {any} body
 * @property {DashboardDeps} deps
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {string} requestId
 */

/**
 * @typedef {Object} DashboardDeps
 * @property {<T>(fn: (c: import('pg').PoolClient) => Promise<T>) => Promise<T>} withClient
 * @property {import('../core/config.js').LoadedConfig|null} config
 * @property {import('../core/config.js').Env} env
 * @property {(() => Promise<import('../core/followups.js').CalendarDeps|null>)|null} calendar
 * @property {ReturnType<typeof import('./calendar-cache.js').createCalendarCache>} calendarCache
 * @property {ReturnType<typeof import('./scan-runner.js').createScanRunner>} scanRunner
 * @property {string} outputRoot absolute path to output/
 * @property {typeof fetch} [fetch]
 * @property {string} [version]
 * @property {string} [startedAt] ISO, set once at process start
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 */

const STATIC_EXTS = Object.freeze({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' });

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} publicRoot
 * @param {string} pathname
 * @param {string} method
 */
function serveStatic(res, publicRoot, pathname, method) {
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'method not allowed; use GET, HEAD', hint: null, details: {} });
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const rootReal = path.resolve(publicRoot);
  const target = path.normalize(path.join(rootReal, rel));
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'not found', hint: null, details: {} });
  }
  /** @type {Buffer} */
  let data;
  try {
    data = fs.readFileSync(target);
  } catch {
    return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'not found', hint: null, details: {} });
  }
  const contentType = STATIC_EXTS[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  if (method === 'HEAD') return res.end();
  res.end(data);
}

/** Send a guard-check failure ({ ok, status, code, message }) as the standard JSON error envelope. */
function sendGuardFailure(res, check) {
  return sendJson(res, check.status, { ok: false, code: check.code, message: check.message, hint: null, details: {} });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ReturnType<typeof createRouter>} router
 * @param {DashboardDeps} deps
 * @param {string} publicRoot
 */
async function handleRequest(req, res, router, deps, publicRoot) {
  const requestId = newRequestId();
  const method = (req.method ?? 'GET').toUpperCase();
  try {
    const url = new URL(req.url ?? '/', 'http://internal.invalid');
    const pathname = url.pathname;
    applyBaseHeaders(res, pathname);

    const hostCheck = checkHost(req);
    if (!hostCheck.ok) return sendGuardFailure(res, hostCheck);

    if (!pathname.startsWith('/api/')) {
      return serveStatic(res, publicRoot, pathname, method);
    }

    const found = router.dispatch(pathname, method);
    if (found === null) return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'not found', hint: null, details: {} });
    if ('notAllowed' in found) {
      res.setHeader('Allow', found.allow.join(', '));
      return sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: `method not allowed; use ${found.allow.join(', ')}`, hint: null, details: {} });
    }

    /** @type {any} */
    let body = {};
    const query = Object.fromEntries(url.searchParams);
    if (method !== 'GET' && method !== 'HEAD') {
      const ctCheck = checkContentType(req);
      if (!ctCheck.ok) return sendGuardFailure(res, ctCheck);
      const originCheck = checkOrigin(req);
      if (!originCheck.ok) return sendGuardFailure(res, originCheck);
      body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES, allowEmpty: found.route.allowEmptyBody });
    }

    if (found.headOnly) {
      // HEAD on a GET route: run the handler for its side-effect-free header/status logic, but swallow
      // any body it writes (rule: "HEAD on GET routes returns headers only").
      res.write = () => true;
      const originalEnd = res.end.bind(res);
      res.end = /** @type {any} */ ((...args) => {
        const cb = args.find((a) => typeof a === 'function');
        return originalEnd(cb);
      });
    }

    const ctx = { params: found.params, query, body, deps, req, res, requestId };
    await found.route.handler(ctx);
  } catch (err) {
    const { status, body: errBody } = mapError(err, requestId);
    if (!res.headersSent) {
      if (status === 413) {
        // The body reader keeps draining without storing anything past the cap (see http.js), so the
        // connection is still mid-stream on this socket; force it closed once the 413 response is fully
        // written rather than leaving it in an ambiguous keep-alive state with an unread remainder.
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
      }
      sendJson(res, status, errBody);
    } else {
      try {
        res.end();
      } catch {
        /* connection already gone */
      }
    }
  }
}

/**
 * @param {DashboardDeps} deps
 * @param {{ publicRoot?: string }} [opts]
 */
export function createDashboardServer(deps, opts = {}) {
  const router = createRouter();
  const streamHub = createStreamHub(deps);
  const publicRoot = opts.publicRoot ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'public');

  router.register('GET', '/api/health', async (ctx) => {
    const d = ctx.deps;
    let dbOk = false;
    try {
      await d.withClient((c) => c.query('SELECT 1'));
      dbOk = true;
    } catch {
      dbOk = false;
    }
    let configLockOk = null;
    try {
      configLockOk = checkConfigLock().ok;
    } catch {
      configLockOk = null;
    }
    let calendarOk = false;
    try {
      calendarOk = Boolean(d.calendar && (await d.calendar()));
    } catch {
      calendarOk = false;
    }
    sendJson(ctx.res, 200, {
      ok: true,
      service: 'job-search-dashboard',
      version: d.version ?? '0.1.0',
      pid: process.pid,
      startedAt: d.startedAt ?? null,
      db_ok: dbOk,
      config_lock_ok: configLockOk,
      calendar_ok: calendarOk,
      banner: Array.isArray(/** @type {any} */ (d).healthBanner) ? /** @type {any} */ (d).healthBanner : [],
    });
  });

  registerSummary(router, deps);
  registerListings(router, deps, streamHub);
  registerFollowups(router, deps, streamHub);
  registerReview(router, deps, streamHub);
  registerScans(router, deps);
  registerReport(router, deps);
  registerCalendar(router, deps);
  registerDocuments(router, deps);
  registerMemory(router, deps);
  registerAnalytics(router, deps);
  registerSources(router, deps);
  registerStreamRoute(router, streamHub);

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res, router, deps, publicRoot).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'internal error' });
        else res.end();
      } catch {
        /* connection already gone */
      }
    });
  });

  return {
    server: httpServer,
    router,
    streamHub,
    /**
     * @param {number} port
     * @param {string} [host]
     */
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (/** @type {Error} */ err) => reject(err);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.removeListener('error', onError);
          resolve(httpServer.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        streamHub.stopAll();
        httpServer.close(() => resolve(undefined));
      });
    },
  };
}
