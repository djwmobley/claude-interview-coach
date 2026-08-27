// @ts-check
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { confirmButton } from '../components/confirm-button.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { shortDate } from '../lib/format.js';

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const outcome = handleOutcome(await getJson('/api/report/history'));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'Report history could not be loaded right now.' })]);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Reports' }),
      h('div', { className: 'reports-grid' }, [
        h('div', { className: 'reports-list' }, [
          h('button', { className: 'btn btn--primary', text: 'Preview today', on: { click: () => app.navigate('report-view', { day: today }) } }),
          confirmButton({
            label: 'Send now', confirmLabel: 'Confirm send',
            onConfirm: async () => {
              const out = handleOutcome(await postJson('/api/report/send', { dryRun: false }));
              if (out.kind === 'ok') showToast({ message: `Report sent: ${out.body.subject ?? 'sent'}.` });
            },
          }),
          h('p', { className: 'reports-list__sent', text: outcome.body.last_report_sent_at ? `Last sent ${shortDate(outcome.body.last_report_sent_at)}.` : 'No report has been sent yet.' }),
          h('h3', { text: 'History' }),
          outcome.body.days.length === 0 ? emptyState({ message: 'No reports generated yet.' }) : h('ul', {}, outcome.body.days.map((day) => h('li', {}, [
            h('a', { hashHref: `#/reports/${day}`, text: day }),
          ]))),
        ]),
      ]),
    ]);
  }

  await load();
  return { name: 'reports', refresh: load };
}
