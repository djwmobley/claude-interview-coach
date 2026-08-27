// @ts-check
/**
 * Ten-plus-two stage buttons for Job detail (plan "Job detail", pr3-spec-decisions.md section 8.5). The
 * digit order (1-0 mapping to new..skip) is fixed here as the single source of truth the keyboard handler
 * in app.js also reads. `dead` and `review` are reachable only through the "More stages" control, never a
 * bare digit key. Disabled per section 9 item 18: `listing.duplicate_of != null`, never the presence of
 * the `duplicates` array (which means this row is a dedup root with children and stays enabled).
 */
import { h } from '../lib/dom.js';
import { stageChip, chipClassName } from './chips.js';

/** Digit-key order (index 0 = key "1" ... index 9 = key "0"), the plan's fixed decision. */
export const DIGIT_STAGE_ORDER = Object.freeze([
  'new', 'maybe', 'shortlisted', 'applied', 'interviewing', 'offer', 'accepted', 'passed', 'lost', 'skip',
]);

/** Statuses reachable only via "More stages", never a bare digit key. */
export const MORE_STAGES = Object.freeze(['dead', 'review']);

const TOOLTIPS = Object.freeze({
  passed: 'Passed: you declined or withdrew',
  lost: 'Lost: employer declined, went silent, or the role closed',
  dead: 'Dead: expired or removed before any action',
  skip: 'Skip: not relevant, never pursued',
  review: 'Review: dedup review pending, resolved on the Review page',
  accepted: 'Accepted: offer accepted',
});

/**
 * @param {{ status: string|null, disabled: boolean, onSelect: (status: string) => void }} opts
 */
export function stageButtons(opts) {
  const makeBtn = (status, digitLabel) => {
    const chip = stageChip(status);
    const active = opts.status === status;
    const btn = h('button', {
      className: `stage-btn ${chipClassName(chip)} ${active ? 'stage-btn--active' : ''}`.trim(),
      disabled: opts.disabled,
      attrs: {
        type: 'button',
        title: opts.disabled ? 'Stage controls are disabled on duplicate rows.' : (TOOLTIPS[status] ?? chip.label),
        'aria-pressed': String(active),
      },
      on: { click: () => { if (!opts.disabled) opts.onSelect(status); } },
    }, [
      digitLabel ? h('span', { className: 'stage-btn__digit', text: digitLabel }) : null,
      h('span', { className: 'stage-btn__label', text: chip.label }),
    ]);
    return btn;
  };

  const digitButtons = DIGIT_STAGE_ORDER.map((status, i) => makeBtn(status, String((i + 1) % 10)));

  const moreStages = h('details', { className: 'stage-more' }, [
    h('summary', { text: 'More stages' }),
    h('div', { className: 'stage-more__list' }, MORE_STAGES.map((status) => makeBtn(status, null))),
  ]);

  return h('div', { className: 'stage-buttons' }, [
    h('div', { className: 'stage-buttons__grid' }, digitButtons),
    moreStages,
  ]);
}
