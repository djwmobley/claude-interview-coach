// @ts-check
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast, showUndoToast } from '../lib/toast.js';
import { dataTable } from '../components/data-table.js';
import { jobRow } from '../components/job-row.js';
import { filterBar, filterStateToQuery } from '../components/filter-bar.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { on, off } from '../lib/bus.js';
import { createListCursor } from '../lib/list-cursor.js';
import { DIGIT_STAGE_ORDER } from '../components/stage-buttons.js';
import { stageChip } from '../components/chips.js';

const COLUMNS = ['', 'Title', 'Company', 'Source', 'Stage', 'Score', 'First seen', 'Location'];

/**
 * Total classification of every action lib/shortcuts.js's reducer can emit, so a totality test can
 * assert no action is silently unhandled (independent review comment 5440498360, blocking finding 1).
 * 'handled' means this page's onKbAction switch has a real case for it; 'not-applicable' is an explicit,
 * deliberate no-op (Jobs has no digit-stage shortcuts or Job-detail-only shortcuts).
 */
export const KEYBOARD_ACTIONS = Object.freeze({
  'row-nav': 'handled',
  'row-open': 'handled',
  'row-stage': 'handled',
  digit: 'not-applicable',
  shortcut: 'not-applicable',
});

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  let filterState = { hideDuplicates: true };
  const selected = new Set();
  const cursor = createListCursor();
  setChildren(container, [skeleton({ rows: 8 })]);

  async function setStageOnRow(id, status) {
    const rowOutcome = handleOutcome(await getJson(`/api/listings/${id}`), { silenceNotFound: true });
    const prevStatus = rowOutcome.kind === 'ok' ? rowOutcome.body.row.status : null;
    const out = handleOutcome(await postJson(`/api/listings/${id}/status`, { status }));
    if (out.kind === 'ok') {
      showUndoToast({
        message: `Stage set to ${status}.`,
        onUndo: async () => { handleOutcome(await postJson(`/api/listings/${id}/status`, { status: prevStatus ?? 'new' })); load(); },
      });
      load();
    }
  }

  async function load() {
    const query = filterStateToQuery(filterState);
    const outcome = handleOutcome(await getJson('/api/listings', query));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'Jobs could not be loaded right now.' })]);
      return;
    }
    const rows = outcome.body.rows;
    const bulkStageSelect = h('select', { className: 'drawer__input' }, DIGIT_STAGE_ORDER.map((s) => h('option', { value: s, text: stageChip(s).label })));
    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Jobs' }),
      filterBar({ state: filterState, onChange: (patch) => { filterState = { ...filterState, ...patch }; load(); } }),
      selected.size > 0 ? h('div', { className: 'bulk-bar' }, [
        h('span', { text: `${selected.size} selected` }),
        bulkStageSelect,
        h('button', { className: 'btn btn--small', text: 'Apply', on: { click: () => bulkSetStage([...selected], /** @type {HTMLSelectElement} */ (bulkStageSelect).value) } }),
      ]) : null,
      rows.length === 0
        ? emptyState({ message: 'No jobs match the current filters.', hint: 'Try widening the location or first-seen window.' })
        : dataTable({
            columns: COLUMNS,
            rows: rows.map((row) => jobRow(row, {
              selected: selected.has(row.id),
              onToggleSelect: (id) => { if (selected.has(id)) selected.delete(id); else selected.add(id); load(); },
              onOpen: (id) => app.navigate('job-detail', { id }),
            })),
          }),
    ]);
    cursor.setRows([...container.querySelectorAll('.job-row')]);
  }

  async function bulkSetStage(ids, status) {
    const outcome = handleOutcome(await postJson('/api/listings/bulk-status', { ids, status }));
    if (outcome.kind === 'ok') {
      showToast({ message: `Updated ${ids.length} listings.` });
      selected.clear();
      load();
    }
  }

  /** @param {{ type: string, [k: string]: any }} action */
  function onKbAction(action) {
    switch (action.type) {
      case 'row-nav':
        cursor.move(action.dir);
        return;
      case 'row-open': {
        const id = cursor.currentId();
        if (id) app.navigate('job-detail', { id: Number(id) });
        return;
      }
      case 'row-stage': {
        const id = cursor.currentId();
        if (id) setStageOnRow(Number(id), action.status);
        return;
      }
      default:
        // digit / shortcut: not applicable on Jobs (see KEYBOARD_ACTIONS).
        return;
    }
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  on('dashboard:kbaction', onKbAction);
  return {
    name: 'jobs',
    refresh: load,
    teardown: () => { off('dashboard:changed', onChanged); off('dashboard:kbaction', onKbAction); },
  };
}
