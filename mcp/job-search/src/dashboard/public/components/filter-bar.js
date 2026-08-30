// @ts-check
/**
 * Jobs filter bar. Encodes pr3-spec-decisions.md section 9 adaptations: location presets are client-side
 * labels sent as a literal `location=` string (never a server-side enum); "first seen in the last N days"
 * computes `today - N` client-side and sends it as `postedAfter` (never `seenAfter`, which tracks
 * re-scans); "hide duplicates" checked (common) state OMITS `includeDuplicates` entirely, only the
 * unchecked state sends `includeDuplicates=1` (getting this polarity backwards makes the toggle a no-op).
 *
 * Dashboard UX slice 2 adds the Filter modal (components/filter-modal.js): the bar itself keeps owning
 * search/location/first-seen/hide-duplicates, and gains a "Filters (n)" button that opens the modal for
 * every other, "modal-owned" dimension. `activeFilterCount()` and `filterStateToQuery()` are the two
 * single sources of truth for what counts as a modal-owned dimension and how it serializes; see each
 * function's own comment.
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

/**
 * Every filter-modal-owned state key, i.e. everything the "Filters (n)" button counts and the modal's
 * Clear button resets. Fixed here as the single list both `activeFilterCount()` and the modal
 * (components/filter-modal.js) key off of, so the button's count can never silently drift from what the
 * modal actually offers. `postedAfterExact` (not `postedAfter`) is the modal's own key: the shared
 * `postedAfter` query param this bar's `firstSeenDays` window ALSO writes is not itself in this list, so
 * a rolling first-seen window set from the bar is never miscounted as a modal-owned filter.
 */
const MODAL_OWNED_STATE_KEYS = Object.freeze([
  'status', 'source', 'noiseClass', 'remote', 'postedAfterExact', 'minPrescore', 'minFit', 'unscored', 'includeExpired', 'untriaged',
  'triagedByAuto',
]);

/**
 * Number of modal-owned filter dimensions currently active, for the "Filters (n)" button label. Each
 * dimension counts once regardless of how many values a multi-select carries; an empty array or an
 * unset/falsy scalar counts as not-active. Multi-select state is expected to already be normalized by
 * the modal (0-of-N and all-N checked both collapse to `undefined` there -- see filter-modal.js's
 * normalizeMultiSelect), so a plain truthiness/length check here is correct without this function needing
 * to know any option universe's size itself.
 * @param {any} state
 */
export function activeFilterCount(state) {
  let n = 0;
  for (const key of MODAL_OWNED_STATE_KEYS) {
    const v = state[key];
    if (Array.isArray(v) ? v.length > 0 : Boolean(v)) n++;
  }
  return n;
}

/** Turn filter-bar UI state into the exact query params buildQuery expects (section 9 items 4-6, plus
 * the filter-modal dimensions added in dashboard UX slice 2). @param {any} state */
export function filterStateToQuery(state) {
  /** @type {Record<string, string>} */
  const q = {};
  if (state.search) q.q = state.search;
  if (state.status && state.status.length) q.status = state.status.join(',');
  if (state.source && state.source.length) q.source = state.source.join(',');
  if (state.noiseClass && state.noiseClass.length) q.noiseClass = state.noiseClass.join(',');
  if (state.location) q.location = state.location;
  if (state.remote) q.remote = state.remote;
  if (typeof state.minPrescore === 'number') q.minPrescore = String(state.minPrescore);
  if (typeof state.minFit === 'number') q.minFit = String(state.minFit);
  // postedAfter has two writers: this bar's `firstSeenDays` rolling window, and the filter modal's exact
  // `postedAfterExact` date. When the modal's exact date is set, it takes precedence over the rolling
  // window ENTIRELY (the two are never merged/intersected) -- an exact date is a more specific, more
  // recently-set choice than a rolling preset, so it wins outright rather than narrowing further.
  if (state.postedAfterExact) {
    q.postedAfter = state.postedAfterExact;
  } else if (state.firstSeenDays) {
    const cutoff = new Date(Date.now() - Number(state.firstSeenDays) * 86400000);
    q.postedAfter = cutoff.toISOString().slice(0, 10);
  }
  if (state.unscored) q.unscored = '1';
  if (state.includeExpired) q.includeExpired = '1';
  if (state.untriaged) q.untriaged = '1';
  // Slice 3 auto-triage (spec section 7): the UI-side state is a plain boolean like every other
  // modal-owned checkbox, but the query param it serializes to is a VALUE ('auto'), never a bare '1' --
  // buildQuery/parseListingsQuery's total classification only ever recognizes the literal 'auto'.
  if (state.triagedByAuto) q.triagedBy = 'auto';
  // hideDuplicates checked (the common/default state) omits includeDuplicates entirely; only the
  // unchecked state sends includeDuplicates=1 (section 9 item 6's polarity rule).
  if (state.hideDuplicates === false) q.includeDuplicates = '1';
  return q;
}

/**
 * @param {{ state: any, onChange: (patch: any) => void, onOpenFilters?: () => void, onReset?: () => void }} opts
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
  const n = activeFilterCount(state);
  const filtersButton = h('button', {
    className: 'btn btn--small',
    attrs: { type: 'button' },
    text: `Filters${n > 0 ? ` (${n})` : ''}`,
    on: { click: () => opts.onOpenFilters?.() },
  });
  // Reset view (full-column-sort spec): same restrained `.btn btn--small` styling as Filters, no new
  // accent color -- this dashboard deliberately keeps color use minimal. Optional, same pattern as
  // onOpenFilters above, since filterBar currently has exactly one caller (pages/jobs.js) but need not
  // assume it stays that way.
  const resetButton = opts.onReset ? h('button', {
    className: 'btn btn--small',
    attrs: { type: 'button' },
    text: 'Reset view',
    on: { click: () => opts.onReset?.() },
  }) : null;
  return h('div', { className: 'filter-bar' }, [
    searchInput,
    h('label', { className: 'filter-bar__field' }, [h('span', { text: 'Location' }), locationSelect]),
    h('label', { className: 'filter-bar__field' }, [h('span', { text: 'First seen' }), firstSeenSelect]),
    h('label', { className: 'filter-bar__field filter-bar__checkbox' }, [hideDupCheckbox, h('span', { text: 'Hide duplicates' })]),
    filtersButton,
    resetButton,
  ]);
}
