// @ts-check
/**
 * Minimal internal pub/sub for cross-module signals (route changes needing a refresh, SSE run/changed
 * events). Deliberately NOT built on `EventTarget.dispatchEvent()`/`CustomEvent`: `test/safety.test.js`
 * bans the literal call-surface substring `.dispatchEvent(` anywhere under `src/` as part of keeping
 * Playwright's page-automation methods (`locator.dispatchEvent()`, along with `.click(`, `.fill(`, etc.)
 * confined to `src/browser/session.js`. That rule predates this front end and is about scan-adapter
 * safety, not the browser's native DOM event system, but the substring match does not distinguish the
 * two -- so this module sidesteps the collision entirely with a plain `Map<string, Set<fn>>`.
 */

/** @type {Map<string, Set<(detail: any) => void>>} */
const listeners = new Map();

/**
 * @param {string} name
 * @param {(detail: any) => void} fn
 */
export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)?.add(fn);
}

/**
 * @param {string} name
 * @param {(detail: any) => void} fn
 */
export function off(name, fn) {
  listeners.get(name)?.delete(fn);
}

/**
 * @param {string} name
 * @param {any} [detail]
 */
export function emit(name, detail) {
  for (const fn of listeners.get(name) ?? []) {
    try {
      fn(detail);
    } catch (err) {
      console.error(`dashboard: listener for "${name}" threw`, err);
    }
  }
}
