// @ts-check
/**
 * Static guarantees for the PR3 files (plan 17.8): the runner, stage, CLI and tool contain no send, mail,
 * shell, powershell or browser path and no encoded command; the tool is read only by construction; the new
 * files carry no em dash; the runner is the only place that starts the stage and the stage is skipped on a
 * dry run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const rel = (/** @type {string} */ p) => path.join(ROOT, ...p.split('/'));
const read = (/** @type {string} */ p) => fs.readFileSync(rel(p), 'utf8');
const strip = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PR3_CODE = ['bin/targets.js', 'src/tools/targets.js', 'src/targets/runner.js', 'src/targets/stage.js', 'src/targets/coverage.js', 'src/targets/dates.js'];

describe('no send, shell, or browser path in the PR3 code', () => {
  for (const f of PR3_CODE) {
    test(`${f}: no child process, shell, powershell, encoded command, browser, mail, or write verb`, () => {
      const src = strip(read(f));
      assert.ok(!/node:child_process|require\(['"]child_process|\bspawn\s*\(|\bexecFile?(?:Sync)?\s*\(|\bexecSync\b/.test(src), 'child process');
      assert.ok(!/powershell|pwsh|EncodedCommand|cmd\.exe|explorer\.exe/i.test(src), 'shell or powershell');
      assert.ok(!/playwright|puppeteer|chrome-launch|connectSession|\bcdp\b/i.test(src), 'browser');
      assert.ok(!/sendmail|nodemailer|smtp|messages\/send|drafts\.create|clipboard/i.test(src), 'mail or clipboard');
      assert.ok(!/\b(?:POST|PUT|PATCH)\b/.test(src), 'write verb');
      assert.ok(!/(?<![.\w])fetch\s*\(/.test(src), 'no direct fetch call: all network goes through the guard');
    });
  }
  test('the tool never mentions a write statement and always opens READ ONLY', () => {
    const src = strip(read('src/tools/targets.js'));
    assert.match(src, /BEGIN READ ONLY/);
    assert.ok(!/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\s+(?:INTO|TABLE|FROM|\w+\s+SET)?/.test(src.replace(/ic_target\w*|ic_targets/g, 'T').replace(/UPDATE_|_UPDATE/g, '')), 'no write statement in the tool source');
  });
});

describe('wiring', () => {
  test('scan-run starts the stage only inside the !dryRun block, after triage, through a seam', () => {
    const src = read('src/core/scan-run.js');
    const triage = src.indexOf('stats.triage = triageStats;');
    const stage = src.indexOf('deps.runTargetsStage ?? runTargetsStage');
    const closing = src.indexOf("log({ evt: 'run_finished'");
    assert.ok(triage > 0 && stage > triage && closing > stage, 'order: triage, stage, run_finished');
    const block = src.slice(src.lastIndexOf('if (!dryRun) {', triage), stage);
    assert.ok(block.includes('stats.triage = triageStats;'), 'the stage sits inside the same !dryRun block as triage');
  });
  test('server registers the targets tool; the CLI is a thin wrapper over runTargets', () => {
    assert.match(read('src/server.js'), /from '\.\/tools\/targets\.js'/);
    assert.match(read('src/server.js'), /restartDashboard, targets\]/);
    assert.match(read('bin/targets.js'), /runTargets\(/);
  });
  test('the migration is registered in all three lists', () => {
    for (const f of ['bin/migrate.js', 'src/core/schema.js', 'bin/bootstrap-test-db.js']) assert.ok(read(f).includes("'025_target_cursors.sql'"), f);
  });
});

describe('hygiene', () => {
  test('no em dash (U+2014) in any PR3 file', () => {
    const all = [...PR3_CODE, 'sql/025_target_cursors.sql', 'test/migration-025.test.js', 'test/helpers/targets-world.js', 'src/core/report.js'];
    for (const f of fs.readdirSync(rel('test')).filter((n) => /^targets-(?:runner|stage|tool|pr3)/.test(n))) all.push(`test/${f}`);
    for (const f of all) assert.ok(!read(f).includes(String.fromCharCode(0x2014)), `${f}: em dash`);
  });
});
