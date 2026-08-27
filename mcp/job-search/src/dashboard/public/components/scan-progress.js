// @ts-check
/**
 * Scan pill and progress panel (design "Scan pill states": idle green, running accent pulse, heartbeat
 * stale >30s yellow, >90s red, canceling muted). Heartbeat staleness is computed client-side from
 * `heartbeat_at` against wall-clock time on every render tick.
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
 * @param {{ running: boolean, run: any|null, canceling?: boolean }} opts
 */
export function scanPill(opts) {
  if (opts.canceling) return h('span', { className: 'scan-pill scan-pill--canceling', text: 'Canceling' });
  if (!opts.running || !opts.run) return h('span', { className: 'scan-pill scan-pill--idle', text: 'Idle' });
  const bucket = heartbeatBucket(opts.run.heartbeat_at);
  const cls = bucket === 'stale-red' ? 'scan-pill--stale-red' : bucket === 'stale-yellow' ? 'scan-pill--stale-yellow' : 'scan-pill--running';
  return h('span', { className: `scan-pill ${cls}`, text: 'Running' });
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
