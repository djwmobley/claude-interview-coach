// @ts-check
/**
 * One Jobs-table row (design "Jobs table" 8-column layout: checkbox, title, company, source, stage,
 * score, first seen, location). The title links out only when `url_ok` (section 2); the row itself
 * navigates to Job detail on click/Enter, matching the `j`/`k`/Enter row-nav keyboard rule.
 */
import { h, hLink } from '../lib/dom.js';
import { stageChip, chipClassName, sourceChip } from './chips.js';
import { scoreBucket } from '../lib/format.js';

/**
 * @param {any} row a GET /api/listings row (carries url_ok)
 * @param {{ selected: boolean, onToggleSelect: (id: number) => void, onOpen: (id: number) => void }} opts
 */
export function jobRow(row, opts) {
  const chip = stageChip(row.status);
  const src = sourceChip(row.source);
  const scoreCls = `score score--${scoreBucket(row.prescore)}`;
  const tr = h('tr', {
    className: 'job-row',
    dataset: { rowId: row.id },
    attrs: { tabindex: '0', role: 'row', 'aria-selected': String(opts.selected) },
    on: {
      click: (ev) => {
        if (/** @type {HTMLElement} */ (ev.target).closest('.job-row__checkbox')) return;
        opts.onOpen(row.id);
      },
      keydown: (ev) => {
        if (ev.key === 'Enter') opts.onOpen(row.id);
      },
    },
  }, [
    h('td', { className: 'job-row__checkbox' }, [
      h('input', { attrs: { type: 'checkbox' }, checked: opts.selected, on: { change: () => opts.onToggleSelect(row.id) } }),
    ]),
    h('td', { className: 'job-row__title' }, [
      hLink({ url: row.url_normalized ?? row.url, urlOk: row.url_ok === true, text: row.title ?? 'untitled', target: '_blank' }),
      row.record_kind === 'manual' ? h('span', { className: 'badge badge--manual', text: 'Manual' }) : null,
      row.duplicate_of != null ? h('span', { className: 'badge badge--dup', text: 'DUP' }) : null,
    ]),
    h('td', { className: 'job-row__company', text: row.company ?? 'unknown company' }),
    h('td', { className: 'job-row__source' }, [h('span', { className: chipClassName(src), text: src.label })]),
    h('td', { className: 'job-row__stage' }, [h('span', { className: chipClassName(chip), text: chip.label })]),
    h('td', { className: scoreCls, text: row.prescore != null ? String(row.prescore) : 'not scored' }),
    h('td', { className: 'job-row__first-seen', text: row.first_seen ? new Date(row.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'not set' }),
    h('td', { className: 'job-row__location', text: row.location ?? 'not listed' }),
  ]);
  return tr;
}
