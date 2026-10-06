// @ts-check
/**
 * Credential routes (apply pipeline slice 4, plan section "5a. Credential prompt"). Loopback-only like
 * every other dashboard route (the server-wide Host/Origin guards in server.js/http.js already cover
 * this; nothing here re-implements them). A password is accepted in the request body -- the ONLY place
 * on the wire it is ever allowed to appear -- and is never logged, never echoed back in the response, and
 * never reaches Postgres: only the credential's target name is ever written to a DB row (via
 * resume-gate.js resumeForCredential()'s own event note, which itself never includes the password -- see
 * src/core/applications.js's insertApplicationEvent, which only ever receives caller-supplied `note`/
 * `meta` text this route never populates with the password).
 *
 * `deps.credentials` is REQUIRED here (unlike deps.calendar, which has a documented "may be absent"
 * contract): bin/dashboard.js always wires a real one (src/core/credentials.js's createCredentials()),
 * and route tests inject a fake the same way they already stub deps.scanRunner/deps.calendar.
 */
import { JobSearchError } from '../../core/errors.js';
import { resumeForCredential } from '../../apply/resume-gate.js';
import { sendJson } from '../http.js';

const TARGET_RE = /^ic-jobsearch\/[A-Za-z0-9.-]+$/;

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 * @param {ReturnType<typeof import('../stream.js').createStreamHub>} [streamHub]
 */
export function register(router, deps, streamHub) {
  router.register('POST', '/api/credentials', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    if (typeof b.target !== 'string' || !TARGET_RE.test(b.target)) {
      throw new JobSearchError('VALIDATION', 'target must match ic-jobsearch/<tenantHost>');
    }
    if (typeof b.username !== 'string' || !b.username.trim()) {
      throw new JobSearchError('VALIDATION', 'username is required');
    }
    if (typeof b.password !== 'string' || !b.password) {
      throw new JobSearchError('VALIDATION', 'password is required');
    }
    const applicationId = Number(b.applicationId);
    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      throw new JobSearchError('VALIDATION', 'applicationId must be a positive integer');
    }
    if (!deps.credentials) {
      throw new JobSearchError('VALIDATION', 'credential storage is not configured on this server');
    }

    await deps.credentials.write(b.target, b.username, b.password);

    // Resume gate R2: the credential is always saved, but the named application is resumed (needs_human
    // -> approved, attempt+1) ONLY when it is parked on kind 'credential' for this exact target, checked
    // under the row lock (src/apply/resume-gate.js resumeForCredential). Any other case (not parked, a
    // different kind, a different target, no such application) leaves the application alone and the
    // response says so with `resumed: false` and a closed `reason`. This closes the loophole where saving
    // any credential resumed an application parked on anything at all.
    const out = await deps.withClient((c) => resumeForCredential(c, applicationId, b.target, {
      actor: 'dashboard', acknowledgePartialDraft: b.acknowledge_partial_draft === true,
    }));
    if (!out.resumed) {
      return sendJson(ctx.res, 200, { ok: true, resumed: false, reason: out.reason, state: out.state });
    }
    const row = out.row;

    streamHub?.notifyChanged('events');
    // Apply pipeline slice 5: the resume seam this route was built for (slice 4's own module doc comment)
    // now actually starts the runner, instead of leaving the application sitting in 'approved' until the
    // next tick. Non-fatal: a start failure is logged, never turns this successful resume into an error.
    if (deps.applyRunner) {
      Promise.resolve(deps.applyRunner.start(applicationId)).catch((err) => {
        deps.log?.({ evt: 'apply_runner_start_failed', application_id: applicationId, err_message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) });
      });
    }
    sendJson(ctx.res, 200, { ok: true, resumed: true, row, warning: out.warning });
  });
}
