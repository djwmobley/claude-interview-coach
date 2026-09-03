// @ts-check
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast, showUndoToast } from '../lib/toast.js';
import { dataTable } from '../components/data-table.js';
import { jobRow } from '../components/job-row.js';
import { filterBar, filterStateToQuery } from '../components/filter-bar.js';
import { openFilterModal } from '../components/filter-modal.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { on, off } from '../lib/bus.js';
import { createListCursor } from '../lib/list-cursor.js';
import { DIGIT_STAGE_ORDER } from '../components/stage-buttons.js';
import { stageChip } from '../components/chips.js';

/**
 * Mirror of src/tools/query_jobs.js's SORTS. public/ code cannot import that module directly: it pulls
 * in the 'zod' package via a bare specifier, which only resolves under Node/bundler module resolution,
 * never in a browser loading this file as a plain ES module. test/query-jobs-sort.test.js cross-checks
 * this mirror (and every sortKey used in COLUMNS below) against the real SORTS array, so drift between
 * the two is a test failure, not a silent runtime mismatch.
 */
export const SORTS = Object.freeze(['posted', 'seen', 'prescore', 'fit', 'id', 'title', 'company', 'source', 'status', 'location', 'first_seen']);

const SORT_STORAGE_KEY = 'jobs.sort.v1';

/**
 * Single source of truth for this page's default filter state -- used both as the initial `filterState`
 * in render() and as what onResetView() restores. Previously these were two independent object literals
 * that had to be kept in sync by hand; a change to one (e.g. adding hideSkip here) silently missed the
 * other. Frozen so a caller mutating the returned object cannot corrupt the shared default; both call
 * sites spread it (`{ ...DEFAULT_FILTER_STATE }`) into a fresh object instead of holding a reference to
 * this one.
 */
export const DEFAULT_FILTER_STATE = Object.freeze({ hideDuplicates: true, hideSkip: true, hideReview: true });

/** @param {unknown} s */
function validateSort(s) {
  return typeof s === 'string' && SORTS.includes(s) ? s : 'posted';
}
/** @param {unknown} d */
function validateDir(d) {
  return d === 'asc' ? 'asc' : 'desc';
}

/** Restored localStorage state is re-validated through the SAME classification the server uses (unknown
 * sort -> 'posted', anything but exactly 'asc' -> 'desc'), never trusted as-is: a stale value from a
 * previous version of this page (or a hand-edited localStorage entry) must never reach the query params
 * unchecked. */
function loadSortState() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return { sort: 'posted', dir: 'desc' };
    const parsed = JSON.parse(raw);
    return { sort: validateSort(parsed?.sort), dir: validateDir(parsed?.dir) };
  } catch {
    // localStorage unavailable/blocked, or a corrupt JSON value: fall back to the default, same as a
    // first-ever visit. Never throws out to the caller.
    return { sort: 'posted', dir: 'desc' };
  }
}

/** @param {{ sort: string, dir: 'asc'|'desc' }} state */
function saveSortState(state) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ sort: state.sort, dir: state.dir }));
  } catch {
    // Private browsing, blocked site data, or a full quota: sorting still works for this page load via
    // in-memory state, it simply will not survive a reload. Never throws out to the caller.
  }
}

// Every column carries the same class as its body cell (components/job-row.js), not just 'Location' and
// 'Fit': app.css's 1180px breakpoint rule needs the paired header/cell classes to hide each header
// alongside the cells it labels, and the jobs-table fixed-layout width rules (also app.css) key off these
// same classes to give the table stable per-sort-key column widths instead of an auto layout that
// recomputes from whichever 50-row /api/listings page happens to be showing.
// `sortKey` values are string literals matching SORTS above (not this same array by reference, since a
// column's sortKey is also read directly by pages/jobs.js's own tests via COLUMNS -- see
// test/query-jobs-sort.test.js).
//
// Every column is sortable now except the leading '' checkbox column. 'First seen' uses sortKey
// 'first_seen', NOT 'seen' -- 'seen' maps server-side to last_seen (the re-scan timestamp), a different
// column from the one this header labels; using 'seen' here would sort the table by the wrong field
// while the header itself kept reading "First seen".
export const COLUMNS = Object.freeze([
  { text: '', className: 'job-row__checkbox' },
  { text: 'Title', sortKey: 'title', className: 'job-row__title' },
  { text: 'Company', sortKey: 'company', className: 'job-row__company' },
  { text: 'Source', sortKey: 'source', className: 'job-row__source' },
  { text: 'Stage', sortKey: 'status', className: 'job-row__stage' },
  { text: 'Prescore', sortKey: 'prescore', className: 'job-row__prescore' },
  { text: 'Fit', sortKey: 'fit', className: 'job-row__fit' },
  { text: 'First seen', sortKey: 'first_seen', className: 'job-row__first-seen' },
  { text: 'Location', sortKey: 'location', className: 'job-row__location' },
  // One-click apply (PR A spec item 8): not sortable -- application state is not a query_jobs sort key.
  { text: 'Apply', className: 'job-row__apply' },
]);

/**
 * Per-sort-key first-click direction (the direction a column sorts on the FIRST click after switching to
 * it from a different column). Alpha columns (title/company/source/location) and the status/pipeline
 * column start ascending -- for status this means pipeline order start-to-finish (new -> ... -> review),
 * the most natural "where does this row sit in the pipeline" reading. Numeric/date columns
 * (prescore/fit/first_seen) start descending -- highest score or most recent first, since that is almost
 * always what someone wants to see first for a score or a date.
 *
 * TOTAL CLASSIFICATION: nextSortState() below reads this with `?? 'desc'`, so any sortKey without an
 * explicit entry here defaults to 'desc' rather than throwing or producing `undefined`. The drift test
 * (test/query-jobs-sort.test.js) still requires every real, sortable COLUMNS entry to have an explicit
 * entry here -- the 'desc' fallback is a safety net for stray/future callers, not a substitute for
 * keeping this object in sync with COLUMNS.
 */
export const FIRST_CLICK_DIR = Object.freeze({
  title: 'asc',
  company: 'asc',
  source: 'asc',
  status: 'asc',
  location: 'asc',
  prescore: 'desc',
  fit: 'desc',
  first_seen: 'desc',
});

/**
 * Pure click-state transition, extracted out of onSort so it is directly unit-testable without a
 * DOM/page render (table-driven tests live in test/query-jobs-sort.test.js). A click on the
 * already-active column toggles asc<->desc; a click on a different column switches to that column at its
 * type's first-click direction (FIRST_CLICK_DIR above).
 * @param {{ sort: string, dir: 'asc'|'desc' }} current
 * @param {string} sortKey
 * @returns {{ sort: string, dir: 'asc'|'desc' }}
 */
export function nextSortState(current, sortKey) {
  if (current.sort === sortKey) return { sort: sortKey, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: sortKey, dir: FIRST_CLICK_DIR[sortKey] ?? 'desc' };
}

/**
 * Pure merge of the two source lists the Jobs page keeps: the server's current distinct-source list
 * (`/api/sources`) and this session's own running union of `row.source` values seen in loaded
 * /api/listings rows (see filter-modal.js's own doc comment for when each one matters, and why neither
 * alone is sufficient). Deduplicated, sorted ascending -- exported as a plain module-level function
 * (no document/window access) so it is directly unit-testable, same pattern as SORTS/COLUMNS above.
 * @param {Iterable<string>} apiSources @param {Iterable<string>} seenSources
 * @returns {string[]}
 */
export function unionSourceOptions(apiSources, seenSources) {
  return [...new Set([...apiSources, ...seenSources])].sort();
}

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
  let filterState = { ...DEFAULT_FILTER_STATE };
  let sortState = loadSortState();
  const selected = new Set();
  const cursor = createListCursor();
  // The running union of every `row.source` value seen in any /api/listings response this page has
  // loaded, across every filter combination applied so far this session -- kept as a fallback alongside
  // apiSources below (see filter-modal.js's own doc comment for when each one matters).
  const seenSources = new Set();
  // The real distinct-source list from GET /api/sources, refreshed on page load and again each time the
  // Filters modal opens. Starts empty (not yet fetched) rather than undefined, so sourceOptionsUnion()
  // below never needs a null check.
  let apiSources = [];
  setChildren(container, [skeleton({ rows: 8 })]);

  /** Refresh apiSources from the server; a failed fetch leaves the last-known list (or the initial empty
   * array) in place rather than clearing it, so a transient network error never regresses the modal's
   * Source options to fewer entries than it already had this session. */
  async function refreshSourceOptions() {
    const outcome = handleOutcome(await getJson('/api/sources'), { silenceNotFound: true });
    if (outcome.kind === 'ok' && Array.isArray(outcome.body.sources)) apiSources = outcome.body.sources;
  }

  /** Union of the server's current distinct-source list and this session's own accumulated union, deduped
   * and sorted -- the Filter modal's Source checkbox options. */
  function sourceOptionsUnion() {
    return unionSourceOptions(apiSources, seenSources);
  }

  /** One-click apply (PR A spec item 8): kicks off POST /api/listings/:id/apply-now. 409 (an active
   * application already exists past drafting) is a normal, expected outcome -- e.g. a second click while
   * the chain is already running -- surfaced as an informational toast, never an error toast. */
  async function applyNow(id) {
    const outcome = handleOutcome(await postJson(`/api/listings/${id}/apply-now`, {}));
    if (outcome.kind === 'ok') {
      showToast({ message: 'Applying: drafting resume.' });
      load();
    } else if (outcome.kind === 'duplicate_application') {
      showToast({ message: 'This listing already has an active application.' });
      load();
    }
  }

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

  /** @param {string} sortKey */
  function onSort(sortKey) {
    sortState = nextSortState(sortState, sortKey);
    saveSortState(sortState);
    load();
  }

  /**
   * Reset view: restores the default sort, the default filter state, and clears selection and the
   * keyboard cursor -- everything this page keeps as its own working state. Deliberately does NOT clear
   * seenSources/apiSources: those are session-persistent Filter-modal option lists by design (see their
   * own comments above), not part of "the current view."
   */
  function onResetView() {
    sortState = { sort: 'posted', dir: 'desc' };
    filterState = { ...DEFAULT_FILTER_STATE };
    selected.clear();
    try {
      localStorage.removeItem(SORT_STORAGE_KEY);
    } catch {
      // Private browsing, blocked site data, or a full quota: sortState is already reset in memory for
      // this page load, it simply will not persist as "removed" across a reload. Never throws out.
    }
    cursor.reset();
    load();
  }

  async function load() {
    const query = { ...filterStateToQuery(filterState), sort: sortState.sort, dir: sortState.dir };
    const outcome = handleOutcome(await getJson('/api/listings', query));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'Jobs could not be loaded right now.' })]);
      return;
    }
    const rows = outcome.body.rows;
    // GET /api/listings' `triage` field (jobs-unscored-visibility PR, Change 3): the dashboard's own
    // triage floor/ceiling, threaded into every row's Fit-cell classification (job-row.js's fitState via
    // lib/format.js's fitDisplayState()). `null` when config/triage.json is not loaded server-side.
    const triageBand = outcome.body.triage ?? null;
    for (const row of rows) if (row.source) seenSources.add(row.source);
    // "Hide in review (N)" count (Change 4): a second, lightweight GET /api/listings call, count-only
    // (limit 1, read `total`), reusing the exact same buildQuery-backed machinery -- no new SQL path.
    // Deliberately independent of the current filter state's OTHER dimensions (search/location/source/
    // etc.): this answers "how many rows are marked review right now," not "how many would show under
    // today's other filters," so the count does not flicker as unrelated filters change. A failed fetch
    // renders the checkbox label with no count (see filter-bar.js's own doc comment) rather than a
    // misleading 0.
    const reviewCountOutcome = handleOutcome(await getJson('/api/listings', { status: 'review', limit: '1' }), { silenceNotFound: true });
    const reviewCount = reviewCountOutcome.kind === 'ok' ? Number(reviewCountOutcome.body.total) : null;
    const bulkStageSelect = h('select', { className: 'drawer__input' }, DIGIT_STAGE_ORDER.map((s) => h('option', { value: s, text: stageChip(s).label })));
    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Jobs' }),
      filterBar({
        state: filterState,
        reviewCount,
        onChange: (patch) => { filterState = { ...filterState, ...patch }; load(); },
        onReset: onResetView,
        onOpenFilters: async () => {
          // Cheap refresh each time the modal opens: a source added to a row since page load (or since
          // the last time this modal was opened) should not require a full page reload to show up.
          await refreshSourceOptions();
          openFilterModal({
            state: filterState,
            sourceOptions: sourceOptionsUnion(),
            onApply: (next) => { filterState = next; load(); },
          });
        },
      }),
      selected.size > 0 ? h('div', { className: 'bulk-bar' }, [
        h('span', { text: `${selected.size} selected` }),
        bulkStageSelect,
        h('button', { className: 'btn btn--small', text: 'Apply', on: { click: () => bulkSetStage([...selected], /** @type {HTMLSelectElement} */ (bulkStageSelect).value) } }),
      ]) : null,
      rows.length === 0
        ? emptyState({ message: 'No jobs match the current filters.', hint: 'Try widening the location or first-seen window.' })
        : dataTable({
            className: 'jobs-table',
            columns: COLUMNS,
            sort: sortState.sort,
            dir: sortState.dir,
            onSort,
            rows: rows.map((row) => jobRow(row, {
              selected: selected.has(row.id),
              onToggleSelect: (id) => { if (selected.has(id)) selected.delete(id); else selected.add(id); load(); },
              onOpen: (id) => app.navigate('job-detail', { id }),
              onApplyNow: applyNow,
              triageBand,
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
  // Fire-and-forget: apiSources only needs to be populated by the time the Filters modal is first
  // opened, not before the page's own rows render, so this never blocks initial paint.
  refreshSourceOptions();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  on('dashboard:kbaction', onKbAction);
  return {
    name: 'jobs',
    refresh: load,
    teardown: () => { off('dashboard:changed', onChanged); off('dashboard:kbaction', onKbAction); },
  };
}
