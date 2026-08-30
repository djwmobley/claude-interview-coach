// @ts-check
/**
 * Generic table shell: header row plus a body the caller fills in. A column is either a plain text
 * label, or `{ text, className, sortKey }` when the header cell needs the same responsive class as its
 * body cells -- e.g. `.job-row__location`, hidden at the 1180px breakpoint alongside the location `<td>`s
 * so a header stays paired with the column it labels rather than floating over the wrong data once the
 * cells beneath it disappear.
 *
 * `sortKey` turns a header into a clickable sort control. The column that owns the currently active
 * `opts.sort` value renders an asc/desc indicator and `aria-sort`; any other sortable column renders
 * `aria-sort="none"`. Clicking always calls `opts.onSort(sortKey)`; the caller (the page) owns the actual
 * asc/first-click-is-desc/toggle state machine, since that state also has to survive into the query
 * params and localStorage -- this component only renders whatever sort/dir it is handed.
 */
import { h } from '../lib/dom.js';

/** @param {{ columns: Array<string|{text: string, className?: string, sortKey?: string}>, className?: string, rows: Node[], sort?: string, dir?: 'asc'|'desc', onSort?: (sortKey: string) => void }} opts */
export function dataTable(opts) {
  const thead = h('thead', {}, [h('tr', {}, opts.columns.map((c) => {
    const col = typeof c === 'string' ? { text: c } : c;
    if (!col.sortKey) return h('th', { className: col.className, text: col.text });
    const active = opts.sort === col.sortKey;
    const dir = active && opts.dir === 'asc' ? 'asc' : active ? 'desc' : null;
    const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
    const indicator = dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '';
    return h('th', { className: col.className, attrs: { 'aria-sort': ariaSort } }, [
      h('button', {
        className: 'data-table__sort-btn',
        attrs: { type: 'button' },
        on: { click: () => opts.onSort?.(/** @type {string} */ (col.sortKey)) },
      }, [
        col.text,
        // Muted indicator span (legibility tweak, no structural redesign): the arrow reads as a
        // secondary cue next to the label rather than competing with it for attention.
        indicator ? h('span', { className: 'data-table__sort-indicator', text: ` ${indicator}` }) : null,
      ]),
    ]);
  }))]);
  const tbody = h('tbody', {}, opts.rows);
  return h('table', { className: `data-table ${opts.className ?? ''}`.trim(), attrs: { role: 'table' } }, [thead, tbody]);
}
