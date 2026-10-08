// @ts-check
/**
 * src/core/claude-spawn.js: the one place every headless `claude -p` runner builds its permission flags and
 * its child environment. Least privilege: `dontAsk` plus an explicit --allowedTools list per profile, a
 * --disallowedTools list that always carries shell, web, subagent, browser and Google tools plus every
 * job-search tool the profile does not need, and an environment built from a fixed allowlist rather than
 * the dashboard's whole process.env.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChildEnv, buildClaudeArgs, permissionArgs, SPAWN_PROFILES, assistedApplyProfile,
  JOB_SEARCH_TOOL_NAMES, ALWAYS_DISALLOWED, CHILD_ENV_ALLOWLIST,
} from '../src/core/claude-spawn.js';
import { TOOLS } from '../src/server.js';
import { tool as assistedApply } from '../src/tools/assisted_apply.js';
import { tool as easyApply } from '../src/tools/easy_apply.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/** @param {string[]} argv @param {string} flag */
function listAfter(argv, flag) {
  const i = argv.indexOf(flag);
  assert.ok(i >= 0, `${flag} present`);
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

describe('permissionArgs', () => {
  for (const [name, profile] of [...Object.entries(SPAWN_PROFILES), ['assisted_apply', assistedApplyProfile('assisted_apply')], ['easy_apply', assistedApplyProfile('easy_apply')]]) {
    test(`${name}: dontAsk, never the bypass mode, shell/web/subagent/browser/Google tools denied`, () => {
      const argv = permissionArgs(/** @type {any} */ (profile));
      assert.deepEqual(argv.slice(0, 2), ['--permission-mode', 'dontAsk']);
      assert.ok(!argv.some((a) => /bypass/i.test(a)));
      const denied = listAfter(argv, '--disallowedTools');
      for (const t of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit',
        'mcp__claude_ai_Gmail', 'mcp__google-workspace', 'mcp__claude-in-chrome', 'mcp__chrome', 'mcp__plugin_playwright_playwright']) {
        assert.ok(denied.includes(t), `${t} denied`);
      }
      // A tool-free profile (triage) passes no --allowedTools flag at all.
      const toolFree = profile.allowed.length === 0 && profile.mcpTools.length === 0;
      if (toolFree) assert.ok(!argv.includes('--allowedTools'), 'tool-free profile allows nothing');
      const allowed = toolFree ? [] : listAfter(argv, '--allowedTools');
      assert.ok(toolFree || allowed.length > 0);
      for (const a of allowed) {
        assert.ok(!/^(Bash|PowerShell|WebFetch|WebSearch|Agent|Task)\b/.test(a), `${a} must not be allowed`);
        assert.ok(!/^(Read|Edit|Write)$/.test(a) && !/\(\*\)$/.test(a), `${a} must be path-scoped`);
      }
      // every job-search tool the profile does not allow is explicitly denied (project settings allow mcp__job-search__*)
      const allowedMcp = allowed.filter((a) => a.startsWith('mcp__job-search__'));
      for (const t of JOB_SEARCH_TOOL_NAMES) {
        const full = `mcp__job-search__${t}`;
        assert.ok(allowedMcp.includes(full) !== denied.includes(full), `${full} is exactly one of allowed or denied`);
      }
    });
  }

  test('write-resume allows exactly its skill, its two MCP tools, and writes under output/markdown and output/cheatsheets only', () => {
    const allowed = listAfter(permissionArgs(SPAWN_PROFILES['write-resume']), '--allowedTools');
    assert.ok(allowed.includes('Skill(write-resume)'));
    assert.deepEqual(allowed.filter((a) => a.startsWith('mcp__')).sort(), ['mcp__job-search__get_job', 'mcp__job-search__render_doc']);
    const writes = allowed.filter((a) => /^(Edit|Write)\(/.test(a));
    assert.ok(writes.length > 0);
    for (const w of writes) assert.match(w, /^(Edit|Write)\(\.\/output\/(markdown|cheatsheets)\/\*\*\)$/);
  });

  test('review-cv allows its skill and get_job only, and no writes at all', () => {
    const allowed = listAfter(permissionArgs(SPAWN_PROFILES['review-cv']), '--allowedTools');
    assert.ok(allowed.includes('Skill(review-cv)'));
    assert.deepEqual(allowed.filter((a) => a.startsWith('mcp__')), ['mcp__job-search__get_job']);
    assert.deepEqual(allowed.filter((a) => /^(Edit|Write)/.test(a)), []);
  });

  test('assisted profile allows only its one lease tool; unknown tool names are refused', () => {
    assert.deepEqual(listAfter(permissionArgs(assistedApplyProfile('easy_apply')), '--allowedTools'), ['mcp__job-search__easy_apply']);
    assert.throws(() => assistedApplyProfile('mark_jobs'));
  });

  test('secret paths are denied for reading; repo code and config are denied for editing', () => {
    const denied = listAfter(permissionArgs(SPAWN_PROFILES['write-resume']), '--disallowedTools');
    for (const r of ['Read(./**/.env)', 'Read(./data/project-background/**)', 'Read(~/.claude/**)', 'Edit(./.claude/**)', 'Edit(./mcp/**)', 'Edit(./data/**)']) {
      assert.ok(denied.includes(r), `${r} denied`);
    }
  });
});

describe('JOB_SEARCH_TOOL_NAMES', () => {
  test('matches every tool the server can register (a new tool must be classified here or this fails)', () => {
    const server = [...TOOLS.map((t) => t.name), assistedApply.name, easyApply.name].sort();
    assert.deepEqual([...JOB_SEARCH_TOOL_NAMES].sort(), server);
  });
});

describe('buildClaudeArgs', () => {
  test('orders prompt, model, settings, permission flags, limits, output, mcp config', () => {
    const argv = buildClaudeArgs({ prompt: 'P', model: 'sonnet', profile: SPAWN_PROFILES['review-cv'], maxTurns: 7, budgetUsd: 2, mcpConfigPath: 'C:/x.json' });
    assert.deepEqual(argv.slice(0, 6), ['-p', 'P', '--model', 'sonnet', '--setting-sources', 'project']);
    assert.deepEqual(argv.slice(-9), ['--max-turns', '7', '--max-budget-usd', '2', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', 'C:/x.json']);
    assert.ok(argv.includes('dontAsk'));
  });
});

describe('buildChildEnv', () => {
  test('keeps allowlisted keys (case-insensitive), drops everything else including secrets and Claude Code nesting vars', () => {
    const env = buildChildEnv(
      { Path: 'C:/bin', SystemRoot: 'C:/Windows', USERPROFILE: 'C:/Users/u', SENTINEL_SECRET: 'leak', GOOGLE_TOKEN_FILE: 'C:/t.json', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_AGENT_ID: 'a', JOBSEARCH_EASY_APPLY_LEASE: 'n', JOBSEARCH_ASSISTED_APPLY_LEASE: 'n', ANTHROPIC_API_KEY: 'k' },
      { PG_DSN: 'dsn-sentinel', SCAN_PROFILE_DIR: 'C:/p', REMINDER_TO: 'a@b', JOBSEARCH_RESUME_MAX_TURNS: 80, LOG_LEVEL: 'info', GOOGLE_OAUTH_REDIRECT_URIS: 'u' },
    );
    assert.equal(env.Path, 'C:/bin');
    assert.equal(env.SystemRoot, 'C:/Windows');
    assert.equal(env.USERPROFILE, 'C:/Users/u');
    assert.equal(env.ANTHROPIC_API_KEY, 'k');
    assert.equal(env.PG_DSN, 'dsn-sentinel');
    assert.equal(env.LOG_LEVEL, 'info');
    for (const k of ['SENTINEL_SECRET', 'GOOGLE_TOKEN_FILE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_ID', 'JOBSEARCH_EASY_APPLY_LEASE', 'JOBSEARCH_ASSISTED_APPLY_LEASE', 'SCAN_PROFILE_DIR', 'REMINDER_TO', 'JOBSEARCH_RESUME_MAX_TURNS', 'GOOGLE_OAUTH_REDIRECT_URIS']) {
      assert.equal(env[k], undefined, `${k} excluded`);
    }
  });

  test('a later source overrides an earlier one for the same key; null and undefined are skipped', () => {
    const env = buildChildEnv({ PG_DSN: 'a', PATH: 'p' }, { PG_DSN: null, PATH: undefined }, { pg_dsn: 'b' });
    assert.equal(Object.keys(env).filter((k) => k.toUpperCase() === 'PG_DSN').length, 1);
    assert.equal(Object.entries(env).find(([k]) => k.toUpperCase() === 'PG_DSN')?.[1], 'b');
    assert.equal(env.PATH, 'p');
  });

  test('the allowlist never names a Google, LinkedIn, Chrome, lease, or Claude Code nesting var', () => {
    for (const k of CHILD_ENV_ALLOWLIST) assert.doesNotMatch(k, /GOOGLE|LINKEDIN|CHROME|CDP|SCAN_|LEASE|^CLAUDECODE$|ENTRYPOINT|AGENT_ID|REMINDER/);
  });
});

describe('source lint', () => {
  test('nothing under src/ names the bypass permission mode, and every claude spawn builds its env through buildChildEnv', () => {
    /** @param {string} dir @returns {string[]} */
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
    const files = walk(SRC);
    assert.deepEqual(files.filter((f) => /bypassPermissions/.test(fs.readFileSync(f, 'utf8'))), []);
    for (const rel of ['dashboard/resume-runner.js', 'dashboard/review-runner.js', 'dashboard/ready-resume-runner.js', 'apply/assisted/runner.js']) {
      const code = fs.readFileSync(path.join(SRC, ...rel.split('/')), 'utf8');
      assert.match(code, /buildChildEnv\(/, `${rel} uses buildChildEnv`);
      assert.match(code, /buildClaudeArgs\(|permissionArgs\(/, `${rel} uses the shared permission flags`);
      assert.doesNotMatch(code, /\.\.\.process\.env/, `${rel} never spreads process.env`);
    }
  });
  test('ALWAYS_DISALLOWED is frozen', () => {
    assert.ok(Object.isFrozen(ALWAYS_DISALLOWED));
  });
});
