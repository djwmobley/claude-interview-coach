// @ts-check
/**
 * Scan progress panel (Home page's own scan-run detail, design "Scan pill states" heartbeat staleness
 * bucketing). Heartbeat staleness is computed client-side from `heartbeat_at` against wall-clock time on
 * every render tick.
 *
 * The topbar pill this file used to also export (`scanPill`) was replaced by
 * components/activity-pill.js's `activityPill()`, fed by GET /api/activity instead of GET
 * /api/scans/live -- see that file's own doc comment for why this one was not simply renamed instead of
 * split (pages/home.js still needs `scanProgressPanel`/`heartbeatBucket` from here).
 */
import { h } from '../lib/dom.js';

/** @param {string|null} heartbeatAt @param {Date} [now] */
export function heartbeatBucket(heartbeatAt, now = new Date()) {
  if (!heartbeatAt) return 'unknown';
  const ageMs = now.getTime() - new Date(heartbeatAt).getTime();
  if (ageMs > 90000) return 'stale-red';
  if (ageMs > 30000) return 'stale-yellow';
  return 'fresh';
}

/**
 * @param {{ run: any }} opts
 */
export function scanProgressPanel(opts) {
  const run = opts.run;
  if (!run) return h('p', { className: 'scan-progress__idle', text: 'No scan in progress.' });
  const started = run.started_at ? new Date(run.started_at) : null;
  const elapsedSec = started ? Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000)) : 0;
  const sources = Object.entries(run.pages_by_source ?? {});
  return h('div', { className: 'scan-progress' }, [
    h('div', { className: 'scan-progress__elapsed', text: `Elapsed ${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s` }),
    h('div', { className: 'scan-progress__sources' }, sources.length
      ? sources.map(([source, pages]) => h('div', { className: 'scan-progress__source' }, [
          h('span', { className: 'scan-progress__source-name', text: source }),
          h('span', { className: 'scan-progress__source-pages', text: `${pages} pages` }),
        ]))
      : [h('p', { className: 'scan-progress__none', text: 'No source activity reported yet.' })]),
    Array.isArray(run.errors) && run.errors.length
      ? h('div', { className: 'scan-progress__errors' }, run.errors.map((e) => h('span', { className: 'badge badge--error', text: e.code ?? 'error' })))
      : null,
  ]);
}
