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
 * text around it. A VERDICT line is only a candidate outside any fenced code block, must sit at column 0
 * (case-sensitive `VERDICT:`, no leading whitespace), and when several survive, the LAST one wins -- the
 * findings json block is then located by searching forward from that winning line only, within a bounded
 * window, never an unanchored whole-string search. No surviving VERDICT line at all is FAIL with reason
 * 'no_verdict'; a VERDICT line found but no json block / malformed json / non-object json is FAIL with
 * reason 'review_unparseable'; a broken --output-format json wrapper (never falls back to raw stdout) is
 * FAIL with reason 'json_wrapper_unparseable'. This is the same "friction over silent escape"
 * total-classification rule that governs every validation gate in this codebase (CLAUDE.md) -- an
 * ambiguous review result must never be read as a pass.
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

// Case-sensitive, no leading whitespace tolerated (SKILL.md requires the VERDICT line at column 0), CRLF
// tolerant via the explicit optional \r before the end-of-line anchor. Global + multiline so every
// candidate line in the text can be found and evaluated, not just the first.
const VERDICT_RE = /^VERDICT:[ \t]*(PASS|FAIL)[ \t]*\r?$/gm;
// Fenced code block ranges (``` ... ```), CRLF tolerant, non-greedy so back-to-back fences pair up
// correctly rather than spanning from the first opening fence to the last closing one.
const FENCE_RE = /```[^\r\n]*\r?\n[\s\S]*?```/g;
const JSON_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)```/;
// The findings json block must immediately follow the winning VERDICT line; searching is bounded to this
// many characters forward from that line so a stray ``` fence anywhere later in a long result text can
// never be mistaken for the machine block (never an unanchored whole-string search).
const JSON_SEARCH_WINDOW = 20000;

/**
 * @param {string} text
 * @returns {[number, number][]} half-open [start, end) ranges covering every fenced code block in `text`
 */
function computeFenceRanges(text) {
  /** @type {[number, number][]} */
  const ranges = [];
  let m;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) FENCE_RE.lastIndex += 1; // guard against zero-length match infinite loop
  }
  return ranges;
}

/**
 * Parses the review-cv skill's machine block out of the CLI result text (spec item 6's contract: a
 * VERDICT line, then a fenced json block). Total classification over the shape of `text`:
 *   - No VERDICT line survives outside a fenced code block anywhere in the text -> 'no_verdict'.
 *   - A surviving VERDICT line exists but no json block is found in the bounded window after it, or the
 *     json block fails to parse, or it parses to something other than a plain object -> 'review_unparseable'
 *     (there is no partial-credit branch -- an unparseable json block is never "trust the VERDICT line
 *     alone").
 *   - Otherwise: the LAST surviving VERDICT line (outside any fence) wins, paired with the json block
 *     found by searching forward from that line only.
 * A VERDICT-shaped line that falls inside a fenced code block (e.g. quoted in an example, or shown as
 * prose inside a ```code``` block) is never a candidate -- only lines outside all fences are considered.
 * @param {string} text
 * @returns {{ ok: true, verdict: 'PASS'|'FAIL', findings: any } | { ok: false, reason: 'no_verdict'|'review_unparseable' }}
 */
export function parseReviewResult(text) {
  const fenceRanges = computeFenceRanges(text);
  const isFenced = (/** @type {number} */ idx) => fenceRanges.some(([s, e]) => idx >= s && idx < e);

  VERDICT_RE.lastIndex = 0;
  /** @type {RegExpExecArray|null} */
  let lastMatch = null;
  /** @type {RegExpExecArray|null} */
  let m;
  while ((m = VERDICT_RE.exec(text)) !== null) {
    if (!isFenced(m.index)) lastMatch = m;
  }
  if (!lastMatch) return { ok: false, reason: 'no_verdict' };

  const verdict = /** @type {'PASS'|'FAIL'} */ (lastMatch[1]);
  const searchStart = lastMatch.index + lastMatch[0].length;
  const window = text.slice(searchStart, searchStart + JSON_SEARCH_WINDOW);
  const jsonBlockMatch = JSON_BLOCK_RE.exec(window);
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

      // Invoked with --output-format json, so stdout is always expected to be a JSON wrapper whose
      // `result` field carries the CLI's text output. If the wrapper itself does not parse, or parses but
      // lacks a string `result`, that is a distinct failure from an unparseable/missing machine block --
      // it means the CLI process's own output contract was violated, not that the model forgot the
      // VERDICT line. Never fall back to raw `stdout` for verdict matching in that case: raw stdout may
      // contain streaming/log noise that could spuriously match VERDICT_RE.
      /** @type {any} */
      let resultJson = null;
      let wrapperOk = true;
      try {
        resultJson = JSON.parse(stdout);
      } catch {
        wrapperOk = false;
      }
      if (wrapperOk && (!resultJson || typeof resultJson.result !== 'string')) wrapperOk = false;

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

      if (!wrapperOk) {
        await storeReview(applicationId, null, null);
        return await fail(applicationId, 'json_wrapper_unparseable');
      }

      const resultText = resultJson.result;
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
