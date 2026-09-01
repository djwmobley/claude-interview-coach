// @ts-check
/**
 * src/core/credentials.js (apply pipeline slice 4): fake read/write/delete/list against an in-memory
 * `execFileFn`, never a real PowerShell process. The fake mimics node:child_process.execFile's own
 * signature (file, args, options, callback) and returns a minimal ChildProcess-like object with a
 * writable `.stdin`, matching exactly what runCredScript() expects -- this is the "injected execFile"
 * the spec requires, not a higher-level custom test seam.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialTarget, readCredential, writeCredential, deleteCredential, listCredentials, createCredentials, CREDENTIAL_PREFIX, generatePassword,
} from '../src/core/credentials.js';

/**
 * generatePassword moved here in apply pipeline slice 6 (single source of truth): bin/cred.js's
 * `--generate` flag re-exports it (test/cred-cli.test.js covers that re-export), and
 * src/apply/worker.js's ctx.credentials.generatePassword (Workday account self-registration) calls the
 * SAME function directly.
 */
describe('generatePassword', () => {
  test('produces a 24-character string', () => {
    assert.equal(generatePassword().length, 24);
  });

  test('two calls never produce the same password', () => {
    assert.notEqual(generatePassword(), generatePassword());
  });

  test('never contains characters outside the declared safe charset', () => {
    const pw = generatePassword();
    assert.match(pw, /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*\-_+=]+$/);
  });
});

/**
 * Build a fake execFileFn backed by an in-memory Map<target, {username,password}>, mimicking cred.ps1's
 * own read/write/delete/list contract (JSON stdout for read/list, exit code 2 for "not found").
 * @param {Map<string, {username:string,password:string}>} store
 */
function makeFakeExecFile(store) {
  /** @type {Array<{file:string, args:string[]}>} */
  const calls = [];
  /** @param {string} file @param {string[]} args @param {any} options @param {(err: any, stdout: string, stderr: string) => void} cb */
  const execFileFn = (file, args, options, cb) => {
    calls.push({ file, args });
    const opIndex = args.indexOf('-Op');
    const op = args[opIndex + 1];
    const targetIndex = args.indexOf('-Target');
    const target = targetIndex === -1 ? null : args[targetIndex + 1];
    const userIndex = args.indexOf('-Username');
    const username = userIndex === -1 ? null : args[userIndex + 1];
    /** @type {string[]} */
    const written = [];
    const fakeChild = {
      stdin: {
        write: (/** @type {string} */ s) => written.push(s),
        end: () => {
          queueMicrotask(() => {
            if (op === 'read') {
              const entry = target ? store.get(target) : undefined;
              if (!entry) {
                const err = /** @type {any} */ (new Error('not found'));
                err.code = 2;
                cb(err, '', '');
                return;
              }
              cb(null, JSON.stringify(entry), '');
              return;
            }
            if (op === 'write') {
              const password = written.join('');
              if (target) store.set(target, { username: /** @type {string} */ (username), password });
              cb(null, '', '');
              return;
            }
            if (op === 'delete') {
              const existed = target ? store.has(target) : false;
              if (target) store.delete(target);
              if (!existed) {
                const err = /** @type {any} */ (new Error('not found'));
                err.code = 2;
                cb(err, '', '');
                return;
              }
              cb(null, '', '');
              return;
            }
            if (op === 'list') {
              const targets = [...store.keys()].filter((t) => t.startsWith(CREDENTIAL_PREFIX));
              cb(null, JSON.stringify(targets), '');
              return;
            }
            cb(new Error(`fake execFile: unknown op "${op}"`), '', '');
          });
        },
      },
    };
    return fakeChild;
  };
  return { execFileFn, calls };
}

describe('credentialTarget', () => {
  test('builds the ic-jobsearch/<tenantHost> shape', () => {
    assert.equal(credentialTarget('boards.greenhouse.io'), 'ic-jobsearch/boards.greenhouse.io');
    assert.equal(credentialTarget('Boards.Greenhouse.IO'), 'ic-jobsearch/boards.greenhouse.io');
  });

  test('rejects a non-hostname value', () => {
    assert.throws(() => credentialTarget('not a hostname'), /must be a bare hostname/);
    assert.throws(() => credentialTarget(''), /must be a bare hostname/);
    assert.throws(() => credentialTarget(42), /must be a bare hostname/);
  });
});

describe('readCredential / writeCredential / deleteCredential / listCredentials: fake read/write/delete', () => {
  test('write then read round-trips username and password; password never appears on argv', async () => {
    /** @type {Map<string, {username:string,password:string}>} */
    const store = new Map();
    const { execFileFn, calls } = makeFakeExecFile(store);
    const target = credentialTarget('boards.greenhouse.io');
    await writeCredential(target, 'djwmobley@gmail.com', 'S3cret!Pass', { execFileFn });
    const writeCall = calls.find((c) => c.args.includes('write'));
    assert.ok(writeCall);
    assert.ok(!writeCall.args.some((a) => a.includes('S3cret')), 'password must never appear as a command-line argument');

    const read = await readCredential(target, { execFileFn });
    assert.deepEqual(read, { username: 'djwmobley@gmail.com', password: 'S3cret!Pass' });
  });

  test('reading a credential that was never written returns null (not found), not an error', async () => {
    const store = new Map();
    const { execFileFn } = makeFakeExecFile(store);
    const target = credentialTarget('jobs.lever.co');
    const read = await readCredential(target, { execFileFn });
    assert.equal(read, null);
  });

  test('deleteCredential reports true when a credential existed, false when it did not', async () => {
    const store = new Map();
    const { execFileFn } = makeFakeExecFile(store);
    const target = credentialTarget('boards.greenhouse.io');
    assert.equal(await deleteCredential(target, { execFileFn }), false);
    await writeCredential(target, 'a@b.com', 'pw', { execFileFn });
    assert.equal(await deleteCredential(target, { execFileFn }), true);
    assert.equal(await readCredential(target, { execFileFn }), null);
  });

  test('listCredentials returns only target names, never secrets, and only ic-jobsearch/ targets', async () => {
    const store = new Map([['some-other-app/unrelated', { username: 'x', password: 'y' }]]);
    const { execFileFn } = makeFakeExecFile(store);
    await writeCredential(credentialTarget('boards.greenhouse.io'), 'a@b.com', 'pw1', { execFileFn });
    await writeCredential(credentialTarget('jobs.lever.co'), 'a@b.com', 'pw2', { execFileFn });
    const targets = await listCredentials({ execFileFn });
    assert.deepEqual([...targets].sort(), ['ic-jobsearch/boards.greenhouse.io', 'ic-jobsearch/jobs.lever.co']);
    assert.ok(!targets.includes('some-other-app/unrelated'));
    assert.ok(!JSON.stringify(targets).includes('pw1'));
  });

  test('createCredentials() binds all four operations to one execFileFn', async () => {
    const store = new Map();
    const { execFileFn } = makeFakeExecFile(store);
    const credentials = createCredentials({ execFileFn });
    const target = credentialTarget('boards.greenhouse.io');
    await credentials.write(target, 'a@b.com', 'pw');
    assert.deepEqual(await credentials.read(target), { username: 'a@b.com', password: 'pw' });
    assert.deepEqual(await credentials.list(), [target]);
    assert.equal(await credentials.delete(target), true);
  });

  test('assertTarget rejects a malformed target before ever calling execFileFn', async () => {
    let called = false;
    const execFileFn = () => {
      called = true;
      return { stdin: { write: () => {}, end: () => {} } };
    };
    await assert.rejects(readCredential('not-a-valid-target', { execFileFn: /** @type {any} */ (execFileFn) }), /credential target must match/);
    assert.equal(called, false);
  });

  test('writeCredential rejects an empty username or password before ever calling execFileFn', async () => {
    let called = false;
    const execFileFn = () => {
      called = true;
      return { stdin: { write: () => {}, end: () => {} } };
    };
    const target = credentialTarget('boards.greenhouse.io');
    await assert.rejects(writeCredential(target, '', 'pw', { execFileFn: /** @type {any} */ (execFileFn) }), /username is required/);
    await assert.rejects(writeCredential(target, 'a@b.com', '', { execFileFn: /** @type {any} */ (execFileFn) }), /password is required/);
    assert.equal(called, false);
  });

  test('a non-2 error code from the script rejects with a clean JobSearchError, not a raw child_process error', async () => {
    const execFileFn = (/** @type {any} */ file, /** @type {any} */ args, /** @type {any} */ options, /** @type {any} */ cb) => {
      queueMicrotask(() => cb(Object.assign(new Error('boom'), { code: 1 }), '', 'cred.ps1: something broke'));
      return { stdin: { write: () => {}, end: () => {} } };
    };
    const target = credentialTarget('boards.greenhouse.io');
    await assert.rejects(readCredential(target, { execFileFn: /** @type {any} */ (execFileFn) }), (err) => {
      assert.equal(/** @type {any} */ (err).code, 'INTERNAL');
      return true;
    });
  });
});
