// @ts-check
/**
 * Guard (2026-10-15): the default test run must never launch a real browser (antivirus flags it).
 * Any test file that shows a real-browser launch indicator must also call the shared opt-in gate in
 * test/helpers/browser-gate.js (browserSkip() or assertBrowserTestsEnabled()), so the suite skips unless
 * JOBSEARCH_BROWSER_TESTS=1.
 *
 * Classification is total: every file under test/ (not only test/*.test.js) is either clean (no indicator),
 * gated (indicator and gate call), or a violation (indicator without gate, or unreadable file or dir).
 * This is a presence check on indicators, not a list of approved files.
 *
 * BLIND SPOTS (what this guard cannot detect):
 *  - A launch hidden behind indirection: a computed module name, a string built at runtime, a launch inside
 *    a src/ module that a test imports without any indicator in the test text itself, or a helper that
 *    wraps launchHeadlessChrome under another name in a file that is not itself scanned.
 *  - Calling the gate is checked by text, not by control flow: a file can call browserSkip() yet ignore the
 *    result and launch anyway. The runtime guard in launchHeadlessChrome() covers only that one helper.
 *  - Comment stripping is naive (line and block comments); a browser API mentioned only inside a string or
 *    comment-like text may be missed or falsely flagged. False positives are friction, by design.
 *  - Fake harnesses that define a method named connectOverCDP are intentionally not flagged (only calls
 *    through a dot are), so a real call written without a dot is missed.
 *  - test/chrome-launch.test.js imports src/core/chrome-launch.js but injects every spawn and process
 *    listing, so a bare import of that module is not treated as an indicator; a test that calls it without
 *    injecting spawnChrome would launch a real Chrome and this guard would not notice.
 *  - Non-test processes (dashboard, scan scripts run by hand) and the MCP browser tools are out of scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');
const SELF = fileURLToPath(import.meta.url);
const GATE_HELPER = path.join(TEST_DIR, 'helpers', 'browser-gate.js');

/** Evidence that a file launches or connects to a real browser. */
const INDICATORS = [
  ['imports puppeteer/playwright', /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:puppeteer|playwright)(?:-core)?['"]/],
  ['uses the headless-chrome launch helper', /\b(?:launchHeadlessChrome|findChromeBinary)\b|helpers\/headless-chrome/],
  ['calls connectOverCDP', /\.\s*connectOverCDP\s*\(/],
  ['calls a browser .launch / launchPersistentContext', /\.\s*launch\s*\(|\blaunchPersistentContext\s*\(/],
  ['spawns a Chrome/Edge executable', /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\([^)]{0,200}(?:chrome|chromium|msedge)/i],
];
/** The gate: any of these means the file opted into the shared helper. */
const GATE_CALL = /\b(?:browserSkip|assertBrowserTestsEnabled)\s*\(/;
const GATE_IMPORT = /helpers\/browser-gate/;

/** @param {string} text */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/**
 * Total classification of one test file's text.
 * @param {string} text
 * @returns {string[]} violation reasons (empty = clean or properly gated)
 */
export function classify(text) {
  const code = stripComments(text);
  const hits = INDICATORS.filter(([, re]) => re.test(code)).map(([name]) => name);
  if (hits.length === 0) return [];
  if (GATE_IMPORT.test(code) && GATE_CALL.test(code)) return [];
  return [`${hits.join(', ')} but does not call the browser-gate helper (browserSkip / assertBrowserTestsEnabled)`];
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    out.push(`${dir}\0UNREADABLE_DIR`);
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'fixtures') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.[cm]?js$/i.test(e.name)) out.push(p);
  }
}

test('classify: indicators need the gate, clean and gated text pass', () => {
  assert.ok(classify("import { chromium } from 'playwright-core';").length > 0);
  assert.ok(classify("const c = await launchHeadlessChrome(dir);").length > 0);
  assert.ok(classify("const b = await chromium.connectOverCDP(url);").length > 0);
  assert.ok(classify("await puppeteer.launch({});").length > 0);
  assert.ok(classify("spawn('C:/x/chrome.exe', ['--headless'])").length > 0);
  assert.equal(classify("const s = { async connectOverCDP() { return b; } };").length, 0, 'fake method definition');
  assert.equal(classify("// uses playwright-core via connectOverCDP in prose only\nconst x = 1;").length, 0, 'comments ignored');
  assert.equal(classify("import { launchHeadlessChrome } from './helpers/headless-chrome.js';\nimport { browserSkip } from './helpers/browser-gate.js';\nconst SKIP = browserSkip();").length, 0);
  assert.ok(classify("import { launchHeadlessChrome } from './helpers/headless-chrome.js';\n// browserSkip()").length > 0, 'gate named only in a comment does not count');
});

test('every test file with a real-browser launch indicator calls the shared browser-gate helper', () => {
  /** @type {string[]} */
  const files = [];
  walk(TEST_DIR, files);
  assert.ok(files.length > 50, `scanner found suspiciously few files (${files.length})`);
  assert.ok(files.some((f) => path.resolve(f) === GATE_HELPER), 'gate helper must exist');
  /** @type {string[]} */
  const violations = [];
  for (const f of files) {
    if (f.endsWith('\0UNREADABLE_DIR')) {
      violations.push(f.replace('\0', ': '));
      continue;
    }
    const abs = path.resolve(f);
    // The gate helper and the launch helper define the mechanism; the guard itself quotes the patterns.
    if (abs === SELF || abs === GATE_HELPER || abs === path.join(TEST_DIR, 'helpers', 'headless-chrome.js')) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (err) {
      violations.push(`${path.relative(ROOT, f)}: unreadable (${/** @type {any} */ (err).code ?? 'error'})`);
      continue;
    }
    for (const reason of classify(text)) violations.push(`${path.relative(ROOT, f)}: ${reason}`);
  }
  assert.deepEqual(violations, [], `Ungated real-browser tests found:\n${violations.join('\n')}`);
});

// ---------------------------------------------------------------------------------------------------
// Production modules (src/, bin/, scripts/): the runtime guard. Any module that can start or drive a real
// browser, or open an OS URL handler, must call assertRealBrowserAllowed() from src/core/test-guard.js so
// the launch throws real_browser_blocked_in_tests under the test runner. Same total classification:
// indicator present means the guard call must be present, otherwise the module is named as a violation.
// Blind spots: the check is textual, so it proves a call exists in the module, not that it precedes every
// launch path; a launch reached through a module with no indicator in its own text (a wrapper that takes
// the command as data) is not seen; the identity check `spawnImpl === spawn` is bypassed by wrapping spawn.
// ---------------------------------------------------------------------------------------------------
const PROD_INDICATORS = [
  ['connects or launches a browser via playwright/puppeteer', /\bconnectOverCDP\s*\(|\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:puppeteer|playwright)(?:-core)?['"]|\b(?:chromium|firefox|webkit|puppeteer)\s*\.\s*launch\s*\(|\blaunchPersistentContext\s*\(/],
  ['names an OS URL handler or browser executable', /['"`](?:explorer(?:\.exe)?|rundll32|xdg-open|msedge(?:\.exe)?|chrome\.exe)['"`]/i],
  ['defines the scan Chrome process listing (listScanProfileProcesses)', /export\s+(?:async\s+)?function\s+listScanProfileProcesses\b/],
  ['passes --remote-debugging-port (starts Chrome)', /--remote-debugging-port/],
  ['drives Chrome tabs over CDP with the real fetch/WebSocket', /Page\.reload/],
];
const PROD_GATE = /\bassertRealBrowserAllowed\s*\(/;
const PROD_GATE_IMPORT = /test-guard\.js/;
const PROD_DIRS = ['src', 'bin', 'scripts'];

/** @param {string} text @returns {string[]} */
export function classifyProd(text) {
  const code = stripComments(text);
  const hits = PROD_INDICATORS.filter(([, re]) => re.test(code)).map(([name]) => name);
  if (hits.length === 0) return [];
  if (PROD_GATE_IMPORT.test(code) && PROD_GATE.test(code)) return [];
  return [`${hits.join(', ')} but does not call assertRealBrowserAllowed (src/core/test-guard.js)`];
}

test('classifyProd: indicators need the runtime guard', () => {
  assert.ok(classifyProd("return ['explorer.exe', [url]];").length > 0);
  assert.ok(classifyProd("await chromium.connectOverCDP(u);").length > 0);
  assert.ok(classifyProd("const a = ['--remote-debugging-port=1'];").length > 0);
  assert.equal(classifyProd("const x = fs.readFileSync(p); // explorer.exe in a comment").length, 0);
  assert.equal(classifyProd("import { assertRealBrowserAllowed } from './test-guard.js';\nassertRealBrowserAllowed('x');\nspawn('xdg-open', []);").length, 0);
});

test('every production module that can launch or drive a real browser calls the runtime guard', () => {
  /** @type {string[]} */
  const files = [];
  for (const d of PROD_DIRS) walk(path.join(ROOT, d), files);
  assert.ok(files.length > 50, `scanner found suspiciously few files (${files.length})`);
  /** @type {string[]} */
  const violations = [];
  for (const f of files) {
    if (f.endsWith('\0UNREADABLE_DIR')) {
      violations.push(f.replace('\0', ': '));
      continue;
    }
    if (path.resolve(f) === path.join(ROOT, 'src', 'core', 'test-guard.js')) continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (err) {
      violations.push(`${path.relative(ROOT, f)}: unreadable (${/** @type {any} */ (err).code ?? 'error'})`);
      continue;
    }
    for (const reason of classifyProd(text)) violations.push(`${path.relative(ROOT, f)}: ${reason}`);
  }
  assert.deepEqual(violations, [], `Production modules with an unguarded real-browser launch:\n${violations.join('\n')}`);
});
