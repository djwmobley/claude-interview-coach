// @ts-check
/**
 * src/apply/screenshot.js (apply pipeline slice 5): write-side confinement (writeApplicationScreenshot)
 * and the matching read-side resolver (resolveLatestApplicationScreenshot). No network, no browser --
 * pure filesystem behavior against a throwaway temp directory standing in for output/.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeApplicationScreenshot, resolveLatestApplicationScreenshot } from '../src/apply/screenshot.js';

/** @type {string} */
let outputRoot;
test.beforeEach(() => {
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-screenshot-'));
});
test.afterEach(() => {
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

describe('writeApplicationScreenshot', () => {
  test('writes under output/applications/<id>/<ts>.png and returns a confined relPath', () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const { relPath, absPath } = writeApplicationScreenshot(outputRoot, 42, buf);
    assert.match(relPath, /^applications\/42\/[^/]+\.png$/);
    assert.equal(fs.readFileSync(absPath).equals(buf), true);
  });

  test('two writes for the same application produce two distinct files (timestamped names)', async () => {
    const buf1 = Buffer.from([1]);
    const r1 = writeApplicationScreenshot(outputRoot, 7, buf1);
    await new Promise((r) => setTimeout(r, 5));
    const buf2 = Buffer.from([2]);
    const r2 = writeApplicationScreenshot(outputRoot, 7, buf2);
    assert.notEqual(r1.absPath, r2.absPath);
  });

  test('rejects a non-positive-integer applicationId', () => {
    assert.throws(() => writeApplicationScreenshot(outputRoot, 0, Buffer.from([1])), /positive integer/);
    assert.throws(() => writeApplicationScreenshot(outputRoot, -1, Buffer.from([1])), /positive integer/);
    assert.throws(() => writeApplicationScreenshot(outputRoot, 1.5, Buffer.from([1])), /positive integer/);
    assert.throws(() => writeApplicationScreenshot(outputRoot, /** @type {any} */ ('42'), Buffer.from([1])), /positive integer/);
  });

  test('rejects a missing or empty buffer', () => {
    assert.throws(() => writeApplicationScreenshot(outputRoot, 1, /** @type {any} */ (null)), /buffer is required/);
    assert.throws(() => writeApplicationScreenshot(outputRoot, 1, Buffer.alloc(0)), /buffer is required/);
  });

  test('refuses to write when output/applications/<id> is a symlink/junction escaping output/applications/', (t) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-screenshot-outside-'));
    const appsRoot = path.join(outputRoot, 'applications');
    fs.mkdirSync(appsRoot, { recursive: true });
    const linkPath = path.join(appsRoot, '99');
    try {
      fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot create a symlink/junction in this environment: ${err instanceof Error ? err.message : String(err)}`);
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }
    try {
      assert.throws(() => writeApplicationScreenshot(outputRoot, 99, Buffer.from([1])), /escapes output\/applications/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('resolveLatestApplicationScreenshot', () => {
  test('returns null when there is no screenshot for the application', () => {
    assert.equal(resolveLatestApplicationScreenshot(outputRoot, 123), null);
  });

  test('returns the lexicographically-latest (i.e. most recent ISO timestamp) file', () => {
    const dir = path.join(outputRoot, 'applications', '5');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-01-01T00-00-00-000Z.png'), 'a');
    fs.writeFileSync(path.join(dir, '2026-06-01T00-00-00-000Z.png'), 'b');
    const resolved = resolveLatestApplicationScreenshot(outputRoot, 5);
    assert.ok(resolved && resolved.endsWith('2026-06-01T00-00-00-000Z.png'));
  });

  test('a symlink/junction escaping output/applications/ resolves to null, never a path outside root', (t) => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-screenshot-read-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.png'), 'nope');
    const appsRoot = path.join(outputRoot, 'applications');
    fs.mkdirSync(appsRoot, { recursive: true });
    const linkPath = path.join(appsRoot, '77');
    try {
      fs.symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`cannot create a symlink/junction in this environment: ${err instanceof Error ? err.message : String(err)}`);
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }
    try {
      assert.equal(resolveLatestApplicationScreenshot(outputRoot, 77), null);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('invalid applicationId returns null rather than throwing', () => {
    assert.equal(resolveLatestApplicationScreenshot(outputRoot, 0), null);
    assert.equal(resolveLatestApplicationScreenshot(outputRoot, /** @type {any} */ ('1; DROP TABLE')), null);
  });
});
