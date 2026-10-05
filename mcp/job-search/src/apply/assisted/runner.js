// @ts-check
/**
 * Assisted apply runner (spec B3; profile-driven since the assisted refactor), modeled on
 * src/dashboard/resume-runner.js: spawns ONE headless `claude -p` session whose only capability is the
 * profile's MCP tool (LinkedIn: the easy_apply alias this release, see A14) for ONE leased application, waits for it (or kills it at the hard timeout), and reports what happened. It never
 * decides application state: the worker reads the lease's verified finish result from the database
 * (spec G8: "Only finish's verified result moves state; never the model's exit code").
 *
 * Invocation (exact; test/easy-apply-runner.test.js pins it):
 *   claude -p <prompt> --model sonnet --strict-mcp-config --mcp-config <job-search only; lease via env>
 *     --allowedTools mcp__job-search__easy_apply --permission-mode dontAsk --max-turns 60
 *     --max-budget-usd 1 --output-format json
 * NEVER bypassPermissions. `dontAsk` denies every tool not pre-approved; on the installed CLI
 * (2.1.289) a probe with this exact flag pair denied Bash, Read, and Task even though the operator's user
 * settings pre-approve them (see the PR body). Belt and braces: in lease mode the job-search server itself
 * registers easy_apply and nothing else (src/server.js toolsForEnv).
 *
 * The generated --mcp-config holds ONLY the job-search server entry copied from the repo's .mcp.json, with
 * the lease token in that server's `env` (the nonce therefore never appears on a command line). The file is
 * written under logDir with a per-attempt name and deleted in `finally`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { JobSearchError, errFields } from '../../core/errors.js';
import { log as defaultLog } from '../../core/logger.js';
import { LEASE_ENV, ASSISTED_LEASE_ENV, parseLeaseToken } from '../../core/easy-apply-state.js';

/** Claude Code env vars (and every lease env) that must never leak into the headless child. */
const STRIP_ENV_VARS = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_ID', LEASE_ENV, ASSISTED_LEASE_ENV]);

/** The two tool names a lease-mode server can expose (src/server.js toolsForEnv). */
const RUNNER_TOOL_NAMES = Object.freeze(['assisted_apply', 'easy_apply']);
/** The lease env each tool name reads. */
const LEASE_ENV_FOR_TOOL = Object.freeze({ assisted_apply: ASSISTED_LEASE_ENV, easy_apply: LEASE_ENV });

/**
 * @typedef {{ prompt: string, runnerToolName: string, leaseEnv: string }} RunnerProfile
 * @typedef {Object} EasyApplyRunnerDeps
 * @property {import('../../core/config.js').Env} env
 * @property {string} logDir
 * @property {string} repoRoot
 * @property {typeof import('node:child_process').spawn} spawn
 * @property {string} [claudeBin] defaults to env.JOBSEARCH_CLAUDE_BIN
 * @property {number} [timeoutMs] default 13 minutes (the worker's own budget for this path is 15)
 * @property {typeof execFile} [execFile]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 */

/**
 * @param {EasyApplyRunnerDeps & { profile: RunnerProfile }} deps
 */
export function createAssistedRunner(deps) {
  const profile = deps && deps.profile;
  if (!profile || typeof profile !== 'object' || typeof profile.prompt !== 'string' || !profile.prompt
    || !RUNNER_TOOL_NAMES.includes(profile.runnerToolName)
    || profile.leaseEnv !== /** @type {any} */ (LEASE_ENV_FOR_TOOL)[profile.runnerToolName]) {
    throw new JobSearchError('VALIDATION', 'assisted runner: a profile with a prompt, a known tool name, and its lease env is required');
  }
  const say = deps.log ?? ((f) => defaultLog.info(f));
  const doExecFile = deps.execFile ?? execFile;
  const claudeBin = deps.claudeBin ?? deps.env.JOBSEARCH_CLAUDE_BIN;
  const timeoutMs = deps.timeoutMs ?? 13 * 60 * 1000;

  /**
   * @param {number} applicationId
   * @param {string} leaseToken
   */
  function writeMcpConfig(applicationId, leaseToken) {
    const src = JSON.parse(fs.readFileSync(path.join(deps.repoRoot, '.mcp.json'), 'utf8'));
    const entry = src && src.mcpServers && src.mcpServers['job-search'];
    if (!entry || typeof entry !== 'object') throw new JobSearchError('CONFIG_INVALID', '.mcp.json has no job-search server entry');
    const server = { ...entry, env: { ...(entry.env ?? {}), [profile.leaseEnv]: leaseToken } };
    fs.mkdirSync(deps.logDir, { recursive: true });
    const dest = path.join(deps.logDir, `easy-apply-mcp-${applicationId}-${Date.now()}.json`);
    fs.writeFileSync(dest, JSON.stringify({ mcpServers: { 'job-search': server } }));
    return dest;
  }

  /**
   * @param {{ applicationId: number, leaseToken: string }} input
   * @returns {Promise<{ timedOut: boolean, exitCode: number|null, spawnError: boolean, costUsd: number|null, turns: number|null, isError: boolean|null }>}
   */
  async function run(input) {
    const parsed = parseLeaseToken(input.leaseToken);
    if (!parsed || parsed.applicationId !== input.applicationId) throw new JobSearchError('VALIDATION', 'easy-apply-runner: lease token does not match the application');
    const mcpConfigPath = writeMcpConfig(input.applicationId, input.leaseToken);
    try {
      const argv = [
        '-p', profile.prompt,
        '--model', 'sonnet',
        '--strict-mcp-config',
        '--mcp-config', mcpConfigPath,
        '--allowedTools', `mcp__job-search__${profile.runnerToolName}`,
        '--permission-mode', 'dontAsk',
        '--max-turns', '60',
        '--max-budget-usd', '1',
        '--output-format', 'json',
      ];
      const spawnEnv = { ...process.env, ...deps.env };
      for (const k of STRIP_ENV_VARS) delete spawnEnv[k];
      const child = deps.spawn(claudeBin, argv, { cwd: deps.repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: spawnEnv });
      say({ evt: 'easy_apply_runner_started', application_id: input.applicationId, pid: child.pid ?? null });
      let stdout = '';
      child.stdout?.on('data', (c) => { stdout = (stdout + c.toString('utf8')).slice(-1_000_000); });
      child.stderr?.on('data', () => {});
      /** @type {{ timedOut: boolean, exitCode: number|null, spawnError: boolean }} */
      const outcome = await new Promise((resolve) => {
        let settled = false;
        const finish = (/** @type {any} */ v) => { if (!settled) { settled = true; resolve(v); } };
        const hard = setTimeout(() => {
          doExecFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], (err) => {
            say({ evt: 'easy_apply_runner_hard_timeout_kill', application_id: input.applicationId, ok: !err });
          });
          finish({ timedOut: true, exitCode: null, spawnError: false });
        }, timeoutMs);
        child.on('exit', (code) => { clearTimeout(hard); finish({ timedOut: false, exitCode: code, spawnError: false }); });
        child.on('error', (err) => { clearTimeout(hard); say({ evt: 'easy_apply_runner_spawn_error', application_id: input.applicationId, err_message: errFields(err).err_message }); finish({ timedOut: false, exitCode: null, spawnError: true }); });
      });
      /** @type {any} */
      let j = null;
      try {
        j = JSON.parse(stdout);
      } catch {
        j = null;
      }
      return {
        ...outcome,
        costUsd: typeof j?.total_cost_usd === 'number' ? j.total_cost_usd : null,
        turns: typeof j?.num_turns === 'number' ? j.num_turns : null,
        isError: typeof j?.is_error === 'boolean' ? j.is_error : null,
      };
    } finally {
      try {
        fs.rmSync(mcpConfigPath, { force: true });
      } catch {
        /* best effort; logDir is local and gitignored */
      }
    }
  }

  return { run };
}
