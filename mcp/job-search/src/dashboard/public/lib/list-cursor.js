// @ts-check
/**
 * Shared row-cursor for j/k/Enter list navigation (pr3-spec-decisions.md section 8 rule 4: bare j/k
 * move a row cursor down/up inside a list view; Enter opens the cursored row). One cursor per page
 * instance, held in the page module's own closure, never in a global store: a hash-route change tears
 * the page down and rebuilds it, which naturally resets the cursor, the same reasoning
 * components/confirm-button.js already relies on for its own per-node armed state.
 *
 * Independent review comment 5440498360, blocking finding 1: this is the piece that was entirely
 * missing before, letting `dashboard:kbaction` be emitted with zero consumers anywhere in `public/`.
 */

/** @param {HTMLElement} el @param {string} id */
export function setRowId(el, id) {
  el.dataset.rowId = String(id);
  return el;
}

export function createListCursor() {
  /** @type {HTMLElement[]} */
  let rows = [];
  let index = -1;

  function applyCursorClass() {
    rows.forEach((el, i) => el.classList.toggle('row-cursor', i === index));
  }

  /**
   * Call after every render with the current row elements, in display order. Clamps a previously
   * cursored index into the new row count rather than resetting to the top on every refresh, so an
   * SSE-driven re-render mid-navigation does not yank the cursor back to row 1.
   * @param {HTMLElement[]} newRows
   */
  function setRows(newRows) {
    rows = newRows;
    index = rows.length > 0 ? Math.min(Math.max(index, 0), rows.length - 1) : -1;
    applyCursorClass();
  }

  /** @param {1|-1} dir */
  function move(dir) {
    if (rows.length === 0) return;
    index = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + dir));
    applyCursorClass();
    const row = rows[index];
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      // Real DOM focus too: reuses the already-verified :focus-visible ring as the cursor's visual
      // indicator on top of .row-cursor, and keeps native Tab-focus and keyboard-cursor state in sync.
      if (typeof row.focus === 'function') row.focus();
    }
  }

  /** @returns {HTMLElement|null} */
  function current() {
    return index >= 0 && index < rows.length ? rows[index] : null;
  }

  /** @returns {string|null} the cursored row's data-row-id, or null if nothing is cursored */
  function currentId() {
    return current()?.dataset.rowId ?? null;
  }

  return { setRows, move, current, currentId };
}
