// @ts-check
/** Pure request-body builder for the Home "Run scan" options drawer. No DOM required. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanRequestBody } from '../src/dashboard/public/lib/scan-options.js';

describe('buildScanRequestBody', () => {
  test('default: no checked map given, every source enabled, dryRun off', () => {
    assert.deepEqual(
      buildScanRequestBody({ allSources: ['greenhouse', 'lever'] }),
      { sources: ['greenhouse', 'lever'], dryRun: false },
    );
  });

  test('a source explicitly unchecked (checked[name] === false) is excluded', () => {
    assert.deepEqual(
      buildScanRequestBody({ allSources: ['greenhouse', 'lever', 'indeed'], checked: { indeed: false } }),
      { sources: ['greenhouse', 'lever'], dryRun: false },
    );
  });

  test('matches the verification step exactly: only greenhouse and lever checked, dryRun on', () => {
    assert.deepEqual(
      buildScanRequestBody({
        allSources: ['greenhouse', 'lever', 'indeed', 'linkedin', 'workday', 'dayforce', 'exec', 'gmail'],
        checked: { indeed: false, linkedin: false, workday: false, dayforce: false, exec: false, gmail: false },
        dryRun: true,
      }),
      { sources: ['greenhouse', 'lever'], dryRun: true },
    );
  });

  test('checked[name] === true (explicitly checked) still includes it -- checked-by-default is not just about absence', () => {
    assert.deepEqual(
      buildScanRequestBody({ allSources: ['greenhouse'], checked: { greenhouse: true } }),
      { sources: ['greenhouse'], dryRun: false },
    );
  });

  test('empty allSources produces an empty sources list, never throws', () => {
    assert.deepEqual(buildScanRequestBody({ allSources: [] }), { sources: [], dryRun: false });
  });

  test('malformed inputs (non-array allSources, non-object checked) degrade to empty/false rather than throwing', () => {
    assert.deepEqual(buildScanRequestBody(/** @type {any} */ ({ allSources: null })), { sources: [], dryRun: false });
    assert.deepEqual(
      buildScanRequestBody(/** @type {any} */ ({ allSources: ['greenhouse'], checked: 'not an object' })),
      { sources: ['greenhouse'], dryRun: false },
    );
  });

  test('non-string entries in allSources are dropped, never passed through', () => {
    assert.deepEqual(
      buildScanRequestBody(/** @type {any} */ ({ allSources: ['greenhouse', 42, null, ''] })),
      { sources: ['greenhouse'], dryRun: false },
    );
  });

  test('dryRun coerces to a strict boolean', () => {
    assert.equal(buildScanRequestBody({ allSources: [], dryRun: /** @type {any} */ (1) }).dryRun, true);
    assert.equal(buildScanRequestBody({ allSources: [], dryRun: /** @type {any} */ (undefined) }).dryRun, false);
  });
});
