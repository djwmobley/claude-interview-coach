// @ts-check
/**
 * Compact stage popover for a Jobs/Pipeline table row (plan: "stage popover, keys 1-0"). Reuses the same
 * DIGIT_STAGE_ORDER as components/stage-buttons.js so a digit key means the same stage everywhere.
 */
import { h } from '../lib/dom.js';
import { stageChip, chipClassName } from './chips.js';
import { DIGIT_STAGE_ORDER } from './stage-buttons.js';

/** @param {{ status: string|null, disabled: boolean, onSelect: (status: string) => void, onClose: () => void }} opts */
export function stagePopover(opts) {
  const items = DIGIT_STAGE_ORDER.map((status) => {
    const chip = stageChip(status);
    return h('button', {
      className: `stage-popover__item ${chipClassName(chip)}`,
      disabled: opts.disabled,
      attrs: { type: 'button' },
      on: { click: () => { opts.onSelect(status); opts.onClose(); } },
    }, [h('span', { text: chip.label })]);
  });
  return h('div', { className: 'stage-popover', attrs: { role: 'menu' } }, items);
}
