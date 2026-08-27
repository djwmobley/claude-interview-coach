// @ts-check
/** Runs list. Section 9 item 12: GET /api/scans uses `runs` as its array key, not `rows`. */
import { h, setChildren } from '../lib/dom.js';
import { getJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { dataTable } from '../components/data-table.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { runStatusChip, triggerBadge, chipClassName } from '../components/chips.js';
import { shortDateTime } from '../lib/format.js';
import { on, off } from '../lib/bus.js';

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 8 })]);

  async function load() {
    const outcome = handleOutcome(await getJson('/api/scans', { last: 50 }));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'Runs could not be loaded right now.' })]);
      return;
    }
    const runs = outcome.body.runs;
    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Runs' }),
      runs.length === 0 ? emptyState({ message: 'No scan runs recorded yet.' }) : dataTable({
        columns: ['Run', 'Started', 'Trigger', 'Status'],
        rows: runs.map((r) => {
          const statusChip = runStatusChip(r);
          const trig = triggerBadge(r.trigger);
          return h('tr', { attrs: { tabindex: '0' }, on: { click: () => app.navigate('run-detail', { id: r.run_id }) } }, [
            h('td', { text: `#${r.run_id}` }),
            h('td', { text: shortDateTime(r.started_at) }),
            h('td', {}, [h('span', { className: chipClassName(trig), text: trig.label })]),
            h('td', {}, [h('span', { className: chipClassName(statusChip), text: statusChip.label })]),
          ]);
        }),
      }),
    ]);
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  on('dashboard:run-update', onChanged);
  return { name: 'runs', refresh: load, teardown: () => { off('dashboard:changed', onChanged); off('dashboard:run-update', onChanged); } };
}
