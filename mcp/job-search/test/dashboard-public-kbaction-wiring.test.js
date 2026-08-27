// @ts-check
/**
 * Totality check for `dashboard:kbaction` consumers (independent review comment 5440498360, blocking
 * finding 1: every action lib/shortcuts.js's reducer can emit was being dispatched via
 * lib/bus.js's `emit('dashboard:kbaction', ...)` with zero subscribers anywhere in `public/`, making the
 * whole row/detail keyboard map dead code). Each page the plan's keyboard map covers now exports a
 * `KEYBOARD_ACTIONS` manifest naming, for every action TYPE the reducer can produce, either 'handled'
 * (a real case exists in that page's `onKbAction` switch) or 'not-applicable' (a deliberate no-op,
 * documented inline in that page's own switch statement). This test does not execute those handlers
 * (that requires a real DOM/browser, out of scope for node:test; see the Playwright script instead) --
 * it proves the manifest itself is total, so a future action type or a future page can never silently
 * fall through both a missing switch case AND a missing manifest entry at the same time.
 *
 * These are plain module imports (no top-level `document`/`window` access in any page module), so they
 * are safe to import directly under node:test.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as jobsPage from '../src/dashboard/public/pages/jobs.js';
import * as pipelinePage from '../src/dashboard/public/pages/pipeline.js';
import * as followupsPage from '../src/dashboard/public/pages/followups.js';
import * as reviewPage from '../src/dashboard/public/pages/review.js';
import * as runsPage from '../src/dashboard/public/pages/runs.js';
import * as jobDetailPage from '../src/dashboard/public/pages/job-detail.js';

/** Every action type lib/shortcuts.js's reduceKeyboard() can ever put on the `dashboard:kbaction` bus
 * (the 'navigate'/'focus-search'/'blur'/'open-help'/'close-help' actions are handled directly in
 * app.js, never dispatched over the bus, so they are intentionally excluded from this list). */
const REDUCER_ACTION_TYPES = Object.freeze(['row-nav', 'row-open', 'row-stage', 'digit', 'shortcut']);

const VALID_MANIFEST_VALUES = new Set(['handled', 'not-applicable']);

/** Pages the plan's keyboard map names: Jobs/Pipeline/Follow-ups/Review/Runs (list-row shortcuts) and
 * Job detail (digit/n/f). Pages outside this list (Home, Reports, Calendar, Analytics, Companies, ...)
 * are not covered by section 8's row/detail keyboard rules and are not expected to subscribe at all. */
const COVERED_PAGES = Object.freeze([
  ['jobs', jobsPage],
  ['pipeline', pipelinePage],
  ['followups', followupsPage],
  ['review', reviewPage],
  ['runs', runsPage],
  ['job-detail', jobDetailPage],
]);

describe('every page the plan covers exports a total KEYBOARD_ACTIONS manifest', () => {
  for (const [name, mod] of COVERED_PAGES) {
    test(`${name}.js exports KEYBOARD_ACTIONS with an entry for every reducer action type`, () => {
      assert.ok(mod.KEYBOARD_ACTIONS, `${name}.js does not export KEYBOARD_ACTIONS at all`);
      for (const actionType of REDUCER_ACTION_TYPES) {
        const value = mod.KEYBOARD_ACTIONS[actionType];
        assert.ok(
          VALID_MANIFEST_VALUES.has(value),
          `${name}.js's KEYBOARD_ACTIONS["${actionType}"] is ${JSON.stringify(value)}, expected "handled" or "not-applicable"`,
        );
      }
    });

    test(`${name}.js subscribes to dashboard:kbaction in its own source (not just declares a manifest)`, async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const HERE = path.dirname(fileURLToPath(import.meta.url));
      const file = path.join(HERE, '..', 'src', 'dashboard', 'public', 'pages', `${name}.js`);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(text.includes("on('dashboard:kbaction'"), `${name}.js declares KEYBOARD_ACTIONS but never calls on('dashboard:kbaction', ...)`);
      assert.ok(text.includes("off('dashboard:kbaction'"), `${name}.js subscribes but never unsubscribes in teardown (listener leak across route changes)`);
    });
  }
});

describe('at least one action per page is genuinely handled, not every page opting out of everything', () => {
  for (const [name, mod] of COVERED_PAGES) {
    test(`${name}.js's manifest has at least one "handled" entry`, () => {
      const values = Object.values(mod.KEYBOARD_ACTIONS);
      assert.ok(values.includes('handled'), `${name}.js's KEYBOARD_ACTIONS is all "not-applicable"; that would make its own subscription pointless`);
    });
  }
});

describe('row-nav is handled by every list page (Jobs, Pipeline, Follow-ups, Review, Runs)', () => {
  const listPages = COVERED_PAGES.filter(([name]) => name !== 'job-detail');
  for (const [name, mod] of listPages) {
    test(`${name}.js handles row-nav`, () => {
      assert.equal(mod.KEYBOARD_ACTIONS['row-nav'], 'handled');
    });
  }
});

describe('digit and shortcut are handled only by Job detail, per the plan\'s "detail 1-0/n/f" scope', () => {
  test('job-detail.js handles digit and shortcut', () => {
    assert.equal(jobDetailPage.KEYBOARD_ACTIONS.digit, 'handled');
    assert.equal(jobDetailPage.KEYBOARD_ACTIONS.shortcut, 'handled');
  });

  const listPages = COVERED_PAGES.filter(([name]) => name !== 'job-detail');
  for (const [name, mod] of listPages) {
    test(`${name}.js marks digit and shortcut not-applicable`, () => {
      assert.equal(mod.KEYBOARD_ACTIONS.digit, 'not-applicable');
      assert.equal(mod.KEYBOARD_ACTIONS.shortcut, 'not-applicable');
    });
  }
});
