// @ts-check
/**
 * Static lint checks over src/dashboard/ (server) and src/dashboard/public/ (front end), extended per
 * pr3-spec-decisions.md section 1: the old public/ ban list was allow-some-deny-some (it never scanned
 * public/ for em/en dash at all, and several DOM-injection primitives evaded every regex it had). This
 * file replaces that with the closed BANNED-sink enumeration from section 1, plus the public/ em/en dash
 * scan and an escaped-unicode-dash source-text check independent of the literal-code-point check.
 *
 * These remain plain string/regex scans over committed source, not a real linter integration -- cheap,
 * fast, and exactly what the decisions file asks for. Known, accepted blind spot (documented in the PR
 * body, not silently swept under a passing test): a computed/bracket property sink such as
 * `el["inner"+"HTML"]` or `el[sinkNameVar]` defeats every regex-based check by construction, including
 * this one; section 1 names this as an existing evasion of any regex ban list, not something this test
 * claims to close.
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
const README_PATH = path.join(PACKAGE_ROOT, 'README.md');

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

// Built from code points, never a literal em-dash/en-dash character in this file's own source: this file
// lives under test/, which test/safety.test.js also scans, so a literal dash character embedded in a
// regex here would trip that check itself.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const DASH_RE = new RegExp(`[${EM_DASH}${EN_DASH}]`);

// The escaped-unicode-dash check (section 1's "Unicode escape evasion" close): the six-character
// backslash-u escape sequence that spells U+2014/U+2013 in source text, independent of DASH_RE, which
// only matches the literal code point. Built from String.raw + charCodeAt hex so this file's own source
// never contains the literal six-character sequence either (which would otherwise make this file itself
// look like the very evasion it is checking for, to a naive substring scan of test/ by some other tool).
const emHex = (0x2014).toString(16);
const enHex = (0x2013).toString(16);
const ESCAPED_DASH_RE = new RegExp(String.raw`\\u(?:${emHex}|${enHex})`, 'i');

const dashboardJsFiles = walkJs(DASHBOARD_DIR);
const publicFiles = walkAll(PUBLIC_DIR, (name) => name.endsWith('.html') || name.endsWith('.js') || name.endsWith('.css'));
const publicJsFiles = publicFiles.filter((f) => f.endsWith('.js'));

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

  // pr3-spec-decisions.md section 1's stated gap: the design reconciliation's own verification step 5
  // was a manual grep, not an automated assertion. This closes that gap.
  test('no U+2014 or U+2013 anywhere in src/dashboard/public/', () => {
    const hits = publicFiles.filter((f) => DASH_RE.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(hits, []);
  });

  test('no U+2014 or U+2013 in README.md', () => {
    if (!fs.existsSync(README_PATH)) return;
    assert.equal(DASH_RE.test(fs.readFileSync(README_PATH, 'utf8')), false, README_PATH);
  });

  // Independent of DASH_RE: a dash spelled as a six-character \uXXXX escape sequence is a different
  // sequence of ASCII characters and would otherwise pass every literal-code-point check while still
  // rendering an em/en dash at runtime once JS-parsed.
  test('no escaped \\u2014 / \\u2013 sequence anywhere in src/dashboard/public/', () => {
    const hits = publicFiles.filter((f) => ESCAPED_DASH_RE.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(hits, []);
  });

  test('no escaped \\u2014 / \\u2013 sequence in src/dashboard/*.js', () => {
    const hits = dashboardJsFiles.filter((f) => ESCAPED_DASH_RE.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(hits, []);
  });
});

describe('public/: total classification of DOM-writing operations (pr3-spec-decisions.md section 1)', () => {
  test('index.html and the app entry point exist', () => {
    assert.ok(publicFiles.some((f) => f.endsWith('index.html')));
    assert.ok(publicFiles.some((f) => f.endsWith(path.join('public', 'app.js'))));
  });

  test('no innerHTML, insertAdjacentHTML, outerHTML, document.write/writeln, or srcdoc assignment in public/', () => {
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(/\.innerHTML\s*=/.test(text), false, `${f}: innerHTML`);
      assert.equal(text.includes('insertAdjacentHTML'), false, `${f}: insertAdjacentHTML`);
      assert.equal(/\.outerHTML\s*=/.test(text), false, `${f}: outerHTML`);
      assert.equal(text.includes('document.write('), false, `${f}: document.write(`);
      assert.equal(text.includes('document.writeln('), false, `${f}: document.writeln(`);
      assert.equal(/\.srcdoc\s*=/.test(text), false, `${f}: srcdoc`);
    }
  });

  test('no DOMParser or Range.createContextualFragment in public/ (identical HTML-injection primitive to innerHTML)', () => {
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(text.includes('DOMParser'), false, `${f}: DOMParser`);
      assert.equal(text.includes('createContextualFragment'), false, `${f}: createContextualFragment`);
    }
  });

  test('no .style.cssText, no setAttribute("style"/"on*", ...), no inline style= attribute in public/', () => {
    const STYLE_SETATTR_RE = /\.setAttribute\(\s*["']style["']/i;
    const ON_SETATTR_RE = /\.setAttribute\(\s*["']on[a-z]+["']/i;
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(text.includes('.style.cssText'), false, `${f}: style.cssText`);
      assert.equal(STYLE_SETATTR_RE.test(text), false, `${f}: setAttribute("style", ...)`);
      assert.equal(ON_SETATTR_RE.test(text), false, `${f}: setAttribute("on*", ...)`);
      assert.equal(/style\s*=\s*"/.test(text), false, `${f}: inline style=`);
    }
  });

  test('no new Function(...) or eval(...) in public/', () => {
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(text.includes('new Function('), false, `${f}: new Function(`);
      assert.equal(/(?<![.\w])eval\(/.test(text), false, `${f}: eval(`);
    }
  });

  // Independent review comment on PR #6 (second re-review): a native window.prompt() flow is reachable
  // by any automation that can dispatch a keydown/click, exactly like a real drawer, so it is not a
  // usable substitute for the plan's required drawer pattern -- and it is banned outright here, not just
  // discouraged, so a future shortcut cannot silently reintroduce one instead of using
  // components/drawer.js. Negative lookbehind avoids matching `confirmButton(`/`confirm-button.js`,
  // which are unrelated identifiers that happen to contain the substring "confirm".
  test('no window.prompt/confirm/alert (or bare prompt/confirm/alert calls) anywhere in public/', () => {
    const PROMPT_RE = /(?<![.\w])(?:window\.)?prompt\(/;
    const CONFIRM_RE = /(?<![.\w])(?:window\.)?confirm\(/;
    const ALERT_RE = /(?<![.\w])(?:window\.)?alert\(/;
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(PROMPT_RE.test(text), false, `${f}: window.prompt(/prompt(`);
      assert.equal(CONFIRM_RE.test(text), false, `${f}: window.confirm(/confirm(`);
      assert.equal(ALERT_RE.test(text), false, `${f}: window.alert(/alert(`);
    }
  });

  test('no javascript: scheme string literal in public/', () => {
    for (const f of publicFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(/javascript\s*:/i.test(text), false, `${f}: javascript: scheme literal`);
    }
  });

  test('no remote <link href="http, no @import, no remote <script src="http, no on*= attribute in public/*.html', () => {
    const htmlFiles = publicFiles.filter((f) => f.endsWith('.html'));
    for (const f of htmlFiles) {
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(/<link[^>]+href="http/i.test(text), false, `${f}: remote <link href="http`);
      assert.equal(text.includes('@import'), false, `${f}: @import`);
      assert.equal(/<script[^>]+src="http/i.test(text), false, `${f}: remote <script src="http`);
      assert.equal(/\son[a-z]+\s*=/i.test(text), false, `${f}: on*= attribute`);
    }
  });

  test('no @import or remote url(http in public/*.css', () => {
    const cssFiles = publicFiles.filter((f) => f.endsWith('.css'));
    for (const f of cssFiles) {
      const text = fs.readFileSync(f, 'utf8');
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

describe('public/: h()/hSvg()/hSandboxedIframe() stay the only DOM construction path', () => {
  test('lib/dom.js is the only file calling document.createElement or document.createElementNS in public/', () => {
    const domFile = path.join(PUBLIC_DIR, 'lib', 'dom.js');
    for (const f of publicJsFiles) {
      if (f === domFile) continue;
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(text.includes('document.createElement'), false, `${f}: calls document.createElement directly, bypassing h()/hSvg()`);
    }
  });
});
