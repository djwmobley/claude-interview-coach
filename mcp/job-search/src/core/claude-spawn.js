// @ts-check
/**
 * Least-privilege flags and environment for every headless `claude -p` runner (resume-runner,
 * review-runner, ready-resume-runner, apply/assisted/runner). Their prompts carry untrusted job-listing
 * text, so a prompt injection must not reach a shell, the web, a subagent, a browser, Google, or any
 * job-search tool the run does not need, and the child must not inherit the dashboard's whole environment.
 *
 * Permission model (probed on the installed CLI, see the PR body):
 *   - `--permission-mode dontAsk` denies every tool call that no allow rule covers. A skill's own
 *     `allowed-tools` frontmatter (write-resume declares Write(*), WebFetch) did NOT widen that in the probe.
 *   - `--allowedTools` lists only the profile's tools, file tools scoped by path.
 *   - `--disallowedTools` always lists shell, web, subagent, notebook, browser and Google tools, every
 *     job-search tool the profile does not allow (the project settings allow mcp__job-search__*, and deny
 *     beats allow), reads of secret paths, and edits of code, config and source data.
 * Path rules are relative to the spawn cwd (the repo root).
 *
 * Environment: buildChildEnv copies only CHILD_ENV_ALLOWLIST keys (case-insensitive, Windows env keys are)
 * from its sources. Google, LinkedIn, Chrome, lease, and Claude Code nesting variables are never on it.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

/** Every tool name the job-search MCP server can register (src/server.js TOOLS plus the two lease tools; headless runs deny the read-only targets tool unless a profile allows it).
 * test/claude-spawn.test.js fails when the server gains a tool that is not listed here. */
export const JOB_SEARCH_TOOL_NAMES = Object.freeze([
  'search_jobs', 'query_jobs', 'get_job', 'mark_jobs', 'profiles', 'scans', 'review', 'render_doc', 'followups',
  'scan_report', 'restart_dashboard', 'targets', 'assisted_apply', 'easy_apply',
]);

/** Denied for every profile, whatever its allow list says. */
export const ALWAYS_DISALLOWED = Object.freeze([
  'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit',
  // Browser and Google MCP servers (server-level rules match every tool on that server).
  'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Drive', 'mcp__claude_ai_Google_Calendar', 'mcp__google-workspace',
  'mcp__chrome', 'mcp__claude-in-chrome', 'mcp__plugin_chrome-devtools-mcp_chrome-devtools',
  'mcp__plugin_playwright_playwright', 'mcp__playwright', 'mcp__firefox-devtools',
  // Secrets and material that must never reach a generated document.
  'Read(./**/.env)', 'Read(./mcp/job-search/config/**)', 'Read(./data/project-background/**)', 'Read(./.git/**)',
  // Narrow home paths only: a broad home rule would also cover a repo checked out under the home folder.
  'Read(~/.claude/**)', 'Read(~/.ssh/**)', 'Read(~/chrome-scan-profile/**)',
  // Code, configuration, and source data are never edited by a headless run.
  'Edit(./.claude/**)', 'Edit(./.mcp.json)', 'Edit(./CLAUDE.md)', 'Edit(./mcp/**)', 'Edit(./tools/**)',
  'Edit(./hooks/**)', 'Edit(./data/**)', 'Edit(./memory/**)', 'Edit(./coaching/**)', 'Edit(./framework/**)',
]);

/** Repo areas the resume and review skills read (their SKILL.md files name these). */
const SKILL_READS = Object.freeze(['Read(./data/**)', 'Read(./memory/**)', 'Read(./coaching/**)', 'Read(./output/**)', 'Read(./framework/**)', 'Read(./plugins/**)']);

/**
 * @typedef {{ name: string, allowed: readonly string[], mcpTools: readonly string[] }} SpawnProfile
 */

/** @type {Readonly<Record<'write-resume'|'review-cv'|'triage'|'target-draft'|'target-review', SpawnProfile>>} */
export const SPAWN_PROFILES = Object.freeze({
  'write-resume': Object.freeze({
    name: 'write-resume',
    mcpTools: Object.freeze(['get_job', 'render_doc']),
    allowed: Object.freeze([
      'Skill(write-resume)', 'ToolSearch', 'Glob', 'Grep', ...SKILL_READS,
      'Write(./output/markdown/**)', 'Edit(./output/markdown/**)', 'Write(./output/cheatsheets/**)', 'Edit(./output/cheatsheets/**)',
    ]),
  }),
  // Fit triage is a pure text-in, JSON-out call: the listing batch arrives on stdin and the answer is the
  // schema-constrained envelope. It needs no tool at all, so nothing is allowed.
  triage: Object.freeze({ name: 'triage', mcpTools: Object.freeze([]), allowed: Object.freeze([]) }),
  // Target outreach drafting and its independent review (plan 19.4) are the same shape: text on stdin, text out,
  // untrusted evidence in the prompt, so no tool of any kind.
  'target-draft': Object.freeze({ name: 'target-draft', mcpTools: Object.freeze([]), allowed: Object.freeze([]) }),
  'target-review': Object.freeze({ name: 'target-review', mcpTools: Object.freeze([]), allowed: Object.freeze([]) }),
  'review-cv': Object.freeze({
    name: 'review-cv',
    mcpTools: Object.freeze(['get_job']),
    allowed: Object.freeze(['Skill(review-cv)', 'ToolSearch', 'Glob', 'Grep', ...SKILL_READS]),
  }),
});

/**
 * The assisted apply profile: only its one lease tool (src/server.js toolsForEnv exposes nothing else in
 * lease mode). No browser MCP: the tool drives the browser inside the job-search server.
 * @param {string} runnerToolName
 * @returns {SpawnProfile}
 */
export function assistedApplyProfile(runnerToolName) {
  if (runnerToolName !== 'assisted_apply' && runnerToolName !== 'easy_apply') {
    throw new Error(`assistedApplyProfile: unknown runner tool ${runnerToolName}`);
  }
  return Object.freeze({ name: runnerToolName, mcpTools: Object.freeze([runnerToolName]), allowed: Object.freeze([]) });
}

/**
 * `--permission-mode dontAsk --allowedTools ... --disallowedTools ...` for one profile.
 * @param {SpawnProfile} profile
 * @returns {string[]}
 */
export function permissionArgs(profile) {
  const mcpAllowed = profile.mcpTools.map((t) => `mcp__job-search__${t}`);
  const mcpDenied = JOB_SEARCH_TOOL_NAMES.filter((t) => !profile.mcpTools.includes(t)).map((t) => `mcp__job-search__${t}`);
  const allow = [...profile.allowed, ...mcpAllowed];
  return [
    '--permission-mode', 'dontAsk',
    // A profile with no tools passes no --allowedTools flag (an empty variadic would swallow the next flag).
    ...(allow.length ? ['--allowedTools', ...allow] : []),
    '--disallowedTools', ...ALWAYS_DISALLOWED, ...mcpDenied,
  ];
}

/**
 * Full argv for a skill-driven run (resume and review runners).
 * @param {{ prompt: string, model: string, profile: SpawnProfile, maxTurns: number|string, budgetUsd: number|string, mcpConfigPath: string }} o
 * @returns {string[]}
 */
export function buildClaudeArgs(o) {
  return [
    '-p', o.prompt,
    '--model', String(o.model),
    '--setting-sources', 'project',
    ...permissionArgs(o.profile),
    '--max-turns', String(o.maxTurns),
    '--max-budget-usd', String(o.budgetUsd),
    '--output-format', 'json',
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfigPath,
  ];
}

/**
 * Run one tool-free `claude -p` call with the prompt on stdin. Resolves, never rejects:
 *   { ok: true, stdout } on a clean exit; { ok: false, reason } with reason timeout, aborted, exit or spawn.
 * The child gets only the allowlisted environment and is killed on timeout or abort.
 * @param {string} bin
 * @param {string[]} args
 * @param {{ input: string, timeoutMs: number, env?: Record<string, string>, signal?: AbortSignal, maxBuffer?: number }} o
 * @returns {Promise<{ ok: true, stdout: string } | { ok: false, reason: 'timeout'|'aborted'|'exit'|'spawn' }>}
 */
export function runClaudeText(bin, args, o) {
  return new Promise((resolve) => {
    if (o.signal?.aborted) {
      resolve({ ok: false, reason: 'aborted' });
      return;
    }
    let settled = false;
    let stdout = '';
    /** @type {NodeJS.Timeout|null} */
    let timer = null;
    /** @type {import('node:child_process').ChildProcess|null} */
    let child = null;
    /** @param {{ ok: true, stdout: string } | { ok: false, reason: 'timeout'|'aborted'|'exit'|'spawn' }} v */
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (!v.ok && child && child.exitCode === null) child.kill('SIGTERM');
      resolve(v);
    };
    try {
      child = spawn(bin, args, { windowsHide: true, ...(o.env ? { env: o.env } : {}) });
    } catch {
      done({ ok: false, reason: 'spawn' });
      return;
    }
    const cap = o.maxBuffer ?? (1 << 20);
    child.stdout?.on('data', (d) => {
      stdout += d;
      if (Buffer.byteLength(stdout) > cap) done({ ok: false, reason: 'exit' });
    });
    child.stderr?.on('data', () => {});
    child.on('error', () => done({ ok: false, reason: 'spawn' }));
    child.on('exit', (code) => done(code === 0 ? { ok: true, stdout } : { ok: false, reason: 'exit' }));
    timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), Math.max(1, o.timeoutMs));
    o.signal?.addEventListener('abort', () => done({ ok: false, reason: 'aborted' }), { once: true });
    child.stdin?.on('error', () => {});
    child.stdin?.write(o.input);
    child.stdin?.end();
  });
}

/**
 * The real model caller for the target draft stage: one call per request, profile target-draft or
 * target-review, empty strict MCP config, model sonnet. The draft call is schema-constrained; the review call
 * is free text (it must carry the nonce verdict line).
 * @param {{ configDir: string, schemaJson: string, bin?: string, model?: string, env?: Record<string, unknown> }} o
 * @returns {(req: { kind: 'draft'|'review', prompt: string, timeoutMs: number, signal?: AbortSignal }) => ReturnType<typeof runClaudeText>}
 */
export function makeClaudeCaller(o) {
  const bin = o.bin ?? (process.env.JOBSEARCH_TARGET_CLAUDE_BIN || 'claude');
  const model = o.model ?? (process.env.JOBSEARCH_TARGET_MODEL || 'sonnet');
  const env = buildChildEnv(o.env ?? process.env);
  return (req) => runClaudeText(bin, targetCallArgs(req.kind, { configDir: o.configDir, schemaJson: o.schemaJson, model }), { input: req.prompt, timeoutMs: req.timeoutMs, env, signal: req.signal });
}

/**
 * The argv of one target draft or review call. No tool is allowed (the profiles list none), the MCP config is
 * the empty strict one, and the prompt travels on stdin, never as an argument.
 * @param {'draft'|'review'} kind
 * @param {{ configDir: string, schemaJson: string, model: string }} o
 * @returns {string[]}
 */
export function targetCallArgs(kind, o) {
  const profile = kind === 'review' ? SPAWN_PROFILES['target-review'] : SPAWN_PROFILES['target-draft'];
  return [
    '-p', '--model', o.model, '--output-format', 'json',
    ...(kind === 'draft' ? ['--json-schema', o.schemaJson] : []),
    '--strict-mcp-config', '--mcp-config', path.join(o.configDir, 'triage-mcp-empty.json'),
    ...permissionArgs(profile),
  ];
}

/**
 * What the child needs: the OS basics to start node, python and bash on Windows; Claude authentication
 * and proxy settings; and the job-search database, log and config locations the MCP server child reads.
 */
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'USERNAME', 'USERDOMAIN',
  'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'SHELL',
  'PYTHONUTF8', 'PYTHONIOENCODING',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'PG_DSN', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
  'JOBSEARCH_LOG_DIR', 'JOBSEARCH_CONFIG_DIR', 'JOBSEARCH_CONFIG_LOCK', 'JOBSEARCH_TEST_GUARD', 'LOG_LEVEL',
]);
const ALLOW = new Set(CHILD_ENV_ALLOWLIST);

/**
 * Merge only allowlisted keys from the sources, later sources winning. Key matching is case-insensitive
 * (Windows); the output keeps one spelling per key. null and undefined values are skipped; numbers and
 * booleans are stringified.
 * @param {...(Record<string, unknown>|null|undefined)} sources
 * @returns {Record<string, string>}
 */
export function buildChildEnv(...sources) {
  /** @type {Map<string, [string, string]>} */
  const picked = new Map();
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      const up = k.toUpperCase();
      if (!ALLOW.has(up)) continue;
      if (v === null || v === undefined) continue;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
      picked.set(up, [k, String(v)]);
    }
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of picked.values()) out[k] = v;
  return out;
}
