// @ts-check
/** Slide-over drawer shell (Add opportunity, New follow-up, Add moment, Add event). Escape closes it. */
import { h } from '../lib/dom.js';

/** @param {{ title: string, body: Node[], onClose: () => void }} opts */
export function drawer(opts) {
  const panel = h('div', { className: 'drawer__panel', attrs: { role: 'dialog', 'aria-label': opts.title } }, [
    h('div', { className: 'drawer__header' }, [
      h('h2', { className: 'drawer__title', text: opts.title }),
      h('button', { className: 'drawer__close', attrs: { type: 'button', 'aria-label': 'Close' }, text: 'Close', on: { click: opts.onClose } }),
    ]),
    h('div', { className: 'drawer__body' }, opts.body),
  ]);
  const overlay = h('div', {
    className: 'drawer-overlay',
    on: {
      click: (ev) => { if (ev.target === overlay) opts.onClose(); },
      keydown: (ev) => { if (ev.key === 'Escape') opts.onClose(); },
    },
  }, [panel]);
  return overlay;
}
