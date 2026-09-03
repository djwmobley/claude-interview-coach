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
 * Fit can render as its own neutral bucket instead of borrowing Prescore's "missing reads as low" default,
 * which would otherwise make every untriaged listing look like it scored poorly rather than simply not
 * having been looked at yet.
 *
 * Unscored label totality (jobs-unscored-visibility PR, Change 3): a null Fit is no longer a single
 * "not scored" catch-all. lib/format.js's fitDisplayState() classifies WHY it is unscored ('noise',
 * 'pending review', or 'below floor') and this row only renders that label -- see fitDisplayState()'s
 * own doc comment for the total classification. All three sub-labels still share the same neutral
 * 'not-scored' CSS bucket/color; only the text differs.
 */
import { h, hLink } from '../lib/dom.js';
import { stageChip, chipClassName, sourceChip } from './chips.js';
import { scoreBucket, fitDisplayState, applyButtonState } from '../lib/format.js';

export const PRESCORE_TITLE = 'Prescore: deterministic keyword/profile/location/salary score times a noise multiplier, computed at scan time.';
export const FIT_TITLE = 'Fit: judgment score set by you or an agent, empty until triaged.';

/**
 * @param {any} row a GET /api/listings row (carries url_ok)
 * @param {{ selected: boolean, onToggleSelect: (id: number) => void, onOpen: (id: number) => void, onApplyNow: (id: number) => void, triageBand?: { floor: number, ceiling: number }|null }} opts
 *   triageBand (jobs-unscored-visibility PR, Change 3): the dashboard's own triage floor/ceiling, from
 *   GET /api/listings' `triage` field, threaded through by pages/jobs.js -- see lib/format.js's
 *   fitDisplayState() for how it is used. onApplyNow (one-click apply PR A spec item 8): POST
 *   /api/listings/:id/apply-now, wired by pages/jobs.js -- this component only renders the button and
 *   delegates the click, matching onOpen/onToggleSelect's own pattern.
 */
export function jobRow(row, opts) {
  const chip = stageChip(row.status);
  const src = sourceChip(row.source);
  const prescoreCls = `score score--${scoreBucket(row.prescore)}`;
  const fitState = fitDisplayState(row, opts.triageBand);
  const fitCls = `score score--${fitState.bucket}`;
  const applyState = applyButtonState(row);
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
      // The flex layout lives on this inner div, not the <td> itself: a `display: flex` directly on a
      // table cell stops it being a real table-cell box (the browser wraps it in an anonymous cell),
      // which breaks the cell's own vertical-align and lets sibling cells in wrapped-title rows misalign
      // (dashboard layout-stability fix). Keeping the <td> a plain table-cell and pushing the flex row
      // into `.job-row__title-flex` restores normal cell behavior while keeping the link+badges layout.
      h('div', { className: 'job-row__title-flex' }, [
        hLink({ url: row.url_normalized ?? row.url, urlOk: row.url_ok === true, text: row.title ?? 'untitled', target: '_blank' }),
        row.record_kind === 'manual' ? h('span', { className: 'badge badge--manual', text: 'Manual' }) : null,
        row.duplicate_of != null ? h('span', { className: 'badge badge--dup', text: 'DUP' }) : null,
      ]),
    ]),
    h('td', { className: 'job-row__company', text: row.company ?? 'unknown company' }),
    h('td', { className: 'job-row__source' }, [h('span', { className: chipClassName(src), text: src.label })]),
    h('td', { className: 'job-row__stage' }, [h('span', { className: chipClassName(chip), text: chip.label })]),
    h('td', { className: `job-row__prescore ${prescoreCls}`, attrs: { title: PRESCORE_TITLE }, text: row.prescore != null ? String(row.prescore) : 'not scored' }),
    h('td', { className: `job-row__fit ${fitCls}`, attrs: { title: FIT_TITLE }, text: fitState.label }),
    h('td', { className: 'job-row__first-seen', text: row.first_seen ? new Date(row.first_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'not set' }),
    h('td', { className: 'job-row__location', text: row.location ?? 'not listed' }),
    h('td', { className: 'job-row__apply' }, [
      applyState === null ? null
        : applyState.actionable
          ? h('button', {
            className: 'btn btn--small', attrs: { type: 'button' }, text: applyState.label,
            on: { click: (ev) => { ev.stopPropagation(); opts.onApplyNow(row.id); } },
          })
          : h('span', { className: 'job-row__apply-status', text: applyState.label }),
    ]),
  ]);
  return tr;
}
