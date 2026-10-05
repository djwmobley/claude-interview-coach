// @ts-check
/**
 * POST /api/google/reauth (2026-09-17 incident follow-up): lets the operator kick off the same
 * unattended Google re-authorization helper (bin/google-reauth.js) a broken-token scan run would spawn
 * on its own, without waiting for the next scheduled scan to notice. Always responds 200 and never
 * throws -- this route is a total classification of every reason it might NOT start a helper
 * (not_configured / already_ok / lock_held / already_starting / spawn_failed), with `reason: null`
 * reserved for the one branch where it actually did start one.
 *
 * Pre-checks run in a fixed order, each one a hard stop before the next is even evaluated:
 *   1. no GOOGLE_TOKEN_FILE configured at all          -> not_configured
 *   2. the token is already in category 'ok'            -> already_ok
 *   3. logs/google-reauth.lock is held and not stale     -> lock_held (readReauthLock's own staleness
 *      classification -- see src/core/google-reauth.js)
 *   4. this route itself spawned a helper in the last 15s -> already_starting (in-process guard; a
 *      double-click or a slow client retry must never spawn two helpers back to back)
 *   5. otherwise: spawn bin/google-reauth.js detached, exactly the way src/core/scan-run.js's own
 *      unattended-reauth policy spawns it (same argv shape, same "no explicit env override" -- the
 *      child simply inherits this process's environment, same as scan-run.js's call).
 *
 * Consent link (2026-10-04): the helper's own OS-level browser launch was never observed to open a tab,
 * so this route now passes --no-launch plus a per-run --nonce, sends the helper's stdout/stderr to
 * logs/google-reauth-helper.out.log, and waits up to 5 s for the consent file that exact helper writes
 * (src/core/reauth-consent.js). The browser navigates a tab it opened during the click to that URL.
 * lock_held answers carry the running helper's link too. GET /api/google/reauth is the lightweight
 * (no token classification) status the every-page banner polls.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { sendJson } from '../http.js';
import { packageRoot } from '../../core/config.js';
import { readReauthLock } from '../../core/google-reauth.js';
import { readConfiguredClientId, waitForConsent } from '../../core/reauth-consent.js';
import { buildGoogleAuthStatus, consentForLock, consentFileForDeps } from './google.js';

/** In-process double-start guard window (spec: 15s). */
const ALREADY_STARTING_GUARD_MS = 15000;
/** Spec S3: how long POST waits for the spawned helper's consent file, and how often it looks. */
const CONSENT_WAIT_MS = 5000;
const CONSENT_POLL_MS = 100;
/** Helper out log is truncated at spawn time once it grows past this. */
const HELPER_OUT_LOG_MAX_BYTES = 1024 * 1024;

/** Cap + single-line a spawn error message (never leak a multi-line stack through the response). */
function capMessage(err) {
  const raw = String(err instanceof Error ? err.message : err);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  /** @type {{ at: number, pid: number|null } | null} */
  let recentlyStarted = null;

  router.register('POST', '/api/google/reauth', async (ctx) => {
    void ctx;
    const tokenFile = deps.env?.GOOGLE_TOKEN_FILE;
    if (!tokenFile) {
      return sendJson(ctx.res, 200, { ok: true, started: false, state: null, category: null, reason: 'not_configured', pid: null });
    }

    /** @type {Awaited<ReturnType<typeof buildGoogleAuthStatus>>} */
    let status;
    try {
      status = await buildGoogleAuthStatus(deps);
    } catch {
      // buildGoogleAuthStatus already defends its own classifyGoogleTokenState call; this is one more
      // net so this route keeps its "always 200, never throws" promise no matter what.
      status = { tokenFile, state: 'broken_malformed', expiry: null, category: 'broken', reauth: { running: false, pid: null, startedAt: null, waitsUntil: null, lastOutcome: null, lastOutcomeAt: null } };
    }

    if (status.category === 'ok') {
      return sendJson(ctx.res, 200, { ok: true, started: false, state: status.state, category: status.category, reason: 'already_ok', pid: null });
    }

    const lockFile = /** @type {any} */ (deps).reauthLockFile;
    const lock = readReauthLock(lockFile);
    if (lock.held && !lock.stale) {
      const waitsUntil = lock.startedAt && lock.waitMs != null
        ? new Date(new Date(lock.startedAt).getTime() + lock.waitMs).toISOString()
        : null;
      // A helper is already waiting (another tab, or the scan's unattended policy): hand back ITS consent
      // link so the operator's click still completes with one tab (spec S3).
      const consent = consentForLock(deps, lock);
      return sendJson(ctx.res, 200, {
        ok: true, started: false, state: status.state, category: status.category, reason: 'lock_held', pid: lock.pid, waitsUntil,
        consentUrl: consent ? consent.consentUrl : null, consentExpect: consent ? consent.consentExpect : null,
      });
    }

    const now = Date.now();
    if (recentlyStarted && (now - recentlyStarted.at) < ALREADY_STARTING_GUARD_MS) {
      return sendJson(ctx.res, 200, { ok: true, started: false, state: status.state, category: status.category, reason: 'already_starting', pid: recentlyStarted.pid });
    }

    const spawnImpl = deps.spawn ?? nodeSpawn;
    const nonce = crypto.randomBytes(16).toString('hex');
    const outFd = openHelperOutLog(/** @type {any} */ (deps).reauthHelperOutLog ?? defaultHelperOutLog());
    /** @type {any} */
    let child;
    try {
      // env mirrors src/core/scan-run.js's own unattended-reauth spawn exactly: no explicit `env`
      // override, so the child inherits this process's environment verbatim, same as scan-run.js's call.
      // cwd is deliberately pinned to packageRoot() here (scan-run.js sets none), so the helper's working
      // directory is correct regardless of what directory the dashboard process itself was launched from.
      // --no-launch (2026-10-04): the tab the operator's click opened is the delivery channel; the helper's
      // own OS-level launch was never observed to produce a tab from this detached, hidden context.
      // stdout/stderr go to logs/google-reauth-helper.out.log so the full URL and any crash text survive.
      child = spawnImpl(
        process.execPath,
        [path.join(packageRoot(), 'bin', 'google-reauth.js'), '--wait-ms', '3600000', '--token-file', tokenFile, '--no-launch', '--nonce', nonce],
        { cwd: packageRoot(), detached: true, windowsHide: true, stdio: outFd === null ? 'ignore' : ['ignore', outFd, outFd] },
      );
      child.unref?.();
    } catch (err) {
      closeFd(outFd);
      return sendJson(ctx.res, 200, { ok: true, started: false, state: status.state, category: status.category, reason: 'spawn_failed', pid: null, message: capMessage(err) });
    }
    // The child holds its own duplicate of the fd from here on; the parent's copy is closed right away.
    closeFd(outFd);
    const pid = child.pid ?? null;
    recentlyStarted = { at: now, pid };

    // Spec S3: poll (async, ~100 ms, bounded) for the consent file this exact helper writes, matched by
    // the nonce passed above and the child's pid. Timeout -> consentUrl null; the client keeps polling GET.
    const waitMs = Number.isFinite(/** @type {any} */ (deps).reauthConsentWaitMs) ? /** @type {any} */ (deps).reauthConsentWaitMs : CONSENT_WAIT_MS;
    const consent = await waitForConsent({
      lockFile,
      consentFile: consentFileForDeps(deps),
      clientId: readConfiguredClientId(tokenFile),
      nonce,
      pid,
      timeoutMs: waitMs,
      intervalMs: CONSENT_POLL_MS,
    });
    return sendJson(ctx.res, 200, {
      ok: true, started: true, state: status.state, category: status.category, reason: null, pid,
      consentUrl: consent ? consent.consentUrl : null, consentExpect: consent ? consent.consentExpect : null,
    });
  }, { allowEmptyBody: true });

  // Lightweight reauth status for the every-page banner poll (2026-10-04): lock + consent link only,
  // never classifies the token (which can mean a network refresh attempt against Google per call).
  router.register('GET', '/api/google/reauth', async (ctx) => {
    const lock = readReauthLock(/** @type {any} */ (deps).reauthLockFile);
    const running = lock.held && !lock.stale;
    const consent = running ? consentForLock(deps, lock) : null;
    return sendJson(ctx.res, 200, {
      ok: true, running, pid: running ? lock.pid : null,
      consentUrl: consent ? consent.consentUrl : null, consentExpect: consent ? consent.consentExpect : null,
    });
  });
}

/** Where the dashboard-spawned helper's stdout/stderr land. */
function defaultHelperOutLog() {
  return path.join(packageRoot(), 'logs', 'google-reauth-helper.out.log');
}

/**
 * Open the helper's out log for append (truncating it first when over HELPER_OUT_LOG_MAX_BYTES).
 * Returns null on any failure: the spawn then falls back to stdio 'ignore' rather than not starting.
 * @param {string} file
 * @returns {number|null}
 */
function openHelperOutLog(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (size > HELPER_OUT_LOG_MAX_BYTES) fs.truncateSync(file, 0);
    return fs.openSync(file, 'a');
  } catch {
    return null;
  }
}

/** @param {number|null} fd */
function closeFd(fd) {
  if (fd === null) return;
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed */
  }
}
