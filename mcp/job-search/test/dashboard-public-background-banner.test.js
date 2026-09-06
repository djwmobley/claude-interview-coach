// @ts-check
/**
 * components/background-banner.js: `dismissKeyFor()` and `visibleBackgroundItems()` are the pure,
 * DOM-free half of this component (this codebase has no jsdom -- see
 * test/dashboard-public-linksafety.test.js's note on hApplicationScreenshot for the house convention: the
 * `h()`-calling render function itself, `renderBackgroundBanner()`, is exercised through the running app,
 * not a unit test). Covers dismissal-key identity (run_id vs the kind:started_at fallback) and the
 * dismissed-set filter, including the "a new run under a different identity reappears" behavior spec item
 * 4 requires.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dismissKeyFor, visibleBackgroundItems } from '../src/dashboard/public/components/background-banner.js';

describe('dismissKeyFor()', () => {
  test('a numeric run_id produces an "id:" key', () => {
    assert.equal(dismissKeyFor({ kind: 'scan', run_id: 42, started_at: '2026-09-05T06:31:00.000Z' }), 'id:42');
  });

  test('a null run_id falls back to "kind:started_at"', () => {
    assert.equal(
      dismissKeyFor({ kind: 'auto-apply', run_id: null, started_at: '2026-09-05T06:55:00.000Z' }),
      'ks:auto-apply:2026-09-05T06:55:00.000Z',
    );
  });

  test('two items of the same kind but different started_at get different keys (both null run_id)', () => {
    const a = dismissKeyFor({ kind: 'confirm', run_id: null, started_at: '2026-09-05T07:45:00.000Z' });
    const b = dismissKeyFor({ kind: 'confirm', run_id: null, started_at: '2026-09-06T07:45:00.000Z' });
    assert.notEqual(a, b);
  });
});

describe('visibleBackgroundItems()', () => {
  const scanItem = { kind: 'scan', label: 'Scheduled scan running since 06:31', run_id: 1, started_at: '2026-09-05T06:31:00.000Z' };
  const autoApplyItem = { kind: 'auto-apply', label: 'Auto-apply running', run_id: null, started_at: '2026-09-05T06:55:00.000Z' };

  test('an empty dismissed set shows everything', () => {
    assert.deepEqual(visibleBackgroundItems([scanItem, autoApplyItem], new Set()), [scanItem, autoApplyItem]);
  });

  test('a dismissed run_id-keyed item is filtered out; others remain', () => {
    const result = visibleBackgroundItems([scanItem, autoApplyItem], new Set(['id:1']));
    assert.deepEqual(result, [autoApplyItem]);
  });

  test('a dismissed kind:started_at-keyed item (null run_id) is filtered out', () => {
    const result = visibleBackgroundItems([scanItem, autoApplyItem], new Set(['ks:auto-apply:2026-09-05T06:55:00.000Z']));
    assert.deepEqual(result, [scanItem]);
  });

  test('a NEW run under a different identity is never filtered by an old dismissal (reappears)', () => {
    // The 06:55 auto-apply run was dismissed; a later run starting at 07:10 has a different key and is
    // therefore never matched by that stale dismissal -- this is the whole mechanism spec item 4's
    // "reappears for a new run" behavior relies on, with no separate bookkeeping.
    const laterRun = { ...autoApplyItem, started_at: '2026-09-05T07:10:00.000Z' };
    const result = visibleBackgroundItems([laterRun], new Set(['ks:auto-apply:2026-09-05T06:55:00.000Z']));
    assert.deepEqual(result, [laterRun]);
  });
});
