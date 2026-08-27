// @ts-check
/** Pure formatting function tests (pr3-spec-decisions.md section 12 item 2). No DOM required. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, ageDays, agingBucket, scoreBucket, shortDate, salaryRange, formatMoney, pluralize, truncate, sourceLabel, formatPercent } from '../src/dashboard/public/lib/format.js';

describe('relativeTime', () => {
  test('fixed-input cases', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    assert.equal(relativeTime(null, now), 'unknown');
    assert.equal(relativeTime(undefined, now), 'unknown');
    assert.equal(relativeTime('not a date', now), 'unknown');
    assert.equal(relativeTime(new Date('2026-08-27T11:59:30Z'), now), 'just now');
    assert.equal(relativeTime(new Date('2026-08-27T11:30:00Z'), now), '30m ago');
    assert.equal(relativeTime(new Date('2026-08-27T09:00:00Z'), now), '3h ago');
    assert.equal(relativeTime(new Date('2026-08-25T12:00:00Z'), now), '2d ago');
    assert.equal(relativeTime(new Date('2026-08-27T12:30:00Z'), now), 'in 30m');
  });
});

describe('ageDays / agingBucket', () => {
  test('null and zero-clamped inputs', () => {
    const now = new Date('2026-08-27T00:00:00Z');
    assert.equal(ageDays(null, now), null);
    assert.equal(ageDays(new Date('2026-08-30T00:00:00Z'), now), 0);
    assert.equal(ageDays(new Date('2026-08-20T00:00:00Z'), now), 7);
  });

  test('bucket thresholds: under 7 / 7-14 / over 14', () => {
    assert.equal(agingBucket(null), 'fresh');
    assert.equal(agingBucket(0), 'fresh');
    assert.equal(agingBucket(6), 'fresh');
    assert.equal(agingBucket(7), 'aging');
    assert.equal(agingBucket(14), 'aging');
    assert.equal(agingBucket(15), 'stale');
  });
});

describe('scoreBucket', () => {
  test('thresholds: >=85 good, >=70 ok, else low, missing treated as low', () => {
    assert.equal(scoreBucket(null), 'low');
    assert.equal(scoreBucket(undefined), 'low');
    assert.equal(scoreBucket(69), 'low');
    assert.equal(scoreBucket(70), 'ok');
    assert.equal(scoreBucket(84), 'ok');
    assert.equal(scoreBucket(85), 'good');
    assert.equal(scoreBucket(100), 'good');
  });
});

describe('shortDate / salaryRange / formatMoney', () => {
  test('missing/invalid inputs never throw', () => {
    assert.equal(shortDate(null), 'not set');
    assert.equal(shortDate('not a date'), 'not set');
    assert.equal(formatMoney(null), 'not listed');
    assert.equal(salaryRange(null, null), 'not listed');
    assert.equal(salaryRange(100000, null), '$100,000');
    assert.equal(salaryRange(100000, 120000), '$100,000 to $120,000');
    assert.equal(salaryRange(100000, 100000), '$100,000');
  });
});

describe('pluralize / truncate', () => {
  test('pluralize', () => {
    assert.equal(pluralize(1, 'item'), '1 item');
    assert.equal(pluralize(2, 'item'), '2 items');
    assert.equal(pluralize(0, 'item'), '0 items');
  });

  test('truncate never exceeds max length', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.equal(truncate('hello world this is long', 10).length, 10);
  });
});

describe('sourceLabel: totality over known and unknown sources', () => {
  test('known sources', () => {
    assert.equal(sourceLabel('greenhouse'), 'Greenhouse');
    assert.equal(sourceLabel('ziprecruiter'), 'ZipRecruiter');
    assert.equal(sourceLabel('manual'), 'Manual');
  });

  test('unknown source falls back to title-cased raw value, never blank', () => {
    assert.equal(sourceLabel('some-new-board'), 'Some-new-board');
    assert.equal(sourceLabel(null), 'Unknown');
    assert.equal(sourceLabel(undefined), 'Unknown');
  });
});

describe('formatPercent', () => {
  test('null/undefined/NaN render as a fixed no-data phrase, never NaN%', () => {
    assert.equal(formatPercent(null), 'not enough data yet');
    assert.equal(formatPercent(undefined), 'not enough data yet');
    assert.equal(formatPercent(0.5), '50%');
    assert.equal(formatPercent(1), '100%');
  });
});
