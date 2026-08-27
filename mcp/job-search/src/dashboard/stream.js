// @ts-check
/**
 * SSE hub (dashboard PR 2, plan "Live updates" + pr2-spec-decisions.md "SSE"). One process-wide timer
 * set fans out to a bounded Set of live responses: cap 16 concurrent streams, 503 beyond that. Watermarks
 * are the max `id` of ic_job_events and ic_followups, never a timestamp column (the seed writes backdated
 * `at` values by design, so a timestamp watermark would miss or re-fire on seeded rows).
 */
import { log } from '../core/logger.js';
import { errFields } from '../core/errors.js';
import { DashboardError } from './http.js';

export const MAX_STREAMS = 16;
const DEFAULT_PING_MS = 25000;
const DEFAULT_WATERMARK_MS = 10000;
const DEFAULT_RUN_POLL_MS = 2000;

/**
 * @param {{ withClient: <T>(fn: (c: import('pg').PoolClient) => Promise<T>) => Promise<T>, scanRunner?: { status: () => { running: boolean, runId: number|null } } }} deps
 * @param {{ pingMs?: number, watermarkMs?: number, runPollMs?: number }} [opts]
 */
export function createStreamHub(deps, opts = {}) {
  const pingMs = opts.pingMs ?? DEFAULT_PING_MS;
  const watermarkMs = opts.watermarkMs ?? DEFAULT_WATERMARK_MS;
  const runPollMs = opts.runPollMs ?? DEFAULT_RUN_POLL_MS;

  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();
  let eventsWatermark = -1;
  let followupsWatermark = -1;
  /** @type {string|null} */
  let lastRunSnapshot = null;

  /** @param {import('node:http').ServerResponse} res */
  function remove(res) {
    if (!streams.has(res)) return;
    streams.delete(res);
    try {
      res.end();
    } catch {
      /* already gone */
    }
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string} event
   * @param {unknown} data
   */
  function write(res, event, data) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // A write failure removes that stream and never propagates to the caller.
      remove(res);
    }
  }

  /**
   * @param {string} event
   * @param {unknown} data
   */
  function broadcast(event, data) {
    for (const res of [...streams]) write(res, event, data);
  }

  async function pollRun() {
    if (streams.size === 0 || !deps.scanRunner) return;
    try {
      const status = deps.scanRunner.status();
      if (!status.running || status.runId == null) {
        lastRunSnapshot = null;
        return;
      }
      const r = await deps.withClient((c) => c.query('SELECT id, status, stats, heartbeat_at, pages_by_source FROM ic_scan_runs WHERE id = $1', [status.runId]));
      if (r.rowCount === 0) return;
      const snap = JSON.stringify(r.rows[0]);
      if (snap !== lastRunSnapshot) {
        lastRunSnapshot = snap;
        broadcast('run', { ...r.rows[0], id: Number(r.rows[0].id) });
      }
    } catch (err) {
      log.warn({ evt: 'dashboard_stream_run_poll_failed', ...errFields(err) });
    }
  }

  async function pollWatermark() {
    if (streams.size === 0) return;
    try {
      const r = await deps.withClient((c) => c.query(
        `SELECT (SELECT coalesce(max(id),0) FROM ic_job_events) AS events_max, (SELECT coalesce(max(id),0) FROM ic_followups) AS followups_max`,
      ));
      const eventsMax = Number(r.rows[0].events_max);
      const followupsMax = Number(r.rows[0].followups_max);
      if (eventsWatermark === -1) eventsWatermark = eventsMax;
      if (followupsWatermark === -1) followupsWatermark = followupsMax;
      if (eventsMax > eventsWatermark) {
        eventsWatermark = eventsMax;
        broadcast('changed', { kind: 'events' });
      }
      if (followupsMax > followupsWatermark) {
        followupsWatermark = followupsMax;
        broadcast('changed', { kind: 'followups' });
      }
    } catch (err) {
      log.warn({ evt: 'dashboard_stream_watermark_failed', ...errFields(err) });
    }
  }

  function pingAll() {
    broadcast('ping', { t: Date.now() });
  }

  const timers = [setInterval(pollRun, runPollMs), setInterval(pollWatermark, watermarkMs), setInterval(pingAll, pingMs)];
  for (const t of timers) t.unref?.();

  /** Called by mutating routes right after a successful write (kind: 'events'|'followups'). */
  function notifyChanged(kind) {
    broadcast('changed', { kind });
  }

  /**
   * Register close/error handlers BEFORE joining the set (decision: rule 3), then add. Returns whether
   * the stream was accepted; caller must check capacity before writing SSE headers.
   * @param {import('node:http').ServerResponse} res
   * @returns {boolean}
   */
  function addStream(res) {
    if (streams.size >= MAX_STREAMS) return false;
    res.on('close', () => remove(res));
    res.on('error', () => remove(res));
    streams.add(res);
    return true;
  }

  function stopAll() {
    for (const t of timers) clearInterval(t);
    for (const res of [...streams]) remove(res);
  }

  return { addStream, notifyChanged, stopAll, size: () => streams.size };
}

/**
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {ReturnType<typeof createStreamHub>} hub
 */
export function registerStreamRoute(router, hub) {
  router.register('GET', '/api/stream', async (ctx) => {
    const { res } = ctx;
    if (hub.size() >= MAX_STREAMS) {
      throw new DashboardError(503, 'STREAM_CAPACITY', 'too many concurrent live streams');
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const jitter = Math.floor(Math.random() * 2000);
    res.write(`retry: ${3000 + jitter}\n\n`);
    hub.addStream(res);
  }, { allowEmptyBody: true });
}
