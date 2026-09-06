// @ts-check
/**
 * Background activity banner (activity pill spec item 4): a thin, dismissable bar under the topbar
 * listing background automation the operator did NOT just click (a scheduled scan, auto-apply, confirm --
 * GET /api/activity's `background` array). Restraint matches the rest of this dashboard's own convention
 * (review-bulk-bar's "section card + thin cyan accent, only a little color" -- see app.css): no new
 * colors, just the existing cyan accent stripe.
 *
 * Dismissal is per RUN IDENTITY, not per item text: `dismissKeyFor()` uses `run_id` when present, else
 * `kind:started_at` (spec item 4's own fallback for a marker-based background source, which has no
 * numeric run id). Stored in sessionStorage (per-tab, cleared with the tab -- never shared across
 * viewers, never read back by the server) so a dismissal survives this tab's own re-renders/polls but not
 * a fresh tab. A run that finishes (falls out of `background` entirely) and later starts again gets a
 * brand-new identity (a new run_id, or a new started_at when run_id is null) that was never dismissed, so
 * it reappears on its own -- no separate "has this run finished and restarted" bookkeeping needed.
 */
import { h, setChildren } from '../lib/dom.js';

const STORAGE_KEY = 'jobsearch:dismissedBackgroundActivity';

/**
 * @param {{ kind: string, run_id: number|string|null, started_at: string }} item
 * @returns {string}
 */
export function dismissKeyFor(item) {
  return item.run_id != null ? `id:${item.run_id}` : `ks:${item.kind}:${item.started_at}`;
}

/**
 * Best-effort read: sessionStorage can throw in some contexts (private browsing quota, a browser
 * configured to block site data) -- any failure just means "nothing was dismissed yet", never a crash.
 * @returns {Set<string>}
 */
function readDismissed() {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** @param {Set<string>} set */
function writeDismissed(set) {
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    /* sessionStorage unavailable: dismissal simply does not persist across a re-render this tick */
  }
}

/**
 * Pure filter, directly unit-testable without a DOM: which items are still visible given a dismissed-key
 * set.
 * @param {Array<{ kind: string, run_id: number|string|null, started_at: string }>} items
 * @param {Set<string>} dismissed
 */
export function visibleBackgroundItems(items, dismissed) {
  return items.filter((item) => !dismissed.has(dismissKeyFor(item)));
}

/**
 * Renders the bar into `host` (replacing its children), or empties `host` when nothing is visible. Never
 * returns a value -- callers just call this again after every GET /api/activity response, exactly like
 * app.js's existing updateActivityPill() pattern.
 * @param {HTMLElement} host
 * @param {Array<{ kind: string, label: string, run_id: number|string|null, started_at: string }>} items
 */
export function renderBackgroundBanner(host, items) {
  const dismissed = readDismissed();
  const visible = visibleBackgroundItems(items ?? [], dismissed);
  if (!visible.length) {
    setChildren(host, []);
    return;
  }
  const rerender = () => renderBackgroundBanner(host, items);
  setChildren(host, [
    h('div', { className: 'background-banner', attrs: { role: 'status' } }, [
      h('div', { className: 'background-banner__items' }, visible.map((item) => h('span', { className: 'background-banner__item' }, [
        h('span', { className: 'background-banner__label', text: item.label }),
        h('button', {
          className: 'background-banner__dismiss',
          attrs: { 'aria-label': `Dismiss: ${item.label}` },
          text: 'Dismiss',
          on: {
            click: () => {
              const next = readDismissed();
              next.add(dismissKeyFor(item));
              writeDismissed(next);
              rerender();
            },
          },
        }),
      ]))),
    ]),
  ]);
}
