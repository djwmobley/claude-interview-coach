// @ts-check
/**
 * components/run-scan-drawer.js: computeGoogleAuthBadgeState() and nextGoogleReauthClickState() are the
 * pure, DOM-free halves of the Google auth row added for the 2026-09-17 incident follow-up (this
 * codebase has no jsdom -- see test/dashboard-public-linksafety.test.js's note on hApplicationScreenshot
 * for the house convention: the `h()`-calling render function itself is exercised through the running
 * app, not a unit test). Covers the category-to-badge total classification (never branching on the raw
 * `state` string), the running/last-attempt line formatting, and the post-click outcome classification.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeGoogleAuthBadgeState, nextGoogleReauthClickState } from '../src/dashboard/public/components/run-scan-drawer.js';

describe('computeGoogleAuthBadgeState(): category -> badge/button total classification', () => {
  test('category "ok": green/ok tone, no Re-authorize button', () => {
    const s = computeGoogleAuthBadgeState({ category: 'ok', state: 'ok', reauth: { running: false } });
    assert.equal(s.tone, 'ok');
    assert.equal(s.showReauthButton, false);
    assert.equal(s.reauthButtonEnabled, false);
    assert.match(s.message, /connected/i);
  });

  test('category "broken": error tone, message includes the raw state text, Re-authorize enabled', () => {
    const s = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: false } });
    assert.equal(s.tone, 'error');
    assert.equal(s.showReauthButton, true);
    assert.equal(s.reauthButtonEnabled, true);
    assert.match(s.message, /broken_invalid_grant/);
  });

  test('an unrecognized category string: neutral tone, "state unknown" message, Re-authorize enabled', () => {
    const s = computeGoogleAuthBadgeState({ category: 'some_future_category', state: 'brand_new_state', reauth: {} });
    assert.equal(s.tone, 'neutral');
    assert.equal(s.showReauthButton, true);
    assert.equal(s.reauthButtonEnabled, true);
    assert.match(s.message, /state unknown/i);
    assert.match(s.message, /brand_new_state/);
  });

  test('a missing category field (e.g. an old server): neutral tone, never throws', () => {
    const s = computeGoogleAuthBadgeState({ state: 'ok' });
    assert.equal(s.tone, 'neutral');
    assert.equal(s.showReauthButton, true);
  });

  test('body === null (a failed GET: network error, unparsable, non-2xx): neutral tone, "no response"', () => {
    const s = computeGoogleAuthBadgeState(null);
    assert.equal(s.tone, 'neutral');
    assert.equal(s.showReauthButton, true);
    assert.match(s.message, /no response/i);
  });

  test('reauth.running disables the Re-authorize button even when category is broken', () => {
    const s = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: true, pid: 4242, startedAt: '2026-09-17T15:10:00.000Z', waitsUntil: '2026-09-17T16:10:00.000Z' } });
    assert.equal(s.showReauthButton, true);
    assert.equal(s.reauthButtonEnabled, false);
  });

  test('runningLine formats pid, started time, and waits-until time as HH:MM', () => {
    const s = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: true, pid: 4242, startedAt: '2026-09-17T15:10:00.000Z', waitsUntil: '2026-09-17T16:10:00.000Z' } });
    assert.ok(s.runningLine);
    assert.match(/** @type {string} */ (s.runningLine), /pid 4242/);
    assert.match(/** @type {string} */ (s.runningLine), /running since/i);
    assert.match(/** @type {string} */ (s.runningLine), /waits until/i);
  });

  test('runningLine is null when reauth.running is false', () => {
    const s = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: false } });
    assert.equal(s.runningLine, null);
  });

  test('lastAttemptLine shows only when NOT running AND category is not ok AND lastOutcome is set', () => {
    const shown = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: false, lastOutcome: 'timeout', lastOutcomeAt: '2026-09-17T14:00:00.000Z' } });
    assert.ok(shown.lastAttemptLine);
    assert.match(/** @type {string} */ (shown.lastAttemptLine), /timeout/);

    const hiddenWhileRunning = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: true, lastOutcome: 'timeout', lastOutcomeAt: '2026-09-17T14:00:00.000Z' } });
    assert.equal(hiddenWhileRunning.lastAttemptLine, null);

    const hiddenWhenOk = computeGoogleAuthBadgeState({ category: 'ok', state: 'ok', reauth: { running: false, lastOutcome: 'reauthorized', lastOutcomeAt: '2026-09-17T14:00:00.000Z' } });
    assert.equal(hiddenWhenOk.lastAttemptLine, null);

    const hiddenWhenNoOutcome = computeGoogleAuthBadgeState({ category: 'broken', state: 'broken_invalid_grant', reauth: { running: false, lastOutcome: null } });
    assert.equal(hiddenWhenNoOutcome.lastAttemptLine, null);
  });
});

describe('nextGoogleReauthClickState(): total classification of the POST outcome', () => {
  test('outcome.kind !== "ok" (network error, unparsable, etc.): re-enable, no toast, no inline', () => {
    const r = nextGoogleReauthClickState({ kind: 'network_error' });
    assert.deepEqual(r, { reenable: true, toast: null, inline: null });
  });

  test('started:true -> disabled, toast tells the operator to Recheck', () => {
    const r = nextGoogleReauthClickState({ kind: 'ok', body: { started: true, reason: null, pid: 4242 } });
    assert.equal(r.reenable, false);
    assert.match(/** @type {string} */ (r.toast), /Recheck/);
    assert.equal(r.inline, null);
  });

  test('started:false, reason lock_held -> stays disabled, inline explanation, no toast', () => {
    const r = nextGoogleReauthClickState({ kind: 'ok', body: { started: false, reason: 'lock_held', pid: 111 } });
    assert.equal(r.reenable, false);
    assert.equal(r.toast, null);
    assert.match(/** @type {string} */ (r.inline), /already running/i);
  });

  test('started:false, any other reason (not_configured/already_ok/already_starting/spawn_failed) -> re-enables with an inline reason', () => {
    for (const reason of ['not_configured', 'already_ok', 'already_starting', 'spawn_failed']) {
      const r = nextGoogleReauthClickState({ kind: 'ok', body: { started: false, reason } });
      assert.equal(r.reenable, true, reason);
      assert.equal(r.toast, null, reason);
      assert.match(/** @type {string} */ (r.inline), new RegExp(reason), reason);
    }
  });
});
