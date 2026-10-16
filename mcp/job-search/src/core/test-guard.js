// @ts-check
/**
 * Runtime guard (2026-10-15): production code that can start a real browser, an OS URL handler, or a
 * real process-control call against Chrome must call assertRealBrowserAllowed() immediately before the
 * real launch. Under the test runner (NODE_TEST_CONTEXT set by `node --test`, or the JOBSEARCH_TEST_GUARD=1
 * marker bin/run-tests.js sets) the call throws real_browser_blocked_in_tests unless the operator opted in
 * with JOBSEARCH_BROWSER_TESTS=1. Injected spawns and fakes never reach the guard. Outside the test runner
 * this is a no-op, so production behavior is unchanged.
 */

export const REAL_BROWSER_BLOCKED = 'real_browser_blocked_in_tests';

export class RealBrowserBlockedError extends Error {
  /** @param {string} what */
  constructor(what) {
    super(`${REAL_BROWSER_BLOCKED}: refusing to ${what} under the test runner; inject a fake, or set JOBSEARCH_BROWSER_TESTS=1 to run real-browser tests by hand`);
    this.name = 'RealBrowserBlockedError';
    this.code = REAL_BROWSER_BLOCKED;
  }
}

/** @param {NodeJS.ProcessEnv} [env] @returns {boolean} true when running under the test runner without opt-in. */
export function realBrowserBlocked(env = process.env) {
  const underTests = Boolean(env.NODE_TEST_CONTEXT) || env.JOBSEARCH_TEST_GUARD === '1';
  return underTests && env.JOBSEARCH_BROWSER_TESTS !== '1';
}

/**
 * @param {string} what short description of the real launch, used in the error message
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertRealBrowserAllowed(what, env = process.env) {
  if (realBrowserBlocked(env)) throw new RealBrowserBlockedError(what);
}
