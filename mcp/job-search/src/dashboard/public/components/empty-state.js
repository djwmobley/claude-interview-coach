// @ts-check
/**
 * One-line empty state naming what specifically is missing (plan requirement; design "component states"
 * bans a generic "No data"). Every call site must supply the specific noun; there is no default text.
 */
import { h } from '../lib/dom.js';

/** @param {{ message: string, hint?: string }} opts */
export function emptyState(opts) {
  return h('div', { className: 'empty-state' }, [
    h('p', { className: 'empty-state__message', text: opts.message }),
    opts.hint ? h('p', { className: 'empty-state__hint', text: opts.hint }) : null,
  ]);
}

/** Pulsing skeleton bars for loading tiles/tables/agenda (design: "never a spinner alone"). @param {{ rows?: number, className?: string }} [opts] */
export function skeleton(opts = {}) {
  const rows = opts.rows ?? 3;
  const children = [];
  for (let i = 0; i < rows; i++) children.push(h('div', { className: 'skeleton-bar' }));
  return h('div', { className: `skeleton ${opts.className ?? ''}`.trim() }, children);
}
