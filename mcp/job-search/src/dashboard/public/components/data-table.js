// @ts-check
/** Generic table shell: header row plus a body the caller fills in. Column headers are plain text. */
import { h } from '../lib/dom.js';

/** @param {{ columns: string[], className?: string, rows: Node[] }} opts */
export function dataTable(opts) {
  const thead = h('thead', {}, [h('tr', {}, opts.columns.map((c) => h('th', { text: c })))]);
  const tbody = h('tbody', {}, opts.rows);
  return h('table', { className: `data-table ${opts.className ?? ''}`.trim(), attrs: { role: 'table' } }, [thead, tbody]);
}
