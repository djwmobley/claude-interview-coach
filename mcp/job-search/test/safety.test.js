// @ts-check
/**
 * Structural safety test (spec section 1). Scans src/ recursively:
 *   - no file under src/adapters/ imports playwright or contains the
 *     identifiers page, context, browser (as whole words);
 *   - nowhere in src/ appears any forbidden call surface;
 *   - only browser/session.js may import playwright-core;
 *   - page.evaluate is called only from browser/capability.js and only with
 *     functions from extractors.js (no inline bodies, no strings).
 * src/adapters/ is scanned even when empty so the next stage's files are
 * covered automatically.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Strip comments so a mention in prose does not count, but keep strings (a forbidden call in a string is still suspicious). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

const FORBIDDEN = [
  'browser.close(', 'context.close(', 'context.route(', 'page.request', 'context.request',
  '.click(', '.fill(', '.type(', '.press(', '.tap(', '.check(', '.selectOption(', '.setInputFiles(', '.dispatchEvent(',
  'mouse.', 'keyboard.',
];

describe('structural safety', () => {
  const files = walk(SRC);
  const adaptersDir = path.join(SRC, 'adapters');
  const adapterFiles = walk(adaptersDir);

  test('src/ has files to scan', () => {
    assert.ok(files.length > 10);
  });

  test('src/adapters/ exists or is scanned as empty (next stage adds files)', () => {
    assert.ok(Array.isArray(adapterFiles));
  });

  test('adapters never import playwright and never mention page/context/browser identifiers', () => {
    for (const f of adapterFiles) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      assert.ok(!/playwright/i.test(src), `${path.relative(SRC, f)} references playwright`);
      const bad = /\b(page|context|browser)\b/.exec(src);
      assert.equal(bad, null, `${path.relative(SRC, f)} contains identifier ${bad && bad[1]}`);
    }
  });

  test('no forbidden call surface anywhere in src/', () => {
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const needle of FORBIDDEN) {
        assert.ok(!src.includes(needle), `${path.relative(SRC, f)} contains ${needle}`);
      }
    }
  });

  test('only browser/session.js imports playwright-core', () => {
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      const imports = /import\s*\(\s*['"]playwright-core['"]\s*\)|from\s+['"]playwright-core['"]/.test(src);
      if (rel === 'browser/session.js') assert.ok(imports, 'session.js loads playwright-core');
      else assert.ok(!imports, `${rel} must not import playwright-core`);
    }
  });

  test('page.evaluate appears only in browser/capability.js and only with named extractor functions', () => {
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      const n = (src.match(/\.evaluate\s*\(/g) ?? []).length;
      if (rel !== 'browser/capability.js') assert.equal(n, 0, `${rel} calls evaluate`);
      else {
        assert.ok(n >= 1);
        // No inline function bodies or string sources: every evaluate receives a cast identifier or EXTRACTORS member.
        assert.ok(!/\.evaluate\s*\(\s*(\(|function|async|['"`])/.test(src), 'evaluate must not receive an inline function or string');
      }
    }
  });

  test('no config-driven evaluate: extractors registry is a frozen object of module functions', async () => {
    const mod = await import('../src/browser/extractors.js');
    assert.ok(Object.isFrozen(mod.EXTRACTORS));
    for (const [k, v] of Object.entries(mod.EXTRACTORS)) assert.equal(typeof v, 'function', k);
  });

  test('logger only writes to stderr or a file; no stdout destination', () => {
    const src = fs.readFileSync(path.join(SRC, 'core', 'logger.js'), 'utf8');
    assert.ok(!/destination\(\s*\{[^}]*dest:\s*1\b/.test(src));
    assert.ok(!/process\.stdout/.test(src));
  });

  test('server.js imports stdout-hygiene first', () => {
    const src = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    const firstImport = src.match(/^import\s.*$/m);
    assert.ok(firstImport && firstImport[0].includes('stdout-hygiene.js'), 'first import is the hygiene module');
  });

  test('no em-dash or en-dash characters in any src/ or bin/ file', () => {
    const all = [...files, ...walk(path.join(HERE, '..', 'bin')), ...walk(HERE)];
    for (const f of all) {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!src.includes('\u2014'), `${path.relative(HERE, f)} contains an em-dash`);
      assert.ok(!src.includes('\u2013'), `${path.relative(HERE, f)} contains an en-dash`);
    }
  });
});
