// @ts-check
/**
 * Shared opt-in gate for tests that launch or connect to a REAL browser (Chrome, Edge, puppeteer,
 * playwright). Antivirus flags real browser launches from the test suite, so the default run never starts
 * one. Set JOBSEARCH_BROWSER_TESTS=1 to run these suites by hand.
 *
 * Usage in a test file:
 *   import { browserSkip } from './helpers/browser-gate.js';
 *   const SKIP = browserSkip();            // false, or a skip-reason string
 *   describe('...', { skip: SKIP }, () => { ... });   // and `if (SKIP) return;` in before() hooks
 *
 * test/no-real-browser.test.js requires every test file that shows a browser launch indicator to call
 * browserSkip() or assertBrowserTestsEnabled().
 */
import { findChromeBinary } from './headless-chrome.js';

export const BROWSER_TESTS_ENV = 'JOBSEARCH_BROWSER_TESTS';

/** @returns {boolean} true only when the operator explicitly opted in. */
export function browserTestsEnabled() {
  return process.env[BROWSER_TESTS_ENV] === '1';
}

/**
 * Skip reason for node:test's `skip` option: a string when the suite must be skipped, false when it may run.
 * @returns {string | false}
 */
export function browserSkip() {
  if (!browserTestsEnabled()) {
    return `real-browser test skipped: set ${BROWSER_TESTS_ENV}=1 to run it (it launches headless Chrome)`;
  }
  return findChromeBinary() ? false : 'no Chrome/Edge binary on this machine';
}

/** Defense in depth for helpers that launch: throws unless the operator opted in. */
export function assertBrowserTestsEnabled() {
  if (!browserTestsEnabled()) {
    throw new Error(`refusing to launch a real browser: ${BROWSER_TESTS_ENV}=1 is not set`);
  }
}
