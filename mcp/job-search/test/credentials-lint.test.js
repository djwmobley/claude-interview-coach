// @ts-check
/**
 * Apply pipeline slice 4: "password never serialized" (spec's own test requirement). Two independent
 * checks: (1) a BEHAVIORAL test that the real pino logger actually strips a `password` field from its
 * written output, not just a claim that the redact list contains the word; (2) a static lint scan over
 * every route/core .js file for a `password` value flowing directly into a log call, catching the case a
 * caller bypasses scalars()/redact entirely by string-concatenating a message.
 *
 * What this CANNOT prove (recorded here, not only in the PR body): a value logged under a renamed key
 * (e.g. `pw`, `secret`, `pass`) evades both checks -- pino's redact list is keyed by exact field name, and
 * the static scan below only recognizes the literal identifier "password". This is a known, accepted
 * blind spot; see the PR body's Blind Spots section.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../src/core/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

describe('logger.js: password is actually redacted from written output, not just declared', () => {
  test('a logged object with a password field never writes the plaintext password to disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-redact-'));
    const file = path.join(dir, 'redact-test.log');
    const logger = createLogger({ file, level: 'info' });
    logger.info({ evt: 'credential_saved', target: 'ic-jobsearch/boards.greenhouse.io', password: 'S3cret!Pass' });
    // pino's sync destination flushes synchronously; a short delay covers any platform where it does not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(!written.includes('S3cret!Pass'), `logger output must never contain the plaintext password; got: ${written}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('static scan: no route or logger path ever serializes a password field directly', () => {
  /** @param {string} dir */
  function walkJs(dir) {
    /** @type {string[]} */
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkJs(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const scanDirs = [path.join(PACKAGE_ROOT, 'src', 'dashboard'), path.join(PACKAGE_ROOT, 'src', 'core'), path.join(PACKAGE_ROOT, 'src', 'apply')];
  const files = scanDirs.flatMap((d) => (fs.existsSync(d) ? walkJs(d) : []));

  // A log-ish call (log.info/log.warn/log.error/logger.*/console.log) whose argument literally contains
  // the identifier "password" on the same statement -- a coarse but zero-false-negative-for-the-literal-
  // name check. src/core/logger.js's own scalars() destructuring loop (`for (const [k, v] of ...)`) is
  // exempted: it is the redaction mechanism itself, not a call site that could leak a password.
  const LOG_CALL_RE = /\b(?:log|logger|console)\.(?:info|warn|error|debug|trace|log)\s*\([^;]*\bpassword\b[^;]*\)/i;

  test('no log call anywhere in src/dashboard, src/core, or src/apply references a "password" identifier', () => {
    const hits = files.filter((f) => {
      if (f.endsWith(path.join('core', 'logger.js'))) return false;
      const text = fs.readFileSync(f, 'utf8');
      return LOG_CALL_RE.test(text);
    });
    assert.deepEqual(hits, [], `password identifier found inside a log call in: ${hits.join(', ')}`);
  });

  test('logger.js redact paths still include "password" (regression guard for the behavioral test above)', () => {
    const text = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'core', 'logger.js'), 'utf8');
    assert.match(text, /redact:\s*\{\s*paths:\s*\[[^\]]*'password'/s);
  });
});
