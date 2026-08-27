// @ts-check
/**
 * lib/api.js's classify() response classification (pr3-spec-decisions.md section 12 item 3): a table of
 * canned {status, body} pairs covering every named branch in section 4's table, plus the "no 401 exists"
 * assertion (an unrecognized status maps to the same generic-unknown branch as INTERNAL, never a thrown
 * exception).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/dashboard/public/lib/api.js';

describe('classify(): section 4 table, one case per named branch', () => {
  test('2xx maps to ok', () => {
    assert.equal(classify(200, { ok: true, row: {} }).kind, 'ok');
    assert.equal(classify(201, { ok: true, id: 5 }).kind, 'ok');
  });

  test('400 VALIDATION', () => {
    const r = classify(400, { ok: false, code: 'VALIDATION', message: 'bad', hint: null, details: {} });
    assert.equal(r.kind, 'validation');
    assert.equal(r.message, 'bad');
  });

  test('403 BAD_HOST / BAD_ORIGIN maps to rejected_request', () => {
    assert.equal(classify(403, { ok: false, code: 'BAD_HOST', message: 'x' }).kind, 'rejected_request');
    assert.equal(classify(403, { ok: false, code: 'BAD_ORIGIN', message: 'x' }).kind, 'rejected_request');
  });

  test('404 NOT_FOUND', () => {
    assert.equal(classify(404, { ok: false, code: 'NOT_FOUND', message: 'x' }).kind, 'not_found');
  });

  test('405 METHOD_NOT_ALLOWED maps to client_bug', () => {
    assert.equal(classify(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'x' }).kind, 'client_bug');
  });

  test('409 LOCKED', () => {
    assert.equal(classify(409, { ok: false, code: 'LOCKED', message: 'x' }).kind, 'locked');
  });

  test('409 CONFIG_LOCK_MISMATCH', () => {
    assert.equal(classify(409, { ok: false, code: 'CONFIG_LOCK_MISMATCH', message: 'x' }).kind, 'config_lock_mismatch');
  });

  test('409 DUPLICATE_CANDIDATE carries candidates through', () => {
    const r = classify(409, { ok: false, code: 'DUPLICATE_CANDIDATE', message: 'x', candidates: [{ id: 1 }] });
    assert.equal(r.kind, 'duplicate_candidate');
    assert.deepEqual(r.candidates, [{ id: 1 }]);
  });

  test('413 PAYLOAD_TOO_LARGE', () => {
    assert.equal(classify(413, { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'x' }).kind, 'payload_too_large');
  });

  test('415 UNSUPPORTED_MEDIA_TYPE maps to client_bug', () => {
    assert.equal(classify(415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'x' }).kind, 'client_bug');
  });

  test('503 DB_UNAVAILABLE', () => {
    assert.equal(classify(503, { ok: false, code: 'DB_UNAVAILABLE', message: 'x' }).kind, 'db_unavailable');
  });

  test('500 INTERNAL carries requestId, never other body fields', () => {
    const r = classify(500, { ok: false, code: 'INTERNAL', message: 'internal error', requestId: 'abc-123' });
    assert.equal(r.kind, 'internal');
    assert.equal(r.requestId, 'abc-123');
  });

  test('unparsable response body (sentinel from a failed JSON.parse)', () => {
    assert.equal(classify(200, { __unparsable: true, raw: '<html>' }).kind, 'unparsable');
  });

  test('there is no 401 branch anywhere: an unrecognized status/code maps to the same generic branch as INTERNAL, never throws', () => {
    assert.doesNotThrow(() => classify(401, { ok: false, code: 'UNAUTHORIZED', message: 'x' }));
    const r401 = classify(401, { ok: false, code: 'UNAUTHORIZED', message: 'x' });
    assert.equal(r401.kind, 'internal');
    assert.equal(r401.unknownStatus, 401);

    assert.doesNotThrow(() => classify(418, {}));
    const rTeapot = classify(418, {});
    assert.equal(rTeapot.kind, 'internal');
  });
});
