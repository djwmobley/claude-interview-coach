// @ts-check
/**
 * config/target-rules.json lint and fixture replay (also run by bin/config-lock.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintTargetRules, EMITTABLE_RULES, STEP_IDS, targetRulesSchema } from '../src/core/target-classify.js';
import { CONFIG_FILES } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, '..', 'config');
/** @param {string} name */
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, name), 'utf8'));
const clone = (/** @type {any} */ x) => JSON.parse(JSON.stringify(x));

describe('target-rules.json', () => {
  test('the shipped rules and fixtures lint clean', () => {
    const r = lintTargetRules(readJson('target-rules.json'), readJson('target-rules-fixtures.json'));
    assert.deepEqual(r.failures, []);
    assert.ok(r.fixtureCount >= 15);
  });
  test('every step has a distinct integer priority, and the file order is irrelevant', () => {
    const rules = readJson('target-rules.json');
    const prios = rules.steps.map((/** @type {any} */ s) => s.priority);
    assert.ok(prios.every(Number.isInteger));
    assert.equal(new Set(prios).size, prios.length);
    assert.deepEqual(rules.steps.map((/** @type {any} */ s) => s.id).sort(), [...STEP_IDS].sort());
  });
  test('verdict_rules are exactly the rules the classifier can emit, each with one class', () => {
    const rules = readJson('target-rules.json');
    assert.deepEqual(rules.verdict_rules.map((/** @type {any} */ r) => r.rule).sort(), [...EMITTABLE_RULES].sort());
    assert.equal(rules.verdict_rules.filter((/** @type {any} */ r) => r.class === 'target').length, 1);
  });
  test('the windows are the approved 120 / 120 / 60 days', () => {
    assert.deepEqual(readJson('target-rules.json').params.windows_days, { pe_deal: 120, exec_departure: 120, leadership_gap: 60 });
  });
  test('target-rules.json is config-locked; the fixtures and blocked-affiliates files are not', () => {
    assert.ok(CONFIG_FILES.includes('target-rules.json'));
    assert.ok(!CONFIG_FILES.includes('target-rules-fixtures.json'));
    assert.ok(!CONFIG_FILES.includes('blocked-affiliates.json'));
    const lock = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.lock.json'), 'utf8'));
    assert.ok(lock.files.includes('target-rules.json'));
  });

  describe('the lint actually fails on drift', () => {
    test('a duplicate step priority fails schema validation', () => {
      const rules = clone(readJson('target-rules.json'));
      rules.steps[1].priority = rules.steps[0].priority;
      assert.equal(targetRulesSchema.safeParse(rules).success, false);
      assert.equal(lintTargetRules(rules, readJson('target-rules-fixtures.json')).ok, false);
    });
    test('a non-integer or missing priority fails', () => {
      const a = clone(readJson('target-rules.json'));
      a.steps[0].priority = 1.5;
      assert.equal(lintTargetRules(a, readJson('target-rules-fixtures.json')).ok, false);
      const b = clone(readJson('target-rules.json'));
      delete b.steps[0].priority;
      assert.equal(lintTargetRules(b, readJson('target-rules-fixtures.json')).ok, false);
    });
    test('a rule missing from verdict_rules, and an extra rule, both fail', () => {
      const missing = clone(readJson('target-rules.json'));
      missing.verdict_rules = missing.verdict_rules.filter((/** @type {any} */ r) => r.rule !== 'date_stale');
      assert.ok(lintTargetRules(missing, readJson('target-rules-fixtures.json')).failures.some((f) => f.includes('date_stale')));
      const extra = clone(readJson('target-rules.json'));
      extra.verdict_rules.push({ rule: 'made_up', step: 'size', class: 'target' });
      assert.ok(lintTargetRules(extra, readJson('target-rules-fixtures.json')).failures.some((f) => f.includes('made_up')));
    });
    test('a step with no handler, and a missing step, both fail', () => {
      const extra = clone(readJson('target-rules.json'));
      extra.steps.push({ id: 'mystery', priority: 50 });
      assert.ok(lintTargetRules(extra, readJson('target-rules-fixtures.json')).failures.some((f) => f.includes('mystery')));
      const gone = clone(readJson('target-rules.json'));
      gone.steps = gone.steps.filter((/** @type {any} */ s) => s.id !== 'size');
      assert.ok(lintTargetRules(gone, readJson('target-rules-fixtures.json')).failures.some((f) => f.includes('size')));
    });
    test('final must be last and trigger_kind first', () => {
      const r = clone(readJson('target-rules.json'));
      r.steps.find((/** @type {any} */ s) => s.id === 'final').priority = 5;
      assert.ok(lintTargetRules(r, readJson('target-rules-fixtures.json')).failures.some((f) => f.includes('final step')));
    });
    test('a fixture whose expectation no longer holds fails, naming it', () => {
      const fx = clone(readJson('target-rules-fixtures.json'));
      fx.fixtures[0].expected_class = 'not-target';
      const r = lintTargetRules(readJson('target-rules.json'), fx);
      assert.equal(r.ok, false);
      assert.ok(r.failures[0].includes(fx.fixtures[0].name));
    });
    test('a changed window changes fixture outcomes and is caught', () => {
      const rules = clone(readJson('target-rules.json'));
      rules.params.windows_days.pe_deal = 10;
      assert.equal(lintTargetRules(rules, readJson('target-rules-fixtures.json')).ok, false);
    });
    test('an empty or malformed fixture document fails', () => {
      assert.equal(lintTargetRules(readJson('target-rules.json'), {}).ok, false);
      assert.equal(lintTargetRules(readJson('target-rules.json'), { now: '2026-10-15', base: {}, fixtures: [] }).ok, false);
      assert.equal(lintTargetRules(readJson('target-rules.json'), null).ok, false);
    });
  });
});
