// @ts-check
/**
 * One Jobs-table row (9-column layout: checkbox, title, company, source, stage, prescore, fit, first
 * seen, location). The title links out only when `url_ok` (section 2); the row itself navigates to Job
 * detail on click/Enter, matching the `j`/`k`/Enter row-nav keyboard rule.
 *
 * Score clarity (dashboard UX slice 2): the old single "Score" column conflated two different numbers --
 * Prescore (a deterministic keyword/profile/location/salary score times a noise multiplier, computed at
 * scan time, never null in practice) and Fit (a judgment score a person or agent sets later, null until
 * triaged). Splitting them into their own columns, each with an explanatory `title` tooltip, means a null
 * Fit can render as its own neutral "not scored" bucket (fitBucket()) instead of borrowing Prescore's
 * "missing reads as low" default, which would otherwise make every untriaged listing look like it scored
 * poorly rather than simply not having been looked at yet.
 */
import { h, hLink } from '../lib/dom.js';
import { stageChip, chipClassName, sourceChip } from './chips.js';
import { scoreBucket, fitBucket } from '../lib/format.js';

export const PRESCORE_TITLE = 'Prescore: deterministic keyword/profile/location/salary score times a noise multiplier, computed at scan time.';
export const FIT_TITLE = 'Fit: judgment score set by you or an agent, empty until triaged.';

/**
 * @param {any} row a GET /api/listings row (carries url_ok)
 * @param {{ selected: boolean, onToggleSelect: (id: number) => void, onOpen: (id: number) => void }} opts
 */
export function jobRow(row, opts) {
  const chip = stageChip(row.status);
  const src = sourceChip(row.source);
  const prescoreCls = `score score--${scoreBucket(row.prescore)}`;
  const fitCls = `score score--${fitBucket(row.fit_score)}`;
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
    h('td', { className: `job-row__prescore ${prescoreCls}`, attrs: { title: PRESCORE_TITLE }, text: row.prescore != null ? String(row.prescore) : 'not scored' }),
    h('td', { className: `job-row__fit ${fitCls}`, attrs: { title: FIT_TITLE }, text: row.fit_score != null ? String(row.fit_score) : 'not scored' }),
    h('td', { className: 'job-row__first-seen', text: row.first_seen ? new Date(row.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'not set' }),
    h('td', { className: 'job-row__location', text: row.location ?? 'not listed' }),
  ]);
  return tr;
}
