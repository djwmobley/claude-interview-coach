// @ts-check
/**
 * GET /api/google/auth (spec A9): the current Google token classification, for the "Run scan" drawer to
 * warn the operator BEFORE they start a scan that a consent tab is about to pop (dashboard/mcp-triggered
 * runs are interactive by default -- src/core/scan-run.js). Read-only; never writes anything, never
 * triggers a reauth itself -- that only ever happens from inside an actual scan run.
 */
import { sendJson } from '../http.js';
import { classifyGoogleTokenState } from '../../core/google.js';

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/google/auth', async (ctx) => {
    void ctx;
    const tokenFile = deps.env?.GOOGLE_TOKEN_FILE ?? '';
    const state = await classifyGoogleTokenState(tokenFile, { gmail: true, gmailRead: true });
    /** @type {string|null} */
    const expiry = state.state === 'ok' ? state.expiry : null;
    sendJson(ctx.res, 200, { ok: true, state: state.state, tokenFile: tokenFile || null, expiry });
  });
}
