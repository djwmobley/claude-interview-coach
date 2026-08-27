// @ts-check
/**
 * render_doc preflight: one fixture per check that fails it, one clean
 * fixture (copy of output/markdown/20260302-default-cto.md) that passes,
 * lock detection, and a render through a stubbed execFile (no Python).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight, renderDoc, detectLocked, checkOutputName, loadStyleConfig, readProjectIndexCompanies, resolveSource } from '../src/core/render.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(HERE, 'fixtures', 'render', 'clean-resume.md');
const EM = '\u2014';
const EN = '\u2013';

/** A temp repo root with tools/, data/project-index.md, and fixtures we mutate. */
let root = '';
const style = loadStyleConfig();
const companies = ['Northwind Advisory', 'VitalCore', 'Beacon Trading Academy', 'Lumaire Global', 'Verdalux', 'Jenkon'];

/** @param {string} name @param {string} text */
function fixture(name, text) {
  const p = path.join(root, 'fx', name);
  fs.writeFileSync(p, text, 'utf8');
  return path.join('fx', name);
}

/** @param {string} name */
function failing(checks, name) {
  const c = checks.find((x) => x.name === name);
  assert.ok(c, `check ${name} present`);
  return c;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-test-'));
  fs.mkdirSync(path.join(root, 'fx'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'tools', 'md_to_docx.py'), '# stub\n');
  fs.writeFileSync(path.join(root, 'tools', 'cover_letter_to_docx.py'), '# stub\n');
  fs.writeFileSync(path.join(root, 'tools', 'cheatsheet_to_docx.py'), '# stub\n');
  fs.writeFileSync(path.join(root, 'data', 'project-index.md'), companies.map((c) => `## x.md\n- **Client:** ${c}\n`).join('\n'));
  fs.copyFileSync(CLEAN, path.join(root, 'fx', 'clean.md'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// Normalize CRLF so the \n-based mutations below work in an autocrlf checkout too.
const clean = () => fs.readFileSync(CLEAN, 'utf8').replace(/\r\n/g, '\n');

describe('render_doc preflight', () => {
  test('clean resume passes every applicable check (Northwind Advisory omitted by explicit approval)', () => {
    const r = preflight({ kind: 'resume', source: 'fx/clean.md', outName: 'Jordan Reyes - CTO', allowMissing: ['Northwind Advisory'] }, { root, style });
    const fails = r.checks.filter((c) => c.result === 'fail');
    assert.deepEqual(fails, [], JSON.stringify(fails));
    assert.equal(r.ok, true);
    assert.equal(r.checks.length, 10);
    for (const c of r.checks) assert.ok(['pass', 'fail', 'not-applicable'].includes(c.result));
  });

  test('role inclusion fails without approval and names the missing role', () => {
    const r = preflight({ kind: 'resume', source: 'fx/clean.md', outName: 'Jordan Reyes - CTO' }, { root, style });
    const c = failing(r.checks, 'role_inclusion');
    assert.equal(c.result, 'fail');
    assert.match(String(c.detail), /Northwind Advisory/);
    assert.equal(r.ok, false);
  });

  test('real data/project-index.md parses company names', () => {
    const real = readProjectIndexCompanies();
    if (real === null) return; // data/ is gitignored; absent on a fresh clone
    assert.ok(real.includes('Jenkon'));
    assert.ok(real.includes('Immunotec'));
  });

  test('em-dash anywhere fails with line numbers', () => {
    const src = fixture('em.md', clean().replace('Technology executive', `Technology executive ${EM} yes`));
    const r = preflight({ kind: 'resume', source: src, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style });
    const c = failing(r.checks, 'em_dash');
    assert.equal(c.result, 'fail');
    assert.deepEqual(c.lines, [8]);
  });

  test('en-dash outside a Year - Year range fails; the company line range passes', () => {
    const src = fixture('en.md', clean().replace('board level', `board ${EN} level`));
    const r = preflight({ kind: 'resume', source: src, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style });
    const c = failing(r.checks, 'en_dash');
    assert.equal(c.result, 'fail');
    assert.equal(c.lines.length, 1);
  });

  test('scare quotes: a single quoted word fails; a quoted phrase does not', () => {
    const bad = fixture('sq.md', clean().replace('board level', 'board "alignment" level'));
    const r = preflight({ kind: 'resume', source: bad, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style });
    assert.equal(failing(r.checks, 'scare_quotes').result, 'fail');
    const curly = fixture('sq2.md', clean().replace('board level', 'board \u201Coverseeing\u201D level'));
    assert.equal(failing(preflight({ kind: 'resume', source: curly, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'scare_quotes').result, 'fail');
    const phrase = fixture('sq3.md', clean().replace('board level', 'board "two words" level'));
    assert.equal(failing(preflight({ kind: 'resume', source: phrase, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'scare_quotes').result, 'pass');
  });

  test('buzzwords from config fail with the word named', () => {
    const src = fixture('bz.md', clean().replace('Took over', 'Spearheaded and leveraged'));
    const c = failing(preflight({ kind: 'resume', source: src, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'buzzwords');
    assert.equal(c.result, 'fail');
    assert.match(String(c.detail), /spearheaded/);
    assert.match(String(c.detail), /leveraged/);
  });

  test('problem-comparison reframe fails', () => {
    const src = fixture('pc.md', clean().replace('Technology executive', 'This is not a technology problem. It is a leadership problem. Technology executive'));
    const c = failing(preflight({ kind: 'resume', source: src, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'problem_comparison');
    assert.equal(c.result, 'fail');
    assert.deepEqual(c.lines, [8]);
  });

  test('resume structure: # in name line, ## in summary, - bullets, comma in role title, table rows', () => {
    const cases = [
      ['name-hash', (t) => t.replace(/^Jordan Reyes/, '# Jordan Reyes'), /name line/],
      ['summary-heading', (t) => t.replace('Technology executive', '## Summary\nTechnology executive'), /block 1/],
      ['dash-bullets', (t) => t.replace('· Took over', '- Took over'), /middle dot/],
      ['title-comma', (t) => t.replace('Chief Technology Officer\nVitalCore', 'Chief Technology Officer, Global\nVitalCore'), /commas in role titles/],
      ['table', (t) => t.replace('EXPERIENCE', 'EXPERIENCE\n| a | b |\n|---|---|'), /tables/],
      ['no-tagline-pipes', (t) => t.replace('Chief Technology Officer | AI & Digital Transformation | Global Commerce & Payments', 'Chief Technology Officer'), /tagline/],
    ];
    for (const [name, mutate, re] of cases) {
      const src = fixture(`st-${name}.md`, /** @type {(t: string) => string} */ (mutate)(clean()));
      const c = failing(preflight({ kind: 'resume', source: src, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'resume_structure');
      assert.equal(c.result, 'fail', name);
      assert.match(String(c.detail), re, name);
      assert.ok(c.lines.length > 0, name);
    }
  });

  test('PMP wording: Lapsed or a variant fails; exact string passes; N/A when absent', () => {
    const lapsed = fixture('pmp1.md', clean().replace('PMP (Expired 2017), Project Management Institute', 'PMP (Lapsed 2017), Project Management Institute'));
    assert.equal(failing(preflight({ kind: 'resume', source: lapsed, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'pmp_wording').result, 'fail');
    const variant = fixture('pmp2.md', clean().replace('PMP (Expired 2017), Project Management Institute', 'PMP, Project Management Institute (expired)'));
    assert.equal(failing(preflight({ kind: 'resume', source: variant, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'pmp_wording').result, 'fail');
    const none = fixture('pmp3.md', 'Hello\nno cert here\n');
    assert.equal(failing(preflight({ kind: 'cheatsheet', source: none }, { root, style }).checks, 'pmp_wording').result, 'not-applicable');
  });

  test('Jenkon title: comma form fails; PMO form fails; correct passes', () => {
    const comma = fixture('jk1.md', clean().replace('Director of Program Management\nJenkon', 'Director, Program Management Office\nJenkon'));
    const c = failing(preflight({ kind: 'resume', source: comma, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'jenkon_title');
    assert.equal(c.result, 'fail');
    const pmo = fixture('jk2.md', clean().replace('Director of Program Management\nJenkon', 'Director of PMO\nJenkon'));
    assert.equal(failing(preflight({ kind: 'resume', source: pmo, outName: 'N', allowMissing: ['Northwind Advisory'] }, { root, style }).checks, 'jenkon_title').result, 'fail');
  });

  test('output naming: outName required for outward kinds; datestamps refused; cheatsheet may default', () => {
    assert.equal(checkOutputName('resume', undefined, '20260302-default-cto').result, 'fail');
    assert.equal(checkOutputName('resume', '20260302-default-cto', 'x').result, 'fail');
    assert.equal(checkOutputName('cover_letter', 'Jordan Reyes - 2026-08-24', 'x').result, 'fail');
    assert.equal(checkOutputName('resume', 'Jordan Reyes - CTO.docx', 'x').result, 'fail');
    assert.equal(checkOutputName('resume', 'bad/name', 'x').result, 'fail');
    assert.equal(checkOutputName('resume', 'Jordan Reyes - CTO', 'x').result, 'pass');
    assert.equal(checkOutputName('cheatsheet', undefined, '20260303-baker-tilly-cheatsheet').result, 'pass');
    assert.equal(checkOutputName('cheatsheet', 'Baker Tilly cheat sheet', 'x').result, 'pass');
  });

  test('non-resume kinds skip structure and role inclusion (not-applicable), still run lexical checks', () => {
    const src = fixture('cl.md', `Jordan Reyes\nHouston\n\nAugust 2026\n\nDear team,\n\nI leveraged nothing ${EM} really.\n\nJordan`);
    const r = preflight({ kind: 'cover_letter', source: src, outName: 'Jordan Reyes - Cover Letter' }, { root, style });
    assert.equal(failing(r.checks, 'resume_structure').result, 'not-applicable');
    assert.equal(failing(r.checks, 'role_inclusion').result, 'not-applicable');
    assert.equal(failing(r.checks, 'em_dash').result, 'fail');
    assert.equal(failing(r.checks, 'buzzwords').result, 'fail');
  });

  test('source path is validated: absolute, escaping, wrong extension, missing', () => {
    assert.throws(() => resolveSource('C:/x.md', 'resume', root), /repo-relative/);
    assert.throws(() => resolveSource('../x.md', 'resume', root), /inside the repo/);
    assert.throws(() => resolveSource('fx/clean.txt', 'resume', root), /must be one of/);
    assert.throws(() => resolveSource('fx/nope.md', 'resume', root), /not found/);
    assert.throws(() => resolveSource('fx/clean.md', 'poster', root), /kind must be/);
  });
});

describe('render_doc rendering', () => {
  test('checkOnly returns checks without touching the converter', async () => {
    let called = 0;
    const r = await renderDoc({ kind: 'resume', source: 'fx/clean.md', outName: 'Jordan Reyes - CTO', checkOnly: true, allowMissing: ['Northwind Advisory'] }, { root, style, execFile: /** @type {any} */ (async () => { called++; }) });
    assert.equal(r.ok, true);
    assert.equal(called, 0);
    assert.equal(r.output_path, undefined);
  });

  test('preflight failure blocks rendering', async () => {
    let called = 0;
    const r = await renderDoc({ kind: 'resume', source: 'fx/clean.md', outName: 'Jordan Reyes - CTO' }, { root, style, execFile: /** @type {any} */ (async () => { called++; }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PREFLIGHT_FAILED');
    assert.equal(called, 0);
  });

  test('render calls the converter with file-path args only and reports bytes and output_path', async () => {
    /** @type {any[]} */
    const calls = [];
    const exec = async (/** @type {string} */ cmd, /** @type {string[]} */ args) => {
      calls.push({ cmd, args });
      fs.writeFileSync(args[2], Buffer.alloc(1234));
      return { stdout: '', stderr: '' };
    };
    const r = await renderDoc({ kind: 'resume', source: 'fx/clean.md', outName: 'Jordan Reyes - CTO', allowMissing: ['Northwind Advisory'] }, { root, style, execFile: /** @type {any} */ (exec) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.bytes, 1234);
    assert.equal(r.output_path, path.join('output', 'resumes', 'Jordan Reyes - CTO.docx'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'python');
    assert.equal(calls[0].args.length, 3);
    assert.ok(calls[0].args[0].endsWith('md_to_docx.py'));
    assert.ok(path.isAbsolute(calls[0].args[1]) && path.isAbsolute(calls[0].args[2]));
    // Second render without force refuses to overwrite.
    const again = await renderDoc({ kind: 'resume', source: 'fx/clean.md', outName: 'Jordan Reyes - CTO', allowMissing: ['Northwind Advisory'] }, { root, style, execFile: /** @type {any} */ (exec) });
    assert.equal(again.code, 'EXISTS');
    const forced = await renderDoc({ kind: 'resume', source: 'fx/clean.md', outName: 'Jordan Reyes - CTO', allowMissing: ['Northwind Advisory'], force: true }, { root, style, execFile: /** @type {any} */ (exec) });
    assert.equal(forced.ok, true);
  });

  test('LOCKED: Word owner file beside the target blocks regeneration', async () => {
    const outDir = path.join(root, 'output', 'coverletters');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'Jordan Reyes - Cover.docx'), 'x');
    fs.writeFileSync(path.join(outDir, '~$rdan Reyes - Cover.docx'), 'lock');
    const src = fixture('cl-ok.txt', 'Jordan Reyes\nHouston\n\nAugust 2026\n\nDear team,\n\nHello.\n\nJordan');
    let called = 0;
    const r = await renderDoc({ kind: 'cover_letter', source: src, outName: 'Jordan Reyes - Cover', force: true }, { root, style, execFile: /** @type {any} */ (async () => { called++; }) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'LOCKED');
    assert.equal(called, 0);
    assert.equal(detectLocked(path.join(outDir, 'nothing.docx')).locked, false);
  });

  test('LOCKED: an exclusively held file is detected on Windows', async () => {
    const outDir = path.join(root, 'output', 'cheatsheets');
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, 'held.docx');
    fs.writeFileSync(target, 'x');
    if (process.platform !== 'win32') return;
    // Simulate Word's share lock with a child process holding the file open exclusively.
    const { spawn } = await import('node:child_process');
    const ps = spawn('powershell', ['-NoProfile', '-Command', `$f=[System.IO.File]::Open('${target.replace(/'/g, "''")}','Open','ReadWrite','None'); Start-Sleep -Seconds 6; $f.Close()`], { stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const d = detectLocked(target);
      assert.equal(d.locked, true, d.reason);
    } finally {
      ps.kill();
    }
  });

  test('converter failure surfaces as RENDER_FAILED with stderr tail', async () => {
    const exec = async () => {
      const e = /** @type {any} */ (new Error('exit 1'));
      e.stderr = 'Traceback: boom';
      throw e;
    };
    const src = fixture('cs.md', '# Cheat sheet\n\nPlain content.\n');
    const r = await renderDoc({ kind: 'cheatsheet', source: src, outName: 'Sheet' }, { root, style, execFile: /** @type {any} */ (exec) });
    assert.equal(r.code, 'RENDER_FAILED');
    assert.match(String(r.message), /boom/);
  });
});
