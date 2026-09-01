// @ts-check
/**
 * Apply pipeline slice 5 amended spec, "Lint tests (replace any author-proof no-op)":
 *   (a) exactly ONE apply-capability constructor callsite across src/, and it is src/apply/worker.js;
 *   (b) nothing on the scan side (src/adapters/, scan paths) imports anything from src/apply/.
 * Both are grep-based structural checks against the real source tree, not import-graph introspection --
 * matching this repo's own existing lint-test style (test/dashboard-lint.test.js, test/credentials-
 * lint.test.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, '..', 'src');

/** @param {string} dir @returns {string[]} */
function listJsFilesRecursive(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFilesRecursive(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const ALL_SRC_FILES = listJsFilesRecursive(SRC_DIR);

describe('lint: makeApplyCapability has exactly one constructor callsite (src/apply/worker.js)', () => {
  test('no other file under src/ calls makeApplyCapability(', () => {
    const callsiteRe = /\bmakeApplyCapability\s*\(/;
    const hits = [];
    for (const f of ALL_SRC_FILES) {
      // Skip the capability module's own definition (it necessarily contains the function's own
      // declaration, `export function makeApplyCapability(page, opts) {`, which is not a callsite).
      if (path.resolve(f) === path.resolve(SRC_DIR, 'apply', 'apply-capability.js')) continue;
      const text = fs.readFileSync(f, 'utf8');
      if (callsiteRe.test(text)) hits.push(path.relative(SRC_DIR, f));
    }
    assert.deepEqual(hits, [path.join('apply', 'worker.js')], 'makeApplyCapability must be constructed only by src/apply/worker.js');
  });

  test('makeApplyCapability is actually imported by src/apply/worker.js (the assertion above is not vacuous)', () => {
    const text = fs.readFileSync(path.join(SRC_DIR, 'apply', 'worker.js'), 'utf8');
    assert.match(text, /import\s*\{[^}]*\bmakeApplyCapability\b[^}]*\}\s*from\s*['"]\.\/apply-capability\.js['"]/);
  });
});

describe('lint: the scan side never imports src/apply/', () => {
  test('nothing under src/adapters/ imports from ../apply/ or src/apply/', () => {
    const adaptersDir = path.join(SRC_DIR, 'adapters');
    const hits = [];
    for (const f of listJsFilesRecursive(adaptersDir)) {
      const text = fs.readFileSync(f, 'utf8');
      if (/from\s+['"](\.\.\/)*apply\//.test(text) || /from\s+['"]\.\.\/apply\//.test(text)) hits.push(path.relative(SRC_DIR, f));
    }
    assert.deepEqual(hits, []);
  });

  test('no scan-path module (src/core/scan-run.js, src/browser/*, src/adapters/*) imports src/apply/*', () => {
    const scanPaths = [
      path.join(SRC_DIR, 'core', 'scan-run.js'),
      ...listJsFilesRecursive(path.join(SRC_DIR, 'browser')),
      ...listJsFilesRecursive(path.join(SRC_DIR, 'adapters')),
    ];
    const hits = [];
    for (const f of scanPaths) {
      const text = fs.readFileSync(f, 'utf8');
      // Any relative import path whose resolved segments include "apply" as a directory component --
      // matches "../apply/x.js", "../../apply/x.js", etc., not merely the substring "apply" inside an
      // unrelated word (word-boundary /apply\// requires the literal directory separator either side).
      if (/from\s+['"](?:\.\.\/)+apply\/[^'"]+['"]/.test(text)) hits.push(path.relative(SRC_DIR, f));
    }
    assert.deepEqual(hits, [], `scan-side files must never import src/apply/*: ${hits.join(', ')}`);
  });
});
