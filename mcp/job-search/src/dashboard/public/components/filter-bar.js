// @ts-check
/**
 * Jobs filter bar. Encodes pr3-spec-decisions.md section 9 adaptations: location presets are client-side
 * labels sent as a literal `location=` string (never a server-side enum); "first seen in the last N days"
 * computes `today - N` client-side and sends it as `postedAfter` (never `seenAfter`, which tracks
 * re-scans); "hide duplicates" checked (common) state OMITS `includeDuplicates` entirely, only the
 * unchecked state sends `includeDuplicates=1` (getting this polarity backwards makes the toggle a no-op).
 */
import { h } from '../lib/dom.js';

export const LOCATION_PRESETS = Object.freeze([
  { key: '', label: 'Any location' },
  { key: 'Houston, TX', label: 'Houston, TX' },
  { key: 'Texas', label: 'Texas' },
]);

export const FIRST_SEEN_WINDOWS = Object.freeze([
  { key: '', label: 'Any time' },
  { key: '1', label: 'Last 24 hours' },
  { key: '7', label: 'Last 7 days' },
  { key: '30', label: 'Last 30 days' },
]);

/** Turn filter-bar UI state into the exact query params buildQuery expects (section 9 items 4-6). @param {any} state */
export function filterStateToQuery(state) {
  /** @type {Record<string, string>} */
  const q = {};
  if (state.search) q.q = state.search;
  if (state.status) q.status = state.status;
  if (state.source) q.source = state.source;
  if (state.location) q.location = state.location;
  if (state.remote) q.remote = state.remote;
  if (state.minPrescore) q.minPrescore = String(state.minPrescore);
  if (state.firstSeenDays) {
    const cutoff = new Date(Date.now() - Number(state.firstSeenDays) * 86400000);
    q.postedAfter = cutoff.toISOString().slice(0, 10);
  }
  // hideDuplicates checked (the common/default state) omits includeDuplicates entirely; only the
  // unchecked state sends includeDuplicates=1 (section 9 item 6's polarity rule).
  if (state.hideDuplicates === false) q.includeDuplicates = '1';
  return q;
}

/**
 * @param {{ state: any, onChange: (patch: any) => void }} opts
 */
export function filterBar(opts) {
  const state = opts.state;
  const searchInput = h('input', {
    className: 'filter-bar__search', attrs: { type: 'search', placeholder: 'Search title or company' }, value: state.search ?? '',
    on: { input: (ev) => opts.onChange({ search: /** @type {HTMLInputElement} */ (ev.target).value }) },
  });
  const locationSelect = h('select', { className: 'filter-bar__select', on: { change: (ev) => opts.onChange({ location: /** @type {HTMLSelectElement} */ (ev.target).value }) } },
    LOCATION_PRESETS.map((p) => h('option', { value: p.key, selected: (state.location ?? '') === p.key, text: p.label })));
  const firstSeenSelect = h('select', { className: 'filter-bar__select', on: { change: (ev) => opts.onChange({ firstSeenDays: /** @type {HTMLSelectElement} */ (ev.target).value }) } },
    FIRST_SEEN_WINDOWS.map((w) => h('option', { value: w.key, selected: (state.firstSeenDays ?? '') === w.key, text: w.label })));
  const hideDupCheckbox = h('input', {
    attrs: { type: 'checkbox' }, checked: state.hideDuplicates !== false,
    on: { change: (ev) => opts.onChange({ hideDuplicates: /** @type {HTMLInputElement} */ (ev.target).checked }) },
  });
  return h('div', { className: 'filter-bar' }, [
    searchInput,
    h('label', { className: 'filter-bar__field' }, [h('span', { text: 'Location' }), locationSelect]),
    h('label', { className: 'filter-bar__field' }, [h('span', { text: 'First seen' }), firstSeenSelect]),
    h('label', { className: 'filter-bar__field filter-bar__checkbox' }, [hideDupCheckbox, h('span', { text: 'Hide duplicates' })]),
  ]);
}
