// @ts-check
/**
 * lib/router.js's parseHash() (pr3-spec-decisions.md section 12 item 4): a table of hash strings to
 * expected {route, params} or the invalid/not_found fallback, covering every rule in section 3 including
 * the %2F-in-:norm case and the leading-zero-id case.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash } from '../src/dashboard/public/lib/router.js';

describe('parseHash(): section 3 total classification', () => {
  test('home: empty hash and bare #', () => {
    assert.deepEqual(parseHash(''), { kind: 'ok', route: 'home', params: {} });
    assert.deepEqual(parseHash('#'), { kind: 'ok', route: 'home', params: {} });
    assert.deepEqual(parseHash('#/'), { kind: 'ok', route: 'home', params: {} });
  });

  test('static routes', () => {
    assert.equal(parseHash('#/jobs').route, 'jobs');
    assert.equal(parseHash('#/pipeline').route, 'pipeline');
    assert.equal(parseHash('#/followups').route, 'followups');
    assert.equal(parseHash('#/review').route, 'review');
    assert.equal(parseHash('#/runs').route, 'runs');
    assert.equal(parseHash('#/reports').route, 'reports');
    assert.equal(parseHash('#/calendar').route, 'calendar');
    assert.equal(parseHash('#/analytics').route, 'analytics');
    assert.equal(parseHash('#/companies').route, 'companies');
  });

  test('#/jobs/../../x: ".." is just a literal path segment, not a traversal bypass; it fails to match any shape', () => {
    assert.equal(parseHash('#/jobs/../../x').kind, 'not_found');
  });

  test(':id must satisfy /^\\d+$/ and be a positive integer; leading zero is accepted and parses to its value', () => {
    assert.deepEqual(parseHash('#/jobs/12'), { kind: 'ok', route: 'job-detail', params: { id: 12 } });
    assert.deepEqual(parseHash('#/jobs/01'), { kind: 'ok', route: 'job-detail', params: { id: 1 } });
    assert.equal(parseHash('#/jobs/<script>').kind, 'invalid');
    assert.equal(parseHash('#/jobs/1.5').kind, 'invalid');
    assert.equal(parseHash('#/jobs/-1').kind, 'invalid');
    assert.equal(parseHash('#/jobs/0').kind, 'invalid');
    assert.deepEqual(parseHash('#/runs/7'), { kind: 'ok', route: 'run-detail', params: { id: 7 } });
  });

  test(':day must match /^\\d{4}-\\d{2}-\\d{2}$/', () => {
    assert.deepEqual(parseHash('#/reports/2026-08-27'), { kind: 'ok', route: 'report-view', params: { day: '2026-08-27' } });
    assert.equal(parseHash('#/reports/2026-8-27').kind, 'invalid');
    assert.equal(parseHash('#/reports/not-a-date').kind, 'invalid');
  });

  test(':norm is opaque but must be non-empty post-decode and must not contain a raw or %2F-encoded slash', () => {
    assert.deepEqual(parseHash('#/companies/northwind'), { kind: 'ok', route: 'company-detail', params: { norm: 'northwind' } });
    // A trailing slash is dropped by rule 1's empty-segment filter before shape matching runs, so
    // "#/companies/" is a 1-segment hash that matches the static "companies" list route, not an empty
    // :norm on the detail route -- this is rule 1's own stated effect ("defeats traversal... must not be
    // special-cased as if it were meaningful"), not a separate blank-:norm branch to test here.
    assert.deepEqual(parseHash('#/companies/'), { kind: 'ok', route: 'companies', params: {} });
    assert.equal(parseHash('#/companies/foo%2Fbar').kind, 'invalid');
    assert.equal(parseHash('#/companies/%').kind, 'invalid'); // malformed percent-encoding throws in decodeURIComponent
  });

  test('unknown route shapes fall to not_found; missing/malformed params fall to invalid; never a third silent state', () => {
    assert.equal(parseHash('#/nope').kind, 'not_found');
    assert.equal(parseHash('#/jobs/1/extra').kind, 'not_found');
    assert.equal(parseHash('#/reports/2026-08-27/extra').kind, 'not_found');
  });
});
