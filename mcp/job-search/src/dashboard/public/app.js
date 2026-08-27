// @ts-check
/**
 * App shell: rail, top bar, hash router, SSE client, keyboard map, responsive breakpoint watcher
 * (pr3-spec-decisions.md sections 3, 5, 8, 11). This is the single entry point loaded by index.html.
 *
 * JUDGMENT CALL, flagged in the PR body: no API response in this server carries a "user block" string
 * (checked GET /api/health and GET /api/summary in full). The plan's design mock hardcodes a real
 * person's name and job title, which the copy rules explicitly forbid shipping as a literal, including
 * in a source comment (public/ ships unbundled, so comments reach the browser verbatim). This constant
 * is the one place a header placeholder lives; it never uses a real name.
 */
import { h, setChildren } from './lib/dom.js';
import { parseHash, buildHash } from './lib/router.js';
import { initToastRoot, setBanner } from './lib/toast.js';
import { getJson } from './lib/api.js';
import { handleOutcome } from './lib/outcome.js';
import { createSseClient } from './lib/sse.js';
import { initialKbState, reduceKeyboard, CHORD_WINDOW_MS } from './lib/shortcuts.js';
import { scanPill } from './components/scan-progress.js';
import { railIcon } from './components/rail-icons.js';
import { emit } from './lib/bus.js';

/** Section 11: the layout breakpoint's numeric trigger is 1180px (the section title "1100" is informal). */
const WIDE_MIN = 1181;
const NARROW_MIN = 900;

/** No server response ever supplies a header identity string; this is the single, non-personal fallback. */
const USER_BLOCK_PLACEHOLDER = 'Job search dashboard';

const RAIL_SECTIONS = Object.freeze([
  { title: 'Daily', items: [
    { route: 'home', label: 'Home', key: 'h' },
    { route: 'jobs', label: 'Jobs', key: 'j' },
    { route: 'pipeline', label: 'Pipeline', key: 'p' },
    { route: 'followups', label: 'Follow-ups', key: 'f' },
    { route: 'review', label: 'Review', key: 'r' },
  ] },
  { title: 'System', items: [
    { route: 'runs', label: 'Runs' },
    { route: 'reports', label: 'Reports' },
    { route: 'calendar', label: 'Calendar' },
  ] },
  { title: 'Insight', items: [
    { route: 'analytics', label: 'Analytics' },
    { route: 'companies', label: 'Companies' },
  ] },
]);

const PAGE_LOADERS = Object.freeze({
  home: () => import('./pages/home.js'),
  jobs: () => import('./pages/jobs.js'),
  'job-detail': () => import('./pages/job-detail.js'),
  pipeline: () => import('./pages/pipeline.js'),
  followups: () => import('./pages/followups.js'),
  review: () => import('./pages/review.js'),
  runs: () => import('./pages/runs.js'),
  'run-detail': () => import('./pages/run-detail.js'),
  reports: () => import('./pages/reports.js'),
  'report-view': () => import('./pages/report-view.js'),
  calendar: () => import('./pages/calendar.js'),
  analytics: () => import('./pages/analytics.js'),
  companies: () => import('./pages/companies.js'),
  'company-detail': () => import('./pages/company-detail.js'),
});

const railEl = document.getElementById('rail');
const topbarEl = document.getElementById('topbar');
const bannersEl = document.getElementById('banners');
const contentEl = document.getElementById('content');
const toastRootEl = document.getElementById('toast-root');
const helpRootEl = document.getElementById('help-overlay-root');

initToastRoot(toastRootEl, bannersEl);

/** @type {{ name: string, refresh?: () => void, teardown?: () => void, beforeLeave?: () => void }|null} */
let currentPage = null;
let currentRouteName = 'home';
let liveScanState = { running: false, run: null };

/** Section 8's chord/reducer state, driven by the module-level keydown listener below. */
let kbState = initialKbState();

function layoutBucket() {
  const w = window.innerWidth;
  if (w < NARROW_MIN) return 'narrow';
  if (w >= WIDE_MIN) return 'wide';
  return 'collapsed';
}

function applyLayoutClass() {
  const bucket = layoutBucket();
  document.body.classList.remove('layout-wide', 'layout-collapsed', 'layout-narrow');
  document.body.classList.add(`layout-${bucket}`);
  if (bucket === 'narrow') {
    setChildren(contentEl, [h('div', { className: 'narrow-notice' }, [
      h('p', { text: 'This window is too narrow for the dashboard.' }),
      h('p', { text: 'Widen the window to at least 900 pixels to continue.' }),
    ])]);
    contentEl.classList.add('narrow-active');
  } else if (contentEl.classList.contains('narrow-active')) {
    contentEl.classList.remove('narrow-active');
    renderRoute(location.hash, { force: true });
  }
}

function renderRail() {
  const sections = RAIL_SECTIONS.map((section) => h('div', { className: 'rail__section' }, [
    h('div', { className: 'rail__section-title', text: section.title }),
    ...section.items.map((item) => {
      const active = currentRouteName === item.route;
      // The `title` attribute is the tooltip shown once app.css's 1180px breakpoint hides
      // `.rail__link-label` and the link goes icon-only, per defect 5: illegible truncated 9px labels are
      // replaced by a single legible icon, never by a shrunken/truncated copy of the same text.
      return h('a', {
        className: `rail__link ${active ? 'rail__link--active' : ''}`.trim(),
        hashHref: buildHash(item.route), attrs: { 'aria-current': active ? 'page' : undefined, title: item.label },
      }, [railIcon(item.route), h('span', { className: 'rail__link-label', text: item.label })]);
    }),
  ]));
  setChildren(railEl, sections);
}

function renderTopbar() {
  const search = h('input', { className: 'topbar__search', attrs: { type: 'search', placeholder: 'Search jobs (press /)', id: 'topbar-search' } });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      location.hash = buildHash('jobs');
    }
  });
  const pillHost = h('span', { className: 'topbar__scan-pill', attrs: { id: 'topbar-scan-pill' } }, [scanPill({ running: false, run: null })]);
  setChildren(topbarEl, [
    h('div', { className: 'topbar__left' }, [search]),
    h('div', { className: 'topbar__right' }, [pillHost, h('span', { className: 'topbar__user', text: USER_BLOCK_PLACEHOLDER })]),
  ]);
}

function updateScanPill() {
  const host = document.getElementById('topbar-scan-pill');
  if (!host) return;
  setChildren(host, [scanPill(liveScanState)]);
}

async function pollLiveScan() {
  const outcome = handleOutcome(await getJson('/api/scans/live'));
  if (outcome.kind !== 'ok') return;
  liveScanState = { running: outcome.body.running, run: outcome.body.run };
  updateScanPill();
}

async function pollHealth() {
  const outcome = handleOutcome(await getJson('/api/health'));
  if (outcome.kind !== 'ok') return;
  if (outcome.body.config_lock_ok === false) {
    setBanner('config-lock', { tone: 'error', message: 'Config lock mismatch. Scans are blocked until this is resolved.' });
  } else {
    setBanner('config-lock', null);
  }
  if (outcome.body.db_ok === false) {
    setBanner('db-unavailable', { tone: 'error', message: 'The database is unavailable right now. This view will recover automatically.' });
  } else {
    setBanner('db-unavailable', null);
  }
}

/** Route table entry -> "Home plus toast" fallback text (section 3 rule 6). */
function navigateHomeWithToast(message) {
  import('./lib/toast.js').then(({ showToast }) => showToast({ message, tone: 'error' }));
  if (location.hash !== '#/') location.hash = '#/';
  else renderRoute('#/', { force: true });
}

async function renderRoute(hash, opts = {}) {
  const parsed = parseHash(hash);
  if (parsed.kind === 'not_found') {
    if (hash !== '#/' && hash !== '') return navigateHomeWithToast('Page not found.');
  }
  if (parsed.kind === 'invalid') {
    return navigateHomeWithToast('Invalid link.');
  }
  const route = parsed.kind === 'ok' ? parsed.route : 'home';
  const params = parsed.kind === 'ok' ? parsed.params : {};
  if (!opts.force && route === currentRouteName && currentPage?.refresh) {
    // Same page, different params handled by the loader itself re-mounting; fall through to full mount
    // for simplicity and correctness (no partial-update state to get wrong).
  }
  if (currentPage?.beforeLeave) currentPage.beforeLeave();
  if (currentPage?.teardown) currentPage.teardown();
  currentRouteName = route;
  renderRail();
  const loader = PAGE_LOADERS[route];
  if (!loader) return navigateHomeWithToast('Page not found.');
  contentEl.setAttribute('aria-busy', 'true');
  try {
    const mod = await loader();
    const page = await mod.render(contentEl, params, { navigate: (r, p) => { location.hash = buildHash(r, p); } });
    currentPage = page ?? { name: route };
  } finally {
    contentEl.removeAttribute('aria-busy');
  }
}

window.addEventListener('hashchange', () => renderRoute(location.hash));
window.addEventListener('resize', applyLayoutClass);

document.addEventListener('keydown', (ev) => {
  const target = /** @type {HTMLElement} */ (ev.target);
  const inInput = Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable));
  const { state, action } = reduceKeyboard(kbState, {
    key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, inInput, now: Date.now(),
  });
  kbState = state;
  if (!action) return;
  switch (action.type) {
    case 'navigate':
      ev.preventDefault();
      location.hash = buildHash(action.route);
      break;
    case 'focus-search':
      ev.preventDefault();
      document.getElementById('topbar-search')?.focus();
      break;
    case 'blur':
      target?.blur();
      break;
    case 'open-help':
      ev.preventDefault();
      showHelpOverlay();
      break;
    case 'close-help':
      ev.preventDefault();
      hideHelpOverlay();
      break;
    default:
      // Row-nav / row-open / row-stage / digit / shortcut actions are dispatched to the mounted page,
      // which owns its own list/detail semantics.
      emit('dashboard:kbaction', action);
      break;
  }
});

function showHelpOverlay() {
  const rows = [
    ['g h / g j / g p / g f / g r', 'Go to Home / Jobs / Pipeline / Follow-ups / Review'],
    ['/', 'Focus search'],
    ['j / k', 'Move row down / up in a list'],
    ['Enter', 'Open the focused row'],
    ['1-0', 'Set stage on Job detail (New..Skip)'],
    ['n', 'Focus notes'],
    ['Esc', 'Close this overlay or blur a field'],
    ['?', 'Toggle this overlay'],
  ];
  setChildren(helpRootEl, [h('div', { className: 'help-overlay', attrs: { role: 'dialog', 'aria-label': 'Keyboard shortcuts' } }, [
    h('h2', { text: 'Keyboard shortcuts' }),
    h('table', { className: 'help-overlay__table' }, rows.map(([k, d]) => h('tr', {}, [h('td', { className: 'help-overlay__key', text: k }), h('td', { text: d })]))),
  ])]);
}

function hideHelpOverlay() {
  setChildren(helpRootEl, []);
}

const sse = createSseClient({
  url: '/api/stream',
  onRun(data) {
    liveScanState = { running: true, run: data };
    updateScanPill();
    emit('dashboard:run-update', data);
  },
  onChanged(data) {
    emit('dashboard:changed', data);
  },
  onPollTick() {
    pollLiveScan();
    emit('dashboard:changed', { kind: 'poll' });
  },
  onDegraded(degraded) {
    setBanner('sse-degraded', degraded ? { tone: 'warn', message: 'Live updates are degraded. Falling back to polling every 5 seconds.' } : null);
  },
});
window.addEventListener('beforeunload', () => sse.stop());

renderTopbar();
applyLayoutClass();
pollHealth();
pollLiveScan();
setInterval(pollHealth, 30000);
setInterval(pollLiveScan, 5000);
if (layoutBucket() !== 'narrow') renderRoute(location.hash || '#/');

export { USER_BLOCK_PLACEHOLDER };
