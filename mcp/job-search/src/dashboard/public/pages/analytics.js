// @ts-check
import { h, setChildren } from '../lib/dom.js';
import { getJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { barChart, funnelChart, statTile, sourceColorToken } from '../lib/charts.js';
import { formatPercent } from '../lib/format.js';

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  let weeks = 8;
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const outcome = handleOutcome(await getJson('/api/analytics', { weeks }));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'Analytics could not be loaded right now.' })]);
      return;
    }
    const d = outcome.body;

    const bySource = {};
    for (const row of d.new_by_source) {
      bySource[row.source] = (bySource[row.source] ?? 0) + row.count;
    }
    const sourceBarData = Object.entries(bySource).map(([source, count]) => ({ label: source, value: count, colorToken: sourceColorToken(source) }));

    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Analytics' }),
      h('div', { className: 'analytics-window' }, [4, 8, 13].map((n) => h('button', { className: `btn btn--small ${n === weeks ? 'btn--active' : ''}`.trim(), text: `${n} weeks`, on: { click: () => { weeks = n; load(); } } }))),
      h('div', { className: 'analytics-stats' }, [
        statTile({ value: formatPercent(d.response_rate), caption: d.response_rate_note ?? 'Response rate' }),
        statTile({ value: String(d.followups.done), caption: `Follow-ups done of ${d.followups.total}` }),
        statTile({ value: formatPercent(d.followups.completion_rate), caption: 'Follow-up completion' }),
        statTile({ value: String(d.look_at_these_by_day.reduce((a, r) => a + r.count, 0)), caption: 'Look-at-these this window' }),
      ]),
      h('h2', { className: 'section-title', text: 'New listings by source' }),
      sourceBarData.length === 0 ? emptyState({ message: 'No new listings in this window.' }) : barChart({ data: sourceBarData, title: 'New listings by source' }),
      h('h2', { className: 'section-title', text: 'Pipeline funnel' }),
      d.funnel.length === 0 ? emptyState({ message: 'No stage-change events in this window.' }) : funnelChart({ stages: d.funnel.map((f) => ({ label: f.status ?? 'unknown', value: f.count })) }),
      h('h2', { className: 'section-title', text: 'Median days per stage' }),
      d.median_days_per_stage.length === 0 ? emptyState({ message: 'Not enough data yet to compute stage timing.' }) : h('ul', {}, d.median_days_per_stage.map((r) => h('li', { text: `${r.status}: ${r.median_days == null ? 'not enough data yet' : `${r.median_days.toFixed(1)} days`}` }))),
    ]);
  }

  await load();
  return { name: 'analytics', refresh: load };
}
