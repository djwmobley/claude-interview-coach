// @ts-check
/**
 * Follow-ups: Overdue / Today / This week / Later / Snoozed / Done. Per pr3-spec-decisions.md section 9
 * item 13, the server's `from`/`to` params filter AFTER its 25-row page limit, so this page does not rely
 * on them for bucketing: it offset-paginates through the status-filtered set (25 rows per request, capped
 * at 8 pages / 200 rows to bound the work) and buckets by due date client-side.
 */
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showUndoToast } from '../lib/toast.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { shortDateTime } from '../lib/format.js';
import { on, off } from '../lib/bus.js';

const MAX_PAGES = 8;

async function fetchAll(status) {
  /** @type {any[]} */
  const rows = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const outcome = handleOutcome(await getJson('/api/followups', { status, offset }));
    if (outcome.kind !== 'ok') break;
    rows.push(...outcome.body.rows);
    if (outcome.body.rows.length < 25) break;
    offset += 25;
  }
  return rows;
}

function bucketOf(dueAt, now) {
  const due = new Date(dueAt).getTime();
  if (due < now) return 'overdue';
  if (due < now + 86400000) return 'today';
  if (due < now + 7 * 86400000) return 'week';
  return 'later';
}

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const now = Date.now();
    const [open, done] = await Promise.all([fetchAll('open,snoozed'), fetchAll('done')]);
    /** @type {Record<string, any[]>} */
    const buckets = { overdue: [], today: [], week: [], later: [], snoozed: [] };
    for (const row of open) {
      if (row.status === 'snoozed') buckets.snoozed.push(row);
      else buckets[bucketOf(row.due_at, now)].push(row);
    }

    const complete = async (id) => {
      const out = handleOutcome(await postJson(`/api/followups/${id}/complete`, {}));
      if (out.kind === 'ok') load();
    };
    const cancel = async (id) => {
      const out = handleOutcome(await postJson(`/api/followups/${id}/cancel`, {}));
      if (out.kind === 'ok') { showUndoToast({ message: 'Follow-up canceled.', onUndo: () => load() }); load(); }
    };
    const snooze = async (id) => {
      const until = new Date(now + 86400000).toISOString();
      handleOutcome(await postJson(`/api/followups/${id}/snooze`, { snoozed_until: until }));
      load();
    };

    const renderRow = (f) => h('div', { className: 'followup-row' }, [
      h('span', { className: 'followup-row__due', text: shortDateTime(f.due_at) }),
      h('span', { className: 'followup-row__contact', text: `${f.contact}${f.org ? ` (${f.org})` : ''}` }),
      h('span', { className: 'followup-row__action', text: f.action ?? '' }),
      h('div', { className: 'followup-row__actions' }, [
        h('button', { className: 'btn btn--small', text: 'Done', on: { click: () => complete(f.id) } }),
        h('button', { className: 'btn btn--small', text: 'Snooze', on: { click: () => snooze(f.id) } }),
        h('button', { className: 'btn btn--small', text: 'Cancel', on: { click: () => cancel(f.id) } }),
      ]),
    ]);

    const section = (key, label) => h('section', { className: 'followup-section' }, [
      h('h2', { text: `${label} (${buckets[key].length})` }),
      ...(buckets[key].length === 0 ? [emptyState({ message: `No follow-ups ${label.toLowerCase()}.` })] : buckets[key].map(renderRow)),
    ]);

    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Follow-ups' }),
      section('overdue', 'Overdue'),
      section('today', 'Today'),
      section('week', 'This week'),
      section('later', 'Later'),
      section('snoozed', 'Snoozed'),
      h('details', { className: 'followup-section' }, [
        h('summary', { text: `Done (${done.length})` }),
        ...(done.length === 0 ? [emptyState({ message: 'No follow-ups completed yet.' })] : done.map(renderRow)),
      ]),
    ]);
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  return { name: 'followups', refresh: load, teardown: () => off('dashboard:changed', onChanged) };
}
