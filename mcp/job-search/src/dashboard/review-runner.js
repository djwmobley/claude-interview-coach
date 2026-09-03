// @ts-check
/**
 * Review runner (one-click apply PR A, spec item 6): the independent headless review Damian required
 * ("something must check Sonnet's draft"). Same shape as src/dashboard/resume-runner.js -- a fresh, single
 * headless `claude` process per run, no marker-file correlation, hard-timeout taskkill backstop -- but
 * drives the /review-cv skill in `listing:<id>` mode instead of /write-resume, and its whole job is
 * parsing a machine-readable verdict out of the result rather than verifying a database side effect.
 *
 * Parses ONLY the `VERDICT: PASS`/`VERDICT: FAIL` line and the fenced json block that follows it
 * (.claude/skills/review-cv/SKILL.md's own machine-block contract) -- never the human-readable report
 * text around it. Anything unparseable (no VERDICT line, no json block, malformed json) is FAIL with
 * reason 'review_unparseable': the same "friction over silent escape" total-classification rule that
 * governs every validation gate in this codebase (CLAUDE.md) -- an ambiguous review result must never be
 * read as a pass.
 *
 * Only VERDICT: PASS lets the caller (POST /api/listings/:id/apply-now, routes/applications.js) proceed
 * to approve(); FAIL or unparseable leaves the application at 'docs_ready' with review_verdict/
 * review_findings stored for the dashboard card, and Approve stays available for Damian's manual call.
 * This runner never transitions the application's state itself -- state stays exactly where the resume
 * runner left it (docs_ready); only the two review_* columns change here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { JobSearchError, errFields } from '../core/errors.js';
import { log as defaultLog } from '../core/logger.js';
import { recordApplicationEvent } from '../core/applications.js';

const STRIP_ENV_VARS = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_ID']);

const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL)\s*$/mi;
const JSON_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)```/;

/**
 * Parses the review-cv skill's machine block out of the CLI result text (spec item 6's contract: a
 * VERDICT line, then a fenced json block). Total classification over the shape of `text`: either both
 * pieces are found and the json parses to a plain object, or the whole thing is 'review_unparseable' --
 * there is no partial-credit branch (a VERDICT line with an unparseable json block is still
 * 'review_unparseable', never "trust the VERDICT line alone").
 * @param {string} text
 * @returns {{ ok: true, verdict: 'PASS'|'FAIL', findings: any } | { ok: false, reason: 'review_unparseable' }}
 */
export function parseReviewResult(text) {
  const verdictMatch = VERDICT_RE.exec(text);
  if (!verdictMatch) return { ok: false, reason: 'review_unparseable' };
  const verdict = /** @type {'PASS'|'FAIL'} */ (verdictMatch[1].toUpperCase());
  const afterVerdict = text.slice(verdictMatch.index + verdictMatch[0].length);
  const jsonBlockMatch = JSON_BLOCK_RE.exec(afterVerdict);
  if (!jsonBlockMatch) return { ok: false, reason: 'review_unparseable' };
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(jsonBlockMatch[1]);
  } catch {
    return { ok: false, reason: 'review_unparseable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'review_unparseable' };
  return { ok: true, verdict, findings: parsed };
}

/**
 * @typedef {Object} ReviewRunnerDeps
 * @property {import('../core/config.js').Env} env
 * @property {string} logDir
 * @property {string} repoRoot
 * @property {(client: import('pg').ClientBase) => Promise<any>} withClient
 * @property {string} [claudeBin] defaults to env.JOBSEARCH_CLAUDE_BIN
 * @property {string} [model] defaults to env.JOBSEARCH_REVIEW_MODEL
 * @property {number} [maxTurns] defaults to env.JOBSEARCH_RESUME_MAX_TURNS (shared budget/turn knobs with resume-runner)
 * @property {number} [budgetUsd] defaults to env.JOBSEARCH_RESUME_BUDGET_USD
 * @property {number} [timeoutMs] defaults to env.JOBSEARCH_RESUME_TIMEOUT_MS
 * @property {typeof import('node:child_process').spawn} spawn
 * @property {typeof execFile} [execFile]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 */

/**
 * @param {ReviewRunnerDeps} deps
 */
export function createReviewRunner(deps) {
  const say = deps.log ?? ((f) => defaultLog.info(f));
  const doExecFile = deps.execFile ?? execFile;
  const claudeBin = deps.claudeBin ?? deps.env.JOBSEARCH_CLAUDE_BIN;
  const model = deps.model ?? deps.env.JOBSEARCH_REVIEW_MODEL;
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
   * @param {'PASS'|'FAIL'|null} verdict
   * @param {any} findings
   */
  async function storeReview(applicationId, verdict, findings) {
    await deps.withClient((c) => c.query(
      'UPDATE ic_job_applications SET review_verdict = $2, review_findings = $3::jsonb, updated_at = now() WHERE id = $1',
      [applicationId, verdict, findings !== null && findings !== undefined ? JSON.stringify(findings) : null],
    ));
  }

  /**
   * @param {number} applicationId
   * @param {string} reason
   * @param {{ meta?: unknown }} [opts]
   */
  async function fail(applicationId, reason, opts = {}) {
    await deps.withClient((c) => recordApplicationEvent(c, {
      applicationId, kind: 'error', actor: 'apply', note: `review runner: ${reason}`, meta: opts.meta,
    }));
    return { ok: false, reason };
  }

  /**
   * @param {number} applicationId
   * @param {string} resumeMarkdownPath repo-relative path to the drafted resume markdown
   * @param {number} listingId
   * @returns {Promise<{ ok: boolean, verdict?: 'PASS'|'FAIL', reason?: string }>}
   */
  async function run(applicationId, resumeMarkdownPath, listingId) {
    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      throw new JobSearchError('VALIDATION', 'review-runner.run: applicationId must be a positive integer');
    }
    if (current) throw new JobSearchError('LOCKED', 'a review run is already in progress');

    current = { applicationId, startedAt: new Date() };
    try {
      fs.mkdirSync(deps.logDir, { recursive: true });
      const mcpConfigPath = path.join(deps.logDir, `review-mcp-${applicationId}-${Date.now()}.json`);
      fs.copyFileSync(path.join(deps.repoRoot, '.mcp.json'), mcpConfigPath);

      const argv = [
        '-p', `Run the /review-cv skill with argument ${resumeMarkdownPath} listing:${listingId}`,
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
      say({ evt: 'review_runner_started', application_id: applicationId, listing_id: listingId, pid: child.pid ?? null });

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
            say({ evt: 'review_runner_hard_timeout_kill', application_id: applicationId, pid: child.pid ?? null, ok: !err });
          });
          finish({ timedOut: true, exitCode: null, spawnError: false });
        }, timeoutMs);
        hardTimer.unref?.();
        child.on('exit', (code) => { clearTimeout(hardTimer); finish({ timedOut: false, exitCode: code, spawnError: false }); });
        child.on('error', (err) => { clearTimeout(hardTimer); say({ evt: 'review_runner_spawn_error', application_id: applicationId, err_message: errFields(err).err_message }); finish({ timedOut: false, exitCode: null, spawnError: true }); });
      });

      if (outcome.timedOut) {
        say({ evt: 'review_runner_timeout', application_id: applicationId });
        await storeReview(applicationId, null, null);
        return await fail(applicationId, 'timeout');
      }
      if (outcome.spawnError) {
        await storeReview(applicationId, null, null);
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
        applicationId, kind: 'progress', actor: 'apply', note: 'review runner CLI result',
        meta: {
          exit_code: outcome.exitCode,
          cost_usd: resultJson?.total_cost_usd ?? resultJson?.cost_usd ?? null,
          turns: resultJson?.num_turns ?? null,
          is_error: resultJson?.is_error ?? null,
          session_id: resultJson?.session_id ?? null,
          stderr_tail: stderrTail ? stderrTail.slice(-300) : null,
        },
      }));

      const parsed = parseReviewResult(resultText);
      if (!parsed.ok) {
        await storeReview(applicationId, null, null);
        return await fail(applicationId, parsed.reason);
      }
      await storeReview(applicationId, parsed.verdict, parsed.findings);
      if (parsed.verdict === 'PASS') {
        say({ evt: 'review_runner_pass', application_id: applicationId });
        return { ok: true, verdict: 'PASS' };
      }
      say({ evt: 'review_runner_fail', application_id: applicationId });
      return await fail(applicationId, 'review_failed', { meta: { verdict: 'FAIL' } });
    } finally {
      current = null;
    }
  }

  return { run, status };
}
