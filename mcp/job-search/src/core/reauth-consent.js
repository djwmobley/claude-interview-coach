// @ts-check
/**
 * Consent-link handoff between the Google reauth helper (bin/google-reauth.js, via
 * src/core/google-reauth.js) and its readers: the dashboard routes and the scan report (2026-10-04 fix:
 * the helper's OS-level browser launch never produced a tab, so the consent URL now travels through a
 * file the dashboard can hand straight to a tab the operator's own click opened).
 *
 * The file (logs/google-reauth.consent.json by default) holds
 * `{ pid, nonce, port, state, url, created_at, expires_at }`. A reader trusts it only when ALL of:
 *   - the reauth lock is live (held and not stale, readReauthLock's own classification);
 *   - the lock carries a nonce and the file's nonce equals it;
 *   - the file's pid equals the lock's pid;
 *   - expires_at is in the future;
 *   - the URL classifies OPEN (src/dashboard/public/lib/consent-url.js, the same function the browser
 *     runs) against the configured OAuth client id, the file's state, and the file's port.
 * Anything else resolves to null. Every function here is best-effort and never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { packageRoot } from './config.js';
import { readReauthLock } from './google-reauth.js';
import { classifyConsentUrl } from '../dashboard/public/lib/consent-url.js';

/** Rename retry budget for Windows' transient EPERM/EBUSY on an atomic replace. */
const RENAME_ATTEMPTS = 3;

/**
 * Consent file path for a given lock file. The default lock (logs/google-reauth.lock) maps to
 * logs/google-reauth.consent.json; any other lock path (tests, custom deployments) gets a sibling
 * `<lock>.consent.json`, so a test pointing the lock at a tmpdir never touches the real logs/ file.
 * @param {string} [lockFile]
 */
export function consentFileFor(lockFile) {
  if (!lockFile) return path.join(packageRoot(), 'logs', 'google-reauth.consent.json');
  return `${lockFile}.consent.json`;
}

/**
 * Atomic write (tmp then rename, up to 3 rename attempts on EPERM/EBUSY, directory created if missing).
 * Never throws; a failure is logged and reported as `false`.
 * @param {string} file
 * @param {Record<string, unknown>} record
 * @param {{ log?: (f: Record<string, string|number|boolean|null>) => void, renameImpl?: (a: string, b: string) => void }} [opts]
 * @returns {boolean}
 */
export function writeConsentFile(file, record, opts = {}) {
  const log = opts.log ?? (() => {});
  const renameImpl = opts.renameImpl ?? fs.renameSync;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  } catch (err) {
    log({ evt: 'google_reauth_consent_write_failed', stage: 'write', err_message: String(err instanceof Error ? err.message : err).slice(0, 200) });
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    return false;
  }
  /** @type {unknown} */
  let lastErr = null;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
    try {
      renameImpl(tmp, file);
      return true;
    } catch (err) {
      lastErr = err;
      const code = /** @type {any} */ (err)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY') break;
    }
  }
  log({ evt: 'google_reauth_consent_write_failed', stage: 'rename', err_code: String(/** @type {any} */ (lastErr)?.code ?? ''), err_message: String(lastErr instanceof Error ? lastErr.message : lastErr).slice(0, 200) });
  try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  return false;
}

/**
 * Parsed consent record, or null when missing/unreadable/malformed.
 * @param {string} file
 * @returns {any}
 */
export function readConsentFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Delete the consent file only when its nonce equals `nonce` (a non-empty string). Never throws.
 * @param {string} file
 * @param {string|null|undefined} nonce
 * @returns {boolean} true when this call removed the file
 */
export function deleteOwnConsentFile(file, nonce) {
  if (typeof nonce !== 'string' || !nonce) return false;
  const cur = readConsentFile(file);
  if (!cur || cur.nonce !== nonce) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unconditionally remove the consent file (used only right after acquiring the lock: anything on disk
 * at that point belongs to a run that no longer holds it). Never throws.
 * @param {string} file
 */
export function unlinkConsentFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* absent */
  }
}

/**
 * The configured OAuth client id (the token file's own client_id: the same value the helper builds its
 * consent URL from). Null when unavailable, which makes every consent URL classify REJECT.
 * @param {string|null|undefined} tokenFile
 * @returns {string|null}
 */
export function readConfiguredClientId(tokenFile) {
  if (!tokenFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    return raw && typeof raw.client_id === 'string' && raw.client_id ? raw.client_id : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   lock: ReturnType<typeof readReauthLock>,
 *   consentFile: string,
 *   clientId: string|null|undefined,
 *   now?: number,
 * }} o
 * @returns {{ consentUrl: string, consentExpect: { clientId: string, state: string, port: number } }|null}
 */
export function resolveLiveConsent(o) {
  try {
    const lock = o.lock;
    if (!lock || !lock.held || lock.stale) return null;
    const lockNonce = typeof lock.nonce === 'string' && lock.nonce ? lock.nonce : null;
    if (!lockNonce || lock.pid === null) return null;
    const rec = readConsentFile(o.consentFile);
    if (!rec) return null;
    if (rec.nonce !== lockNonce) return null;
    if (Number(rec.pid) !== lock.pid) return null;
    const expiresMs = typeof rec.expires_at === 'string' ? Date.parse(rec.expires_at) : NaN;
    const now = Number.isFinite(o.now) ? /** @type {number} */ (o.now) : Date.now();
    if (!Number.isFinite(expiresMs) || expiresMs <= now) return null;
    const expect = { clientId: o.clientId, state: rec.state, port: rec.port };
    if (classifyConsentUrl(rec.url, expect).verdict !== 'OPEN') return null;
    return { consentUrl: rec.url, consentExpect: { clientId: /** @type {string} */ (o.clientId), state: rec.state, port: rec.port } };
  } catch {
    return null;
  }
}

/**
 * The scan report's AUTH_REAUTH_PENDING line (spec S7): carries the live helper's consent link when one
 * validates, otherwise points the operator at the dashboard's Re-authorize Google control. Never throws.
 * @param {{ lockFile?: string, consentFile?: string, tokenFile?: string|null }} o
 * @returns {string}
 */
export function reauthPendingMessage(o) {
  const fallback = 'Google consent is waiting for approval; open the dashboard and click Re-authorize Google for the sign-in link (Gmail resumes next run)';
  try {
    const lock = readReauthLock(o.lockFile);
    const consent = resolveLiveConsent({ lock, consentFile: o.consentFile ?? consentFileFor(o.lockFile), clientId: readConfiguredClientId(o.tokenFile) });
    if (!consent) return fallback;
    return `Google consent is waiting for approval; open this link to approve it (Gmail resumes next run): ${consent.consentUrl}`;
  } catch {
    return fallback;
  }
}

/**
 * Poll (async, never blocking the event loop) for a live consent record whose lock carries `nonce` and
 * `pid`. Resolves null at timeout.
 * @param {{ lockFile?: string, consentFile: string, clientId: string|null, nonce: string, pid: number|null, timeoutMs?: number, intervalMs?: number }} o
 * @returns {Promise<{ consentUrl: string, consentExpect: { clientId: string, state: string, port: number } }|null>}
 */
export async function waitForConsent(o) {
  const timeoutMs = Number.isFinite(o.timeoutMs) ? /** @type {number} */ (o.timeoutMs) : 5000;
  const intervalMs = Number.isFinite(o.intervalMs) ? /** @type {number} */ (o.intervalMs) : 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = readReauthLock(o.lockFile);
    if (lock.held && !lock.stale && lock.nonce === o.nonce && (o.pid === null || lock.pid === o.pid)) {
      const r = resolveLiveConsent({ lock, consentFile: o.consentFile, clientId: o.clientId });
      if (r) return r;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
}
