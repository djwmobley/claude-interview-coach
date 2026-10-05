// @ts-check
/**
 * bin/google-reauth.js (2026-10-04 consent-link fix, spec S2/S8): --no-launch skips the OS-level
 * browser launch entirely; without it, the launch is still attempted but its exit code and stderr are
 * captured and logged (launchOsBrowserDiagnosed). Fake spawn only: nothing real is ever launched.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseArgs, makeOpenUrl } from '../bin/google-reauth.js';
import { launchOsBrowserDiagnosed } from '../src/core/open-dashboard.js';

const URL_OK = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code';

/**
 * Fake spawn whose child emits spawn, optional stderr data, then exit.
 * @param {{ exitCode?: number|null, stderr?: string, throwSync?: boolean, emitError?: boolean, never?: boolean }} b
 */
function fakeSpawn(b = {}) {
  /** @type {any[]} */
  const calls = [];
  const fn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    calls.push({ cmd, args, opts });
    if (b.throwSync) throw new Error('spawn EACCES');
    const child = /** @type {any} */ (new EventEmitter());
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.kill = () => { child.killed = true; };
    child.pid = 777;
    setImmediate(() => {
      if (b.emitError) {
        child.emit('error', new Error('spawn ENOENT'));
        return;
      }
      child.emit('spawn');
      if (b.never) return;
      if (b.stderr) child.stderr.emit('data', b.stderr);
      child.emit('exit', b.exitCode ?? 0, null);
      child.emit('close', b.exitCode ?? 0, null);
    });
    return child;
  };
  return { fn, calls };
}

describe('parseArgs', () => {
  test('--no-launch and --nonce parse; defaults are launch-on, no nonce', () => {
    assert.equal(parseArgs([]).noLaunch, false);
    assert.equal(parseArgs([]).nonce, undefined);
    const a = parseArgs(['--wait-ms', '5', '--no-launch', '--nonce', 'abc', '--token-file', 't.json']);
    assert.equal(a.noLaunch, true);
    assert.equal(a.nonce, 'abc');
    assert.equal(a.waitMs, 5);
    assert.equal(a.tokenFile, 't.json');
  });
});

describe('makeOpenUrl', () => {
  test('--no-launch: the URL is written to stdout and the OS launch is never called', async () => {
    /** @type {string[]} */
    const out = [];
    /** @type {any[]} */
    const logs = [];
    let launched = 0;
    const openUrl = makeOpenUrl({ noLaunch: true, write: (s) => out.push(s), log: (f) => logs.push(f), launch: async () => { launched++; return /** @type {any} */ ({}); } });
    await openUrl(URL_OK);
    assert.equal(launched, 0);
    assert.deepEqual(out, [URL_OK]);
    assert.equal(logs.some((l) => l.evt === 'google_reauth_launch_skipped'), true);
  });

  test('without --no-launch: launch runs and its exit code + stderr are logged', async () => {
    /** @type {any[]} */
    const logs = [];
    let launchedWith = '';
    const openUrl = makeOpenUrl({
      noLaunch: false,
      write: () => {},
      log: (f) => logs.push(f),
      launch: async (url) => {
        launchedWith = url;
        return { spawned: true, exitCode: 1, signal: null, stderr: 'Start-Process : This command cannot be run', error: null, timedOut: false };
      },
    });
    await openUrl(URL_OK);
    assert.equal(launchedWith, URL_OK);
    const ev = logs.find((l) => l.evt === 'google_reauth_launch_result');
    assert.ok(ev);
    assert.equal(ev.exit_code, 1);
    assert.match(String(ev.stderr), /Start-Process/);
  });

  test('a launch that throws is logged, never rethrown', async () => {
    /** @type {any[]} */
    const logs = [];
    const openUrl = makeOpenUrl({ noLaunch: false, write: () => {}, log: (f) => logs.push(f), launch: async () => { throw new Error('boom'); } });
    await openUrl(URL_OK);
    assert.equal(logs.some((l) => l.evt === 'open_url_failed'), true);
  });
});

describe('launchOsBrowserDiagnosed', () => {
  test('captures exit code and stderr; win32 uses powershell, hidden, not detached', async () => {
    const s = fakeSpawn({ exitCode: 1, stderr: 'some error text' });
    const r = await launchOsBrowserDiagnosed({ url: URL_OK, spawnImpl: /** @type {any} */ (s.fn), platform: 'win32' });
    assert.equal(r.spawned, true);
    assert.equal(r.exitCode, 1);
    assert.equal(r.stderr, 'some error text');
    assert.equal(s.calls[0].cmd, 'powershell.exe');
    assert.equal(s.calls[0].opts.windowsHide, true);
    assert.notEqual(s.calls[0].opts.detached, true);
    assert.deepEqual(s.calls[0].opts.stdio, ['ignore', 'ignore', 'pipe']);
  });
  test('a spawn error resolves (never rejects) with spawned:false', async () => {
    const r = await launchOsBrowserDiagnosed({ url: URL_OK, spawnImpl: /** @type {any} */ (fakeSpawn({ emitError: true }).fn), platform: 'win32' });
    assert.equal(r.spawned, false);
    assert.match(String(r.error), /ENOENT/);
  });
  test('a synchronous spawn throw resolves with the error', async () => {
    const r = await launchOsBrowserDiagnosed({ url: URL_OK, spawnImpl: /** @type {any} */ (fakeSpawn({ throwSync: true }).fn), platform: 'win32' });
    assert.equal(r.spawned, false);
    assert.match(String(r.error), /EACCES/);
  });
  test('an invalid URL is refused without spawning', async () => {
    const s = fakeSpawn();
    const r = await launchOsBrowserDiagnosed({ url: 'javascript:alert(1)', spawnImpl: /** @type {any} */ (s.fn), platform: 'win32' });
    assert.equal(r.spawned, false);
    assert.equal(s.calls.length, 0);
  });
  test('a launcher that never exits times out and is killed', async () => {
    const r = await launchOsBrowserDiagnosed({ url: URL_OK, spawnImpl: /** @type {any} */ (fakeSpawn({ never: true }).fn), platform: 'win32', timeoutMs: 50 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
  });
});
