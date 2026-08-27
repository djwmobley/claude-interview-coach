// @ts-check
/**
 * bin/dashboard.js pure-function unit tests: --port/env resolution and the EADDRINUSE identity probe
 * (pr2-spec-decisions.md "Single instance and startup"). Never starts a real server or binds a port.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseArgs, resolvePort, probeExistingHealth, DEFAULT_PORT, SERVICE_NAME } from '../bin/dashboard.js';

describe('parseArgs', () => {
  test('parses --port, --open, --help', () => {
    assert.deepEqual(parseArgs(['--port', '9000', '--open']), { port: 9000, open: true, help: false });
    assert.equal(parseArgs(['--help']).help, true);
    assert.deepEqual(parseArgs([]), { port: undefined, open: false, help: false });
  });
});

describe('resolvePort: total classification, checked before listen', () => {
  const noopLog = () => {};

  test('no CLI port, no env value -> DEFAULT_PORT, no warning', () => {
    assert.deepEqual(resolvePort(undefined, undefined, noopLog), { port: DEFAULT_PORT, warning: null });
  });

  test('valid CLI port wins over env', () => {
    assert.deepEqual(resolvePort(8080, '9999', noopLog), { port: 8080, warning: null });
  });

  test('valid env value used when no CLI port', () => {
    assert.deepEqual(resolvePort(undefined, '8123', noopLog), { port: 8123, warning: null });
  });

  test('below 1024 -> falls back to DEFAULT_PORT with a warning', () => {
    const r = resolvePort(80, undefined, noopLog);
    assert.equal(r.port, DEFAULT_PORT);
    assert.ok(r.warning);
  });

  test('above 65535 -> falls back with a warning', () => {
    const r = resolvePort(70000, undefined, noopLog);
    assert.equal(r.port, DEFAULT_PORT);
    assert.ok(r.warning);
  });

  test('non-integer -> falls back with a warning', () => {
    const r = resolvePort(7311.5, undefined, noopLog);
    assert.equal(r.port, DEFAULT_PORT);
    assert.ok(r.warning);
  });

  test('non-numeric env string -> falls back with a warning', () => {
    const r = resolvePort(undefined, 'not-a-number', noopLog);
    assert.equal(r.port, DEFAULT_PORT);
    assert.ok(r.warning);
  });
});

describe('probeExistingHealth', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {number} */
  let port;

  test('same service answering -> same:true', async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: SERVICE_NAME }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {any} */ (server.address()).port;
    const r = await probeExistingHealth(port);
    assert.equal(r.same, true);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('a different service answering -> same:false with a reason', async () => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'something-else' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {any} */ (server.address()).port;
    const r = await probeExistingHealth(port);
    assert.equal(r.same, false);
    assert.ok(r.reason);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('non-2xx status -> same:false', async () => {
    server = http.createServer((req, res) => {
      res.statusCode = 500;
      res.end('nope');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {any} */ (server.address()).port;
    const r = await probeExistingHealth(port);
    assert.equal(r.same, false);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('non-JSON body -> same:false', async () => {
    server = http.createServer((req, res) => {
      res.end('plain text, not json');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    port = /** @type {any} */ (server.address()).port;
    const r = await probeExistingHealth(port);
    assert.equal(r.same, false);
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  test('nothing listening -> same:false, never throws', async () => {
    const r = await probeExistingHealth(1); // privileged/unused port, connection refused
    assert.equal(r.same, false);
    assert.ok(r.reason);
  });
});
