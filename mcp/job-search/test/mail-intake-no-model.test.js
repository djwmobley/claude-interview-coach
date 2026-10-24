// @ts-check
/**
 * No model ever reads intake text (spec D): triage and every Claude step must not receive it. The guarantee is
 * structural, so it is asserted structurally:
 *   1. no module that spawns Claude or builds a model prompt imports the intake modules or names ic_mail_intake;
 *   2. the intake modules import nothing that spawns Claude or reaches a model;
 *   3. triage and the other Claude-spawning steps read listings only: no SQL in them names the ledger, and the scan
 *      run calls runTriage without any intake argument.
 *
 * BLIND SPOTS: a static import and name check cannot see a dynamic import with a computed specifier, a raw SQL
 * string assembled at runtime that reads ic_mail_intake, or a future module that passes intake text through an
 * unrelated variable. It proves today's graph, not tomorrow's.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTAKE_MODULES = ['mail-intake', 'mail-intake-store', 'mail-intake-report', 'mail-intake-config', 'mail-mime', 'gmail-intake'];
const INTAKE_NAME = /mail-intake|mail-mime|gmail-intake|ic_mail_intake|mailIntake/;
/** Anything that can put text in front of a model. */
const MODEL_REACH = /claude-spawn|spawnClaude|runModelTriage|triage\.js|--print|anthropic|ollama|embed\.js/i;

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
}
const rel = (/** @type {string} */ p) => path.relative(ROOT, p).replace(/\\/g, '/');

describe('no model reads intake text', () => {
  test('modules that talk to a model never import or name the intake', () => {
    /** @type {string[]} */
    const files = [];
    walk(path.join(ROOT, 'src'), files);
    // Model-facing: the Claude spawner itself, anything that imports it (triage, resume and review runners,
    // the target draft stage, the assisted apply runner), triage, and the embedding client.
    const importsSpawner = (/** @type {string} */ t) => t.split('\n').some((l) => /^\s*import\b.*claude-spawn/.test(l));
    const modelFiles = files.filter((f) => /claude-spawn|\/triage\.js$|embed\.js$/.test(rel(f)) || importsSpawner(fs.readFileSync(f, 'utf8')));
    assert.ok(modelFiles.length >= 6, `the scan found the model-facing modules (${modelFiles.length})`);
    for (const f of modelFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(INTAKE_NAME.test(text), false, `${rel(f)} must not reference the mail intake`);
    }
  });

  test('the intake modules import nothing that reaches a model', () => {
    for (const name of INTAKE_MODULES) {
      const file = ['src/core', 'src/adapters'].map((d) => path.join(ROOT, d, `${name}.js`)).find((p) => fs.existsSync(p));
      assert.ok(file, name);
      const imports = fs.readFileSync(/** @type {string} */ (file), 'utf8').split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
      assert.equal(MODEL_REACH.test(imports), false, `${name} imports a model-reaching module:\n${imports}`);
    }
  });

  test('triage and the Claude-spawning steps read listings, never the ledger: no SQL in them names ic_mail_intake', () => {
    for (const f of ['src/core/triage.js', 'src/core/claude-spawn.js', 'src/core/gmail-detail.js', 'src/core/detail-verify.js']) {
      const full = path.join(ROOT, f);
      if (!fs.existsSync(full)) continue;
      assert.equal(/ic_mail_intake/.test(fs.readFileSync(full, 'utf8')), false, f);
    }
  });

  test('the scan run hands the intake rows to the ledger only: the persisted rows are never passed to triage', () => {
    const scanRun = fs.readFileSync(path.join(ROOT, 'src/core/scan-run.js'), 'utf8');
    const triageCall = scanRun.slice(scanRun.indexOf('runTriage('), scanRun.indexOf('runTriage(') + 600);
    assert.equal(/intake/i.test(triageCall), false, 'runTriage is called without any intake argument');
  });
});
