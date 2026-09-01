#!/usr/bin/env node
// @ts-check
/**
 * Apply CLI (apply pipeline slice 5), the runner-spawned entrypoint for one application:
 *
 *   node bin/apply.js --application <id> [--run-marker path] [--json [out]]
 *
 * On startup, BEFORE running the requested application, this file also:
 *   1. reconciles stale 'submitting' rows (src/core/applications.js's reconcileStale -- the amended spec's
 *      duplicate-submission guard: a stale row whose current attempt already recorded
 *      "submit_request_sent" goes to needs_human, never a retryable failed);
 *   2. resumes every 'needs_human' application whose pending_question.kind is 'credential' and whose
 *      credential now exists in Credential Manager (plan section 5a's "on startup it also checks...").
 * Both steps run regardless of which application id this invocation was given -- they are general
 * housekeeping the runner gets "for free" on every apply tick, mirroring bin/scan.js's own reaper step.
 *
 * Exit 0 ok (submitted / needs_human / skipped-not-approved) / 2 locked / 1 failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from '../src/core/config.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { errFields } from '../src/core/errors.js';
import { withClient, closePool } from '../src/core/db.js';
import { reconcileStale, resume } from '../src/core/applications.js';
import { createCredentials } from '../src/core/credentials.js';
import { runApplyWorker } from '../src/apply/worker.js';

const USAGE = 'usage: node bin/apply.js --application <id> [--run-marker path] [--json [out]]';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ application: number|null, runMarker: string|undefined, json: string|null|undefined, help: boolean }} */
  const out = { application: null, runMarker: undefined, json: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--application') out.application = Number(argv[++i]);
    else if (a === '--run-marker') out.runMarker = String(argv[++i] ?? '');
    else if (a === '--json') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        out.json = v;
        i++;
      } else out.json = null;
    } else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * Resume every needs_human application whose pending_question.kind is 'credential' and whose credential
 * now exists (plan section 5a). Mirrors src/dashboard/stream.js's pollCredentialResume, CLI-side: this is
 * the "next apply-runner tick" the plan's own credential-prompt doc comment refers to. One row's failure
 * (a race with a concurrent dashboard Resume click, e.g.) is logged and never aborts the rest of the sweep.
 * @param {import('pg').ClientBase} client
 * @param {{ read: (target: string) => Promise<{username:string,password:string}|null> }} credentials
 * @param {(f: Record<string, string|number|boolean|null>) => void} log
 */
export async function resumeCredentialReadyApplications(client, credentials, log) {
  let resumed = 0;
  const r = await client.query(
    `SELECT id, pending_question FROM ic_job_applications WHERE state = 'needs_human' AND pending_question->>'kind' = 'credential'`,
  );
  for (const row of r.rows) {
    const pq = row.pending_question;
    const target = pq && typeof pq === 'object' && typeof pq.target === 'string' ? pq.target : null;
    if (!target) continue;
    /** @type {{username:string,password:string}|null} */
    let found;
    try {
      found = await credentials.read(target);
    } catch (err) {
      log({ evt: 'apply_credential_resume_read_failed', application_id: Number(row.id), ...errFields(err) });
      continue;
    }
    if (!found) continue;
    try {
      await resume(client, Number(row.id), { actor: 'apply', note: `credential found for ${target}, auto-resumed at worker startup` });
      resumed++;
    } catch (err) {
      log({ evt: 'apply_credential_resume_failed', application_id: Number(row.id), ...errFields(err) });
    }
  }
  return resumed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!Number.isInteger(args.application) || /** @type {number} */ (args.application) <= 0) {
    console.log(JSON.stringify({ ok: false, code: 'VALIDATION', message: '--application <id> is required and must be a positive integer' }));
    process.exit(1);
  }
  const applicationId = /** @type {number} */ (args.application);

  const env = getEnv();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'apply', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'apply'), name: 'apply' });
  /** @param {Record<string, string|number|boolean|null>} f */
  const log = (f) => logger.info(f);

  if (args.runMarker) {
    try {
      fs.mkdirSync(path.dirname(args.runMarker), { recursive: true });
      fs.writeFileSync(args.runMarker, JSON.stringify({ application_id: applicationId }));
    } catch (err) {
      log({ evt: 'apply_run_marker_write_failed', ...errFields(err) });
    }
  }

  const credentials = createCredentials();

  try {
    await withClient((c) => reconcileStale(c));
  } catch (err) {
    log({ evt: 'apply_reconcile_stale_failed', ...errFields(err) });
  }
  try {
    const resumed = await withClient((c) => resumeCredentialReadyApplications(c, credentials, log));
    if (resumed > 0) log({ evt: 'apply_credential_resume_swept', resumed });
  } catch (err) {
    log({ evt: 'apply_credential_resume_sweep_failed', ...errFields(err) });
  }

  let code = 1;
  /** @type {any} */
  let result;
  try {
    result = await runApplyWorker(applicationId, { env, log });
    if (result.status === 'locked') code = 2;
    else if (result.ok) code = 0;
    else code = 1;
  } catch (err) {
    const f = errFields(err);
    log({ evt: 'apply_run_failed', application_id: applicationId, ...f });
    result = { ok: false, ...f };
    code = 1;
  }

  if (args.json !== undefined) {
    const file = args.json ?? path.join(env.JOBSEARCH_LOG_DIR, `apply-${applicationId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    log({ evt: 'apply_json_written', file: path.basename(file) });
  }

  console.log(JSON.stringify({ application_id: applicationId, ...result }));
  await closePool().catch(() => {});
  process.exit(code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
