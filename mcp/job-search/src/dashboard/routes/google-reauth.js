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
 */
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { sendJson } from '../http.js';
import { packageRoot } from '../../core/config.js';
import { readReauthLock } from '../../core/google-reauth.js';
import { buildGoogleAuthStatus } from './google.js';

/** In-process double-start guard window (spec: 15s). */
const ALREADY_STARTING_GUARD_MS = 15000;

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

    const lock = readReauthLock(/** @type {any} */ (deps).reauthLockFile);
    if (lock.held && !lock.stale) {
      const waitsUntil = lock.startedAt && lock.waitMs != null
        ? new Date(new Date(lock.startedAt).getTime() + lock.waitMs).toISOString()
        : null;
      return sendJson(ctx.res, 200, { ok: true, started: false, state: status.state, category: status.category, reason: 'lock_held', pid: lock.pid, waitsUntil });
    }

    const now = Date.now();
    if (recentlyStarted && (now - recentlyStarted.at) < ALREADY_STARTING_GUARD_MS) {
      return sendJson(ctx.res, 200, { ok: true, started: false, state: status.state, category: status.category, reason: 'already_starting', pid: recentlyStarted.pid });
    }

    const spawnImpl = deps.spawn ?? nodeSpawn;
    try {
      // Exactly src/core/scan-run.js's own unattended-reauth spawn shape (process.execPath + the script
      // path as argv, --wait-ms/--token-file, detached/windowsHide/stdio:ignore, NO explicit `env`
      // override -- the child inherits this process's environment verbatim, same as scan-run.js's call).
      const child = spawnImpl(
        process.execPath,
        [path.join(packageRoot(), 'bin', 'google-reauth.js'), '--wait-ms', '3600000', '--token-file', tokenFile],
        { cwd: packageRoot(), detached: true, windowsHide: true, stdio: 'ignore' },
      );
      child.unref?.();
      recentlyStarted = { at: now, pid: child.pid ?? null };
      return sendJson(ctx.res, 200, { ok: true, started: true, state: status.state, category: status.category, reason: null, pid: child.pid ?? null });
    } catch (err) {
      return sendJson(ctx.res, 200, { ok: true, started: false, state: status.state, category: status.category, reason: 'spawn_failed', pid: null, message: capMessage(err) });
    }
  }, { allowEmptyBody: true });
}
