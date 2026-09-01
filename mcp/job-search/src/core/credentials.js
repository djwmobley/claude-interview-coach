// @ts-check
/**
 * Windows Credential Manager wrapper (apply pipeline slice 4, plan section "5. Credentials"). This
 * module's entire job is spawning scripts/cred.ps1 correctly and parsing its output; the actual
 * CredRead/CredWrite/CredDelete/CredEnumerate P/Invoke calls live entirely in that script. A password
 * NEVER crosses the process boundary as a command-line argument in either direction -- it is written to
 * cred.ps1's stdin (write) or read from cred.ps1's stdout, wrapped in a small JSON envelope (read/list),
 * never logged.
 *
 * Tests inject `execFileFn`, matching node:child_process's own `execFile` signature, with an in-memory
 * fake ChildProcess-like object -- this module never spawns a real PowerShell process in the default test
 * run (spec: "never invoke real PowerShell in default test runs").
 */
import { execFile as nodeExecFile } from 'node:child_process';
import path from 'node:path';
import { packageRoot } from './config.js';
import { JobSearchError } from './errors.js';

/** Every credential target this pipeline ever touches lives under this prefix. */
export const CREDENTIAL_PREFIX = 'ic-jobsearch/';

const TENANT_HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TARGET_RE = /^ic-jobsearch\/[A-Za-z0-9.-]+$/;

/**
 * Build the full Credential Manager target name for a tenant host (e.g. "boards.greenhouse.io" ->
 * "ic-jobsearch/boards.greenhouse.io"). Total over its input: a non-string or a string that does not
 * look like a bare hostname throws VALIDATION rather than silently building a malformed target.
 * @param {unknown} tenantHost
 * @returns {string}
 */
export function credentialTarget(tenantHost) {
  if (typeof tenantHost !== 'string' || !TENANT_HOST_RE.test(tenantHost.trim())) {
    throw new JobSearchError('VALIDATION', 'tenantHost must be a bare hostname (e.g. "boards.greenhouse.io")', {
      details: { tenantHost: typeof tenantHost === 'string' ? tenantHost.slice(0, 100) : null },
    });
  }
  return `${CREDENTIAL_PREFIX}${tenantHost.trim().toLowerCase()}`;
}

/** @param {unknown} target */
function assertTarget(target) {
  if (typeof target !== 'string' || !TARGET_RE.test(target)) {
    throw new JobSearchError('VALIDATION', `credential target must match ${CREDENTIAL_PREFIX}<tenantHost>`, {
      details: { target: typeof target === 'string' ? target.slice(0, 100) : null },
    });
  }
}

function credScriptPath() {
  return path.join(packageRoot(), 'scripts', 'cred.ps1');
}

/**
 * @typedef {(file: string, args: string[], options: Record<string, unknown>, callback: (err: (Error & { code?: number })|null, stdout: string, stderr: string) => void) => { stdin: { write: (s: string) => void, end: () => void } }} ExecFileFn
 */

/**
 * Spawn scripts/cred.ps1 through `execFileFn` (real node:child_process.execFile by default). The secret,
 * when present, is written to the child's stdin stream and the stream is always closed -- never appended
 * to `args`. cred.ps1's own convention: exit code 2 means "not found" for read/delete, a legitimate
 * outcome this function returns rather than rejecting on; any other non-zero exit is a real failure.
 * @param {string} op
 * @param {string[]} args
 * @param {string|null} stdinText
 * @param {{ execFileFn?: ExecFileFn }} [opts]
 * @returns {Promise<{ stdout: string, code: number }>}
 */
function runCredScript(op, args, stdinText, opts = {}) {
  const execFileFn = opts.execFileFn ?? /** @type {ExecFileFn} */ (/** @type {unknown} */ (nodeExecFile));
  const fullArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', credScriptPath(), '-Op', op, ...args];
  return new Promise((resolve, reject) => {
    const child = execFileFn('powershell.exe', fullArgs, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === 'number' ? err.code : 1;
        if (code === 2) {
          resolve({ stdout: String(stdout ?? ''), code: 2 });
          return;
        }
        reject(new JobSearchError('INTERNAL', `cred.ps1 ${op} failed: ${String(stderr || err.message).slice(0, 300)}`, { details: { op } }));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), code: 0 });
    });
    if (child && child.stdin) {
      if (stdinText !== null) child.stdin.write(stdinText);
      child.stdin.end();
    }
  });
}

/**
 * @param {string} target
 * @param {{ execFileFn?: ExecFileFn }} [opts]
 * @returns {Promise<{ username: string, password: string } | null>} null when no credential is stored
 */
export async function readCredential(target, opts = {}) {
  assertTarget(target);
  const { stdout, code } = await runCredScript('read', ['-Target', target], null, opts);
  if (code === 2) return null;
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new JobSearchError('INTERNAL', 'cred.ps1 read: unparsable output', { details: { target } });
  }
  if (!parsed || typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new JobSearchError('INTERNAL', 'cred.ps1 read: malformed output', { details: { target } });
  }
  return { username: parsed.username, password: parsed.password };
}

/**
 * @param {string} target
 * @param {string} username
 * @param {string} password
 * @param {{ execFileFn?: ExecFileFn }} [opts]
 */
export async function writeCredential(target, username, password, opts = {}) {
  assertTarget(target);
  if (typeof username !== 'string' || !username.trim()) throw new JobSearchError('VALIDATION', 'username is required');
  if (typeof password !== 'string' || !password) throw new JobSearchError('VALIDATION', 'password is required');
  await runCredScript('write', ['-Target', target, '-Username', username], password, opts);
}

/**
 * @param {string} target
 * @param {{ execFileFn?: ExecFileFn }} [opts]
 * @returns {Promise<boolean>} true if a credential existed and was deleted, false if none existed
 */
export async function deleteCredential(target, opts = {}) {
  assertTarget(target);
  const { code } = await runCredScript('delete', ['-Target', target], null, opts);
  return code !== 2;
}

/**
 * @param {{ execFileFn?: ExecFileFn }} [opts]
 * @returns {Promise<string[]>} target names only, never secrets
 */
export async function listCredentials(opts = {}) {
  const { stdout } = await runCredScript('list', [], null, opts);
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch {
    throw new JobSearchError('INTERNAL', 'cred.ps1 list: unparsable output');
  }
  if (!Array.isArray(parsed)) throw new JobSearchError('INTERNAL', 'cred.ps1 list: malformed output');
  return parsed.filter((t) => typeof t === 'string');
}

/**
 * Bind the four operations to one `execFileFn`, for `DashboardDeps.credentials` (bin/dashboard.js wires
 * the real one; route tests inject a fake the same way they stub scanRunner/calendar).
 * @param {{ execFileFn?: ExecFileFn }} [opts]
 */
export function createCredentials(opts = {}) {
  return {
    read: (/** @type {string} */ target) => readCredential(target, opts),
    write: (/** @type {string} */ target, /** @type {string} */ username, /** @type {string} */ password) => writeCredential(target, username, password, opts),
    delete: (/** @type {string} */ target) => deleteCredential(target, opts),
    list: () => listCredentials(opts),
  };
}
