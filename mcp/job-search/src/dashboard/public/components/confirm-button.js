// @ts-check
/**
 * Two-step confirm button (pr3-spec-decisions.md section 7.1, design "component states"). Confirm-armed
 * state lives only on the button's own DOM node (a WeakMap keyed by element), never in a global store, so
 * a hash-route change that tears down and rebuilds the page naturally disarms any confirm in progress.
 */
import { h } from '../lib/dom.js';

/** @type {WeakMap<HTMLElement, number>} */
const armedTimers = new WeakMap();

/**
 * @param {{ label: string, confirmLabel: string, className?: string, onConfirm: () => void, disabled?: boolean, revertMs?: number }} opts
 */
export function confirmButton(opts) {
  const revertMs = opts.revertMs ?? 5000;
  const btn = h('button', {
    className: `btn ${opts.className ?? ''}`.trim(),
    disabled: Boolean(opts.disabled),
    attrs: { type: 'button' },
    text: opts.label,
    on: {
      click: () => {
        const armed = armedTimers.has(btn);
        if (armed) {
          const t = armedTimers.get(btn);
          if (t) clearTimeout(t);
          armedTimers.delete(btn);
          btn.textContent = opts.label;
          btn.classList.remove('btn--confirming');
          opts.onConfirm();
          return;
        }
        btn.textContent = opts.confirmLabel;
        btn.classList.add('btn--confirming');
        const timer = setTimeout(() => {
          armedTimers.delete(btn);
          btn.textContent = opts.label;
          btn.classList.remove('btn--confirming');
        }, revertMs);
        armedTimers.set(btn, /** @type {any} */ (timer));
      },
    },
  });
  return btn;
}
