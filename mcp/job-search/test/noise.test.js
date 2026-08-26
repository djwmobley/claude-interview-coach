// @ts-check
/**
 * Noise classification (spec R2): total classification, fixed rule order via config priority, and the
 * must-NOT-match adversarial cases the binding decisions were written to fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyNoise, weightedPrescore, lintNoiseFixtures, NOISE_CLASSES, _resetNoiseDefaults } from '../src/core/noise.js';
import { noiseRulesSchema, NOISE_RULE_CLASSES } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, '..', 'config');

const RULES = /** @type {any} */ (JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'noise-rules.json'), 'utf8')));
const FIXTURES = /** @type {any[]} */ (JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'noise-fixtures.json'), 'utf8')));
const KNOWN = new Set(['greenhouse', 'lever', 'workday', 'dayforce', 'exec', 'indeed', 'linkedin', 'gmail']);

describe('noiseRulesSchema validates the real config/noise-rules.json', () => {
  test('parses and every rule has a distinct priority', () => {
    const r = noiseRulesSchema.safeParse(RULES);
    assert.equal(r.success, true, r.success ? '' : JSON.stringify(r.error.issues));
  });
  test('rejects two rules sharing a priority (decision 5/8: no positional dependence)', () => {
    const bad = { ...RULES, rules: RULES.rules.map((r) => ({ ...r, priority: 1 })) };
    const r = noiseRulesSchema.safeParse(bad);
    assert.equal(r.success, false);
  });
  test('rejects a rule with no priority field', () => {
    const bad = { ...RULES, rules: [{ class: 'suspect' }] };
    const r = noiseRulesSchema.safeParse(bad);
    assert.equal(r.success, false);
  });
  test('rejects multipliers missing a noise class', () => {
    const bad = { ...RULES, multipliers: { ok: 1 } };
    const r = noiseRulesSchema.safeParse(bad);
    assert.equal(r.success, false);
  });
});

describe('config/noise-fixtures.json all pass against config/noise-rules.json (decision 8)', () => {
  test('lintNoiseFixtures reports zero failures', () => {
    const r = lintNoiseFixtures(RULES, FIXTURES, { knownSources: KNOWN });
    assert.deepEqual(r.failures, []);
    assert.equal(r.ok, true);
  });
  test('every fixture exercised individually', () => {
    for (const f of FIXTURES) {
      const actual = classifyNoise(f.listing, { rules: RULES, knownSources: KNOWN });
      assert.equal(actual, f.expected_class, `${f.name}: expected ${f.expected_class}, got ${actual}`);
    }
  });
});

describe('classifyNoise: rule order (decision 5) and total classification', () => {
  test('aggregator_repost checked before fractional_or_founder before staffing_generic before suspect', () => {
    // A row that could match BOTH fractional_or_founder (title) and staffing_generic (company alias)
    // resolves to fractional_or_founder because it is evaluated first (priority 20 < 30) -- this is
    // exactly adversary finding 5's "Interim CTO for Staffing Solutions Group" case.
    const rec = { source: 'exec', title: 'Interim CTO for Staffing Solutions Group', company_norm: 'staffing solutions group' };
    assert.equal(classifyNoise(rec, { rules: RULES, knownSources: KNOWN }), 'fractional_or_founder');
  });
  test('every value classifyNoise can return is in NOISE_CLASSES (total classification)', () => {
    const cases = [
      { source: 'greenhouse', title: 'CTO', company_norm: 'acme' },
      { source: 'manual', title: 'CTO', company_norm: 'acme' },
      { source: '', title: 'CTO', company_norm: 'acme' },
      { source: null, title: 'CTO', company_norm: 'acme' },
      { source: 'weird-unlisted-source', title: 'CTO', company_norm: 'acme' },
    ];
    for (const c of cases) assert.ok(NOISE_CLASSES.includes(classifyNoise(c, { rules: RULES, knownSources: KNOWN })));
  });
  test('NOISE_RULE_CLASSES excludes the terminal source-check outcomes', () => {
    assert.equal(NOISE_RULE_CLASSES.includes('ok'), false);
    assert.equal(NOISE_RULE_CLASSES.includes('ok_manual'), false);
    assert.equal(NOISE_RULE_CLASSES.includes('unknown_source'), false);
  });
});

describe('classifyNoise: must-NOT-match cases (adversarial)', () => {
  test('fractional_or_founder never scans company_norm (adversary finding 1)', () => {
    const rec = { source: 'greenhouse', title: 'Chief Technology Officer', company_norm: 'founding farmers restaurant group' };
    assert.notEqual(classifyNoise(rec, { rules: RULES, knownSources: KNOWN }), 'fractional_or_founder');
  });
  test('a native adapter posting with an "(est.)" salary marker is never aggregator_repost (adversary finding 6)', () => {
    const rec = { source: 'greenhouse', title: 'CTO', company_norm: 'acme', url_normalized: 'https://boards.greenhouse.io/acme/jobs/1', salary_raw: '$180K-$220K (est. based on level)' };
    assert.notEqual(classifyNoise(rec, { rules: RULES, knownSources: KNOWN }), 'aggregator_repost');
  });
  test('a staffing-firm posting with a direct-hire description signal is never staffing_generic (adversary finding 3)', () => {
    const rec = { source: 'linkedin', title: 'CTO', company_norm: 'robert half international', description: 'We are hiring for our own internal platform team.' };
    assert.notEqual(classifyNoise(rec, { rules: RULES, knownSources: KNOWN }), 'staffing_generic');
  });
  test('"Virtual CTO" is never silently ok (adversary finding 7): it is suspect, not fractional_or_founder', () => {
    const rec = { source: 'exec', title: 'Virtual CTO', company_norm: 'acme corp' };
    const c = classifyNoise(rec, { rules: RULES, knownSources: KNOWN });
    assert.equal(c, 'suspect');
    assert.notEqual(c, 'ok');
    assert.notEqual(c, 'fractional_or_founder');
  });
  test('source comparison is case/whitespace insensitive (adversary finding 4)', () => {
    assert.equal(classifyNoise({ source: ' GreenHouse ', title: 'CTO', company_norm: 'acme' }, { rules: RULES, knownSources: KNOWN }), 'ok');
  });
});

describe('weightedPrescore', () => {
  test('applies the configured multiplier and rounds like prescore()', () => {
    assert.equal(weightedPrescore(80, 'ok', { rules: RULES }), 80);
    assert.equal(weightedPrescore(80, 'aggregator_repost', { rules: RULES }), 48);
    assert.equal(weightedPrescore(70, 'fractional_or_founder', { rules: RULES }), 35);
  });
  test('clamps to 0-100', () => {
    assert.equal(weightedPrescore(100, 'ok', { rules: RULES }), 100);
    assert.equal(weightedPrescore(0, 'staffing_generic', { rules: RULES }), 0);
  });
});

describe('getDefaultNoiseRules / getDefaultKnownSources fall back without a config directory', () => {
  test('classifyNoise still returns a total classification with no opts (uses real config or a built-in fallback)', () => {
    _resetNoiseDefaults();
    const c = classifyNoise({ source: 'unknown-thing', title: 'CTO', company_norm: 'acme' });
    assert.ok(NOISE_CLASSES.includes(c));
    _resetNoiseDefaults();
  });
});
