// @ts-check
/**
 * Generic table shell: header row plus a body the caller fills in. A column is either a plain text
 * label, or `{ text, className }` when the header cell needs the same responsive class as its body
 * cells -- e.g. `.job-row__location`, hidden at the 1180px breakpoint alongside the location `<td>`s so
 * a header stays paired with the column it labels rather than floating over the wrong data once the
 * cells beneath it disappear.
 */
import { h } from '../lib/dom.js';

/** @param {{ columns: Array<string|{text: string, className?: string}>, className?: string, rows: Node[] }} opts */
export function dataTable(opts) {
  const thead = h('thead', {}, [h('tr', {}, opts.columns.map((c) => {
    const col = typeof c === 'string' ? { text: c } : c;
    return h('th', { className: col.className, text: col.text });
  }))]);
  const tbody = h('tbody', {}, opts.rows);
  return h('table', { className: `data-table ${opts.className ?? ''}`.trim(), attrs: { role: 'table' } }, [thead, tbody]);
}
