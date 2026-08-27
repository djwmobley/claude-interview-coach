// @ts-check
/**
 * Home's six-tile status strip (plan/design density rule: six numbers above the fold). Reflows 3x2 at
 * the 900-1180 breakpoint via CSS grid, not JS.
 */
import { h } from '../lib/dom.js';
import { relativeTime } from '../lib/format.js';

/** @param {{ summary: any }} opts */
export function statusStrip(opts) {
  const s = opts.summary;
  const lastRun = s.last_run;
  const nextScan = s.next_scheduled_scan;
  const disabledCount = Array.isArray(s.disabled_sources) ? s.disabled_sources.length : 0;
  const tiles = [
    { label: 'Last scan', value: lastRun ? relativeTime(lastRun.finished_at ?? lastRun.started_at) : 'never run' },
    { label: 'Next scan', value: nextScan && nextScan.next_run ? relativeTime(nextScan.next_run) : nextScanReasonLabel(nextScan) },
    { label: 'Sources disabled', value: String(disabledCount) },
    { label: 'Review queue', value: String(s.open_review ?? 0) },
    { label: 'Follow-ups due', value: String((s.followups?.overdue ?? 0) + (s.followups?.today ?? 0)) },
    { label: 'Untriaged', value: String(s.pipeline?.untriaged ?? 0) },
  ];
  return h('div', { className: 'tile-row' }, tiles.map((t) => h('div', { className: 'tile' }, [
    h('div', { className: 'tile__value', text: t.value }),
    h('div', { className: 'tile__label', text: t.label }),
  ])));
}

/** Section 9 item 11: branch on `reason !== null`, never print the raw reason string. @param {{next_run:string|null, reason:string|null}|null|undefined} nextScan */
function nextScanReasonLabel(nextScan) {
  if (!nextScan || nextScan.reason === null || nextScan.reason === undefined) return 'not scheduled';
  const table = {
    not_registered_or_unavailable: 'task not registered',
    unparseable: 'schedule not readable',
    error: 'schedule check failed',
  };
  return table[nextScan.reason] ?? 'not scheduled';
}
