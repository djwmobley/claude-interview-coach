// @ts-check
/**
 * bin/cred.js (apply pipeline slice 4): pure-function pieces only (parseArgs, generatePassword). The
 * actual `set`/`list`/`delete` commands go through src/core/credentials.js, already covered by
 * test/credentials.test.js's fake-execFileFn suite; this file does not spawn the CLI as a subprocess.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, generatePassword } from '../bin/cred.js';

describe('generatePassword', () => {
  test('is always 24 characters, and never includes visually-ambiguous excluded letters', () => {
    for (let i = 0; i < 20; i++) {
      const pw = generatePassword();
      assert.equal(pw.length, 24);
      assert.ok(!/[IOl01]/.test(pw), `password "${pw}" contains an excluded ambiguous character`);
    }
  });

  test('two calls produce different passwords (uses a real CSPRNG, not a fixed sequence)', () => {
    const a = generatePassword();
    const b = generatePassword();
    assert.notEqual(a, b);
  });
});

describe('parseArgs', () => {
  test('set <tenantHost> [--user email] [--generate]', () => {
    assert.deepEqual(parseArgs(['set', 'boards.greenhouse.io']), {
      command: 'set', tenantHost: 'boards.greenhouse.io', user: 'djwmobley@gmail.com', generate: false, help: false,
    });
    assert.deepEqual(parseArgs(['set', 'jobs.lever.co', '--user', 'me@example.com', '--generate']), {
      command: 'set', tenantHost: 'jobs.lever.co', user: 'me@example.com', generate: true, help: false,
    });
  });

  test('list', () => {
    assert.deepEqual(parseArgs(['list']), { command: 'list', help: false });
  });

  test('delete <target>', () => {
    assert.deepEqual(parseArgs(['delete', 'ic-jobsearch/boards.greenhouse.io']), {
      command: 'delete', target: 'ic-jobsearch/boards.greenhouse.io', help: false,
    });
  });

  test('an unrecognized or missing command falls to the help branch', () => {
    assert.deepEqual(parseArgs([]), { command: null, help: true });
    assert.deepEqual(parseArgs(['bogus']), { command: null, help: true });
  });
});
