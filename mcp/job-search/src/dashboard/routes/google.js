// @ts-check
/**
 * GET /api/google/auth (spec A9, extended 2026-09-17): the current Google token classification, for the
 * "Run scan" drawer to warn the operator BEFORE they start a scan that a consent tab is about to pop
 * (dashboard/mcp-triggered runs are interactive by default -- src/core/scan-run.js). Read-only; never
 * writes anything, never triggers a reauth itself -- POST /api/google/reauth (routes/google-reauth.js)
 * is the only route that does that.
 *
 * `category` (2026-09-17) is the total classification the front end now branches on instead of the raw
 * state string: 'ok' | 'broken' | 'unknown'. 'unknown' is the safe default for anything not in
 * classifyGoogleTokenState's own known-states set (GOOGLE_TOKEN_STATE_HINTS' keys plus 'ok') -- a future
 * state this route has not been updated for still renders a usable (if generic) badge rather than
 * silently falling through to nothing, per the "friction over silent escape" rule for total
 * classifications.
 */
import { sendJson } from '../http.js';
import { classifyGoogleTokenState, GOOGLE_TOKEN_STATE_HINTS } from '../../core/google.js';
import { readReauthLock, readLastReauthOutcome } from '../../core/google-reauth.js';
import { consentFileFor, readConfiguredClientId, resolveLiveConsent } from '../../core/reauth-consent.js';

/** Every branch classifyGoogleTokenState can ever return, derived from its own hint map so this set
 * never drifts out of sync with google.js's own total classification of broken_* states. */
const KNOWN_GOOGLE_STATES = new Set(['ok', ...Object.keys(GOOGLE_TOKEN_STATE_HINTS)]);

/**
 * Total classification of a raw token-state string into the badge-level category the front end
 * branches on.
 * @param {string} state
 * @returns {'ok'|'broken'|'unknown'}
 */
export function categoryForState(state) {
  if (state === 'ok') return 'ok';
  if (KNOWN_GOOGLE_STATES.has(state)) return 'broken';
  return 'unknown';
}

/**
 * @param {import('../server.js').DashboardDeps} deps
 */
export async function buildGoogleAuthStatus(deps) {
  const tokenFile = deps.env?.GOOGLE_TOKEN_FILE ?? '';
  // Same test-seam pattern src/core/scan-run.js already uses for this exact function
  // (`deps.classifyGoogleTokenState ?? classifyGoogleTokenState`): production always falls through to
  // the real classifier; tests inject a fake to reach 'ok' deterministically, without a real Google
  // token or network call.
  const doClassify = /** @type {any} */ (deps).classifyGoogleTokenState ?? classifyGoogleTokenState;
  /** @type {{ state: string, expiry?: string|null }} */
  let state;
  try {
    state = await doClassify(tokenFile, { gmail: true, gmailRead: true });
  } catch {
    // classifyGoogleTokenState is documented as a total classification that never throws; this is a
    // defensive net only, so a route promising "always 200" never breaks on an unforeseen exception.
    state = { state: 'broken_malformed' };
  }
  const category = categoryForState(state.state);
  const expiry = state.state === 'ok' ? (state.expiry ?? null) : null;

  const lock = readReauthLock(/** @type {any} */ (deps).reauthLockFile);
  const running = lock.held && !lock.stale;
  const waitsUntil = lock.startedAt && lock.waitMs != null
    ? new Date(new Date(lock.startedAt).getTime() + lock.waitMs).toISOString()
    : null;
  const last = readLastReauthOutcome(/** @type {any} */ (deps).reauthLastOutcomeFile);
  const consent = running ? consentForLock(deps, lock) : null;

  return {
    tokenFile: tokenFile || null,
    state: state.state,
    expiry,
    category,
    reauth: {
      running,
      pid: lock.pid,
      startedAt: lock.startedAt,
      waitsUntil,
      lastOutcome: last ? last.outcome : null,
      lastOutcomeAt: last ? last.at : null,
      consentUrl: consent ? consent.consentUrl : null,
      consentExpect: consent ? consent.consentExpect : null,
    },
  };
}

/** Consent file path the dashboard reads (test seam: deps.reauthConsentFile, else next to the lock).
 * @param {import('../server.js').DashboardDeps} deps */
export function consentFileForDeps(deps) {
  const d = /** @type {any} */ (deps);
  return typeof d.reauthConsentFile === 'string' && d.reauthConsentFile ? d.reauthConsentFile : consentFileFor(d.reauthLockFile);
}

/**
 * The live helper's consent link (2026-10-04 consent-link fix, spec S4): non-null only when `lock` is
 * live, the consent file's nonce and pid equal the lock's, it has not expired, and the URL classifies
 * OPEN against the configured client id (src/core/reauth-consent.js resolveLiveConsent).
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof readReauthLock>} lock
 */
export function consentForLock(deps, lock) {
  return resolveLiveConsent({ lock, consentFile: consentFileForDeps(deps), clientId: readConfiguredClientId(deps.env?.GOOGLE_TOKEN_FILE) });
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/google/auth', async (ctx) => {
    void ctx;
    const status = await buildGoogleAuthStatus(deps);
    sendJson(ctx.res, 200, { ok: true, ...status });
  });
}
