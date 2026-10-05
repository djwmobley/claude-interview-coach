// @ts-check
/**
 * src/apply/easy-apply-policy.js (assisted Easy Apply, spec G10/G11): start gate (breaker, 09:00-19:00
 * window for morning runs, spacing), jittered spacing, and per-action/per-character pacing. Fake clock
 * and fake random source throughout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EASY_APPLY_DEFAULTS, checkStartGate, nextMorningSpacingMs, actionDelayMs, charDelayMs, localMinutes,
} from '../src/apply/easy-apply-policy.js';

const TZ = 'America/Chicago';
/** 2026-10-05 is CDT (UTC-5). @param {string} hhmm */
const at = (hhmm) => new Date(`2026-10-05T${hhmm}:00-05:00`);

describe('defaults', () => {
  test('match the spec numbers', () => {
    assert.equal(EASY_APPLY_DEFAULTS.easyApplyDaily, 5);
    assert.equal(EASY_APPLY_DEFAULTS.windowStartLocal, '09:00');
    assert.equal(EASY_APPLY_DEFAULTS.windowEndLocal, '19:00');
    assert.equal(EASY_APPLY_DEFAULTS.morningSpacingMinMinutes, 20);
    assert.equal(EASY_APPLY_DEFAULTS.morningSpacingMaxMinutes, 40);
    assert.equal(EASY_APPLY_DEFAULTS.dashboardSpacingMinutes, 5);
  });
});

describe('localMinutes', () => {
  test('converts to America/Chicago wall-clock minutes', () => {
    assert.equal(localMinutes(at('09:30'), TZ), 9 * 60 + 30);
  });
});

describe('checkStartGate', () => {
  const base = { timezone: TZ, lastAttemptAt: null, breakerUntil: null, cfg: EASY_APPLY_DEFAULTS };
  test('morning trigger before 09:00 is refused outside_window', () => {
    assert.deepEqual(checkStartGate({ ...base, trigger: 'morning', now: at('08:59') }), { ok: false, reason: 'outside_window' });
  });
  test('morning trigger at 09:00 and 18:59 is allowed; 19:00 is not', () => {
    assert.equal(checkStartGate({ ...base, trigger: 'morning', now: at('09:00') }).ok, true);
    assert.equal(checkStartGate({ ...base, trigger: 'morning', now: at('18:59') }).ok, true);
    assert.deepEqual(checkStartGate({ ...base, trigger: 'morning', now: at('19:00') }), { ok: false, reason: 'outside_window' });
  });
  test('morning spacing: under 20 minutes since the last attempt is refused', () => {
    const r = checkStartGate({ ...base, trigger: 'morning', now: at('10:19'), lastAttemptAt: at('10:00') });
    assert.deepEqual(r, { ok: false, reason: 'spacing' });
    assert.equal(checkStartGate({ ...base, trigger: 'morning', now: at('10:20'), lastAttemptAt: at('10:00') }).ok, true);
  });
  test('dashboard trigger ignores the window but enforces a 5-minute minimum spacing', () => {
    assert.equal(checkStartGate({ ...base, trigger: 'dashboard', now: at('22:00') }).ok, true);
    assert.deepEqual(checkStartGate({ ...base, trigger: 'dashboard', now: at('22:04'), lastAttemptAt: at('22:00') }), { ok: false, reason: 'spacing' });
    assert.equal(checkStartGate({ ...base, trigger: 'dashboard', now: at('22:05'), lastAttemptAt: at('22:00') }).ok, true);
  });
  test('an active breaker refuses every trigger; an expired one does not', () => {
    assert.deepEqual(checkStartGate({ ...base, trigger: 'dashboard', now: at('12:00'), breakerUntil: at('13:00') }), { ok: false, reason: 'breaker' });
    assert.equal(checkStartGate({ ...base, trigger: 'dashboard', now: at('12:00'), breakerUntil: at('11:00') }).ok, true);
  });
  test('an unknown trigger is refused (total)', () => {
    assert.deepEqual(checkStartGate({ ...base, trigger: /** @type {any} */ ('cron'), now: at('12:00') }), { ok: false, reason: 'unknown_trigger' });
  });
});

describe('jitter and pacing', () => {
  test('morning spacing is 20-40 minutes', () => {
    assert.equal(nextMorningSpacingMs(() => 0), 20 * 60000);
    const top = nextMorningSpacingMs(() => 0.999999);
    assert.ok(top < 40 * 60000 && top > 39 * 60000, String(top));
  });
  test('action delay is 1.5-4 s', () => {
    assert.equal(actionDelayMs(() => 0), 1500);
    assert.ok(actionDelayMs(() => 0.999999) < 4000);
  });
  test('character delay is 60-160 ms', () => {
    assert.equal(charDelayMs(() => 0), 60);
    assert.ok(charDelayMs(() => 0.999999) < 160);
  });
});
