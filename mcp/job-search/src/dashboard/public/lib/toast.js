// @ts-check
/**
 * Toast root, banner stack, and the single-slot undo toast (pr3-spec-decisions.md section 7.2, design
 * "component states"). A second mutation while an undo toast is visible replaces it outright; there is
 * never a queue. Persistent banners (config lock, SSE degraded, DB unavailable, calendar not connected)
 * live in a separate stacked strip under the top bar, each keyed so a repeat call updates in place
 * instead of duplicating.
 */
import { h, setChildren } from './dom.js';

let toastRoot = null;
let bannerRoot = null;
let undoToastEl = null;
let undoTimer = null;

/** Call once at startup with the two fixed DOM slots from index.html. */
export function initToastRoot(root, banners) {
  toastRoot = root;
  bannerRoot = banners;
}

/**
 * @param {{ message: string, tone?: 'error'|'info', code?: string|null }} opts
 */
export function showToast(opts) {
  if (!toastRoot) return;
  const tone = opts.tone ?? 'info';
  const el = h('div', { className: `toast toast--${tone}`, attrs: { role: 'status' } }, [
    h('span', { className: 'toast__message', text: opts.message }),
    opts.code ? h('span', { className: 'toast__code', text: opts.code }) : null,
    h('button', { className: 'toast__dismiss', attrs: { 'aria-label': 'Dismiss' }, text: 'x', on: { click: () => el.remove() } }),
  ]);
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), tone === 'error' ? 8000 : 5000);
}

/**
 * Single-slot undo toast: a second call replaces the first outright (design rule, never a queue).
 * @param {{ message: string, seconds?: number, onUndo: () => void }} opts
 */
export function showUndoToast(opts) {
  if (!toastRoot) return;
  if (undoToastEl) {
    undoToastEl.remove();
    undoToastEl = null;
  }
  if (undoTimer) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
  const seconds = opts.seconds ?? 10;
  const countEl = h('span', { className: 'toast__count', text: `${seconds}s` });
  let remaining = seconds;
  const el = h('div', { className: 'toast toast--undo', attrs: { role: 'status' } }, [
    h('span', { className: 'toast__message', text: opts.message }),
    countEl,
    h('button', { className: 'toast__undo-btn', text: 'Undo', on: { click: () => { finish(); opts.onUndo(); } } }),
  ]);
  const tick = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      finish();
      return;
    }
    countEl.textContent = `${remaining}s`;
  }, 1000);
  function finish() {
    clearInterval(tick);
    if (undoTimer) clearTimeout(undoTimer);
    el.remove();
    if (undoToastEl === el) undoToastEl = null;
  }
  undoTimer = setTimeout(finish, seconds * 1000);
  undoToastEl = el;
  toastRoot.appendChild(el);
}

/** Persistent, dismissible banner keyed by `key`; a repeat call with the same key updates the existing one. */
export function setBanner(key, opts) {
  if (!bannerRoot) return;
  const existingId = `banner-${key}`;
  const prior = bannerRoot.querySelector(`[data-banner-key="${cssEscape(key)}"]`);
  if (opts === null) {
    if (prior) prior.remove();
    return;
  }
  const el = h('div', { className: `banner banner--${opts.tone ?? 'warn'}`, dataset: { bannerKey: key }, attrs: { role: 'alert', id: existingId } }, [
    h('span', { className: 'banner__message', text: opts.message }),
    h('button', { className: 'banner__dismiss', attrs: { 'aria-label': 'Dismiss banner' }, text: 'Dismiss', on: { click: () => el.remove() } }),
  ]);
  if (prior) prior.replaceWith(el);
  else bannerRoot.appendChild(el);
}

/** @param {string} s */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}
