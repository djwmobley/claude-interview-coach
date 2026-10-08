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

/** Every tool name the job-search MCP server can register (src/server.js TOOLS plus the two lease tools).
 * test/claude-spawn.test.js fails when the server gains a tool that is not listed here. */
export const JOB_SEARCH_TOOL_NAMES = Object.freeze([
  'search_jobs', 'query_jobs', 'get_job', 'mark_jobs', 'profiles', 'scans', 'review', 'render_doc', 'followups',
  'scan_report', 'assisted_apply', 'easy_apply',
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

/** @type {Readonly<Record<'write-resume'|'review-cv', SpawnProfile>>} */
export const SPAWN_PROFILES = Object.freeze({
  'write-resume': Object.freeze({
    name: 'write-resume',
    mcpTools: Object.freeze(['get_job', 'render_doc']),
    allowed: Object.freeze([
      'Skill(write-resume)', 'ToolSearch', 'Glob', 'Grep', ...SKILL_READS,
      'Write(./output/markdown/**)', 'Edit(./output/markdown/**)', 'Write(./output/cheatsheets/**)', 'Edit(./output/cheatsheets/**)',
    ]),
  }),
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
  return [
    '--permission-mode', 'dontAsk',
    '--allowedTools', ...profile.allowed, ...mcpAllowed,
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
