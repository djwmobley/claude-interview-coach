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
 * Unattended submit (spec v1 items 1-4, v2 addendum C1-C9): a form adapter reaches its final Submit only
 * through ctx.submit, and Workday only through the scripted post-finish step (workdaySubmitStep); both
 * run src/apply/unattended-submit.js's runGuardedSubmit (click-time gate, atomic marker, single click,
 * confirmation). The run holds a per-application advisory lock throughout, so reconcileStale never treats
 * a live run as stale.
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
import { connectDedicated as defaultConnectDedicated, withTransaction } from '../core/db.js';
import { errFields } from '../core/errors.js';
import { log as defaultLog } from '../core/logger.js';
import {
  getApplication, transition, transitionUnwrapped, markSubmitted, hasSubmitRequestSentEver,
  hasAssistedNextClickEver, assistedPartialQuestion, submitUnconfirmedQuestion, APPLICATION_LOCK_NAMESPACE,
  recordDeferral,
} from '../core/applications.js';
import { runGuardedSubmit, clickTimeExclusionCheck } from './unattended-submit.js';
import { SUBMIT_GATE_KIND } from './submit-gate.js';
import { classifyExclusion, loadExclusionConfig, walkDuplicateRoot } from './exclusions.js';
import { resolveOutputPath } from '../core/documents.js';
import { hostsForAts } from './ats-detect.js';
import { parseAnswerBank, matchQuestion } from './answers.js';
import { buildRegistry, guardUrl } from '../core/urlguard.js';
import { connectSession as defaultConnectSession, applyTargetMarkerPath } from '../browser/session.js';
import { makeApplyCapability } from './apply-capability.js';
import { ADAPTERS } from './adapters/index.js';
import { credentialTarget, readCredential, writeCredential, generatePassword } from '../core/credentials.js';
import { findVerificationMessage } from './gmail-verify.js';
import { easyApplyStartGate, runAssistedEasyApply, easyApplyConfig, refundEasyApplyCharge } from './easy-apply-flow.js';
import { createEasyApplyRunner } from './easy-apply-runner.js';
import { parkAwaitingSubmit } from '../core/easy-apply-state.js';
import { profileForAts } from './assisted/profiles/index.js';
import { runAssistedHandoff } from './assisted/handoff.js';
import { workdayStartGate, refundWorkdayCharge, workdayAssistedConfig } from './assisted/gate.js';
import { createAssistedRunner } from './assisted/runner.js';
import { spawn as nodeSpawn } from 'node:child_process';

/** Same numeric key as src/core/scan-run.js's LOCK_KEY -- see the module doc comment. Never a different key. */
export const LOCK_KEY = 730193001;

/** Namespace for the pre-submit exclusion recheck's 2-key pg_advisory_xact_lock (see
 * preSubmitExclusionRecheck below). A 2-key advisory lock occupies a wholly separate key space from a
 * 1-key one, so this can never collide with LOCK_KEY above regardless of what integer is chosen here --
 * this specific value has no other significance. */
export const EXCLUSION_LOCK_NAMESPACE = 907010001;

/**
 * Apply exclusion gate, pre-submit recheck (spec item 4): re-runs the FULL classifyExclusion inside the
 * SAME transaction that moves the application from 'approved' to 'submitting', holding
 * pg_advisory_xact_lock on the listing's dedup root for the duration of that transaction -- so a second
 * application racing to submit against a listing sharing the same root serializes here rather than both
 * passing the check and both submitting. Aborts to 'needs_human' (never 'failed': this is not a technical
 * failure, it is new information that surfaced between Approve and submit) when no longer eligible.
 *
 * `excludeApplicationId: applicationId` is passed to classifyExclusion so THIS application's own
 * (currently 'approved', about to become 'submitting') row never counts as "already applied" against
 * itself -- see classifyExclusion's own doc comment on that field. A DIFFERENT application (a duplicate
 * listing, or the same company+title, that reached a non-withdrawn state after this one was approved) is
 * exactly what this recheck exists to catch.
 * @param {import('pg').ClientBase} client
 * @param {{ id: number, listing_id: number, apply_url: string|null }} app
 * @param {import('./exclusions.js').ExclusionConfig} exclusionConfig
 * @param {{ actor?: string }} [opts]
 * @returns {Promise<import('./exclusions.js').ExclusionResult>}
 */
export async function preSubmitExclusionRecheck(client, app, exclusionConfig, opts = {}) {
  const actor = opts.actor ?? 'apply';
  return withTransaction(client, async (c) => {
    const rootId = await walkDuplicateRoot(c, app.listing_id);
    await c.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [EXCLUSION_LOCK_NAMESPACE, rootId]);
    const listingRes = await c.query(
      `SELECT id, company, company_norm, title, title_norm, apply_url, url, url_normalized, description
       FROM ic_job_listings WHERE id = $1`,
      [app.listing_id],
    );
    // A listing row that has vanished between Approve and submit is itself a "no longer eligible" outcome
    // -- never treated as a silent pass.
    const verdict = listingRes.rowCount === 0
      ? { branch: 'unknown_company', reason: 'listing no longer found at pre-submit recheck', evidence: {} }
      : await classifyExclusion(
        {
          id: Number(listingRes.rows[0].id), company: listingRes.rows[0].company ?? null, companyNorm: listingRes.rows[0].company_norm ?? null,
          title: listingRes.rows[0].title ?? null, titleNorm: listingRes.rows[0].title_norm ?? null, applyUrl: listingRes.rows[0].apply_url ?? null,
          sourceUrl: listingRes.rows[0].url_normalized ?? listingRes.rows[0].url ?? null, description: listingRes.rows[0].description ?? null,
        },
        { client: c, config: exclusionConfig, excludeApplicationId: app.id },
      );
    // TRANSITIONS has no approved -> needs_human edge (only approved -> submitting|withdrawn): this always
    // moves to 'submitting' first (exactly the transition worker.js's own caller used to make directly),
    // then -- still inside this same transaction, so nothing outside ever observes the intermediate state
    // -- re-routes on to 'needs_human' when no longer eligible (submitting -> needs_human IS a legal edge).
    await transitionUnwrapped(c, app.id, 'submitting', { actor, note: 'worker started' }, {});
    if (verdict.branch !== 'eligible') {
      await transitionUnwrapped(c, app.id, 'needs_human', {
        actor, note: `pre-submit exclusion recheck aborted: ${verdict.reason}`,
        pending_question: { kind: 'apply_exclusion', label: `Pre-submit check found: ${verdict.reason}. Review before applying.`, page_url: app.apply_url },
      }, {});
    }
    return verdict;
  });
}

/** Hard per-application timeout (amended spec: "hard 6-minute abort"). */
export const APPLY_TIMEOUT_MS = 6 * 60 * 1000;

/** Assisted LinkedIn Easy Apply's own budget (spec B4: 15 minutes for this path). */
export const EASY_APPLY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * True when a thrown error is a unique-index violation (directly, or wrapped by a helper that kept the
 * driver error as `cause` / in its message).
 * @param {unknown} err
 */
function isUniqueViolationLike(err) {
  const e = /** @type {any} */ (err);
  return Boolean(e && (e.code === '23505' || (e.cause && e.cause.code === '23505') || /duplicate key value|inflight_uq/.test(String(e.message ?? ''))));
}

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
 * @property {{ read: (tenantHost: string) => Promise<{username: string, password: string}|null>, write: (tenantHost: string, username: string, password: string) => Promise<void>, generatePassword: () => string }} [credentials]
 *   apply pipeline slice 6 test seam: override the whole per-tenant credential surface an adapter reaches
 *   through ctx.credentials (backed by src/core/credentials.js's Windows Credential Manager wrapper by
 *   default). Adapters that need an account (e.g. Workday) read/write through this, never import
 *   src/core/credentials.js directly.
 * @property {(o: { tenantHost: string, sentAfter: Date }) => Promise<import('./gmail-verify.js').VerifyResult>} [gmailVerify]
 *   apply pipeline slice 6 test seam: override ctx.gmailVerify (backed by src/apply/gmail-verify.js's
 *   findVerificationMessage, reusing the SAME Gmail auth path src/adapters/gmail.js already uses, by
 *   default). An adapter never touches env.GOOGLE_TOKEN_FILE or google.js directly.
 * @property {(ms: number) => Promise<void>} [sleep] apply pipeline slice 6 test seam: ctx.sleep, used by an
 *   adapter's own bounded poll loop (e.g. Workday's verify-email wait). Real `setTimeout` by default.
 * @property {import('./easy-apply-flow.js').EasyApplyDeps} [easyApply] assisted LinkedIn Easy Apply seams
 *   and the run's trigger ('dashboard' by default; bin/auto-apply.js passes 'morning'). Production wires
 *   the real CDP connector, driver, and src/apply/easy-apply-runner.js when omitted.
 * @property {import('./exclusions.js').ExclusionConfig} [exclusionConfig] apply exclusion gate test seam:
 *   override config/apply-exclusions.json's loaded shape (src/apply/exclusions.js's loadExclusionConfig by
 *   default). A missing/invalid file is a hard error here exactly as it is for auto-apply's select phase.
 * @property {{ runner?: { run: (input: { applicationId: number, leaseToken: string }) => Promise<any> }, now?: () => Date, trigger?: 'morning'|'dashboard' }} [workday]
 *   assisted Workday seams: the headless runner (default: src/apply/assisted/runner.js with the Workday
 *   profile, tool assisted_apply), the clock, and the trigger.
 * @property {typeof preSubmitExclusionRecheck} [preSubmitExclusionRecheck] test seam ONLY -- see
 *   preSubmitExclusionRecheck's own export for why a test suite with shared company/title fixtures across
 *   many unrelated test cases needs this. Never set by bin/apply.js or bin/auto-apply.js.
 * @property {() => any} [loadFreshConfig] unattended submit (spec v2 C1): the config read AT CLICK TIME.
 *   Default: a fresh, uncached loadConfig of the same config directory. Test seam.
 * @property {(client: import('pg').ClientBase, app: any) => Promise<{ branch: string, reason?: string }>} [clickTimeExclusionCheck]
 *   unattended submit (spec item 1, v2 C11): the exclusion verdict AT CLICK TIME. Default: the full
 *   classifyExclusion with this application's own row excluded, against a fresh read of
 *   config/apply-exclusions.json (or the exclusionConfig seam when a test set one). Test seam.
 * @property {{ pollMs?: number, maxPolls?: number, settleMs?: number }} [submitTiming] confirmation poll
 *   cadence after the click (src/apply/unattended-submit.js defaults). Test seam.
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
  const exclusionConfig = deps.exclusionConfig ?? loadExclusionConfig(config.configDir);
  // Test seam only (never overridden by bin/apply.js or bin/auto-apply.js): lets a test exercising
  // unrelated worker behavior with a shared company/title fixture opt out of the exclusion gate's own
  // cross-listing "already applied elsewhere with this company+title" DB lookup (branch c/d), which would
  // otherwise see every OTHER test in the same file/run that reused the same fixture and reached a
  // non-withdrawn state. Defaults to the real gate.
  const runPreSubmitExclusionRecheck = deps.preSubmitExclusionRecheck ?? preSubmitExclusionRecheck;
  const credentials = deps.credentials ?? {
    read: (/** @type {string} */ tenantHost) => readCredential(credentialTarget(tenantHost)),
    write: (/** @type {string} */ tenantHost, /** @type {string} */ username, /** @type {string} */ password) => writeCredential(credentialTarget(tenantHost), username, password),
    generatePassword,
  };
  const gmailVerify = deps.gmailVerify ?? ((/** @type {{ tenantHost: string, sentAfter: Date }} */ o) => findVerificationMessage({ tokenFile: env.GOOGLE_TOKEN_FILE, tenantHost: o.tenantHost, sentAfter: o.sentAfter }));
  const sleep = deps.sleep ?? ((/** @type {number} */ ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  // Stable, well-known path (NOT the per-run --run-marker apply-runner.js uses to detect this process
  // started -- that one is fresh-per-run, mirroring scan-runner.js's own correlation marker). This one is
  // the SAME path every run, by design: it is how a crashed run's own leftover page gets found and closed
  // by the NEXT run (session.js's reconcileTargets/writeTargetMarker).
  const targetMarkerFile = deps.targetMarkerFile ?? applyTargetMarkerPath(env.JOBSEARCH_LOG_DIR);
  // Unattended submit (spec v2 C1): the click-time gate reads config and the exclusion list FRESH from
  // disk, never this run's start-of-run copies.
  const loadFreshConfig = deps.loadFreshConfig ?? (() => loadConfig({ fresh: true, dir: config.configDir }));
  const runClickTimeExclusion = deps.clickTimeExclusionCheck
    ?? ((/** @type {import('pg').ClientBase} */ c, /** @type {any} */ a) => clickTimeExclusionCheck(c, a, deps.exclusionConfig ?? loadExclusionConfig(config.configDir)));
  const submitTiming = deps.submitTiming ?? {};

  const client = await connectDedicated();
  let locked = false;
  let appLocked = false;
  /** @type {import('../browser/session.js').Session|null} */
  let session = null;
  /** The Workday prelude tab's capability, for the scripted post-finish submit step only. @type {any} */
  let preludeCap = null;
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    locked = Boolean(lockRes.rows[0].ok);
    if (!locked) {
      log({ evt: 'apply_locked', application_id: applicationId });
      return { ok: false, status: 'locked' };
    }
    // Spec v2 C3/C9: the per-application lock, held for the whole run. The submit gate re-takes it
    // (re-entrant on this session) across check, marker insert, and click; reconcileStale skips a row
    // whose lock is held, so a live run is never reconciled as stale.
    const appLockRes = await client.query('SELECT pg_try_advisory_lock($1::int, $2::int) AS ok', [APPLICATION_LOCK_NAMESPACE, applicationId]);
    appLocked = Boolean(appLockRes.rows[0].ok);
    if (!appLocked) {
      log({ evt: 'apply_locked', application_id: applicationId, scope: 'application' });
      return { ok: false, status: 'locked' };
    }

    const app = await getApplication(client, applicationId);
    if (app.state !== 'approved') {
      log({ evt: 'apply_skip_not_approved', application_id: applicationId, state: app.state });
      return { ok: true, status: 'skipped', state: app.state };
    }

    // Unblock-auto-apply Item 1 (the app 5 fix, A10): every deferral leaves the row 'approved', so it is
    // also written as an application event (one per reason per local day), under the per-application lock
    // this client holds. A failed write is logged and never turns the deferral into a crash.
    /** @param {string} reason */
    const deferred = async (reason) => {
      try {
        await recordDeferral(client, applicationId, reason);
      } catch (err) {
        log({ evt: 'apply_deferral_event_failed', application_id: applicationId, reason, ...errFields(err) });
      }
      return { ok: true, status: 'deferred', reason, state: 'approved' };
    };

    // Assisted LinkedIn Easy Apply (operator decision 2026-10-04): breaker, window/spacing, the single
    // in-flight slot, and the daily cap are all checked BEFORE the claim, so a refusal leaves the
    // application 'approved' for a later run. The cap reservation (last) is made here and kept only when
    // the claim below succeeds with an eligible verdict: a refused claim (the row changed state between
    // read and claim, the in-flight index refused it, or the recheck found it ineligible) refunds it,
    // because no attempt ran.
    const assisted = Boolean(adapters[app.ats_type] && adapters[app.ats_type].assisted);
    // Total classification of the assisted path (spec v1 clause 7): LinkedIn keeps its raw-CDP flow;
    // an assisted adapter with a profile and a scripted prepare() runs the prelude handoff (Workday);
    // anything else assisted has no runnable path and is deferred, never run unattended.
    const assistedProfile = assisted ? profileForAts(app.ats_type) : null;
    const assistedKind = !assisted ? null
      : app.ats_type === 'linkedin_easy' ? 'linkedin'
        : assistedProfile && typeof adapters[app.ats_type].prepare === 'function' ? 'prelude' : 'unsupported';
    if (assistedKind === 'unsupported') {
      log({ evt: 'assisted_deferred', application_id: applicationId, reason: 'no_assisted_path' });
      return deferred('no_assisted_path');
    }
    /** @type {import('./easy-apply-flow.js').EasyApplyDeps} */
    const easyApplyDeps = deps.easyApply ?? {};
    const workdayDeps = deps.workday ?? {};
    /** @type {any} */
    let easyApplyCharge = null;
    if (assistedKind === 'linkedin') {
      const gate = await easyApplyStartGate(client, { config, easyApply: easyApplyDeps });
      if (!gate.ok) {
        log({ evt: 'easy_apply_deferred', application_id: applicationId, reason: gate.reason });
        return deferred(gate.reason);
      }
      easyApplyCharge = gate.charge;
    } else if (assistedKind === 'prelude') {
      const gate = await workdayStartGate(client, { config, now: (workdayDeps.now ?? (() => new Date()))() });
      if (!gate.ok) {
        log({ evt: 'assisted_deferred', application_id: applicationId, reason: gate.reason });
        return deferred(gate.reason);
      }
      easyApplyCharge = gate.charge;
    }
    const refundCharge = async () => {
      if (!easyApplyCharge) return;
      const charge = easyApplyCharge;
      easyApplyCharge = null;
      try {
        if (charge.kind === 'workday') await refundWorkdayCharge(client, charge);
        else await refundEasyApplyCharge(client, charge);
        log({ evt: 'easy_apply_charge_refunded', application_id: applicationId });
      } catch (err) {
        log({ evt: 'easy_apply_charge_refund_failed', application_id: applicationId, ...errFields(err) });
      }
    };

    // Apply exclusion gate, pre-submit recheck (spec item 4): the FULL classifyExclusion runs again here,
    // inside the same transaction that moves approved -> submitting, under an advisory lock on the
    // listing's dedup root -- see preSubmitExclusionRecheck's own doc comment. New information that
    // surfaced between Approve and now (a duplicate listing applied to elsewhere, a config change) parks
    // the application in needs_human instead of ever reaching the adapter.
    /** @type {Awaited<ReturnType<typeof preSubmitExclusionRecheck>>} */
    let preSubmitVerdict;
    try {
      preSubmitVerdict = await runPreSubmitExclusionRecheck(client, app, exclusionConfig, { actor: 'apply' });
    } catch (err) {
      await refundCharge();
      // G9: the unique partial index refused a second linkedin_easy row in submitting/awaiting_submit.
      if (assisted && isUniqueViolationLike(err)) {
        log({ evt: 'easy_apply_deferred', application_id: applicationId, reason: 'easy_apply_in_flight' });
        return deferred('easy_apply_in_flight');
      }
      // The row moved on between the read above and the claim (the dashboard withdrew it, say): the
      // claim transaction rolled back, nothing was submitted, and the row keeps whatever state the other
      // writer gave it. A skip, never a throw, so a scheduled caller does not count it as a crash.
      const now = await getApplication(client, applicationId).catch(() => null);
      if (now && now.state !== 'approved') {
        log({ evt: 'apply_skip_state_changed', application_id: applicationId, state: now.state, ...errFields(err) });
        return { ok: true, status: 'skipped', state: now.state };
      }
      throw err;
    }
    if (preSubmitVerdict.branch !== 'eligible') {
      await refundCharge();
      log({ evt: 'apply_presubmit_exclusion_blocked', application_id: applicationId, branch: preSubmitVerdict.branch });
      progress({ applicationId, message: 'needs_human' });
      return { ok: true, status: 'needs_human' };
    }
    progress({ applicationId, message: 'submitting' });
    log({ evt: 'apply_started', application_id: applicationId, ats: app.ats_type });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), assisted ? EASY_APPLY_TIMEOUT_MS : APPLY_TIMEOUT_MS);
    timeout.unref?.();

    /** @type {any} */
    let result;
    try {
      const wdCfg = workdayAssistedConfig(config);
      result = assistedKind === 'prelude'
        ? await runAssistedHandoff({
          client, app, profile: assistedProfile, trigger: workdayDeps.trigger ?? easyApplyDeps.trigger ?? 'dashboard', log, now: workdayDeps.now,
          ttlMs: wdCfg.runTimeoutMinutes * 60000, breakerHours: wdCfg.breakerHours,
          prelude: () => runPrelude({
            client, app, controller, adapter: adapters[app.ats_type], outputRoot, bank, env, config, connectSession, progress, log, lookup: deps.lookup, targetMarkerFile, credentials, gmailVerify, sleep,
          }),
          // Unattended submit (spec item 2): the scripted post-finish step. The model never reaches it.
          submitStep: (m) => workdaySubmitStep({ client, app, ledger: m.ledger, prefilledUnledgered: m.prefilledUnledgered }),
          // The scripted prelude has already used part of the worker's budget; the model gets what is left.
          runner: workdayDeps.runner ?? createAssistedRunner({
            profile: assistedProfile, env, logDir: env.JOBSEARCH_LOG_DIR, repoRoot: repoRoot(), spawn: nodeSpawn,
            timeoutMs: Math.max(60000, (wdCfg.runTimeoutMinutes - 5) * 60000),
          }),
        })
        : assistedKind === 'linkedin'
        ? await runAssistedEasyApply({
          client, app, config, env, outputRoot, lookup: deps.lookup, log,
          easyApply: {
            ...easyApplyDeps,
            runner: easyApplyDeps.runner ?? createEasyApplyRunner({
              env, logDir: env.JOBSEARCH_LOG_DIR, repoRoot: repoRoot(), spawn: nodeSpawn,
              timeoutMs: Math.max(60000, (easyApplyConfig(config).runTimeoutMinutes - 2) * 60000),
            }),
          },
        })
        : await runOneApplication({
          client, app, controller, adapters, outputRoot, bank, env, config, connectSession, progress, log, lookup: deps.lookup, targetMarkerFile, credentials, gmailVerify, sleep,
          loadFreshConfig, clickTimeExclusionCheck: runClickTimeExclusion, submitTiming,
        });
    } catch (err) {
      clearTimeout(timeout);
      // "no assume-ok path": any throw the adapter/browser layer raises is a failure UNLESS the durable
      // submit_request_sent marker exists (spec v2 C2: from ANY attempt), in which case a duplicate-
      // submission guard applies and the application parks as submit_unconfirmed instead.
      const sent = await hasSubmitRequestSentEver(client, applicationId);
      const f = errFields(err);
      log({ evt: 'apply_failed', application_id: applicationId, submit_request_sent: sent, ...f });
      // A10: a run that clicked Next may have left a saved draft at the ATS; a human decides the retry.
      // Resume gate R3: the durable marker counts a Next click from ANY attempt, not only this one.
      if (!sent && await hasAssistedNextClickEver(client, applicationId)) {
        await transition(client, applicationId, 'needs_human', {
          actor: 'apply', note: 'assisted run failed after a Next click; a human checks the saved draft before any retry', error: f.err_message,
          pending_question: assistedPartialQuestion(app.apply_url ?? null, 'the run crashed'),
        });
        return { ok: true, status: 'needs_human' };
      }
      if (sent) {
        await transition(client, applicationId, 'needs_human', {
          actor: 'apply', note: 'submit request was sent but the run then failed; submit unconfirmed, never retried', error: f.err_message,
          pending_question: submitUnconfirmedQuestion(app.apply_url ?? null, 'the run failed after the submit marker'),
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
    if (result.outcome === 'awaiting_submit') {
      // Spec G12: the tab stays open, its CDP target id is stored, and nothing here (or anywhere else) ever
      // clicks Submit. Damian submits in the scan Chrome and confirms with "I submitted".
      // Workday (A9): the handoff already removed the route policy from the tab before returning here.
      await parkAwaitingSubmit(client, applicationId, {
        targetId: result.targetId, ledger: result.ledger, screenshotRelPath: result.screenshotRelPath,
        note: `${assistedKind === 'prelude' ? 'assisted Workday' : 'easy apply'} filled and stopped at Review (${result.reason})`, pageUrl: app.apply_url ?? null, reason: result.reason,
        ...(assistedProfile ? { atsLabel: assistedProfile.label } : {}),
        ...(Array.isArray(result.prefilledUnledgered) ? { prefilledUnledgered: result.prefilledUnledgered } : {}),
      });
      progress({ applicationId, message: 'awaiting_submit' });
      log({ evt: 'easy_apply_awaiting_submit', application_id: applicationId, reason: result.reason });
      return { ok: true, status: 'awaiting_submit' };
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
    if (appLocked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [APPLICATION_LOCK_NAMESPACE, applicationId]);
      } catch {
        /* connection gone: the lock dies with it */
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
   * @param {{ client: import('pg').Client, app: any, controller: AbortController, adapters: Record<string, any>, outputRoot: string, bank: import('./answers.js').AnswerBank, env: any, config: any, connectSession: typeof defaultConnectSession, progress: (f: any) => void, log: (f: any) => void, lookup?: import('../core/urlguard.js').Lookup, targetMarkerFile?: string, credentials: WorkerDeps['credentials'], gmailVerify: WorkerDeps['gmailVerify'], sleep: (ms: number) => Promise<void>, loadFreshConfig: () => any, clickTimeExclusionCheck: (client: import('pg').ClientBase, app: any) => Promise<{ branch: string, reason?: string }>, submitTiming: { pollMs?: number, maxPolls?: number, settleMs?: number } }} p
   */
  async function runOneApplication(p) {
    const { client: c, app, controller, adapters: adapterRegistry, outputRoot: outRoot, bank: rawBank, env: e, config: cfg, connectSession: connectSess, progress: prog, log: lg } = p;
    // One-click apply PR A (spec item 3): the application's own salary_floor (resolved once, at
    // createApplication time, from the listing's location/remote_mode -- src/core/salary-floor.js's
    // resolveFloor()) always wins over the shared answer bank's own meta.salary_floor for THIS
    // application's screening questions, never the other way around: two applications sharing one bank
    // file must never answer a salary question with the wrong location's floor. Falls back to the bank's
    // own value only when the application has none recorded (e.g. a row created before this migration).
    const b = { ...rawBank, meta: { ...rawBank.meta, salary_floor: app.salary_floor ?? rawBank.meta.salary_floor } };
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
        // The ledger source of the email value (spec item 1: contact data or the account email).
        emailSource: b.facts.get('email')?.value ? 'contact' : 'account_email',
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
      // Unattended submit (spec items 1-4, v2 C1-C6): the ONLY way a form adapter reaches its final Submit.
      // There is no other submit hook in ctx: the gate, the atomic marker, the single click, and the
      // confirmation check cannot be skipped by an adapter.
      submit: (/** @type {{ submitSelector: string, scopeSelector: string, ledger: any[] }} */ o) => runGuardedSubmit({
        client: c, app, cap, mode: 'form', submitSelector: o.submitSelector, scopeSelector: o.scopeSelector, ledger: o.ledger,
        loadConfig: p.loadFreshConfig, exclusionCheck: p.clickTimeExclusionCheck,
        resumeHash: () => hashLinkedFile(outRoot, documents.resumePath),
        sleep: p.sleep, log: (/** @type {any} */ f) => lg(f), ...p.submitTiming,
      }),
      // apply pipeline slice 6: account-holding adapters (Workday) reach credentials and Gmail
      // verify-email ONLY through these two ctx members -- never by importing src/core/credentials.js or
      // src/apply/gmail-verify.js directly, mirroring how every adapter already reaches the browser only
      // through `cap`, never through `page`/session directly.
      credentials: {
        read: () => p.credentials.read(tenantHost),
        write: (/** @type {string} */ username, /** @type {string} */ password) => p.credentials.write(tenantHost, username, password),
        generatePassword: p.credentials.generatePassword,
        target: credentialTarget(tenantHost),
      },
      gmailVerify: (/** @type {{ sentAfter: Date }} */ o) => p.gmailVerify({ tenantHost, sentAfter: o.sentAfter }),
      sleep: p.sleep,
    };

    return adapter.run(cap, ctx);
  }

  /**
   * Workday unattended submit (spec item 2, v2 C4): runs after the model's VERIFIED finish, on the same tab,
   * with the route policy still on. Reads config FRESH: submitMode other than 'unattended' (or an unreadable
   * config) returns null, which keeps the assisted awaiting_submit hand-off unchanged. Otherwise the click
   * goes through runGuardedSubmit's Workday mode (classifyStep 'review', verifyResumeCards, exactly one
   * Submit control, no consent box or signature, the audit, the marker, the confirmation). A SOFT gate park
   * (kill switch, ATS off, cap) also returns null, so Damian can still submit by hand; a HARD park (an
   * exclusion, a drifted resume, a failed audit) is a needs_human outcome and the tab is closed.
   * @param {{ client: import('pg').Client, app: any, ledger: any[], prefilledUnledgered: string[] }} s
   */
  async function workdaySubmitStep(s) {
    /** @type {any} */
    let fresh;
    try {
      fresh = loadFreshConfig();
    } catch (err) {
      log({ evt: 'workday_submit_config_unreadable', application_id: s.app.id, ...errFields(err) });
      return null;
    }
    if (workdayAssistedConfig(fresh).submitMode !== 'unattended') return null;
    if (!preludeCap) {
      return { outcome: /** @type {const} */ ('needs_human'), clicked: false, pendingQuestion: { kind: SUBMIT_GATE_KIND, label: 'The Workday tab was not available to the submit step; nothing was submitted.', page_url: s.app.apply_url ?? null } };
    }
    const documents = await loadLinkedDocuments(s.client, s.app);
    const r = await runGuardedSubmit({
      client: s.client, app: s.app, cap: preludeCap, mode: 'workday', ledger: s.ledger, prefilledUnledgered: s.prefilledUnledgered,
      expectedResume: documents.resumePath ? path.basename(documents.resumePath) : null,
      loadConfig: () => fresh, exclusionCheck: runClickTimeExclusion,
      resumeHash: () => hashLinkedFile(outputRoot, documents.resumePath),
      sleep, log, ...submitTiming,
    });
    if (r.outcome === 'needs_human' && r.gate && r.gate.soft) {
      log({ evt: 'workday_submit_soft_park', application_id: s.app.id, reason: r.gate.reason });
      return null;
    }
    return r;
  }

  /**
   * Assisted prelude (Workday; spec v1 clauses 6-7, v2 A8, A12, A15): open ONE apply-mode page under the
   * tenant's route policy, write the target marker (BEFORE any lease, so a crash leaves a tab the next run
   * closes), run the adapter's scripted, model-blind prepare() (entry, sign-in or account creation, email
   * verification; there is no submit hook in its ctx), assert exactly one page, and hand back the tab's
   * target id with a release(keepTab) that unroutes-and-leaves-open or closes. The route policy stays
   * active until release.
   * @param {{ client: import('pg').Client, app: any, controller: AbortController, adapter: any, outputRoot: string, bank: import('./answers.js').AnswerBank, env: any, config: any, connectSession: typeof defaultConnectSession, progress: (f: any) => void, log: (f: any) => void, lookup?: import('../core/urlguard.js').Lookup, targetMarkerFile?: string, credentials: WorkerDeps['credentials'], gmailVerify: WorkerDeps['gmailVerify'], sleep: WorkerDeps['sleep'] }} p
   * @returns {Promise<import('./assisted/handoff.js').PreludeResult>}
   */
  async function runPrelude(p) {
    const { client: c, app, controller, adapter, outputRoot: outRoot, env: e, config: cfg, connectSession: connectSess, log: lg } = p;
    /** @param {boolean} keepTab */
    const release = async (keepTab) => {
      const s = session;
      if (!s) return { ok: !keepTab };
      if (keepTab) {
        const r = await s.detachLeaveOpen();
        if (r && r.ok) {
          session = null;
          if (p.targetMarkerFile) await s.writeTargetMarker(p.targetMarkerFile);
          return { ok: true };
        }
      }
      session = null;
      await s.closeAll();
      if (p.targetMarkerFile) await s.writeTargetMarker(p.targetMarkerFile);
      return { ok: !keepTab };
    };
    /** @param {any} pendingQuestion */
    const fail = (pendingQuestion) => ({ ok: /** @type {const} */ (false), result: { outcome: /** @type {const} */ ('needs_human'), pendingQuestion }, release });

    if (app.resume_hash) {
      const documents = await loadLinkedDocuments(c, app);
      if (hashLinkedFile(outRoot, documents.resumePath) !== app.resume_hash) {
        return fail({ kind: 'document_drift', label: 'The linked resume file changed on disk since Approve. Re-approve (or regenerate and re-approve) before submitting.', page_url: app.apply_url });
      }
    }
    if (typeof app.apply_url !== 'string' || !app.apply_url) return fail({ kind: 'unrecognized_page', label: 'This application has no apply URL on record; apply by hand.' });
    /** @type {string} */
    let tenantHost;
    try {
      tenantHost = new URL(app.apply_url).hostname.toLowerCase();
    } catch {
      return fail({ kind: 'unrecognized_page', label: 'The application URL could not be parsed; apply by hand.' });
    }

    session = await connectSess({ cdpUrl: e.SCAN_CDP_URL });
    if (p.targetMarkerFile) await session.reconcileTargets(p.targetMarkerFile);
    await session.reconcile();
    const page = await session.attachPage({
      mode: 'apply', tenantHost, atsHosts: hostsForAts(app.ats_type), uploadHosts: adapter.uploadHosts ?? [], signal: controller.signal,
    });
    // A8: the marker lists this tab BEFORE any lease is issued.
    if (p.targetMarkerFile) await session.writeTargetMarker(p.targetMarkerFile);

    const guarded = await guardUrl(app.apply_url, buildRegistry(cfg), { source: app.ats_type, lookup: p.lookup });
    await page.goto(guarded.url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });

    const cap = makeApplyCapability(page, { signal: controller.signal, applicationId: app.id, outputRoot: outRoot });
    // Kept for the worker's own scripted post-finish submit step (workdaySubmitStep), never handed to
    // prepare() or to the model.
    preludeCap = cap;
    const b = p.bank;
    // A15: no submit hook here; prepare() has no path to a submit control.
    const ctx = {
      applicationId: app.id,
      applyUrl: app.apply_url,
      tenantHost,
      atsType: app.ats_type,
      profile: {
        email: (b.facts.get('email')?.value) ?? app.account_email,
        fullName: (b.facts.get('full_name')?.value) ?? null,
        phone: (b.facts.get('phone')?.value) ?? null,
      },
      signal: controller.signal,
      log: (/** @type {any} */ f) => lg({ application_id: app.id, ...f }),
      progress: (/** @type {any} */ f) => p.progress({ applicationId: app.id, ...f }),
      credentials: {
        read: () => p.credentials.read(tenantHost),
        write: (/** @type {string} */ username, /** @type {string} */ password) => p.credentials.write(tenantHost, username, password),
        generatePassword: p.credentials.generatePassword,
        target: credentialTarget(tenantHost),
      },
      gmailVerify: (/** @type {{ sentAfter: Date }} */ o) => p.gmailVerify({ tenantHost, sentAfter: o.sentAfter }),
      sleep: p.sleep,
    };
    const prep = await adapter.prepare(cap, ctx);
    if (!prep || prep.outcome !== 'ok') {
      return fail(prep && prep.pendingQuestion ? prep.pendingQuestion : { kind: 'unrecognized_page', label: 'The scripted Workday entry did not finish.', page_url: app.apply_url });
    }
    // A12: exactly one page after prepare (a popup or a second tab means the model could act elsewhere).
    if (session.openPages() !== 1) {
      return fail({ kind: 'assisted_stopped', label: 'More than one browser tab was open after the scripted Workday entry; apply by hand.', page_url: app.apply_url, assisted_reason: 'multiple_tabs' });
    }
    const targetId = await session.targetIdOf(page);
    if (!targetId) return fail({ kind: 'assisted_stopped', label: 'The Workday tab could not be identified; apply by hand.', page_url: app.apply_url, assisted_reason: 'target_id_unknown' });
    if (p.targetMarkerFile) await session.writeTargetMarker(p.targetMarkerFile);
    return { ok: true, targetId, release };
  }
}
