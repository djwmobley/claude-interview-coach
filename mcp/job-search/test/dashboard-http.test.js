// @ts-check
/**
 * src/dashboard/http.js guard unit tests (dashboard PR 2, pr2-spec-decisions.md "Request guards"). No
 * network, no DB: requests are plain EventEmitter stand-ins.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  checkHost, checkOrigin, checkContentType, readJsonBody, mapError, applyBaseHeaders, applySandboxHtmlHeaders,
  DashboardError, MAX_BODY_BYTES,
} from '../src/dashboard/http.js';
import { JobSearchError } from '../src/core/errors.js';

/** @param {{ rawHeaders?: string[], headers?: Record<string,string> }} [opts] */
function fakeReq(opts = {}) {
  const req = /** @type {any} */ (new EventEmitter());
  req.rawHeaders = opts.rawHeaders ?? [];
  req.headers = opts.headers ?? {};
  req.destroy = () => {};
  return req;
}

function fakeRes() {
  /** @type {Record<string,string>} */
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
  };
}

describe('checkHost', () => {
  test('missing Host -> 400 BAD_HOST', () => {
    const r = checkHost(fakeReq({ rawHeaders: [] }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.code, 'BAD_HOST');
  });

  test('more than one Host header line -> 400 BAD_HOST', () => {
    const r = checkHost(fakeReq({ rawHeaders: ['Host', '127.0.0.1:7311', 'Host', 'evil.example'] }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  test('non-loopback Host -> 403 BAD_HOST', () => {
    const r = checkHost(fakeReq({ rawHeaders: ['Host', 'evil.example'] }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  test('127.0.0.1 with port -> ok', () => {
    assert.equal(checkHost(fakeReq({ rawHeaders: ['Host', '127.0.0.1:7311'] })).ok, true);
  });

  test('localhost, case-insensitive -> ok', () => {
    assert.equal(checkHost(fakeReq({ rawHeaders: ['Host', 'LOCALHOST:7311'] })).ok, true);
  });

  test('bracketed IPv6 loopback with port -> ok', () => {
    assert.equal(checkHost(fakeReq({ rawHeaders: ['Host', '[::1]:7311'] })).ok, true);
  });

  test('bracketed IPv6 loopback without port -> ok', () => {
    assert.equal(checkHost(fakeReq({ rawHeaders: ['Host', '[::1]'] })).ok, true);
  });

  test('exact set membership only: a host that merely starts with a loopback value is refused', () => {
    const r = checkHost(fakeReq({ rawHeaders: ['Host', '127.0.0.1.evil.example'] }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  test('a host that merely ends with "localhost" is refused', () => {
    const r = checkHost(fakeReq({ rawHeaders: ['Host', 'notlocalhost'] }));
    assert.equal(r.ok, false);
  });
});

describe('checkOrigin', () => {
  test('absent Origin -> allowed', () => {
    assert.equal(checkOrigin(fakeReq({ headers: {} })).ok, true);
  });

  test('literal "null" -> 403 BAD_ORIGIN (parse failure treated the same as any other, never as absence)', () => {
    const r = checkOrigin(fakeReq({ headers: { origin: 'null' } }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });

  test('https origin refused (must be http)', () => {
    assert.equal(checkOrigin(fakeReq({ headers: { origin: 'https://127.0.0.1:7311' } })).ok, false);
  });

  test('loopback http origin allowed', () => {
    assert.equal(checkOrigin(fakeReq({ headers: { origin: 'http://127.0.0.1:7311' } })).ok, true);
  });

  test('non-loopback http origin refused', () => {
    assert.equal(checkOrigin(fakeReq({ headers: { origin: 'http://evil.example' } })).ok, false);
  });

  test('unparseable origin string refused, not treated as absent', () => {
    const r = checkOrigin(fakeReq({ headers: { origin: 'not a url at all' } }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
});

describe('checkContentType', () => {
  test('missing -> 415', () => {
    const r = checkContentType(fakeReq({ headers: {} }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 415);
  });

  test('application/json with a charset parameter -> ok (parameters ignored)', () => {
    assert.equal(checkContentType(fakeReq({ headers: { 'content-type': 'application/json; charset=utf-8' } })).ok, true);
  });

  test('text/plain -> 415', () => {
    assert.equal(checkContentType(fakeReq({ headers: { 'content-type': 'text/plain' } })).ok, false);
  });

  test('application/json variant with different case -> ok', () => {
    assert.equal(checkContentType(fakeReq({ headers: { 'content-type': 'Application/JSON' } })).ok, true);
  });
});

describe('readJsonBody', () => {
  test('empty body without allowEmpty -> VALIDATION', async () => {
    const req = fakeReq();
    const p = readJsonBody(req);
    req.emit('end');
    await assert.rejects(p, (err) => err instanceof JobSearchError && err.code === 'VALIDATION');
  });

  test('empty body with allowEmpty -> {}', async () => {
    const req = fakeReq();
    const p = readJsonBody(req, { allowEmpty: true });
    req.emit('end');
    assert.deepEqual(await p, {});
  });

  test('invalid JSON -> VALIDATION', async () => {
    const req = fakeReq();
    const p = readJsonBody(req);
    req.emit('data', Buffer.from('{not json'));
    req.emit('end');
    await assert.rejects(p, (err) => err instanceof JobSearchError && err.code === 'VALIDATION');
  });

  test('array body without allowArray -> VALIDATION', async () => {
    const req = fakeReq();
    const p = readJsonBody(req);
    req.emit('data', Buffer.from('[1,2,3]'));
    req.emit('end');
    await assert.rejects(p, (err) => err instanceof JobSearchError && err.code === 'VALIDATION');
  });

  test('null body -> VALIDATION', async () => {
    const req = fakeReq();
    const p = readJsonBody(req);
    req.emit('data', Buffer.from('null'));
    req.emit('end');
    await assert.rejects(p, (err) => err instanceof JobSearchError && err.code === 'VALIDATION');
  });

  test('valid JSON object resolves', async () => {
    const req = fakeReq();
    const p = readJsonBody(req);
    req.emit('data', Buffer.from('{"a":1}'));
    req.emit('end');
    assert.deepEqual(await p, { a: 1 });
  });

  test('exceeding the byte cap aborts with 413 before end fires', async () => {
    const req = fakeReq();
    const p = readJsonBody(req, { maxBytes: 10 });
    req.emit('data', Buffer.alloc(20, 'x'));
    await assert.rejects(p, (err) => err instanceof DashboardError && err.status === 413 && err.code === 'PAYLOAD_TOO_LARGE');
  });

  test('default cap matches MAX_BODY_BYTES (256 KB)', () => {
    assert.equal(MAX_BODY_BYTES, 256 * 1024);
  });
});

describe('mapError: total classification', () => {
  test('JobSearchError VALIDATION -> 400', () => {
    const { status, body } = mapError(new JobSearchError('VALIDATION', 'bad'), 'req-1');
    assert.equal(status, 400);
    assert.equal(body.code, 'VALIDATION');
  });

  test('JobSearchError NOT_FOUND -> 404', () => {
    assert.equal(mapError(new JobSearchError('NOT_FOUND', 'x'), 'r').status, 404);
  });

  test('JobSearchError LOCKED -> 409', () => {
    assert.equal(mapError(new JobSearchError('LOCKED', 'x'), 'r').status, 409);
  });

  test('JobSearchError CONFIG_LOCK_MISMATCH -> 409', () => {
    assert.equal(mapError(new JobSearchError('CONFIG_LOCK_MISMATCH', 'x'), 'r').status, 409);
  });

  test('JobSearchError DB_UNAVAILABLE -> 503', () => {
    assert.equal(mapError(new JobSearchError('DB_UNAVAILABLE', 'x'), 'r').status, 503);
  });

  test('JobSearchError with an unmapped code -> 500', () => {
    assert.equal(mapError(new JobSearchError('INTERNAL', 'x'), 'r').status, 500);
  });

  test('DashboardError uses its own status and code', () => {
    const { status, body } = mapError(new DashboardError(415, 'UNSUPPORTED_MEDIA_TYPE', 'nope'), 'req-1');
    assert.equal(status, 415);
    assert.equal(body.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('an unrecognized thrown value -> 500 INTERNAL with the request id, never the original message', () => {
    const { status, body } = mapError(new Error('secret internal detail'), 'req-9');
    assert.equal(status, 500);
    assert.equal(body.code, 'INTERNAL');
    assert.equal(body.requestId, 'req-9');
    assert.ok(!JSON.stringify(body).includes('secret internal detail'));
  });

  test('a thrown non-Error value -> 500 INTERNAL', () => {
    const { status, body } = mapError('just a string', 'req-2');
    assert.equal(status, 500);
    assert.equal(body.code, 'INTERNAL');
  });
});

describe('response headers', () => {
  test('applyBaseHeaders sets CSP/nosniff/referrer on every path, and no-store only under /api/', () => {
    const apiRes = fakeRes();
    applyBaseHeaders(/** @type {any} */ (apiRes), '/api/summary');
    assert.ok(apiRes.headers['Content-Security-Policy'].includes("default-src 'self'"));
    assert.equal(apiRes.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(apiRes.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(apiRes.headers['Cache-Control'], 'no-store');

    const staticRes = fakeRes();
    applyBaseHeaders(/** @type {any} */ (staticRes), '/');
    assert.equal(staticRes.headers['Cache-Control'], undefined);
  });

  test('applySandboxHtmlHeaders overwrites CSP to a locked-down sandbox policy', () => {
    const res = fakeRes();
    applyBaseHeaders(/** @type {any} */ (res), '/api/documents/file');
    applySandboxHtmlHeaders(/** @type {any} */ (res));
    assert.equal(res.headers['Content-Security-Policy'], "sandbox; default-src 'none'");
  });
});
