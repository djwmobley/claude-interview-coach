// @ts-check
/**
 * Repo-wide em-dash / en-dash lint for the prose corpus swept in the "no em-dash" pass
 * (framework/, .claude/skills/, docs/, tools/, root *.md, mcp/job-search/README.md,
 * mcp/job-search/data/*.example.md, memory/ if tracked).
 *
 * Resolves the repo root from this file's own location (mandatory: walking via `git ls-files`
 * from the repo root, not from cwd, means this test behaves identically whether it's invoked
 * from mcp/job-search, the repo root, or a worktree -- and never accidentally walks a worktree
 * or node_modules, since `git ls-files` only ever lists files git itself tracks in that root).
 *
 * Scope filter mirrors the sweep's own scope (item 1 of the binding spec): the listed directory
 * prefixes, root-level *.md files, the two specific mcp/job-search paths, and memory/ if tracked,
 * intersected with the extension whitelist below, with examples/ excluded outright (upstream
 * fictional sample data, left untouched by decision).
 *
 * Failure rule: any U+2014 (em-dash) anywhere in scope fails, no exceptions. Any U+2013 (en-dash)
 * fails UNLESS its left side is a digit and its right side is a digit or the word Present/present
 * (each side optionally separated by a single space) -- the year-range / number-range form, e.g.
 * "2019-2021" or "2019 - 2021", or the resume format's open-ended "2019 - Present" form (real dash
 * characters below, not the literal glyph, to avoid this file itself looking like what it scans
 * for to a naive substring search). The Present/present exemption mirrors render.js's own
 * YEAR_RANGE regex, which already treats a trailing Present the same as a trailing year.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// test/ -> job-search -> mcp -> repo root
const REPO_ROOT = path.join(HERE, '..', '..', '..');

// Built from code points rather than a literal character, consistent with test/dashboard-lint.test.js:
// this file itself must never contain the literal glyph it is scanning for.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

// The digit-digit exemption for en-dash: a real number/year range, spaced or unspaced.
const EN_DASH_NUMBER_RANGE_RE = new RegExp(`\\d\\s?${EN_DASH}\\s?(\\d|present)`, 'i');

const EXTENSIONS = new Set(['.md', '.py', '.js', '.mjs', '.json', '.txt', '.yml', '.yaml']);

/** @param {string} relPath posix-style path relative to REPO_ROOT, as `git ls-files` emits it */
function inScope(relPath) {
  if (relPath.startsWith('examples/')) return false;
  if (relPath.includes('node_modules/')) return false;
  const ext = path.extname(relPath);
  if (!EXTENSIONS.has(ext)) return false;

  if (relPath.startsWith('framework/')) return true;
  if (relPath.startsWith('.claude/skills/')) return true;
  if (relPath.startsWith('docs/')) return true;
  if (relPath.startsWith('tools/')) return true;
  if (relPath.startsWith('memory/')) return true;
  if (relPath === 'mcp/job-search/README.md') return true;
  if (/^mcp\/job-search\/data\/[^/]+\.example\.md$/.test(relPath)) return true;
  // root-level *.md (CLAUDE.md, README.md, etc.): no "/" anywhere in the path
  if (!relPath.includes('/') && ext === '.md') return true;

  return false;
}

/** Every git-tracked path in the repo, as forward-slash-separated paths relative to REPO_ROOT. */
function gitLsFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split(String.fromCharCode(0)).filter(Boolean);
}

const scopedFiles = gitLsFiles().filter(inScope);

/**
 * @param {string} relPath
 * @returns {{file: string, line: number, col: number, char: string}[]}
 */
function findViolations(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  const text = fs.readFileSync(abs, 'utf8');
  /** @type {{file: string, line: number, col: number, char: string}[]} */
  const violations = [];

  let line = 1;
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      line++;
      col = 0;
      continue;
    }
    col++;
    if (ch === EM_DASH) {
      violations.push({ file: relPath, line, col, char: 'U+2014' });
    } else if (ch === EN_DASH) {
      // Window sized to fit the widest exempt right-hand side ("present"/"Present", 7 chars)
      // plus an optional single space, on either side of the dash.
      const windowStart = Math.max(0, i - 2);
      const windowEnd = Math.min(text.length, i + 9);
      const window = text.slice(windowStart, windowEnd);
      if (!EN_DASH_NUMBER_RANGE_RE.test(window)) {
        violations.push({ file: relPath, line, col, char: 'U+2013' });
      }
    }
  }
  return violations;
}

describe('no-em-dash: repo-wide sweep scope', () => {
  test('scoped-file discovery examined at least 50 files (cannot pass trivially on an empty scope)', () => {
    assert.ok(
      scopedFiles.length >= 50,
      `expected at least 50 scoped files, found ${scopedFiles.length}`
    );
  });

  test('no U+2014 (em-dash) anywhere in scope, and no U+2013 (en-dash) outside a digit-digit range', () => {
    /** @type {string[]} */
    const messages = [];
    for (const relPath of scopedFiles) {
      for (const v of findViolations(relPath)) {
        messages.push(`${v.file}:${v.line}:${v.col}: unexpected ${v.char}`);
      }
    }
    assert.deepEqual(messages, []);
  });

  test('examples/ is excluded from scope even though it is git-tracked', () => {
    const allTracked = gitLsFiles();
    const trackedExamples = allTracked.filter((f) => f.startsWith('examples/'));
    // Sanity: examples/ actually exists and is tracked, otherwise this exclusion is untested.
    assert.ok(trackedExamples.length > 0, 'expected examples/ to contain tracked files');
    const scopedExamples = scopedFiles.filter((f) => f.startsWith('examples/'));
    assert.deepEqual(scopedExamples, []);
  });
});

describe('no-em-dash: en-dash number-range exemption regex (fixture-free)', () => {
  test('matches an unspaced year range', () => {
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`2019${EN_DASH}2021`));
  });

  test('matches a spaced year range', () => {
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`2019 ${EN_DASH} 2021`));
  });

  test('matches a single-space-only-on-one-side year range', () => {
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`2019${EN_DASH} 2021`));
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`2019 ${EN_DASH}2021`));
  });

  test('matches a short numeric range embedded in prose', () => {
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`read the 3${EN_DASH}6 most relevant projects`));
  });

  // The resume format's open-ended "Year - Present" notation (render.js's own YEAR_RANGE
  // regex already treats a trailing Present/present the same as a trailing year).
  test('matches a digit followed by "Present" (capitalized)', () => {
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`2019 ${EN_DASH} Present`));
  });

  test('matches a digit followed by "present" (lowercase)', () => {
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`2019 ${EN_DASH} present`));
  });

  test('matches an unspaced year range (explicit "2019-2021" case)', () => {
    assert.ok(EN_DASH_NUMBER_RANGE_RE.test(`2019${EN_DASH}2021`));
  });

  test('does NOT match a sentence-break en-dash (no digit on either side)', () => {
    assert.equal(EN_DASH_NUMBER_RANGE_RE.test(`the plan works ${EN_DASH} mostly`), false);
  });

  test('does NOT match a dash between two ordinary words (e.g. "word - word")', () => {
    assert.equal(EN_DASH_NUMBER_RANGE_RE.test(`word ${EN_DASH} word`), false);
  });

  test('does NOT match a dash between a non-digit label and a digit (e.g. "Year - 2021")', () => {
    assert.equal(EN_DASH_NUMBER_RANGE_RE.test(`Year ${EN_DASH} 2021`), false);
  });
});
