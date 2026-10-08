// @ts-check
/**
 * src/apply/easy-apply-runner.js (assisted Easy Apply, spec B3): the exact `claude -p` argv (never
 * bypassPermissions), a generated --mcp-config that carries ONLY the job-search server with the lease token
 * in its env, deleted after the run (it holds the nonce), Claude Code env vars stripped from the child,
 * and the hard-timeout taskkill backstop. The runner reports what happened; it never decides application
 * state (spec G8: only finish's verified result moves state, never the model's exit code).
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createEasyApplyRunner, EASY_APPLY_PROMPT } from '../src/apply/easy-apply-runner.js';
import { assistedApplyProfile, permissionArgs } from '../src/core/claude-spawn.js';

/** @type {string} */
let repoRoot;
/** @type {string} */
let logDir;
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyrunner-repo-'));
  fs.writeFileSync(path.join(repoRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'job-search': { command: 'node', args: ['${CLAUDE_PROJECT_DIR:-.}/mcp/job-search/src/server.js'] }, other: { command: 'evil' } } }));
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyrunner-log-'));
});

/** @param {{ exitAfterMs?: number, exitCode?: number, stdout?: string, onSpawn?: (cmd: string, argv: string[], opts: any) => void }} o */
function fakeSpawn(o = {}) {
  return (/** @type {string} */ cmd, /** @type {string[]} */ argv, /** @type {any} */ opts) => {
    o.onSpawn?.(cmd, argv, opts);
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    if (o.exitAfterMs !== undefined) {
      setTimeout(() => {
        if (o.stdout) child.stdout.emit('data', Buffer.from(o.stdout));
        child.emit('exit', o.exitCode ?? 0);
      }, o.exitAfterMs);
    }
    return child;
  };
}

describe('createEasyApplyRunner', () => {
  test('spawns the exact argv; mcp config holds only job-search with the lease env; config file removed afterwards', async () => {
    /** @type {any} */
    let seen = null;
    /** @type {any} */
    let configAtSpawn = null;
    const runner = createEasyApplyRunner({
      env: /** @type {any} */ ({ CLAUDECODE: '1', SOME: 'x' }), logDir, repoRoot, claudeBin: 'C:/bin/claude.exe', timeoutMs: 5000, log: () => {},
      spawn: /** @type {any} */ (fakeSpawn({
        exitAfterMs: 10, exitCode: 0, stdout: JSON.stringify({ result: 'done', total_cost_usd: 0.2, num_turns: 9, is_error: false }),
        onSpawn: (cmd, argv, opts) => {
          seen = { cmd, argv, opts };
          const cfgPath = argv[argv.indexOf('--mcp-config') + 1];
          configAtSpawn = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        },
      })),
    });
    const out = await runner.run({ applicationId: 42, leaseToken: '42.abcdef0123456789abcdef0123456789' });
    assert.equal(seen.cmd, 'C:/bin/claude.exe');
    const cfgPath = seen.argv[seen.argv.indexOf('--mcp-config') + 1];
    assert.deepEqual(seen.argv, [
      '-p', EASY_APPLY_PROMPT,
      '--model', 'sonnet',
      '--strict-mcp-config',
      '--mcp-config', cfgPath,
      '--setting-sources', 'project',
      ...permissionArgs(assistedApplyProfile('easy_apply')),
      '--max-turns', '60',
      '--max-budget-usd', '1',
      '--output-format', 'json',
    ]);
    assert.ok(!seen.argv.some((/** @type {string} */ a) => /bypass/i.test(a)));
    assert.deepEqual(seen.argv.slice(seen.argv.indexOf('--allowedTools') + 1, seen.argv.indexOf('--disallowedTools')), ['mcp__job-search__easy_apply']);
    for (const t of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'mcp__job-search__mark_jobs', 'mcp__job-search__assisted_apply']) assert.ok(seen.argv.includes(t), `${t} denied`);
    assert.equal(seen.opts.env.SOME, undefined, 'only allowlisted env reaches the child');
    assert.deepEqual(Object.keys(configAtSpawn.mcpServers), ['job-search']);
    assert.equal(configAtSpawn.mcpServers['job-search'].env.JOBSEARCH_EASY_APPLY_LEASE, '42.abcdef0123456789abcdef0123456789');
    assert.equal(fs.existsSync(cfgPath), false, 'the config file carries the nonce and must be deleted after the run');
    assert.equal(seen.opts.env.CLAUDECODE, undefined);
    assert.equal(seen.opts.env.JOBSEARCH_EASY_APPLY_LEASE, undefined, 'the lease reaches the MCP server through its config env only');
    assert.equal(seen.opts.cwd, repoRoot);
    assert.deepEqual({ timedOut: out.timedOut, exitCode: out.exitCode, spawnError: out.spawnError }, { timedOut: false, exitCode: 0, spawnError: false });
    assert.equal(out.costUsd, 0.2);
  });

  test('the prompt tells the model to stop at Review and never mentions submitting as an action', () => {
    assert.match(EASY_APPLY_PROMPT, /finish/);
    assert.match(EASY_APPLY_PROMPT, /untrusted/i);
    assert.doesNotMatch(EASY_APPLY_PROMPT, /click submit|press submit/i);
  });

  test('hard timeout kills the process tree and reports timedOut', async () => {
    /** @type {any[]} */
    const kills = [];
    const runner = createEasyApplyRunner({
      env: /** @type {any} */ ({}), logDir, repoRoot, claudeBin: 'claude', timeoutMs: 30, log: () => {},
      spawn: /** @type {any} */ (fakeSpawn({})),
      execFile: /** @type {any} */ ((cmd, args, cb) => { kills.push([cmd, args]); cb(null); }),
    });
    const out = await runner.run({ applicationId: 7, leaseToken: '7.abcdef0123456789abcdef0123456789' });
    assert.equal(out.timedOut, true);
    assert.deepEqual(kills, [['taskkill', ['/pid', '999', '/T', '/F']]]);
  });

  test('a malformed lease token is refused before spawning', async () => {
    let spawned = false;
    const runner = createEasyApplyRunner({ env: /** @type {any} */ ({}), logDir, repoRoot, claudeBin: 'claude', timeoutMs: 30, log: () => {}, spawn: /** @type {any} */ (() => { spawned = true; }) });
    await assert.rejects(runner.run({ applicationId: 7, leaseToken: 'nope' }), /lease/);
    assert.equal(spawned, false);
  });
});
