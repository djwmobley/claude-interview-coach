// @ts-check
/** Calendar: 14-day agenda grouped by day, google/followup/both badges, banner when not connected. */
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { setBanner } from '../lib/toast.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { shortDateTime } from '../lib/format.js';
import { on, off } from '../lib/bus.js';

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const from = new Date();
    const to = new Date(Date.now() + 14 * 86400000);
    const outcome = handleOutcome(await getJson('/api/calendar/agenda', { from: from.toISOString(), to: to.toISOString() }));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'The calendar could not be loaded right now.' })]);
      return;
    }
    setBanner('calendar-not-connected', outcome.body.connected === false ? { tone: 'warn', message: 'Google Calendar is not connected. Only follow-ups are shown.' } : null);

    const items = [
      ...(outcome.body.events ?? []).map((e) => ({ at: e.start ?? e.startIso ?? e.start_at, title: e.summary ?? 'Event', google: true, followup: false })),
      ...(outcome.body.followups ?? []).map((f) => ({ at: f.due_at, title: `${f.action} with ${f.contact}`, google: false, followup: true, id: f.id })),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const byDay = new Map();
    for (const item of items) {
      const day = new Date(item.at).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(item);
    }

    const rows = [...byDay.entries()].map(([day, dayItems]) => h('div', { className: 'calendar-day-row' }, [
      h('div', { className: 'calendar-day-row__date', text: day }),
      h('div', { className: 'calendar-day-row__items' }, dayItems.map((item) => h('div', { className: 'calendar-item' }, [
        h('span', { text: shortDateTime(item.at) }),
        h('span', { text: item.title }),
        item.google ? h('span', { className: 'badge badge--google', text: 'Google' }) : null,
        item.followup ? h('span', { className: 'badge badge--followup', text: 'Follow-up' }) : null,
        item.followup ? h('button', { className: 'btn btn--small', text: 'Done', on: { click: async () => { handleOutcome(await postJson(`/api/followups/${item.id}/complete`, {})); load(); } } }) : null,
        item.followup ? h('button', { className: 'btn btn--small', text: 'Snooze', on: { click: async () => { handleOutcome(await postJson(`/api/followups/${item.id}/snooze`, { snoozed_until: new Date(Date.now() + 86400000).toISOString() })); load(); } } }) : null,
      ]))),
    ]));

    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Calendar' }),
      rows.length === 0 ? emptyState({ message: 'Nothing on the calendar in the next 14 days.' }) : h('div', { className: 'calendar-days' }, rows),
    ]);
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  return { name: 'calendar', refresh: load, teardown: () => off('dashboard:changed', onChanged) };
}
