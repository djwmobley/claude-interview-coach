// @ts-check
/**
 * src/core/config.js's autoApplySchema (auto-apply PR B extension of one-click apply PR A's schema):
 * probeCapPerSource, probeRowCap, reprobeAfterHours, lockMinutes, pollSeconds default sensibly, reject an
 * unknown key (zod's default `strict` behavior on z.object is actually to strip unknown keys, not reject
 * them -- this file asserts the ACTUAL behavior rather than assuming strict mode, see the note on the
 * "unknown key" test below), and reject a negative/zero cap on every new positive-int field.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { autoApplySchema } from '../src/core/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('shipped config/auto-apply.json fit floors (operator decision 2026-10-04)', () => {
  test('fitFloor and probeFitFloor are both 60 and match each other', () => {
    const shippedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'auto-apply.json');
    const shipped = autoApplySchema.parse(JSON.parse(fs.readFileSync(shippedPath, 'utf8')));
    assert.equal(shipped.fitFloor, 60);
    assert.equal(shipped.probeFitFloor, 60);
  });

  test('unblock Item 3: probeRowCap 30 and probeTimeBudgetMs 900000; probeFitFloor stays 60', () => {
    const shippedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'auto-apply.json');
    const shipped = autoApplySchema.parse(JSON.parse(fs.readFileSync(shippedPath, 'utf8')));
    assert.equal(shipped.probeRowCap, 30);
    assert.equal(shipped.probeTimeBudgetMs, 900000);
    assert.equal(shipped.probeFitFloor, 60);
  });

  test('unblock Items 1-2: approvedDriver ships enabled (schema default off), reroute on, both maxPerRun 5', () => {
    const shippedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'auto-apply.json');
    const shipped = autoApplySchema.parse(JSON.parse(fs.readFileSync(shippedPath, 'utf8')));
    assert.deepEqual(shipped.approvedDriver, { enabled: true, maxPerRun: 5 });
    assert.deepEqual(shipped.reroute, { enabled: true, maxPerRun: 5 });
    const defaults = autoApplySchema.parse({});
    assert.deepEqual(defaults.approvedDriver, { enabled: false, maxPerRun: 5 });
    assert.deepEqual(defaults.reroute, { enabled: true, maxPerRun: 5 });
    assert.equal(defaults.dailyCap, 5, 'dailyCap untouched');
  });
});

describe('shipped config/triage.json (unblock Item 4)', () => {
  test('scoreFloor 20, backlogPerRun 60, maxListingsPerRun 200, maxBatchesPerRun 15', () => {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'triage.json');
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(t.model.scoreFloor, 20);
    assert.equal(t.model.backlogPerRun, 60);
    assert.equal(t.model.maxListingsPerRun, 200);
    assert.equal(t.model.maxBatchesPerRun, 15);
    assert.equal(t.deterministic.floor, 40, 'the deterministic floor (sticky-skip, scope) is unchanged');
  });
});

const BASE = {
  fitFloor: 70,
  dailyCap: 5,
  atsAllow: ['greenhouse'],
  floors: { texas_or_remote: 225000, relocation: 275000 },
};

describe('autoApplySchema: new probe/lock fields', () => {
  test('defaults apply when the whole object is empty', () => {
    const parsed = autoApplySchema.parse({});
    assert.equal(parsed.probeCapPerSource, 10);
    assert.equal(parsed.probeRowCap, 3);
    assert.equal(parsed.reprobeAfterHours, 48);
    assert.equal(parsed.lockMinutes, 40);
    assert.equal(parsed.pollSeconds, 30);
  });

  test('an explicit value for every new field parses through unchanged', () => {
    const parsed = autoApplySchema.parse({
      ...BASE, probeCapPerSource: 20, probeRowCap: 5, reprobeAfterHours: 24, lockMinutes: 10, pollSeconds: 15,
    });
    assert.equal(parsed.probeCapPerSource, 20);
    assert.equal(parsed.probeRowCap, 5);
    assert.equal(parsed.reprobeAfterHours, 24);
    assert.equal(parsed.lockMinutes, 10);
    assert.equal(parsed.pollSeconds, 15);
  });

  test('a field this schema does not declare is stripped, not preserved on the parsed object', () => {
    // z.object() strips unrecognized keys by default (it does not throw for them) -- this test documents
    // the real, observed behavior rather than assuming .strict() semantics that this schema does not opt
    // into anywhere else in this file (config.js never calls .strict() on any of its object schemas).
    const parsed = /** @type {any} */ (autoApplySchema.parse({ ...BASE, notARealField: 'nope' }));
    assert.equal(parsed.notARealField, undefined);
  });

  for (const field of ['probeCapPerSource', 'probeRowCap', 'reprobeAfterHours', 'lockMinutes', 'pollSeconds']) {
    test(`${field}: zero is rejected (must be positive)`, () => {
      const result = autoApplySchema.safeParse({ ...BASE, [field]: 0 });
      assert.equal(result.success, false);
    });
    test(`${field}: a negative value is rejected`, () => {
      const result = autoApplySchema.safeParse({ ...BASE, [field]: -1 });
      assert.equal(result.success, false);
    });
    test(`${field}: a non-integer value is rejected`, () => {
      const result = autoApplySchema.safeParse({ ...BASE, [field]: 1.5 });
      assert.equal(result.success, false);
    });
  }
});

describe('autoApplySchema: scan-wait fields (spec amendments A2/A3)', () => {
  test('defaults apply when the whole object is empty', () => {
    const parsed = autoApplySchema.parse({});
    assert.equal(parsed.waitForScan, true);
    assert.equal(parsed.waitDeadlineLocal, '07:40');
    assert.equal(parsed.waitHardDeadlineLocal, '07:55');
    assert.equal(parsed.waitPollSeconds, 60);
    assert.equal(parsed.waitStaleHeartbeatMinutes, 10);
    assert.equal(parsed.probeFitFloor, 70);
    assert.equal(parsed.probeRowCapWithBrowser, 40);
    assert.equal(parsed.probeTimeBudgetMs, 600000);
  });

  test('explicit values parse through unchanged', () => {
    const parsed = autoApplySchema.parse({
      ...BASE, waitForScan: false, waitDeadlineLocal: '06:15', waitHardDeadlineLocal: '06:45',
      waitPollSeconds: 15, waitStaleHeartbeatMinutes: 5, probeFitFloor: 60, probeRowCapWithBrowser: 20,
      probeTimeBudgetMs: 300000,
    });
    assert.equal(parsed.waitForScan, false);
    assert.equal(parsed.waitDeadlineLocal, '06:15');
    assert.equal(parsed.waitHardDeadlineLocal, '06:45');
    assert.equal(parsed.waitPollSeconds, 15);
    assert.equal(parsed.waitStaleHeartbeatMinutes, 5);
    assert.equal(parsed.probeFitFloor, 60);
    assert.equal(parsed.probeRowCapWithBrowser, 20);
    assert.equal(parsed.probeTimeBudgetMs, 300000);
  });

  for (const field of ['waitDeadlineLocal', 'waitHardDeadlineLocal']) {
    test(`${field}: must be "HH:MM", garbage is rejected`, () => {
      assert.equal(autoApplySchema.safeParse({ ...BASE, [field]: 'not-a-time' }).success, false);
      assert.equal(autoApplySchema.safeParse({ ...BASE, [field]: '7:05' }).success, true); // single-digit hour is fine, minute must be 2 digits
      assert.equal(autoApplySchema.safeParse({ ...BASE, [field]: '07:5' }).success, false); // single-digit minute is not
    });
  }

  test('probeFitFloor: out of 0-100 range is rejected', () => {
    assert.equal(autoApplySchema.safeParse({ ...BASE, probeFitFloor: -1 }).success, false);
    assert.equal(autoApplySchema.safeParse({ ...BASE, probeFitFloor: 101 }).success, false);
  });

  for (const field of ['waitPollSeconds', 'waitStaleHeartbeatMinutes', 'probeRowCapWithBrowser', 'probeTimeBudgetMs']) {
    test(`${field}: zero/negative is rejected (must be positive)`, () => {
      assert.equal(autoApplySchema.safeParse({ ...BASE, [field]: 0 }).success, false);
      assert.equal(autoApplySchema.safeParse({ ...BASE, [field]: -1 }).success, false);
    });
  }
});
