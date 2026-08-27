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

const COLUMNS = ['', 'Title', 'Company', 'Source', 'Stage', 'Score', 'First seen', 'Location'];

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  let filterState = { hideDuplicates: true };
  const selected = new Set();
  setChildren(container, [skeleton({ rows: 8 })]);

  async function load() {
    const query = filterStateToQuery(filterState);
    const outcome = handleOutcome(await getJson('/api/listings', query));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'Jobs could not be loaded right now.' })]);
      return;
    }
    const rows = outcome.body.rows;
    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Jobs' }),
      filterBar({ state: filterState, onChange: (patch) => { filterState = { ...filterState, ...patch }; load(); } }),
      selected.size > 0 ? h('div', { className: 'bulk-bar' }, [
        h('span', { text: `${selected.size} selected` }),
        h('button', { className: 'btn btn--small', text: 'Set stage', on: { click: () => bulkSetStage([...selected]) } }),
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
  }

  async function bulkSetStage(ids) {
    const status = prompt('Set stage to (new, maybe, shortlisted, applied, interviewing, offer, accepted, passed, lost, skip):');
    if (!status) return;
    const outcome = handleOutcome(await postJson('/api/listings/bulk-status', { ids, status }));
    if (outcome.kind === 'ok') {
      showToast({ message: `Updated ${ids.length} listings.` });
      selected.clear();
      load();
    }
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  return { name: 'jobs', refresh: load, teardown: () => off('dashboard:changed', onChanged) };
}
