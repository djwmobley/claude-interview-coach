// @ts-check
/**
 * Home tile for the target finder (plan 18.4, O5): new targets and new needs-review rows since the last digest,
 * the last run's status, and per-source coverage. Click-through goes to the Targets page. Counts and closed
 * codes only: no company name, excerpt or other source text ever reaches this tile.
 */
import { h } from '../lib/dom.js';
import { relativeTime } from '../lib/format.js';
import { runStatusChip, chipClassName } from './chips.js';

/** @param {any} s one source entry from the summary */
export function sourceLine(s) {
  const notes = [];
  if (s.reason) notes.push(String(s.reason));
  if (typeof s.backlog_days === 'number' && s.backlog_days > 0) notes.push(`backlog ${s.backlog_days}d`);
  return `${String(s.name)} ${String(s.status)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

/** @param {any} lastRun @returns {{ label: string, fg: string, bg: string, style: 'outline'|'filled' }} */
function runChip(lastRun) {
  if (lastRun && lastRun.status === 'skipped_locked') return { label: 'Skipped (busy)', fg: '--muted', bg: '--tag-bg', style: 'outline' };
  return runStatusChip({ status: lastRun ? String(lastRun.status) : 'unknown' });
}

/**
 * @param {{ summary: any }} opts the GET /api/targets/summary body
 */
export function targetsTile(opts) {
  const s = opts.summary;
  const lr = s.last_run;
  const sources = Array.isArray(s.sources) ? s.sources : [];
  const sinceText = s.since_basis === 'last_digest' ? 'since the last digest' : 'in the last 7 days';
  return h('section', { className: 'approval-section targets-tile' }, [
    h('h2', { className: 'approval-section__title', text: 'Targets' }),
    h('div', { className: 'targets-tile__row' }, [
      h('div', { className: 'tile' }, [h('div', { className: 'tile__value', text: String(s.new_targets ?? 0) }), h('div', { className: 'tile__label', text: `New targets ${sinceText}` })]),
      h('div', { className: 'tile' }, [h('div', { className: 'tile__value', text: String(s.new_needs_review ?? 0) }), h('div', { className: 'tile__label', text: `New needs-review ${sinceText}` })]),
      h('div', { className: 'tile' }, [
        h('div', { className: 'tile__value' }, [lr ? h('span', { className: chipClassName(runChip(lr)), text: runChip(lr).label }) : h('span', { text: 'never run' })]),
        h('div', { className: 'tile__label', text: lr ? `Last run ${relativeTime(lr.finished_at ?? lr.started_at)}` : 'Last run' }),
      ]),
    ]),
    sources.length
      ? h('p', { className: 'approval-section__note', text: sources.map(sourceLine).join(' | ') })
      : h('p', { className: 'approval-section__note', text: 'No per-source coverage recorded yet.' }),
    h('a', { hashHref: '#/targets', text: `Open Targets (${s.open?.targets ?? 0} targets, ${s.open?.needs_review ?? 0} needs review)` }),
  ]);
}
