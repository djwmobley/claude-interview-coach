// @ts-check
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { statusStrip } from '../components/status-strip.js';
import { actionBar } from '../components/action-bar.js';
import { scanProgressPanel } from '../components/scan-progress.js';
import { agenda } from '../components/agenda.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { actorBadge, chipClassName, stageChip } from '../components/chips.js';
import { shortDateTime } from '../lib/format.js';
import { on, off } from '../lib/bus.js';

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const [summaryOutcome, agendaOutcome] = await Promise.all([
      handleOutcome(await getJson('/api/summary')),
      handleOutcome(await getJson('/api/calendar/agenda', {
        from: new Date().toISOString(),
        to: new Date(Date.now() + 7 * 86400000).toISOString(),
      }), { silenceNotFound: true }),
    ]);
    if (summaryOutcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'The summary could not be loaded right now.' })]);
      return;
    }
    const summary = summaryOutcome.body;
    const live = handleOutcome(await getJson('/api/scans/live'));
    const running = live.kind === 'ok' ? live.body.running : false;
    const liveRun = live.kind === 'ok' ? live.body.run : null;

    const agendaItems = agendaOutcome.kind === 'ok'
      ? [
          ...(agendaOutcome.body.events ?? []).map((e) => ({ at: e.start ?? e.startIso ?? e.start_at, title: e.summary ?? 'Event', google: true, followup: false })),
          ...(agendaOutcome.body.followups ?? []).map((f) => ({ at: f.due_at, title: `${f.action} with ${f.contact}`, google: false, followup: true, id: f.id })),
        ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
      : [];

    if (agendaOutcome.kind === 'ok' && agendaOutcome.body.connected === false) {
      import('../lib/toast.js').then(({ setBanner }) => setBanner('calendar-not-connected', { tone: 'warn', message: 'Google Calendar is not connected. Agenda shows follow-ups only.' }));
    }

    const recentEvents = summary.recent_events ?? [];

    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Home' }),
      statusStrip({ summary }),
      actionBar({
        running,
        disabled: false,
        onRunScan: async () => {
          const outcome = handleOutcome(await postJson('/api/scans', {}));
          if (outcome.kind === 'ok') showToast({ message: 'Scan started.' });
        },
        onCancelScan: async () => {
          if (!liveRun) return;
          const outcome = handleOutcome(await postJson(`/api/scans/${liveRun.run_id}/cancel`, {}));
          if (outcome.kind === 'ok') showToast({ message: 'Cancel requested.' });
        },
        onPreviewReport: () => { app.navigate('report-view', { day: new Date().toISOString().slice(0, 10) }); },
        onSendReport: async () => {
          const outcome = handleOutcome(await postJson('/api/report/send', { dryRun: false }));
          if (outcome.kind === 'ok') showToast({ message: 'Report sent.' });
        },
        onAddOpportunity: () => { app.navigate('pipeline'); },
        onNewFollowup: () => { app.navigate('followups'); },
      }),
      h('h2', { className: 'section-title', text: 'Scan progress' }),
      scanProgressPanel({ run: liveRun }),
      h('div', { className: 'home-body' }, [
        h('div', { className: 'home-body__left' }, [
          h('h2', { className: 'section-title', text: 'Agenda, next 7 days' }),
          agenda({
            items: agendaItems,
            onDone: async (id) => { handleOutcome(await postJson(`/api/followups/${id}/complete`, {})); load(); },
            onSnooze: async (id) => {
              const until = new Date(Date.now() + 86400000).toISOString();
              handleOutcome(await postJson(`/api/followups/${id}/snooze`, { snoozed_until: until }));
              load();
            },
          }),
        ]),
        h('div', { className: 'home-body__right' }, [
          h('h2', { className: 'section-title', text: 'Recent activity' }),
          recentEvents.length === 0
            ? emptyState({ message: 'No recent activity yet.' })
            : h('ul', { className: 'activity-list' }, recentEvents.slice(0, 15).map((e) => {
                const badge = actorBadge(e.actor);
                return h('li', { className: 'activity-list__row' }, [
                  h('span', { className: 'activity-list__time', text: shortDateTime(e.at) }),
                  h('span', { className: chipClassName(badge), text: badge.label }),
                  h('span', { className: 'activity-list__desc', text: `${e.kind}${e.to_status ? `: ${stageChip(e.to_status).label}` : ''}` }),
                ]);
              })),
        ]),
      ]),
    ]);
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  on('dashboard:run-update', onChanged);
  return { name: 'home', refresh: load, teardown: () => { off('dashboard:changed', onChanged); off('dashboard:run-update', onChanged); } };
}
