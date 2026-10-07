// @ts-check
/**
 * config/auto-apply.json readyToApply block (Ready to apply list, spec section 12 as amended by R6, A9,
 * A10): defaults, the shipped values, and the resume daily cap's HARD ceiling (A10: a config value above
 * it fails config load; there is no override anywhere).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoApplySchema, READY_RESUME_HARD_CEILING } from '../src/core/config.js';

const SHIPPED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'auto-apply.json');

describe('readyToApply config block', () => {
  test('defaults when absent', () => {
    const d = autoApplySchema.parse({}).readyToApply;
    assert.equal(d.enabled, true);
    assert.equal(d.fitFloor, null);
    assert.equal(d.includeEasyApply, true);
    assert.equal(d.noControlRepeatToList, 2);
    assert.equal(d.noControlHoldMaxDays, 3);
    assert.equal(d.staleDays, 21);
    assert.equal(d.autoStallRuns, 2);
    assert.equal(d.driftThreshold, 0.4);
    assert.equal(d.resume.dailyCap, 10);
    assert.equal(d.resume.maxAttempts, 2);
  });

  test('the hard ceiling is 10 and a dailyCap above it is refused', () => {
    assert.equal(READY_RESUME_HARD_CEILING, 10);
    assert.equal(autoApplySchema.safeParse({ readyToApply: { resume: { dailyCap: 11 } } }).success, false);
    assert.equal(autoApplySchema.safeParse({ readyToApply: { resume: { maxAttempts: 3 } } }).success, false);
    assert.equal(autoApplySchema.safeParse({ readyToApply: { driftThreshold: 1.5 } }).success, false);
  });

  test('the shipped file carries the block: enabled, Easy Apply listed (R7), cap 10 (R6)', () => {
    const shipped = autoApplySchema.parse(JSON.parse(fs.readFileSync(SHIPPED, 'utf8')));
    assert.equal(shipped.readyToApply.enabled, true);
    assert.equal(shipped.readyToApply.includeEasyApply, true);
    assert.equal(shipped.readyToApply.resume.dailyCap, 10);
    assert.equal(shipped.readyToApply.resume.enabled, true);
  });
});
