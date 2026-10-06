// @ts-check
/**
 * Structural lint for assisted LinkedIn Easy Apply (spec B1, B3, G4, G13): src/apply/easy-apply-driver.js
 * is the ONLY module in the flow that clicks, types, selects, uploads, or calls Runtime.callFunctionOn;
 * the in-page function dispatches no key events and installs no listeners, timers, or observers; nothing
 * in the flow uses network interception or bypassPermissions; and in the driver's advance branch the G1
 * and G2 checks come before the only button click. Grep-based against the real source tree, matching
 * test/apply-lint.test.js's style.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_FUNCTION } from '../src/apply/easy-apply-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
/** Source with block and line comments removed (doc comments may NAME a forbidden primitive). @param {string} t */
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const read = (/** @type {string} */ rel) => code(fs.readFileSync(path.join(SRC, rel), 'utf8'));

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const DRIVER = path.join('apply', 'easy-apply-driver.js');
const FLOW_FILES = [
  path.join('apply', 'easy-apply-guard.js'),
  path.join('apply', 'easy-apply-answers.js'),
  path.join('apply', 'easy-apply-policy.js'),
  path.join('apply', 'easy-apply-flow.js'),
  path.join('apply', 'easy-apply-runner.js'),
  path.join('apply', 'easy-apply-morning.js'),
  path.join('apply', 'adapters', 'linkedin-easy.js'),
  path.join('apply', 'worker.js'),
  path.join('tools', 'easy_apply.js'),
  // Assisted apply modules (PR #80 reviewer note; assisted Workday PR-2). assisted/driver.js only
  // re-exports the driver and is listed too: it must never grow page actions of its own.
  path.join('tools', 'assisted_apply.js'),
  path.join('apply', 'assisted', 'answers.js'),
  path.join('apply', 'assisted', 'driver.js'),
  path.join('apply', 'assisted', 'field-policy.js'),
  path.join('apply', 'assisted', 'gate.js'),
  path.join('apply', 'assisted', 'guard.js'),
  path.join('apply', 'assisted', 'handoff.js'),
  path.join('apply', 'assisted', 'runner.js'),
  path.join('apply', 'assisted', 'profiles', 'index.js'),
  path.join('apply', 'assisted', 'profiles', 'linkedin.js'),
  path.join('apply', 'assisted', 'profiles', 'workday.js'),
  path.join('dashboard', 'routes', 'easy-apply.js'),
  path.join('core', 'easy-apply-state.js'),
  path.join('core', 'easy-apply-tabs.js'),
  path.join('browser', 'cdp-target.js'),
];
const ACTION_RE = /\.click\(|dispatchEvent\(|Input\.dispatch|Input\.insertText|insertText|setInputFiles|DOM\.setFileInputFiles|\.fill\(|\.press\(|keyboard\.|mouse\.|Runtime\.callFunctionOn/;

describe('easy apply lint: only the driver acts on the page', () => {
  test('no other Easy Apply flow module contains a click/type/select/upload primitive or callFunctionOn', () => {
    const hits = FLOW_FILES.filter((f) => ACTION_RE.test(read(f)));
    assert.deepEqual(hits, []);
  });
  test('the driver does contain them (the check above is not vacuous)', () => {
    const d = read(DRIVER);
    assert.match(d, /\.click\(\)/);
    assert.match(d, /Runtime\.callFunctionOn/);
    assert.match(d, /DOM\.setFileInputFiles/);
  });
  test('Runtime.callFunctionOn appears nowhere else under src/', () => {
    const hits = walk(SRC).filter((f) => path.relative(SRC, f) !== DRIVER && /Runtime\.callFunctionOn/.test(code(fs.readFileSync(f, 'utf8'))));
    assert.deepEqual(hits.map((f) => path.relative(SRC, f)), []);
  });
  test('the in-page function has no key events, listeners, timers, observers, or network hooks (G4)', () => {
    assert.doesNotMatch(PAGE_FUNCTION, /KeyboardEvent|keydown|keypress|keyup|\bEnter\b|addEventListener|setInterval|setTimeout|MutationObserver|XMLHttpRequest|fetch\(|\.submit\(|requestSubmit/);
  });
  test('the advance branch evaluates G1, G2, then an in-call re-verification, before its only click', () => {
    const block = PAGE_FUNCTION.slice(PAGE_FUNCTION.indexOf("case 'advance':"), PAGE_FUNCTION.indexOf("case 'fill_text':"));
    const g1 = block.indexOf('G.classifyAdvanceButton(');
    const g2 = block.indexOf('G.checkNotLastStep(');
    const reverify = block.indexOf("'changed_before_click'");
    const click = block.indexOf('HTMLElement.prototype.click.call(');
    assert.ok(g1 > 0 && g2 > g1 && reverify > g2 && click > reverify, `g1=${g1} g2=${g2} reverify=${reverify} click=${click}`);
    assert.doesNotMatch(block, /\.click\(\)/, 'the advance branch clicks only through the prototype after re-verification');
  });
  test('nothing in the flow uses network interception or bypassPermissions', () => {
    const files = [...FLOW_FILES, DRIVER];
    const hits = files.filter((f) => /bypassPermissions|\.route\(|Fetch\.enable|Network\.setRequestInterception|Network\.enable/.test(read(f)));
    assert.deepEqual(hits, []);
  });
  test('every assisted module under src/apply/assisted/ is in FLOW_FILES (a new module cannot slip past the action check)', () => {
    const assistedDir = path.join(SRC, 'apply', 'assisted');
    const missing = walk(assistedDir).map((f) => path.relative(SRC, f)).filter((f) => !FLOW_FILES.includes(f));
    assert.deepEqual(missing, []);
  });
  test('model-reachable modules never import core/credentials.js, the worker, the Workday adapter, or Gmail verification (spec v1 clause 6)', () => {
    const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    /** @param {string} entry */
    const closure = (entry) => {
      const seen = new Set();
      const stack = [path.join(SRC, entry)];
      while (stack.length) {
        const f = /** @type {string} */ (stack.pop());
        if (seen.has(f)) continue;
        seen.add(f);
        for (const m of fs.readFileSync(f, 'utf8').matchAll(IMPORT_RE)) stack.push(path.resolve(path.dirname(f), m[1] ?? m[2]));
      }
      return [...seen].map((f) => path.relative(SRC, f));
    };
    const banned = [path.join('core', 'credentials.js'), path.join('apply', 'worker.js'), path.join('apply', 'adapters', 'workday.js'), path.join('apply', 'gmail-verify.js')];
    for (const entry of [path.join('tools', 'assisted_apply.js'), path.join('tools', 'easy_apply.js')]) {
      const reach = closure(entry);
      assert.ok(reach.length > 10, `${entry}: the import walk found its dependencies`);
      assert.deepEqual(reach.filter((f) => banned.includes(f)), [], entry);
    }
    // The lease-mode MCP server process as a whole never loads the credential store either.
    assert.deepEqual(closure('server.js').filter((f) => f === path.join('core', 'credentials.js')), []);
  });
  test('the scan side still never imports src/apply/ (session.js reads the tab set through src/core/)', () => {
    const s = read(path.join('browser', 'session.js'));
    assert.doesNotMatch(s, /from\s+['"](?:\.\.\/)+apply\//);
    assert.match(s, /core\/easy-apply-tabs\.js/);
  });
});
