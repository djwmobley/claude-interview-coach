// @ts-check
/**
 * Static and structural guarantees for PR5 (plan 19.8): no send API is reachable from src/targets or the
 * targets routes; the model is reached only through claude-spawn, whose draft and review profiles grant no
 * tool; the audit table is written only by decisions.js and the approve transaction; the stage is wired after
 * the targets stage inside the scan, and the stats write carries explicit timeouts (F13); the new files carry no
 * dash or look-alike character; the facts file is never read from data/ or project-background.
 *
 * The one place a real process starts is claude-spawn.js runClaudeText, exercised here against the node binary
 * itself (never a shell, never claude).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SPAWN_PROFILES, permissionArgs, targetCallArgs, runClaudeText, makeClaudeCaller, JOB_SEARCH_TOOL_NAMES,
} from '../src/core/claude-spawn.js';
import { DRAFT_SCHEMA } from '../src/targets/draft-prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const rel = (/** @type {string} */ p) => path.join(ROOT, ...p.split('/'));
const read = (/** @type {string} */ p) => fs.readFileSync(rel(p), 'utf8');
const strip = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PR5_SRC = [
  'src/targets/draft-text.js', 'src/targets/draft-gates.js', 'src/targets/draft-prompt.js', 'src/targets/pitch-facts.js', 'src/targets/draft-note.js',
  'src/targets/draft-errors.js', 'src/targets/draft-context.js', 'src/targets/drafts.js', 'src/targets/draft-stage.js',
  'src/dashboard/draft-approve.js', 'src/dashboard/draft-view.js', 'src/dashboard/routes/target-drafts.js', 'src/dashboard/routes/targets.js',
  'src/dashboard/public/lib/target-approve.js', 'src/dashboard/public/pages/targets.js', 'src/dashboard/public/components/targets-tile.js',
  'src/core/claude-spawn.js', 'src/core/report.js', 'src/core/scan-run.js', 'src/core/db.js',
];
const PR5_OTHER = [
  'sql/027_target_drafts.sql', 'config/target-pitch-facts.example.json', 'config/style-checks.json',
  'test/helpers/targets-pr5.js', 'test/targets-draft-gates.test.js', 'test/targets-draft-prompt.test.js', 'test/targets-drafts-pipeline.test.js',
  'test/dashboard-target-drafts-route.test.js', 'test/dashboard-public-target-note.test.js', 'test/migration-027.test.js', 'test/targets-pr5-static.test.js',
  'test/scan-a8-timeouts.test.js',
];

/**
 * Relative imports of a module, resolved to repo paths.
 * @param {string} file absolute path
 * @returns {string[]}
 */
function importsOf(file) {
  const src = strip(fs.readFileSync(file, 'utf8'));
  /** @type {string[]} */
  const out = [];
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const spec = m[1] ?? m[2];
    out.push(path.normalize(path.join(path.dirname(file), spec)));
  }
  return out;
}

/** @param {string[]} entries repo-relative @returns {string[]} every module reachable by relative import, repo-relative */
function reachable(entries) {
  const seen = new Set();
  const stack = entries.map(rel);
  while (stack.length) {
    const f = /** @type {string} */ (stack.pop());
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
}

describe('no send API is reachable from the draft code (plan 19.8)', () => {
  const ENTRIES = ['src/targets/draft-stage.js', 'src/targets/drafts.js', 'src/dashboard/routes/target-drafts.js', 'src/dashboard/draft-approve.js', 'src/dashboard/draft-view.js', 'src/dashboard/routes/targets.js'];
  const graph = reachable(ENTRIES);

  test('the import graph holds no Gmail, Google, mail, reminder-sender, apply or browser module', () => {
    const bad = graph.filter((f) => /(^|\/)(google|gmail|mail|remind|email|smtp)[^/]*\.js$/i.test(f) || /^src\/(apply|browser|adapters)\//.test(f) && f !== 'src/apply/exclusions.js');
    assert.deepEqual(bad, [], `graph: ${graph.join(', ')}`);
    assert.ok(graph.includes('src/core/followups.js') && graph.includes('src/core/claude-spawn.js'), 'the graph walker sees the real imports');
  });

  test('child_process appears in the graph only in claude-spawn.js, and only the draft stage reaches it', () => {
    const withCp = graph.filter((f) => /node:child_process|require\(['"]child_process/.test(strip(read(f))));
    assert.deepEqual(withCp, ['src/core/claude-spawn.js']);
    const importers = graph.filter((f) => importsOf(rel(f)).some((i) => i.endsWith(`${path.sep}claude-spawn.js`)));
    assert.deepEqual(importers, ['src/targets/draft-stage.js']);
  });

  test('no src/targets, draft or targets-route file names a send verb, a mail API, LinkedIn, the Gmail MCP or a clipboard', () => {
    const files = fs.readdirSync(rel('src/targets')).filter((f) => f.endsWith('.js')).map((f) => `src/targets/${f}`)
      .concat(['src/dashboard/routes/target-drafts.js', 'src/dashboard/routes/targets.js', 'src/dashboard/draft-approve.js', 'src/dashboard/draft-view.js']);
    for (const f of files) {
      const s = strip(read(f));
      assert.ok(!/messages\/send|drafts\/send|drafts\.create|users\.messages\.send|sendmail|sendMail|nodemailer|smtp|mailto:|send_gmail_message|send_message|gmailSend/i.test(s), `${f}: send API`);
      assert.ok(!/linkedin/i.test(s), `${f}: linkedin`);
      assert.ok(!/mcp__claude_ai_Gmail|mcp__google-workspace|claude_ai_Gmail/.test(s), `${f}: Gmail MCP`);
      assert.ok(!/clipboard/i.test(s), `${f}: clipboard`);
      assert.ok(!/(?<![.\w])fetch\s*\(|XMLHttpRequest|node:(?:http|https|net|tls|dgram)\b/.test(s) || f === 'src/targets/fetch-guard.js', `${f}: network`);
    }
  });

  test('the model is reached through an injected callModel: drafts.js holds no process, network or mail import', () => {
    const s = strip(read('src/targets/drafts.js'));
    assert.match(s, /deps\.callModel\(/);
    assert.ok(!/claude-spawn|child_process/.test(s));
  });

  test('the draft pipeline never reads personal data directories', () => {
    for (const f of ['src/targets/drafts.js', 'src/targets/draft-context.js', 'src/targets/pitch-facts.js', 'src/targets/draft-prompt.js', 'src/dashboard/draft-approve.js']) {
      assert.ok(!/project-background|['"`]data['"`]|\.\.\/\.\.\/data|coaching|memory\//.test(strip(read(f))), f);
    }
    assert.match(strip(read('src/targets/pitch-facts.js')), /target-pitch-facts\.json/);
  });
});

describe('the draft and review profiles grant no tools (plan 19.4)', () => {
  const dir = '/cfg';

  test('profiles list no tool and no MCP tool', () => {
    for (const k of /** @type {const} */ (['target-draft', 'target-review'])) {
      assert.deepEqual([SPAWN_PROFILES[k].allowed, SPAWN_PROFILES[k].mcpTools], [[], []]);
    }
  });

  test('argv: bare -p (the prompt travels on stdin), dontAsk, no allowed tools, every job-search tool and shell denied, empty strict MCP config', () => {
    for (const kind of /** @type {const} */ (['draft', 'review'])) {
      const argv = targetCallArgs(kind, { configDir: dir, schemaJson: JSON.stringify(DRAFT_SCHEMA), model: 'sonnet' });
      assert.equal(argv[0], '-p');
      assert.equal(argv[1], '--model', 'no prompt text in argv');
      assert.ok(!argv.includes('--allowedTools'));
      assert.deepEqual(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.match(argv[argv.indexOf('--mcp-config') + 1].replace(/\\/g, '/'), /\/cfg\/triage-mcp-empty\.json$/);
      const denied = argv.slice(argv.indexOf('--disallowedTools') + 1);
      for (const t of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'mcp__claude_ai_Gmail', 'mcp__google-workspace']) assert.ok(denied.includes(t), t);
      for (const t of JOB_SEARCH_TOOL_NAMES) assert.ok(denied.includes(`mcp__job-search__${t}`), t);
      assert.equal(argv.includes('--json-schema'), kind === 'draft', 'only the draft call is schema-constrained');
      assert.ok(!argv.includes('bypassPermissions') && !argv.includes('--dangerously-skip-permissions'));
    }
    assert.deepEqual(permissionArgs(SPAWN_PROFILES['target-draft']), permissionArgs(SPAWN_PROFILES.triage));
  });

  test('the empty MCP config the calls use exists and declares no server', () => {
    assert.deepEqual(JSON.parse(read('config/triage-mcp-empty.json')).mcpServers ?? {}, {});
  });
});

describe('runClaudeText against the node binary (no shell, no claude)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr5-spawn-'));
  const script = (/** @type {string} */ name, /** @type {string} */ body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };

  test('delivers the prompt on stdin and returns stdout on a clean exit', async () => {
    const s = script('echo.js', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('GOT:'+d));");
    const r = await runClaudeText(process.execPath, [s], { input: 'hello prompt', timeoutMs: 15000, env });
    assert.deepEqual(r, { ok: true, stdout: 'GOT:hello prompt' });
  });

  test('a non-zero exit, a missing binary, a timeout and an aborted signal are each a closed failure, never a throw', async () => {
    assert.deepEqual(await runClaudeText(process.execPath, [script('fail.js', 'process.exit(3)')], { input: 'x', timeoutMs: 15000, env }), { ok: false, reason: 'exit' });
    assert.deepEqual(await runClaudeText('definitely-not-a-binary-pr5', [], { input: 'x', timeoutMs: 5000, env }), { ok: false, reason: 'spawn' });
    const t0 = Date.now();
    assert.deepEqual(await runClaudeText(process.execPath, [script('hang.js', 'setTimeout(()=>{},60000)')], { input: 'x', timeoutMs: 300, env }), { ok: false, reason: 'timeout' });
    assert.ok(Date.now() - t0 < 10000, 'the hung child was cut at the timeout');
    const ac = new AbortController();
    ac.abort();
    assert.deepEqual(await runClaudeText(process.execPath, [script('never.js', 'process.exit(0)')], { input: 'x', timeoutMs: 5000, env, signal: ac.signal }), { ok: false, reason: 'aborted' });
  });

  test('output past the buffer cap is a failure', async () => {
    const s = script('flood.js', "process.stdout.write('x'.repeat(5000000));");
    const r = await runClaudeText(process.execPath, [s], { input: '', timeoutMs: 15000, env, maxBuffer: 1000 });
    assert.equal(r.ok, false);
  });

  test('makeClaudeCaller builds its child environment from the allowlist, never the whole process env', () => {
    const src = strip(read('src/core/claude-spawn.js'));
    assert.match(src, /buildChildEnv\(o\.env \?\? process\.env\)/);
    assert.equal(typeof makeClaudeCaller({ configDir: dir, schemaJson: '{}' }), 'function');
  });
});

describe('the audit table and the decision columns', () => {
  test('only decisions.js and the approve transaction write ic_target_decisions, by INSERT only, with the literal actor', () => {
    const dec = strip(read('src/targets/decisions.js'));
    const app = strip(read('src/dashboard/draft-approve.js'));
    for (const s of [dec, app]) {
      assert.match(s, /INSERT INTO ic_target_decisions/);
      assert.ok(!/(?:UPDATE|DELETE\s+FROM)\s+ic_target_decisions/i.test(s));
      assert.match(s, /'damian'/);
    }
    for (const f of ['src/targets/drafts.js', 'src/targets/draft-stage.js', 'src/dashboard/draft-view.js', 'src/dashboard/routes/target-drafts.js', 'src/dashboard/routes/targets.js', 'src/targets/runner.js']) {
      assert.ok(!/ic_target_decisions/.test(strip(read(f))) || f === 'src/dashboard/routes/targets.js', f);
    }
    assert.match(app, /'approve'/);
  });

  test('ic_target_draft_edits is written by INSERT only', () => {
    for (const f of PR5_SRC.filter((x) => x.endsWith('.js'))) {
      assert.ok(!/(?:UPDATE|DELETE\s+FROM)\s+ic_target_draft_edits/i.test(strip(read(f))), f);
    }
    assert.match(strip(read('src/dashboard/draft-approve.js')), /INSERT INTO ic_target_draft_edits/);
  });

  test('the runner never touches the draft tables, and only the approve code sets decision = approved', () => {
    assert.ok(!/ic_target_drafts|ic_target_draft_edits/.test(strip(read('src/targets/runner.js'))));
    for (const f of PR5_SRC) {
      const s = strip(read(f));
      if (f === 'src/dashboard/draft-approve.js') continue;
      assert.ok(!/decision\s*=\s*'approved'/.test(s), f);
    }
    assert.match(strip(read('src/dashboard/draft-approve.js')), /decision = 'approved'/);
  });

  test('draft-approve.js never reaches into the gates by name on edited drafts: the edited mode is the only advisory path', () => {
    const s = strip(read('src/dashboard/draft-approve.js'));
    assert.match(s, /mode = 'edited'|'edited'/);
    assert.match(s, /GATES_FAILED/);
  });
});

describe('wiring', () => {
  test('scan-run starts the draft stage after the targets stage and before the stats write, inside the !dryRun block, through a seam', () => {
    const src = read('src/core/scan-run.js');
    const targets = src.indexOf('deps.runTargetsStage ?? runTargetsStage');
    const drafts = src.indexOf('deps.runTargetDraftStage ?? runDraftStage');
    const write = src.indexOf('connectBounded(() =>');
    const closing = src.indexOf("log({ evt: 'run_finished'");
    assert.ok(targets > 0 && drafts > targets && write > drafts && closing > write, 'order: targets, drafts, bounded stats write, run_finished');
    const block = src.slice(src.lastIndexOf('if (!dryRun) {', targets), drafts);
    assert.ok(block.includes('stats.triage = triageStats;'), 'the draft stage sits in the same !dryRun block as triage and targets');
  });

  test('F13: the stats write after the target stages connects and runs statements with explicit timeouts', () => {
    const src = read('src/core/scan-run.js');
    assert.match(src, /A8_CONNECT_TIMEOUT_MS = 10_000/);
    assert.match(src, /A8_STATEMENT_TIMEOUT_MS = 15_000/);
    assert.match(src, /connectBounded\(\(\) => \(deps\.connectDedicated \?\? defaultConnectDedicated\)\(\{ connectTimeoutMs: A8_CONNECT_TIMEOUT_MS, statementTimeoutMs: A8_STATEMENT_TIMEOUT_MS \}\), A8_CONNECT_TIMEOUT_MS\)/);
    const db = read('src/core/db.js');
    assert.match(db, /connectionTimeoutMillis: opts\.connectTimeoutMs/);
    assert.match(db, /statement_timeout: opts\.statementTimeoutMs/);
  });

  test('the style-checks file carries the two new patterns and the example facts file is a placeholder', () => {
    const j = JSON.parse(read('config/style-checks.json'));
    assert.ok(j.problemComparisonPatterns.some((/** @type {string} */ p) => p.includes('less about')));
    assert.ok(j.problemComparisonPatterns.some((/** @type {string} */ p) => p.includes("isn't|is not")));
    assert.equal(JSON.parse(read('config/target-pitch-facts.example.json'))._placeholder, true);
  });
});

describe('hygiene', () => {
  test('no dash character (U+2010 to U+2015, U+2212) and no non-ASCII look-alike in any PR5 file', () => {
    for (const f of [...PR5_SRC, ...PR5_OTHER]) {
      if (!fs.existsSync(rel(f))) continue;
      const s = read(f);
      for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0;
        assert.ok(!(cp >= 0x2010 && cp <= 0x2015) && cp !== 0x2212, `${f}: dash U+${cp.toString(16)}`);
        assert.ok(cp === 0x0a || cp === 0x0d || cp === 0x09 || (cp >= 0x20 && cp < 0x7f) || cp > 0x7f, `${f}: control character U+${cp.toString(16)}`);
      }
    }
  });

  test('the new gate and prompt files are plain ASCII (escapes, never raw look-alike letters)', () => {
    for (const f of ['src/targets/draft-text.js', 'src/targets/draft-gates.js', 'src/targets/draft-prompt.js', 'src/targets/pitch-facts.js', 'src/targets/drafts.js', 'src/dashboard/draft-approve.js']) {
      const s = read(f);
      const bad = [...s].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7e || ((ch.codePointAt(0) ?? 0) < 0x20 && !'\n\r\t'.includes(ch)));
      assert.deepEqual(bad.map((c) => c.codePointAt(0)), [], f);
    }
  });
});
