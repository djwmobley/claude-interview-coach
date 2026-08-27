// @ts-check
/**
 * Static lint checks over src/dashboard/ and its public/ front-end placeholder
 * (pr2-spec-decisions.md rules 2 and 4, plan line 140). These are plain string/regex scans over the
 * committed source, not a real linter integration -- cheap, fast, and exactly what the decisions file
 * asks for: "test/dashboard-lint.test.js greps ... and fails on any hit."
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');
const DASHBOARD_DIR = path.join(PACKAGE_ROOT, 'src', 'dashboard');
const PUBLIC_DIR = path.join(DASHBOARD_DIR, 'public');

/** @param {string} dir */
function walkJs(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** @param {string} dir @param {(name: string) => boolean} filter */
function walkAll(dir, filter) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAll(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const dashboardJsFiles = walkJs(DASHBOARD_DIR);

// Built from code points, never a literal em-dash/en-dash character in this file's own source: this file
// lives under test/, which the existing test/safety.test.js "no em-dash or en-dash characters in any
// src/ or bin/ file" check also scans (it walks its own directory too), so a literal dash character
// embedded in a regex here would trip that check itself.
const DASH_RE = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

describe('src/dashboard/: banned raw-body-merge patterns (pr2-spec-decisions.md rule 2)', () => {
  test('no Object.assign( anywhere in src/dashboard/', () => {
    const hits = dashboardJsFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('Object.assign('));
    assert.deepEqual(hits, []);
  });

  test('no ...body or ...req.body spread anywhere in src/dashboard/', () => {
    const hits = dashboardJsFiles.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return text.includes('...body') || text.includes('...req.body');
    });
    assert.deepEqual(hits, []);
  });
});

describe('src/dashboard/: no CORS headers anywhere (rule 4)', () => {
  test('no Access-Control header set anywhere in src/dashboard/', () => {
    const hits = dashboardJsFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('Access-Control'));
    assert.deepEqual(hits, []);
  });
});

describe('em-dash / en-dash: never in generated or authored dashboard text', () => {
  test('no U+2014 or U+2013 in src/dashboard/*.js', () => {
    const hits = dashboardJsFiles.filter((f) => DASH_RE.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(hits, []);
  });

  test('no U+2014 or U+2013 in bin/dashboard.js or bin/seed-opportunities.js', () => {
    for (const f of ['dashboard.js', 'seed-opportunities.js']) {
      const p = path.join(PACKAGE_ROOT, 'bin', f);
      assert.equal(DASH_RE.test(fs.readFileSync(p, 'utf8')), false, p);
    }
  });
});

describe('public/: banned DOM APIs (ahead of the PR 3 front end; the placeholder page must already comply)', () => {
  const publicFiles = walkAll(PUBLIC_DIR, (name) => name.endsWith('.html') || name.endsWith('.js') || name.endsWith('.css'));

  test('at least the placeholder index.html exists', () => {
    assert.ok(publicFiles.some((f) => f.endsWith('index.html')));
  });

  test('no innerHTML, insertAdjacentHTML, or srcdoc assignment in public/', () => {
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(/\.innerHTML\s*=/.test(text), false, `${f}: innerHTML`);
      assert.equal(text.includes('insertAdjacentHTML'), false, `${f}: insertAdjacentHTML`);
      assert.equal(/\.srcdoc\s*=/.test(text), false, `${f}: srcdoc`);
    }
  });

  test('no inline style= attributes, no <link href="http, no @import in public/', () => {
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(/style\s*=\s*"/.test(text), false, `${f}: inline style=`);
      assert.equal(/<link[^>]+href="http/i.test(text), false, `${f}: remote <link href="http`);
      assert.equal(text.includes('@import'), false, `${f}: @import`);
    }
  });

  test('no inline <script> or <style> blocks in public/*.html', () => {
    const htmlFiles = publicFiles.filter((f) => f.endsWith('.html'));
    for (const f of htmlFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(text.replace(/<script[^>]*\/>/gi, '')), false, `${f}: inline <script>`);
      assert.equal(/<style[^>]*>[\s\S]*?<\/style>/i.test(text), false, `${f}: inline <style>`);
    }
  });
});
