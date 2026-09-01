// @ts-check
/**
 * Apply worker (apply pipeline slice 5, plan section 3 "Worker" + amended spec). Drives ONE application
 * end to end: verifies it is 'approved', transitions to 'submitting', attaches an apply-mode browser page
 * scoped to the application's own tenant (src/browser/session.js's per-page route policy), runs the ATS
 * adapter, integrates screening-question answers (auto-answer ONLY learned-tier hits from src/apply/
 * answers.js's matcher; alias/synonym suggestions and misses park with pending_question + screenshot;
 * never guesses a required answer), and lands the application in exactly one of submitted / needs_human /
 * failed -- total, no assume-ok path. `submitting -> submitted` goes through the SAME markSubmitted()
 * status helper the dashboard's own routes use, so `listing.status = 'applied'` always has a status event
 * behind it.
 *
 * The ONLY constructor callsite for src/apply/apply-capability.js's makeApplyCapability in this whole
 * package (test/apply-lint.test.js's lint test enforces this with a grep-based check across src/).
 *
 * Advisory lock: reuses scan's own LOCK_KEY (730193001, src/core/scan-run.js) VERBATIM, on its own
 * dedicated connection, so a scan and an apply run never share the scan Chrome concurrently -- Postgres
 * advisory locks are per-key, not per-module, so simply importing the same numeric constant is what makes
 * this serialize correctly; there is nothing else to wire.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getEnv, loadConfig, packageRoot, repoRoot } from '../core/config.js';
import { connectDedicated as defaultConnectDedicated } from '../core/db.js';
import { errFields } from '../core/errors.js';
import { log as defaultLog } from '../core/logger.js';
import {
  getApplication, transition, markSubmitted, recordSubmitRequestSent, hasSubmitRequestSentThisAttempt,
} from '../core/applications.js';
import { resolveOutputPath } from '../core/documents.js';
import { hostsForAts } from './ats-detect.js';
import { parseAnswerBank, matchQuestion } from './answers.js';
import { buildRegistry, guardUrl } from '../core/urlguard.js';
import { connectSession as defaultConnectSession } from '../browser/session.js';
import { makeApplyCapability } from './apply-capability.js';
import { ADAPTERS } from './adapters/index.js';

/** Same numeric key as src/core/scan-run.js's LOCK_KEY -- see the module doc comment. Never a different key. */
export const LOCK_KEY = 730193001;

/** Hard per-application timeout (amended spec: "hard 6-minute abort"). */
export const APPLY_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * @param {string} [file]
 * @returns {import('./answers.js').AnswerBank}
 */
export function loadAnswerBank(file = path.join(packageRoot(), 'data', 'apply-answers.md')) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = ''; // missing bank file: an empty, valid bank -- every question parks, never a crash
  }
  return parseAnswerBank(text);
}

/**
 * @param {import('pg').ClientBase} client
 * @param {any} app application row
 */
async function loadLinkedDocuments(client, app) {
  /** @param {number|null} docId */
  const lookup = async (docId) => {
    if (!docId) return null;
    const r = await client.query('SELECT rel_path FROM ic_job_documents WHERE id = $1', [docId]);
    return r.rowCount ? String(r.rows[0].rel_path) : null;
  };
  return { resumePath: await lookup(app.resume_doc_id), coverletterPath: await lookup(app.coverletter_doc_id) };
}

/**
 * sha256 hex of a linked document, using the SAME resolveOutputPath-backed path resolution
 * src/core/applications.js's approve() uses -- never a raw fs.readFileSync on a caller path.
 * @param {string} outputRoot
 * @param {string|null} relPath
 */
function hashLinkedFile(outputRoot, relPath) {
  if (!relPath) return null;
  const resolved = resolveOutputPath(outputRoot, relPath);
  if (!resolved.ok) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(resolved.absPath)).digest('hex');
}

/**
 * @typedef {Object} WorkerDeps
 * @property {import('../core/config.js').LoadedConfig} [config]
 * @property {import('../core/config.js').Env} [env]
 * @property {() => Promise<import('pg').Client>} [connectDedicated]
 * @property {typeof defaultConnectSession} [connectSession]
 * @property {Record<string, any>} [adapters] test seam: override the ADAPTERS registry
 * @property {import('./answers.js').AnswerBank} [answerBank]
 * @property {string} [outputRoot]
 * @property {import('../core/urlguard.js').Lookup} [lookup]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 * @property {(fields: Record<string, unknown>) => void} [progress] worker/adapter progress notifications;
 *   bin/apply.js wires this to a loopback POST to the dashboard's /api/internal/apply-progress
 * @property {string} [targetMarkerFile] apply pipeline slice 5's CDP target-id marker file
 *   (src/browser/session.js's reconcileTargets/writeTargetMarker) -- when present, a stale target left by
 *   a killed prior run is closed at the START of this run, and this run's own opened page is recorded for
 *   the NEXT run to reconcile in turn. Omitted entirely by tests that do not exercise this path.
 */

/**
 * @param {number} applicationId
 * @param {WorkerDeps} [deps]
 * @returns {Promise<{ ok: boolean, status: string, state?: string }>}
 */
export async function runApplyWorker(applicationId, deps = {}) {
  const log = deps.log ?? ((f) => defaultLog.info(f));
  const progress = deps.progress ?? (() => {});
  const env = deps.env ?? getEnv();
  const config = deps.config ?? loadConfig();
  const connectDedicated = deps.connectDedicated ?? (() => defaultConnectDedicated());
  const connectSession = deps.connectSession ?? defaultConnectSession;
  const adapters = deps.adapters ?? ADAPTERS;
  const outputRoot = deps.outputRoot ?? path.join(repoRoot(), 'output');
  const bank = deps.answerBank ?? loadAnswerBank();
  // Stable, well-known path (NOT the per-run --run-marker apply-runner.js uses to detect this process
  // started -- that one is fresh-per-run, mirroring scan-runner.js's own correlation marker). This one is
  // the SAME path every run, by design: it is how a crashed run's own leftover page gets found and closed
  // by the NEXT run (session.js's reconcileTargets/writeTargetMarker).
  const targetMarkerFile = deps.targetMarkerFile ?? path.join(env.JOBSEARCH_LOG_DIR, 'apply-page-targets.json');

  const client = await connectDedicated();
  let locked = false;
  /** @type {import('../browser/session.js').Session|null} */
  let session = null;
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    locked = Boolean(lockRes.rows[0].ok);
    if (!locked) {
      log({ evt: 'apply_locked', application_id: applicationId });
      return { ok: false, status: 'locked' };
    }

    const app = await getApplication(client, applicationId);
    if (app.state !== 'approved') {
      log({ evt: 'apply_skip_not_approved', application_id: applicationId, state: app.state });
      return { ok: true, status: 'skipped', state: app.state };
    }

    await transition(client, applicationId, 'submitting', { actor: 'apply', note: 'worker started' });
    progress({ applicationId, message: 'submitting' });
    log({ evt: 'apply_started', application_id: applicationId, ats: app.ats_type });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), APPLY_TIMEOUT_MS);
    timeout.unref?.();

    /** @type {{ outcome: 'submitted', confirmationRef: string|null } | { outcome: 'needs_human', pendingQuestion: any }} */
    let result;
    try {
      result = await runOneApplication({
        client, app, controller, adapters, outputRoot, bank, env, config, connectSession, progress, log, lookup: deps.lookup, targetMarkerFile,
      });
    } catch (err) {
      clearTimeout(timeout);
      // "no assume-ok path": any throw the adapter/browser layer raises is a failure UNLESS the durable
      // submit_request_sent marker already fired for this attempt, in which case a duplicate-submission
      // guard applies (amended spec) and the application parks in needs_human instead.
      const sent = await hasSubmitRequestSentThisAttempt(client, applicationId);
      const f = errFields(err);
      log({ evt: 'apply_failed', application_id: applicationId, submit_request_sent: sent, ...f });
      if (sent) {
        await transition(client, applicationId, 'needs_human', {
          actor: 'apply', note: 'submit request was sent but the run then failed; verify manually before retrying', error: f.err_message,
          pending_question: {
            kind: 'post_submit_uncertain',
            label: 'The submit request was sent but the run failed before confirming completion. Check the site or your email for a confirmation before retrying, to avoid a duplicate application.',
            page_url: app.apply_url,
          },
        });
        return { ok: true, status: 'needs_human' };
      }
      await transition(client, applicationId, 'failed', { actor: 'apply', note: 'worker failed', error: f.err_message });
      return { ok: false, status: 'failed' };
    }
    clearTimeout(timeout);

    if (result.outcome === 'submitted') {
      await markSubmitted(client, applicationId, { confirmationRef: result.confirmationRef ?? null, actor: 'apply', note: 'submitted by worker' });
      progress({ applicationId, message: 'submitted' });
      log({ evt: 'apply_submitted', application_id: applicationId });
      return { ok: true, status: 'submitted' };
    }
    if (result.outcome === 'needs_human') {
      await transition(client, applicationId, 'needs_human', { actor: 'apply', note: 'parked for human input', pending_question: result.pendingQuestion });
      progress({ applicationId, message: 'needs_human' });
      log({ evt: 'apply_needs_human', application_id: applicationId, kind: result.pendingQuestion?.kind ?? null });
      return { ok: true, status: 'needs_human' };
    }
    // Totality: an adapter returning any shape other than the two recognized outcomes is treated as a
    // failure, never assumed ok.
    await transition(client, applicationId, 'failed', { actor: 'apply', note: 'worker failed', error: 'adapter returned an unrecognized outcome' });
    return { ok: false, status: 'failed' };
  } finally {
    if (session) {
      try {
        await session.closeAll();
      } catch {
        /* ignore */
      }
    }
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
      } catch {
        /* connection gone: the lock dies with it */
      }
    }
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {{ client: import('pg').Client, app: any, controller: AbortController, adapters: Record<string, any>, outputRoot: string, bank: import('./answers.js').AnswerBank, env: any, config: any, connectSession: typeof defaultConnectSession, progress: (f: any) => void, log: (f: any) => void, lookup?: import('../core/urlguard.js').Lookup, targetMarkerFile?: string }} p
   */
  async function runOneApplication(p) {
    const { client: c, app, controller, adapters: adapterRegistry, outputRoot: outRoot, bank: b, env: e, config: cfg, connectSession: connectSess, progress: prog, log: lg } = p;
    const adapter = adapterRegistry[app.ats_type];
    if (!adapter) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unsupported_ats', label: `No automated adapter for ATS "${app.ats_type}" yet; apply by hand, then mark applied.`, page_url: app.apply_url } };
    }

    // Document-drift guard: the file linked at Approve time must not have changed on disk since (plan
    // section 2's "store the DOCX hash at Approve; the worker refuses to upload a file whose hash changed").
    if (app.resume_hash) {
      const documents = await loadLinkedDocuments(c, app);
      const currentHash = hashLinkedFile(outRoot, documents.resumePath);
      if (currentHash !== app.resume_hash) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'document_drift', label: 'The linked resume file changed on disk since Approve. Re-approve (or regenerate and re-approve) before submitting.', page_url: app.apply_url } };
      }
    }

    // Classify-only adapters (indeed_easy/linkedin_easy, plan section 8: "deliberately not automated")
    // never touch the browser at all.
    if (adapter.classifyOnly) {
      return adapter.run(null, { applicationId: app.id, applyUrl: app.apply_url, atsType: app.ats_type, log: (f) => lg({ application_id: app.id, ...f }) });
    }

    if (typeof app.apply_url !== 'string' || !app.apply_url) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'This application has no apply URL on record; apply by hand.' } };
    }
    /** @type {string} */
    let tenantHost;
    try {
      tenantHost = new URL(app.apply_url).hostname.toLowerCase();
    } catch {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'The application URL could not be parsed; apply by hand.' } };
    }

    session = await connectSess({ cdpUrl: e.SCAN_CDP_URL });
    if (p.targetMarkerFile) await session.reconcileTargets(p.targetMarkerFile);
    await session.reconcile();
    const page = await session.attachPage({
      mode: 'apply', tenantHost, atsHosts: hostsForAts(app.ats_type), uploadHosts: adapter.uploadHosts ?? [], signal: controller.signal,
    });
    if (p.targetMarkerFile) await session.writeTargetMarker(p.targetMarkerFile);

    const registry = buildRegistry(cfg);
    const navSource = app.ats_type === 'indeed_easy' ? 'indeed' : app.ats_type === 'linkedin_easy' ? 'linkedin' : app.ats_type;
    const guarded = await guardUrl(app.apply_url, registry, { source: navSource, lookup: p.lookup });
    await page.goto(guarded.url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });

    const cap = makeApplyCapability(page, { signal: controller.signal, applicationId: app.id, outputRoot: outRoot });
    const documents = await loadLinkedDocuments(c, app);
    const ctx = {
      applicationId: app.id,
      applyUrl: app.apply_url,
      tenantHost,
      atsType: app.ats_type,
      documents,
      profile: {
        email: (b.facts.get('email')?.value) ?? app.account_email,
        fullName: (b.facts.get('full_name')?.value) ?? null,
        phone: (b.facts.get('phone')?.value) ?? null,
      },
      answers: {
        bank: b,
        match: (/** @type {unknown} */ label, /** @type {unknown} */ controlType, /** @type {unknown} */ options) => matchQuestion(b, { label, controlType, options }),
      },
      signal: controller.signal,
      log: (/** @type {any} */ f) => lg({ application_id: app.id, ...f }),
      progress: (/** @type {any} */ f) => prog({ applicationId: app.id, ...f }),
      recordSubmitRequestSent: async () => {
        await recordSubmitRequestSent(c, app.id);
        lg({ evt: 'apply_submit_request_sent', application_id: app.id });
      },
    };

    return adapter.run(cap, ctx);
  }
}
