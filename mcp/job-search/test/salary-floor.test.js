// @ts-check
/**
 * src/core/salary-floor.js (one-click apply PR A spec item 2): resolveFloor()'s total classification
 * over the location_norm/remote_mode vocabulary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFloor } from '../src/core/salary-floor.js';

const FLOORS = { texas_or_remote: 225000, relocation: 275000 };

describe('resolveFloor', () => {
  test('remoteMode === "remote" -> texas_or_remote floor, regardless of locationNorm', () => {
    assert.equal(resolveFloor({ locationNorm: 'country-us', remoteMode: 'remote' }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: 'absent', remoteMode: 'remote' }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: null, remoteMode: 'remote' }, FLOORS), 225000);
  });

  test('locationNorm starting with "remote-" -> texas_or_remote floor', () => {
    assert.equal(resolveFloor({ locationNorm: 'remote-us', remoteMode: null }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: 'remote-us-tx', remoteMode: 'hybrid' }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: 'remote-ca', remoteMode: null }, FLOORS), 225000);
  });

  test('locationNorm === "state-tx" -> texas_or_remote floor', () => {
    assert.equal(resolveFloor({ locationNorm: 'state-tx', remoteMode: 'onsite' }, FLOORS), 225000);
  });

  test('locationNorm matching /^city-.*-tx$/ -> texas_or_remote floor (spec-literal pattern)', () => {
    assert.equal(resolveFloor({ locationNorm: 'city-houston-tx', remoteMode: 'onsite' }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: 'city-austin-tx', remoteMode: null }, FLOORS), 225000);
  });

  test('every other value falls to the relocation floor -- total classification, table-driven', () => {
    const relocationCases = [
      ['country-us', 'onsite'],
      ['absent', null],
      ['unknown:abc123', 'onsite'],
      ['unknown:abc123', null],
      ['legacy-unknown', null],
      [null, 'onsite'],
      [undefined, undefined],
      ['state-ny', 'onsite'],
      // The codebase's OWN normalizeLocation() never actually produces a "city-<slug>-tx" value with a
      // "city-" prefix (test/normalize.test.js: parseLocation('Houston, TX') -> value 'houston-tx', no
      // prefix) -- so a real Texas city listing's location_norm ('houston-tx') does NOT match the
      // spec-literal /^city-.*-tx$/ pattern above and falls here, to the HIGHER relocation floor. This is
      // a real gap between this function's spec-literal pattern and the actual location_norm vocabulary;
      // documented here (and in the PR body's blind-spots section) rather than silently "fixed" by
      // reinterpreting the binding spec.
      ['houston-tx', 'onsite'],
      ['austin-tx', null],
    ];
    for (const [locationNorm, remoteMode] of relocationCases) {
      assert.equal(resolveFloor({ locationNorm, remoteMode }, FLOORS), 275000, `locationNorm=${locationNorm} remoteMode=${remoteMode}`);
    }
  });

  test('"Remote - US" style rows that normalize to unknown with remote_mode remote still hit the remote branch', () => {
    // normalizeLocation() itself always returns remote_mode: 'remote' whenever remoteDeclared is true
    // (never 'unknown'), so this exercises the SAME branch as the first test above via a locationNorm
    // shaped like normalizeLocation's real remote-declared output, not a synthetic unknown: value.
    assert.equal(resolveFloor({ locationNorm: 'remote-us', remoteMode: 'remote' }, FLOORS), 225000);
  });

  test('a different floors object is honored verbatim (never a hardcoded 225000/275000 in the function itself)', () => {
    const custom = { texas_or_remote: 111, relocation: 222 };
    assert.equal(resolveFloor({ locationNorm: 'state-tx', remoteMode: null }, custom), 111);
    assert.equal(resolveFloor({ locationNorm: 'country-us', remoteMode: null }, custom), 222);
  });
});
