// @ts-check
/**
 * Ready to apply list: resume generation (spec section 9 as resolved by R4, R6 and amended by A5, A10).
 *
 * runReadyResumes() (bin/ready-resumes.js, scheduled right after the morning auto-apply run): takes the
 * run-level single-flight lock (a second run exits 'locked'), classifies and refreshes the ledger (never a
 * display, so no lock is written here), then walks the ready rows highest fit first:
 *   1. skip rows whose resume is ready, gave_up, running, or skipped_no_description;
 *   2. reuse: a resume document already linked to the listing whose file is on disk is used as is (no
 *      model call, no cap slot); a reused document that an application's review FAILED is not reused;
 *   3. otherwise reserve one slot of the daily cap (budget source 'ready_resume', America/Chicago day,
 *      min(config, READY_RESUME_HARD_CEILING)); refused -> stop ('daily_cap'), the rest stay 'queued';
 *   4. take the shared cross-process spawn lock (bounded wait); not obtained -> refund, stop ('spawn_busy');
 *   5. generate (listing mode), then the advisory review (R4). PASS -> 'ready'. FAIL (A10) -> not ready:
 *      'failed' with the verdict shown, retried on a later run until maxAttempts (2), then 'gave_up'.
 *      A generation failure counts the same way. no_description and spawn failures refund the slot.
 *   6. stop starting new items after maxRunMinutes.
 *
 * startReadyResumeForListing() (POST /api/ready-to-apply/:listingId/resume): the same pipeline for one row,
 * with NO wait for the spawn lock (409 READY_RESUME_BUSY), the same server-side cap (409 READY_RESUME_CAP,
 * no override flag exists), and the work started asynchronously (202).
 */
import fs from 'node:fs';
import path from 'node:path';
import { reserveBudget, refundBudget } from './budget.js';
import { READY_RESUME_HARD_CEILING } from './config.js';
import { classifyReadyList, refreshReadyLedger, readyConfig } from './ready-to-apply.js';
import { errFields } from './errors.js';

export const READY_RESUME_BUDGET_SOURCE = 'ready_resume';

/** A per-run id (lowercase, path- and prompt-safe); the skill writes its markdown under it. @param {number} listingId @param {Date} now */
export function newReadyRunId(listingId, now = new Date()) {
  return `r${now.getTime().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}-${listingId}`;
}
/** A 'running' ledger row older than this is a crashed run and may be retried. */
const STALE_RUNNING_MS = 3 * 3600000;

/**
 * @typedef {Object} ReadyResumeDeps
 * @property {<T>(fn: (c: import('pg').ClientBase) => Promise<T>) => Promise<T>} withClient
 * @property {any} config LoadedConfig (or a test stand-in with autoApply.readyToApply)
 * @property {() => Date} now
 * @property {(f: Record<string, unknown>) => void} log
 * @property {{ generate: (listingId: number, runId: string) => Promise<any>, review: (listingId: number, markdownPath: string) => Promise<any> }} runner
 * @property {{ acquire?: (o: { waitMs: number }) => Promise<any>, tryAcquire?: () => Promise<any> }} spawnLock
 * @property {{ tryAcquire: () => Promise<any> }} [runLock]
 * @property {string} outputRoot absolute output/ directory
 * @property {string} [budgetSource] test seam; production uses READY_RESUME_BUDGET_SOURCE
 * @property {string} [timezone]
 * @property {() => Promise<{ ready: Array<{ listingId: number, resumeEligible: boolean }> }>} [classifyAndRefresh] test seam
 */

/** @param {any} config */
function resumeConfig(config) {
  const block = config?.autoApply?.readyToApply ?? {};
  const r = block.resume ?? {};
  return {
    enabled: block.enabled !== false && r.enabled !== false,
    dailyCap: Math.min(READY_RESUME_HARD_CEILING, Math.max(0, Number.isInteger(r.dailyCap) ? r.dailyCap : READY_RESUME_HARD_CEILING)),
    maxAttempts: Math.min(2, Math.max(1, Number.isInteger(r.maxAttempts) ? r.maxAttempts : 2)),
    maxRunMinutes: Number.isInteger(r.maxRunMinutes) ? r.maxRunMinutes : 180,
    spawnLockWaitSeconds: Number.isInteger(r.spawnLockWaitSeconds) ? r.spawnLockWaitSeconds : 600,
  };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {Record<string, unknown>} fields column -> value
 */
async function setLedger(client, listingId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await client.query(`UPDATE ic_ready_to_apply SET ${sets}, updated_at = now() WHERE listing_id = $1`, [listingId, ...keys.map((k) => fields[k])]);
}

/**
 * A resume already linked to the listing with its file on disk, newest first. A document an application's
 * review FAILED is skipped. Returns the verdict that application review gave, when there was one.
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 * @param {string} outputRoot
 */
export async function findReusableResume(client, listingId, outputRoot) {
  const r = await client.query(
    `SELECT d.id, d.rel_path,
            (SELECT a.review_verdict FROM ic_job_applications a WHERE a.resume_doc_id = d.id AND a.review_verdict IS NOT NULL ORDER BY a.id DESC LIMIT 1) AS verdict,
            (SELECT a.review_findings FROM ic_job_applications a WHERE a.resume_doc_id = d.id AND a.review_verdict IS NOT NULL ORDER BY a.id DESC LIMIT 1) AS findings
       FROM ic_job_documents d WHERE d.listing_id = $1 AND d.kind = 'resume' ORDER BY d.created_at DESC, d.id DESC`,
    [listingId],
  );
  for (const d of r.rows) {
    if (d.verdict === 'FAIL') continue;
    const abs = path.join(outputRoot, ...String(d.rel_path).split('/'));
    if (!abs.startsWith(path.resolve(outputRoot))) continue;
    let ok = false;
    try {
      ok = fs.statSync(abs).isFile();
    } catch {
      ok = false;
    }
    if (ok) return { docId: Number(d.id), relPath: String(d.rel_path), verdict: d.verdict ?? null, findings: d.findings ?? null };
  }
  return null;
}

/**
 * Generate + review one row while the caller holds the spawn lock and one cap slot.
 * @param {ReadyResumeDeps} deps
 * @param {number} listingId
 * @param {{ attempts: number, maxAttempts: number, refund: () => Promise<void> }} o
 * @returns {Promise<string>} the resulting resume_status
 */
async function generateOne(deps, listingId, o) {
  const now = deps.now();
  const runId = newReadyRunId(listingId, now);
  const attempts = o.attempts + 1;
  await deps.withClient((c) => setLedger(c, listingId, { resume_status: 'running', resume_attempts: attempts, resume_last_attempt_at: now, resume_run_id: runId }));
  /** @type {any} */
  let gen;
  try {
    gen = await deps.runner.generate(listingId, runId);
  } catch (err) {
    gen = { ok: false, reason: `generate_threw:${errFields(err).err_code}` };
  }
  const failStatus = attempts >= o.maxAttempts ? 'gave_up' : 'failed';
  if (!gen.ok) {
    if (gen.refund) await o.refund();
    if (gen.reason === 'no_description') {
      await deps.withClient((c) => setLedger(c, listingId, { resume_status: 'skipped_no_description', resume_attempts: o.attempts, resume_last_error: 'no_description' }));
      return 'skipped_no_description';
    }
    await deps.withClient((c) => setLedger(c, listingId, { resume_status: failStatus, resume_last_error: String(gen.reason ?? 'unknown').slice(0, 200) }));
    deps.log({ evt: 'ready_resume_failed', listing_id: listingId, reason: gen.reason ?? null, status: failStatus });
    return failStatus;
  }
  /** @type {any} */
  let rev;
  try {
    rev = await deps.runner.review(listingId, gen.markdownPath);
  } catch (err) {
    rev = { ok: false, reason: `review_threw:${errFields(err).err_code}` };
  }
  const base = { resume_doc_id: gen.docId ?? null, resume_source: 'generated' };
  if (rev.ok && rev.verdict === 'PASS') {
    await deps.withClient((c) => setLedger(c, listingId, { ...base, resume_status: 'ready', resume_last_error: null, review_verdict: 'PASS', review_findings: JSON.stringify(rev.findings ?? null) }));
    deps.log({ evt: 'ready_resume_ready', listing_id: listingId, run_id: runId });
    return 'ready';
  }
  const verdict = rev.ok ? rev.verdict : null;
  await deps.withClient((c) => setLedger(c, listingId, {
    ...base, resume_status: failStatus, resume_last_error: rev.ok ? 'review_failed' : `review_${rev.reason}`, review_verdict: verdict, review_findings: rev.ok ? JSON.stringify(rev.findings ?? null) : null,
  }));
  deps.log({ evt: 'ready_resume_review_not_pass', listing_id: listingId, verdict, reason: rev.ok ? null : rev.reason, status: failStatus });
  return failStatus;
}

/**
 * @param {ReadyResumeDeps} deps
 * @param {number} listingId
 * @returns {Promise<{ skip: string }|{ reuse: true }|{ attempts: number }>}
 */
async function prepareItem(deps, listingId) {
  const l = (await deps.withClient((c) => c.query('SELECT resume_status, resume_attempts, resume_last_attempt_at FROM ic_ready_to_apply WHERE listing_id = $1', [listingId]))).rows[0];
  if (!l) return { skip: 'no_ledger_row' };
  const status = String(l.resume_status);
  if (status === 'ready' || status === 'gave_up' || status === 'skipped_no_description') return { skip: status };
  if (status === 'running') {
    const at = l.resume_last_attempt_at ? new Date(l.resume_last_attempt_at).getTime() : 0;
    if (deps.now().getTime() - at < STALE_RUNNING_MS) return { skip: 'running' };
  }
  const reuse = await deps.withClient((c) => findReusableResume(c, listingId, deps.outputRoot));
  if (reuse) {
    await deps.withClient((c) => setLedger(c, listingId, {
      resume_status: 'ready', resume_source: 'reused', resume_doc_id: reuse.docId, resume_last_error: null,
      review_verdict: reuse.verdict, review_findings: reuse.findings === null ? null : JSON.stringify(reuse.findings),
    }));
    return { reuse: true };
  }
  return { attempts: Number(l.resume_attempts ?? 0) };
}

/**
 * @param {ReadyResumeDeps} deps
 * @returns {Promise<{ status: 'ok'|'locked'|'disabled', stopReason?: string|null, generated?: number, reused?: number, failed?: number, gaveUp?: number, skipped?: number, queued?: number }>}
 */
export async function runReadyResumes(deps) {
  const rc = resumeConfig(deps.config);
  if (!rc.enabled) return { status: 'disabled' };
  const runHeld = deps.runLock ? await deps.runLock.tryAcquire() : { release: async () => {} };
  if (!runHeld) return { status: 'locked' };
  const started = Date.now();
  const tz = deps.timezone ?? deps.config?.adapters?.run?.timezone ?? 'America/Chicago';
  const source = deps.budgetSource ?? READY_RESUME_BUDGET_SOURCE;
  const counts = { generated: 0, reused: 0, failed: 0, gaveUp: 0, skipped: 0, queued: 0 };
  /** @type {string|null} */
  let stopReason = null;
  try {
    const result = deps.classifyAndRefresh
      ? await deps.classifyAndRefresh()
      : await deps.withClient(async (c) => {
        const res = await classifyReadyList(c, { config: deps.config, now: deps.now() });
        await refreshReadyLedger(c, res, deps.now(), { display: false });
        return res;
      });
    const items = result.ready.filter((r) => r.resumeEligible);
    for (let i = 0; i < items.length; i++) {
      const listingId = items[i].listingId;
      if (stopReason) {
        await deps.withClient((c) => c.query(`UPDATE ic_ready_to_apply SET resume_status = 'queued', updated_at = now() WHERE listing_id = $1 AND resume_status IN ('none', 'failed')`, [listingId]));
        counts.queued++;
        continue;
      }
      const prep = await prepareItem(deps, listingId);
      if ('skip' in prep) { counts.skipped++; continue; }
      if ('reuse' in prep) { counts.reused++; continue; }
      if (Date.now() - started > rc.maxRunMinutes * 60000) { stopReason = 'max_run_minutes'; i--; continue; }
      const now = deps.now();
      const caps = { dailyPages: rc.dailyCap, dailyDetails: 0 };
      const slot = await deps.withClient((c) => reserveBudget(c, source, { pages: 1 }, caps, now, tz));
      if (!slot.ok) { stopReason = 'daily_cap'; i--; continue; }
      const refund = () => deps.withClient((c) => refundBudget(c, source, { pages: 1 }, now, tz));
      const held = deps.spawnLock.acquire ? await deps.spawnLock.acquire({ waitMs: rc.spawnLockWaitSeconds * 1000 }) : null;
      if (!held) {
        await refund();
        stopReason = 'spawn_busy';
        i--;
        continue;
      }
      try {
        const st = await generateOne(deps, listingId, { attempts: prep.attempts, maxAttempts: rc.maxAttempts, refund });
        if (st === 'ready') counts.generated++;
        else if (st === 'gave_up') counts.gaveUp++;
        else if (st === 'skipped_no_description') counts.skipped++;
        else counts.failed++;
      } finally {
        await held.release().catch(() => {});
      }
    }
  } finally {
    await runHeld.release().catch(() => {});
  }
  deps.log({ evt: 'ready_resumes_done', stop_reason: stopReason, ...counts });
  return { status: 'ok', stopReason, ...counts };
}

/**
 * Dashboard per-row button. Synchronous refusals carry an HTTP status and code; a start returns 202 and
 * `done`, the promise of the background work (the route does not await it).
 * @param {ReadyResumeDeps} deps
 * @param {number} listingId
 * @returns {Promise<{ status: 202, done: Promise<string> } | { status: 409|404, code: string, message: string }>}
 */
export async function startReadyResumeForListing(deps, listingId) {
  const rc = resumeConfig(deps.config);
  if (!rc.enabled) return { status: 409, code: 'READY_RESUME_DISABLED', message: 'Ready list resume generation is disabled in config.' };
  const l = (await deps.withClient((c) => c.query('SELECT bucket, left_at, resume_status FROM ic_ready_to_apply WHERE listing_id = $1', [listingId]))).rows[0];
  if (!l) return { status: 404, code: 'NOT_FOUND', message: 'This listing is not on the Ready to apply list.' };
  if (l.bucket !== 'ready_to_apply' || l.left_at || ['ready', 'gave_up', 'running', 'skipped_no_description'].includes(String(l.resume_status))) {
    return { status: 409, code: 'READY_RESUME_NOT_ELIGIBLE', message: `No resume can be started for this row (bucket ${l.bucket}, resume ${l.resume_status}).` };
  }
  const prep = await prepareItem(deps, listingId);
  if ('reuse' in prep) return { status: 202, done: Promise.resolve('ready') };
  if ('skip' in prep) return { status: 409, code: 'READY_RESUME_NOT_ELIGIBLE', message: `No resume can be started for this row (${prep.skip}).` };
  const tz = deps.timezone ?? deps.config?.adapters?.run?.timezone ?? 'America/Chicago';
  const source = deps.budgetSource ?? READY_RESUME_BUDGET_SOURCE;
  const now = deps.now();
  const slot = await deps.withClient((c) => reserveBudget(c, source, { pages: 1 }, { dailyPages: rc.dailyCap, dailyDetails: 0 }, now, tz));
  if (!slot.ok) return { status: 409, code: 'READY_RESUME_CAP', message: `Today's Ready list resume cap (${rc.dailyCap}) is used up.` };
  const refund = () => deps.withClient((c) => refundBudget(c, source, { pages: 1 }, now, tz));
  const held = deps.spawnLock.tryAcquire ? await deps.spawnLock.tryAcquire() : null;
  if (!held) {
    await refund();
    return { status: 409, code: 'READY_RESUME_BUSY', message: 'Another resume is being drafted right now; try again in a few minutes.' };
  }
  const done = (async () => {
    try {
      return await generateOne(deps, listingId, { attempts: prep.attempts, maxAttempts: rc.maxAttempts, refund });
    } catch (err) {
      deps.log({ evt: 'ready_resume_button_failed', listing_id: listingId, ...errFields(err) });
      return 'failed';
    } finally {
      await held.release().catch(() => {});
    }
  })();
  return { status: 202, done };
}
