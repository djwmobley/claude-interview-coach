// @ts-check
/**
 * src/core/salary-floor.js (one-click apply PR A spec item 2, defect fix): resolveFloor()'s total
 * classification over the REAL location_norm/remote_mode vocabulary produced by src/core/normalize.js
 * (a Texas city value has NO "city-" prefix, e.g. "houston-tx", not "city-houston-tx" -- the previous
 * version of this function and this test file were both built against the spec-literal but wrong
 * "city-*-tx" pattern and never matched a real Texas city listing).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFloor } from '../src/core/salary-floor.js';

const FLOORS = { texas_or_remote: 225000, relocation: 275000 };

describe('resolveFloor: TEXAS branch (real location_norm vocabulary, no "city-" prefix)', () => {
  test('real Texas city values -> texas_or_remote floor', () => {
    assert.equal(resolveFloor({ locationNorm: 'houston-tx', remoteMode: 'onsite' }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: 'dallas-tx', remoteMode: 'onsite' }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: 'austin-tx', remoteMode: null }, FLOORS), 225000);
  });

  test('bare Texas state -> texas_or_remote floor', () => {
    assert.equal(resolveFloor({ locationNorm: 'state-tx', remoteMode: 'onsite' }, FLOORS), 225000);
  });

  test('Texas-suffixed remote value matches TEXAS before REMOTE (same floor either way)', () => {
    assert.equal(resolveFloor({ locationNorm: 'remote-us-tx', remoteMode: 'remote' }, FLOORS), 225000);
  });

  test('is case-insensitive on locationNorm', () => {
    assert.equal(resolveFloor({ locationNorm: 'HOUSTON-TX', remoteMode: 'onsite' }, FLOORS), 225000);
  });

  test('"unknown:<sha1>" never accidentally matches the TEXAS pattern (colon breaks the character class)', () => {
    assert.equal(resolveFloor({ locationNorm: 'unknown:abc123', remoteMode: 'onsite' }, FLOORS), 275000);
  });
});

describe('resolveFloor: REMOTE branch', () => {
  test('locationNorm === "remote" -> texas_or_remote floor', () => {
    assert.equal(resolveFloor({ locationNorm: 'remote', remoteMode: null }, FLOORS), 225000);
  });

  test('locationNorm starting with "remote-us" -> texas_or_remote floor', () => {
    assert.equal(resolveFloor({ locationNorm: 'remote-us', remoteMode: null }, FLOORS), 225000);
  });

  test('remoteMode === "remote" with an onsite-shaped locationNorm still qualifies (mode-only remote signal)', () => {
    assert.equal(resolveFloor({ locationNorm: 'denver-co', remoteMode: 'remote' }, FLOORS), 225000);
  });

  test('remoteMode === "remote" with an empty/absent locationNorm qualifies', () => {
    assert.equal(resolveFloor({ locationNorm: '', remoteMode: 'remote' }, FLOORS), 225000);
    assert.equal(resolveFloor({ locationNorm: null, remoteMode: 'remote' }, FLOORS), 225000);
  });

  test('a non-US remote signal ("remote-de") does NOT qualify even with remoteMode === "remote" -- falls to relocation', () => {
    assert.equal(resolveFloor({ locationNorm: 'remote-de', remoteMode: 'remote' }, FLOORS), 275000);
  });
});

describe('resolveFloor: UNKNOWN and OTHER_US both resolve to the relocation floor', () => {
  test('every other value falls to the relocation floor -- total classification, table-driven', () => {
    const relocationCases = [
      ['country-us', 'onsite'],
      ['', null],
      ['unknown:abc123', 'onsite'],
      ['unknown:abc123', null],
      ['legacy-unknown', null],
      [null, 'onsite'],
      [undefined, undefined],
      ['state-ny', 'onsite'],
      ['denver-co', null],
      ['denver-co', 'hybrid'],
    ];
    for (const [locationNorm, remoteMode] of relocationCases) {
      assert.equal(resolveFloor({ locationNorm, remoteMode }, FLOORS), 275000, `locationNorm=${locationNorm} remoteMode=${remoteMode}`);
    }
  });
});

describe('resolveFloor: never throws on malformed input', () => {
  test('undefined/non-object input -> treated as {}, resolves to relocation floor, does not throw', () => {
    assert.equal(resolveFloor(/** @type {any} */ (undefined), FLOORS), 275000);
    assert.equal(resolveFloor(/** @type {any} */ (42), FLOORS), 275000);
    assert.equal(resolveFloor(/** @type {any} */ ([]), FLOORS), 275000);
  });

  test('null floors -> treated as {}, does not throw (result is whatever the empty floors object yields)', () => {
    assert.doesNotThrow(() => resolveFloor({ locationNorm: 'houston-tx', remoteMode: null }, /** @type {any} */ (null)));
    assert.equal(resolveFloor({ locationNorm: 'houston-tx', remoteMode: null }, /** @type {any} */ (null)), undefined);
    assert.equal(resolveFloor({ locationNorm: 'denver-co', remoteMode: null }, /** @type {any} */ (null)), undefined);
  });
});

describe('resolveFloor: a different floors object is honored verbatim (never a hardcoded 225000/275000)', () => {
  test('custom floors pass through', () => {
    const custom = { texas_or_remote: 111, relocation: 222 };
    assert.equal(resolveFloor({ locationNorm: 'state-tx', remoteMode: null }, custom), 111);
    assert.equal(resolveFloor({ locationNorm: 'country-us', remoteMode: null }, custom), 222);
  });
});
