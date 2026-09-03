// @ts-check
/**
 * Resume runner (one-click apply PR A, spec items 5, 10, 11). Cloned from src/dashboard/apply-runner.js's
 * shape (single-flight, detached spawn, hard-timeout taskkill backstop) but drives a headless `claude`
 * CLI invocation of the /write-resume skill instead of bin/apply.js: there is no marker-file correlation
 * here (the CLI has no equivalent of bin/apply.js's --run-marker write), so start() itself awaits the
 * whole run -- spawn, exit or timeout, then a DATABASE-ONLY verification (never trusting the CLI's own
 * stdout claim of success) -- and its caller (POST /api/listings/:id/apply-now, routes/applications.js)
 * fires it off without awaiting so the HTTP response is not blocked on a run that can take minutes.
 *
 * Precheck (spec item 11): before spawning anything, the listing's own description is loaded and must be
 * at least 300 characters. A short/missing description fails immediately with reason 'no_description' --
 * no claude spawn, no cost -- mirroring the write-resume skill's own headless-mode rule (spec item 10:
 * `HEADLESS_ABORT: no_description`) as a belt-and-braces runner-side gate that never depends on the model
 * actually honoring its instructions.
 *
 * Success is decided ENTIRELY by database state (spec item 4/5's own instruction: "success must be
 * decided by DB state only" -- a clean exit with no output is possible from the CLI): the application must
 * be 'docs_ready' AND its resume_doc_id's document row must belong to the SAME listing this run targeted.
 * A mismatch resets the link (clears resume_doc_id and transitions the application back to 'drafting')
 * and is reported as a failure, never silently repaired into a false success.
 *
 * Failure reason precedence when the DB never flips to docs_ready:
 *   1. a `HEADLESS_ABORT: <reason>` line found anywhere in the CLI result text -- that reason, verbatim
 *   2. the result text reads as the model asking a question rather than drafting (ends in '?', or matches
 *      a small set of confirmation-seeking phrases) -- 'model_asked'. This is a heuristic, not a proof
 *      (see the blind-spots note in the PR body): it exists only to give a MORE USEFUL failure reason than
 *      the generic fallback below when a model asked instead of running headless as instructed; a model
 *      that ignores the instruction in some other shape still fails (DB never flips), just under the
 *      generic reason.
 *   3. otherwise -- 'no_docs_ready', the generic "the run finished (or crashed) and nothing was verified"
 *      fallback.
 * A hard timeout is its own, fourth branch ('timeout'): the process is killed and no DB verification is
 * attempted, since a killed-mid-write process's DB state is not a reliable signal either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { JobSearchError, errFields } from '../core/errors.js';
import { log as defaultLog } from '../core/logger.js';
import { getApplication, recordApplicationEvent, transition } from '../core/applications.js';

/** claude CLI env vars that must never leak into the headless child (this dashboard process IS a Claude
 * Code session when run interactively during development; the spawned CLI must never inherit that and
 * think it is a nested/resumed session). */
const STRIP_ENV_VARS = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_ID']);

const MIN_DESCRIPTION_CHARS = 300;

const HEADLESS_ABORT_RE = /HEADLESS_ABORT:\s*([a-z0-9_]+)/i;

/** A small, explicit set of confirmation-seeking phrases, plus "ends in a question mark": a heuristic for
 * "the model asked instead of drafting," never a proof (see this module's doc comment). */
const QUESTION_SHAPED_RE = /\b(want me to|should i|shall i|do you want|would you like|can i confirm|proceed anyway|is (?:it|that) ok(?:ay)? if)\b/i;

/**
 * @param {string} text
 */
function looksQuestionShaped(text) {
  const t = text.trim();
  if (!t) return false;
  return t.endsWith('?') || QUESTION_SHAPED_RE.test(t);
}

/**
 * @typedef {Object} ResumeRunnerDeps
 * @property {import('../core/config.js').Env} env
 * @property {string} logDir absolute path; created if missing (holds the generated --mcp-config file)
 * @property {string} repoRoot absolute repo root (spawn cwd, and where .mcp.json is read from)
 * @property {(client: import('pg').ClientBase) => Promise<any>} withClient
 * @property {string} [claudeBin] defaults to env.JOBSEARCH_CLAUDE_BIN
 * @property {string} [model] defaults to env.JOBSEARCH_RESUME_MODEL
 * @property {number} [maxTurns] defaults to env.JOBSEARCH_RESUME_MAX_TURNS
 * @property {number} [budgetUsd] defaults to env.JOBSEARCH_RESUME_BUDGET_USD
 * @property {number} [timeoutMs] defaults to env.JOBSEARCH_RESUME_TIMEOUT_MS
 * @property {typeof import('node:child_process').spawn} spawn
 * @property {typeof execFile} [execFile]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 */

/**
 * @param {ResumeRunnerDeps} deps
 */
export function createResumeRunner(deps) {
  const say = deps.log ?? ((f) => defaultLog.info(f));
  const doExecFile = deps.execFile ?? execFile;
  const claudeBin = deps.claudeBin ?? deps.env.JOBSEARCH_CLAUDE_BIN;
  const model = deps.model ?? deps.env.JOBSEARCH_RESUME_MODEL;
  const maxTurns = deps.maxTurns ?? deps.env.JOBSEARCH_RESUME_MAX_TURNS;
  const budgetUsd = deps.budgetUsd ?? deps.env.JOBSEARCH_RESUME_BUDGET_USD;
  const timeoutMs = deps.timeoutMs ?? deps.env.JOBSEARCH_RESUME_TIMEOUT_MS;

  /** @type {{ applicationId: number, startedAt: Date } | null} */
  let current = null;

  function status() {
    return { running: Boolean(current), applicationId: current ? current.applicationId : null, startedAt: current ? current.startedAt.toISOString() : null };
  }

  /**
   * @param {number} applicationId
   * @param {string|null} reason
   * @param {{ meta?: unknown }} [opts]
   */
  async function fail(applicationId, reason, opts = {}) {
    await deps.withClient((c) => recordApplicationEvent(c, {
      applicationId, kind: 'error', actor: 'apply', note: `resume runner failed: ${reason}`, meta: opts.meta,
    }));
    return { ok: false, reason };
  }

  /**
   * Build the --mcp-config file: a copy of repoRoot/.mcp.json, which today contains only the job-search
   * server (--strict-mcp-config then refuses any OTHER server the ambient environment might otherwise
   * supply). Written fresh per run under a per-application, per-attempt name so two runs never race on the
   * same file.
   * @param {number} applicationId
   */
  function writeMcpConfig(applicationId) {
    fs.mkdirSync(deps.logDir, { recursive: true });
    const src = path.join(deps.repoRoot, '.mcp.json');
    const dest = path.join(deps.logDir, `resume-mcp-${applicationId}-${Date.now()}.json`);
    fs.copyFileSync(src, dest);
    return dest;
  }

  /**
   * The newest .md file under output/markdown/ whose mtime is at or after `since` (a small 2 s back-buffer
   * absorbs filesystem mtime granularity, never a source of picking the WRONG file since resume-runner is
   * single-flight and write-resume's cheat sheet output lives in a different directory entirely). Used
   * only to hand the review runner the markdown path -- no document row records it the way a rendered DOCX
   * does, so this is the one place in this file that infers a path from disk rather than the database.
   * Returns null when no candidate is found (an empty/never-written output/markdown/ directory, or a run
   * that reached docs_ready without ever writing markdown there -- both should be impossible in practice,
   * but this returns null rather than throwing so the caller can fail closed with a clear reason).
   * @param {Date} since
   */
  function findNewestMarkdown(since) {
    const dir = path.join(deps.repoRoot, 'output', 'markdown');
    const cutoff = since.getTime() - 2000;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    /** @type {{ rel: string, mtimeMs: number }|null} */
    let best = null;
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const abs = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { rel: `output/markdown/${name}`, mtimeMs: stat.mtimeMs };
    }
    return best ? best.rel : null;
  }

  /**
   * @param {number} applicationId
   * @param {number} listingId
   * @returns {Promise<{ ok: boolean, reason?: string, markdownPath?: string }>}
   */
  async function run(applicationId, listingId) {
    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      throw new JobSearchError('VALIDATION', 'resume-runner.run: applicationId must be a positive integer');
    }
    if (!Number.isInteger(listingId) || listingId <= 0) {
      throw new JobSearchError('VALIDATION', 'resume-runner.run: listingId must be a positive integer');
    }
    if (current) throw new JobSearchError('LOCKED', 'a resume run is already in progress');
    // The LOCKED guard above is a plain synchronous check-then-set, which is only safe because `current`
    // is set HERE, before this function's first `await` -- moving it any later (e.g. after the precheck's
    // own DB query) would reopen a race window where two concurrent run() calls both pass the guard while
    // the first call's precheck query is in flight, since `current` would still read null for both. This
    // is not hypothetical: an earlier version of this file set `current` after the precheck and two
    // overlapping runs sharing one pg client corrupted its transaction state (see the PR body's blind
    // spots / this bug's own fix commit).
    current = { applicationId, startedAt: new Date() };
    try {
      // Precheck (spec item 11): no spawn, no cost, when the posting is too thin to draft from.
      const listingRes = await deps.withClient((c) => c.query('SELECT description FROM ic_job_listings WHERE id = $1', [listingId]));
      const description = listingRes.rowCount ? listingRes.rows[0].description : null;
      if (typeof description !== 'string' || description.length < MIN_DESCRIPTION_CHARS) {
        say({ evt: 'resume_runner_precheck_failed', application_id: applicationId, listing_id: listingId, reason: 'no_description' });
        return await fail(applicationId, 'no_description');
      }

      const mcpConfigPath = writeMcpConfig(applicationId);
      const argv = [
        '-p', `Run the /write-resume skill with argument ${listingId} application:${applicationId}`,
        '--model', model,
        '--setting-sources', 'project',
        '--permission-mode', 'bypassPermissions',
        '--max-turns', String(maxTurns),
        '--max-budget-usd', String(budgetUsd),
        '--output-format', 'json',
        '--strict-mcp-config',
        '--mcp-config', mcpConfigPath,
      ];
      const spawnEnv = { ...process.env, ...deps.env };
      for (const k of STRIP_ENV_VARS) delete spawnEnv[k];

      const child = deps.spawn(claudeBin, argv, {
        cwd: deps.repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: spawnEnv,
      });
      child.unref();
      say({ evt: 'resume_runner_started', application_id: applicationId, listing_id: listingId, pid: child.pid ?? null });

      let stdout = '';
      let stderrTail = '';
      child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-2_000_000); });
      child.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000); });

      /** @type {{ timedOut: boolean, exitCode: number|null, spawnError: boolean }} */
      const outcome = await new Promise((resolve) => {
        let settled = false;
        const finish = (/** @type {any} */ v) => { if (!settled) { settled = true; resolve(v); } };
        const hardTimer = setTimeout(() => {
          doExecFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], (err) => {
            say({ evt: 'resume_runner_hard_timeout_kill', application_id: applicationId, pid: child.pid ?? null, ok: !err });
          });
          finish({ timedOut: true, exitCode: null, spawnError: false });
        }, timeoutMs);
        hardTimer.unref?.();
        child.on('exit', (code) => { clearTimeout(hardTimer); finish({ timedOut: false, exitCode: code, spawnError: false }); });
        child.on('error', (err) => { clearTimeout(hardTimer); say({ evt: 'resume_runner_spawn_error', application_id: applicationId, err_message: errFields(err).err_message }); finish({ timedOut: false, exitCode: null, spawnError: true }); });
      });

      if (outcome.timedOut) {
        say({ evt: 'resume_runner_timeout', application_id: applicationId });
        return await fail(applicationId, 'timeout');
      }
      if (outcome.spawnError) {
        return await fail(applicationId, 'spawn_failed');
      }

      /** @type {any} */
      let resultJson = null;
      try {
        resultJson = JSON.parse(stdout);
      } catch {
        resultJson = null;
      }
      const resultText = resultJson && typeof resultJson.result === 'string' ? resultJson.result : stdout;
      await deps.withClient((c) => recordApplicationEvent(c, {
        applicationId, kind: 'progress', actor: 'apply', note: 'resume runner CLI result',
        meta: {
          exit_code: outcome.exitCode,
          cost_usd: resultJson?.total_cost_usd ?? resultJson?.cost_usd ?? null,
          turns: resultJson?.num_turns ?? null,
          is_error: resultJson?.is_error ?? null,
          session_id: resultJson?.session_id ?? null,
          stderr_tail: stderrTail ? stderrTail.slice(-300) : null,
        },
      }));

      const app = await deps.withClient((c) => getApplication(c, applicationId));
      if (app.state === 'docs_ready' && app.resume_doc_id) {
        const docRes = await deps.withClient((c) => c.query('SELECT listing_id FROM ic_job_documents WHERE id = $1', [app.resume_doc_id]));
        const docListingId = docRes.rowCount ? Number(docRes.rows[0].listing_id) : null;
        if (docListingId === Number(listingId)) {
          const markdownPath = findNewestMarkdown(current.startedAt);
          if (!markdownPath) {
            return await fail(applicationId, 'markdown_not_found');
          }
          say({ evt: 'resume_runner_success', application_id: applicationId, listing_id: listingId });
          return { ok: true, markdownPath };
        }
        // Mismatch (adversary finding 1's own belt-and-braces re-verification, spec item 4/5): reset the
        // link rather than trust it. resume_doc_id is cleared with a raw UPDATE (transitionUnwrapped never
        // touches document-link columns) and the state walked back to 'drafting' via the normal
        // TRANSITIONS-validated path (docs_ready -> drafting is a legal edge).
        await deps.withClient((c) => c.query('UPDATE ic_job_applications SET resume_doc_id = NULL, updated_at = now() WHERE id = $1', [applicationId]));
        try {
          await deps.withClient((c) => transition(c, applicationId, 'drafting', { actor: 'apply', note: 'resume document listing mismatch detected after resume run; link reset' }));
        } catch {
          /* state already moved on by another actor between the SELECT above and here: the reset UPDATE
             already ran, which is the material safety fix; a transition race here is not itself a failure
             to surface differently. */
        }
        return await fail(applicationId, 'listing_mismatch', { meta: { document_listing_id: docListingId, application_listing_id: listingId } });
      }

      const abortMatch = HEADLESS_ABORT_RE.exec(resultText);
      if (abortMatch) {
        return await fail(applicationId, abortMatch[1].toLowerCase());
      }
      if (looksQuestionShaped(resultText)) {
        return await fail(applicationId, 'model_asked');
      }
      return await fail(applicationId, 'no_docs_ready');
    } finally {
      current = null;
    }
  }

  return { run, status };
}
