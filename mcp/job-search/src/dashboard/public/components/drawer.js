// @ts-check
/**
 * Slide-over drawer shell (Add opportunity, New follow-up, Add moment, Add event). Independent review
 * comment on PR #6 (second re-review): Escape closes it, focus is trapped inside the panel while open,
 * and focus returns to whichever control opened the drawer once it closes.
 */
import { h } from '../lib/dom.js';

/** @param {HTMLElement} panel */
function focusableEls(panel) {
  return [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]')]
    .filter((el) => !(/** @type {any} */ (el).disabled) && /** @type {HTMLElement} */ (el).tabIndex !== -1);
}

/**
 * @param {{ title: string, body: Node[], onClose?: () => void, panelClass?: string }} opts
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function drawer(opts) {
  const previouslyFocused = /** @type {HTMLElement|null} */ (document.activeElement);
  let closed = false;

  /** @type {() => void} */
  let close = () => {};

  // `panelClass` is an optional extra class alongside the base `drawer__panel` (e.g. the Filters modal's
  // `drawer__panel--wide`, since that modal now carries five sections instead of one flat column). Every
  // other drawer caller omits it and gets the same single-class panel as before this option existed.
  const panelClassName = opts.panelClass ? `drawer__panel ${opts.panelClass}` : 'drawer__panel';
  const panel = h('div', { className: panelClassName, attrs: { role: 'dialog', 'aria-label': opts.title, 'aria-modal': 'true' } }, [
    h('div', { className: 'drawer__header' }, [
      h('h2', { className: 'drawer__title', text: opts.title }),
      h('button', { className: 'drawer__close', attrs: { type: 'button', 'aria-label': 'Close' }, text: 'Close', on: { click: () => close() } }),
    ]),
    h('div', { className: 'drawer__body' }, opts.body),
  ]);
  const overlay = h('div', {
    className: 'drawer-overlay',
    attrs: { role: 'presentation' },
    on: {
      click: (ev) => { if (ev.target === overlay) close(); },
      keydown: (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          close();
          return;
        }
        if (ev.key === 'Tab') {
          const items = focusableEls(panel);
          if (items.length === 0) return;
          const first = /** @type {HTMLElement} */ (items[0]);
          const last = /** @type {HTMLElement} */ (items[items.length - 1]);
          if (ev.shiftKey && document.activeElement === first) {
            ev.preventDefault();
            last.focus();
          } else if (!ev.shiftKey && document.activeElement === last) {
            ev.preventDefault();
            first.focus();
          }
        }
      },
    },
  }, [panel]);

  close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    opts.onClose?.();
  };

  // The caller appends `el` to the document synchronously, right after this call returns; by the time
  // this microtask runs (after the current synchronous script finishes), the element is connected, so
  // focusing its first focusable control here reliably moves real keyboard focus into the drawer.
  queueMicrotask(() => {
    if (closed) return;
    const first = focusableEls(panel)[0];
    if (first) first.focus();
  });

  return { el: overlay, close };
}
