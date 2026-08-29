// @ts-check
/**
 * Structural verification of the real-DOCX-output path (renderer fix,
 * spec Slice 1 + amendments A4/A6). Renders the existing, de-identified
 * `test/fixtures/render/clean-resume.md` fixture (never edited by this
 * file) through the real `tools/md_to_docx.py` converter into a temp
 * directory under os.tmpdir() (never output/), unzips the result with
 * `test/helpers/unzip.js`, and inspects document.xml / styles.xml
 * directly. Skips cleanly, not failing, if python-docx is not importable
 * in this environment.
 *
 * Two assertions from the base spec turned out to be unverifiable as
 * literally worded once checked against real python-docx output and real
 * fixture content; both are called out inline where they diverge:
 *
 *  (a) "zero U+00B7 in document.xml" would false-fail on this very fixture:
 *      the header contact line and the competencies line both use the
 *      middle dot as a prose separator (e.g. "Austin, TX · (512) ..."),
 *      which is legitimate content, not a rendered bullet. The real
 *      assertion is "no List-Bullet-styled paragraph's own text still
 *      starts with the glyph" -- i.e. every actual bullet was converted,
 *      while prose elsewhere is left alone.
 *  (b)/(f) "<w:numPr> count in document.xml equals the bullet count" does
 *      not hold: verified empirically that `doc.add_paragraph(style="List
 *      Bullet")` records numbering only in the STYLE's own pPr (styles.xml),
 *      never copied into each paragraph's own pPr in document.xml. The
 *      per-paragraph signal actually present in document.xml is
 *      `w:pStyle w:val="ListBullet"`, so that is what is counted instead.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZipEntryText } from './helpers/unzip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'render', 'clean-resume.md');
const MD_TO_DOCX = path.join(ROOT, 'tools', 'md_to_docx.py');
const CHEATSHEET_TO_DOCX = path.join(ROOT, 'tools', 'cheatsheet_to_docx.py');

let pythonDocxAvailable = false;
let tmpDir = '';

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-output-test-'));
  try {
    execFileSync('python', ['-c', 'import docx'], { stdio: 'ignore', windowsHide: true });
    pythonDocxAvailable = true;
  } catch {
    pythonDocxAvailable = false;
  }
});

/** @param {string} script @param {string} mdPath @param {string} docxPath */
function renderTo(script, mdPath, docxPath) {
  execFileSync('python', [script, mdPath, docxPath], { cwd: ROOT, windowsHide: true, stdio: 'pipe' });
}

/**
 * Regex-based `<w:p>` walker. Sufficient here: these converters never emit
 * tables, nested paragraphs, or anything else that would confuse a
 * non-nesting `<w:p>...</w:p>` scan.
 * @param {string} documentXml
 */
function extractParagraphs(documentXml) {
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const paras = [];
  let m;
  while ((m = paraRe.exec(documentXml))) {
    const body = m[1];
    const keepNext = /<w:keepNext\s*\/>/.test(body);
    const keepLines = /<w:keepLines\s*\/>/.test(body);
    const pStyleMatch = body.match(/<w:pStyle w:val="([^"]+)"\s*\/>/);
    const text = [...body.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('');
    paras.push({ text, keepNext, keepLines, pStyle: pStyleMatch ? pStyleMatch[1] : null });
  }
  return paras;
}

/** @param {string[]} lines */
function joinContinuations(lines) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith('  ') && out.length && out[out.length - 1].trim()) {
      out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '') + ' ' + line.trim();
    } else {
      out.push(line);
    }
  }
  return out;
}

/** @param {string[]} lines */
function splitByDividers(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === '---') {
      blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

/**
 * Re-implements md_to_docx.py's render_body() decision tree plus the A4
 * PageState rule, independently of the Python converter, to predict each
 * emitted body paragraph's keepNext value (assertion (e)). Scoped to
 * blocks 3+ only, matching the spec's "over blocks 3+ of the fixture".
 * @param {string} mdText
 */
function simulateBodyKeepNext(mdText) {
  const rawLines = mdText.replace(/\r\n/g, '\n').split('\n');
  const joined = joinContinuations(rawLines);
  const blocks = splitByDividers(joined);
  const bodyBlocks = blocks.slice(3);
  // By the time render_body runs for real, render_summary/render_competencies
  // have already called add_section_heading twice with zero bullets in
  // between -- seed the same precondition rather than starting fresh.
  const state = { seenHeading: true, bulletsSinceHeading: 0 };
  /** @type {{ type: string, text: string, keepNext: boolean }[]} */
  const emitted = [];
  const closeLast = () => {
    if (emitted.length) emitted[emitted.length - 1].keepNext = false;
  };
  for (const block of bodyBlocks) {
    const lines = block.map((l) => l.replace(/\s+$/, ''));
    const nextNonBlank = (i) => {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      return j < lines.length ? lines[j].trim() : '';
    };
    const prevNonBlank = (i) => {
      let k = i - 1;
      while (k >= 0 && !lines[k].trim()) k--;
      return k >= 0 ? lines[k].trim() : '';
    };
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      if (!text) continue;
      if (/^[A-Z\s]+$/.test(text) && text.length > 3) {
        if (!state.seenHeading || state.bulletsSinceHeading > 0) closeLast();
        state.seenHeading = true;
        state.bulletsSinceHeading = 0;
        emitted.push({ type: 'heading', text, keepNext: true });
        continue;
      }
      if (text.startsWith('·')) {
        emitted.push({ type: 'bullet', text, keepNext: true });
        state.bulletsSinceHeading += 1;
        continue;
      }
      if (text.includes('|')) {
        emitted.push({ type: 'company', text, keepNext: true });
        continue;
      }
      if (nextNonBlank(i).includes('|')) {
        closeLast(); // add_role_title always closes the previous chain first
        emitted.push({ type: 'role-title', text, keepNext: true });
        continue;
      }
      if (prevNonBlank(i).includes('|')) {
        emitted.push({ type: 'description', text, keepNext: true });
        continue;
      }
      emitted.push({ type: 'plain', text, keepNext: false });
    }
  }
  closeLast(); // final close_block(doc) before doc.save
  return emitted;
}

describe('docx-output: real bullets, uniform 10pt sizing, EDUCATION/CERTIFICATIONS pagination', () => {
  test('resume: List Bullet paragraphs, single explicit run size, keepNext mask matches an independent JS simulation', (t) => {
    if (!pythonDocxAvailable) {
      t.skip('python-docx not importable in this environment');
      return;
    }

    const outPath = path.join(tmpDir, 'clean-resume.docx');
    renderTo(MD_TO_DOCX, FIXTURE, outPath);
    const buf = fs.readFileSync(outPath);
    const documentXml = readZipEntryText(buf, 'word/document.xml');
    const stylesXml = readZipEntryText(buf, 'word/styles.xml');
    const mdText = fs.readFileSync(FIXTURE, 'utf8');

    const bulletLineCount = mdText
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((l) => l.trim().startsWith('·')).length;

    const allParas = extractParagraphs(documentXml);
    const bulletParas = allParas.filter((p) => p.pStyle === 'ListBullet');

    // (a)/(b) adjusted: see file header. Every source bullet line became a
    // List-Bullet-styled paragraph with the glyph stripped; numbering lives
    // in the style, not per paragraph.
    assert.equal(bulletParas.length, bulletLineCount, 'one List Bullet paragraph per source bullet line');
    for (const p of bulletParas) {
      assert.ok(!p.text.trimStart().startsWith('·'), `bullet paragraph still carries the glyph: ${JSON.stringify(p.text)}`);
    }
    assert.equal((documentXml.match(/<w:numPr>/g) || []).length, 0, 'numbering lives in the List Bullet style, not per paragraph');

    // (c) every explicit w:sz is 36 (18pt, the name) and appears once
    const szValues = [...documentXml.matchAll(/<w:sz w:val="(\d+)"\s*\/>/g)].map((m) => m[1]);
    assert.deepEqual(szValues, ['36'], 'the only explicit run size left in document.xml is the 18pt name');

    // (d) Normal is 10pt (sz 20) with eastAsia/cs Calibri; List Bullet has no contextualSpacing
    const normalBlock = stylesXml.match(/<w:style [^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/);
    assert.ok(normalBlock, 'Normal style present in styles.xml');
    assert.match(normalBlock[0], /<w:sz w:val="20"\s*\/>/, 'Normal is 10pt (sz 20)');
    assert.match(normalBlock[0], /w:eastAsia="Calibri"/, 'Normal rFonts eastAsia is Calibri');
    assert.match(normalBlock[0], /w:cs="Calibri"/, 'Normal rFonts cs is Calibri');
    const listBulletBlock = stylesXml.match(/<w:style [^>]*w:styleId="ListBullet"[\s\S]*?<\/w:style>/);
    assert.ok(listBulletBlock, 'List Bullet style present in styles.xml');
    assert.ok(!listBulletBlock[0].includes('contextualSpacing'), 'List Bullet style carries no contextualSpacing');

    // (e) rebuild the classifier in JS over blocks 3+ and assert the keepNext
    // mask paragraph by paragraph
    const expected = simulateBodyKeepNext(mdText);
    const startIdx = allParas.findIndex((p) => p.text.trim() === 'EXPERIENCE');
    assert.ok(startIdx >= 0, 'EXPERIENCE heading paragraph found in the rendered document');
    const actualBody = allParas.slice(startIdx, startIdx + expected.length);
    assert.equal(actualBody.length, expected.length, 'simulated and actual body paragraph counts match');
    expected.forEach((exp, i) => {
      assert.equal(actualBody[i].keepNext, exp.keepNext, `paragraph ${i} (${exp.type} ${JSON.stringify(exp.text.slice(0, 40))}) keepNext mismatch`);
    });

    // Named spot checks for the two behaviors the spec called out by name.
    const eduIdx = expected.findIndex((e) => e.text === 'EDUCATION');
    const certIdx = expected.findIndex((e) => e.text === 'CERTIFICATIONS');
    assert.ok(eduIdx > 0 && certIdx > eduIdx, 'EDUCATION and CERTIFICATIONS both found in order');
    assert.equal(expected[certIdx - 1].keepNext, true, 'EDUCATION content stays chained through into CERTIFICATIONS (no bullets in EDUCATION)');
    assert.equal(expected[eduIdx - 1].keepNext, false, "EXPERIENCE's last bullet releases the chain before EDUCATION");
    assert.equal(expected[expected.length - 1].keepNext, false, 'the last paragraph in the document never keeps with a nonexistent next paragraph');

    // (f) adjusted: every List Bullet paragraph also carries keepLines
    for (const p of bulletParas) {
      assert.ok(p.keepLines, `bullet paragraph missing keepLines: ${JSON.stringify(p.text)}`);
    }
  });

  test('cheatsheet: dash bullets become real List Bullet paragraphs with no leftover glyph', (t) => {
    if (!pythonDocxAvailable) {
      t.skip('python-docx not importable in this environment');
      return;
    }

    const mdPath = path.join(tmpDir, 'cheatsheet-fixture.md');
    fs.writeFileSync(
      mdPath,
      ['# Cheat Sheet', '', '## Key Points', '- First point about the role', "- Second point, **bolded** for emphasis", '- Third point', ''].join('\n'),
      'utf8',
    );
    const outPath = path.join(tmpDir, 'cheatsheet-fixture.docx');
    renderTo(CHEATSHEET_TO_DOCX, mdPath, outPath);
    const buf = fs.readFileSync(outPath);
    const documentXml = readZipEntryText(buf, 'word/document.xml');
    const stylesXml = readZipEntryText(buf, 'word/styles.xml');

    const bulletParas = extractParagraphs(documentXml).filter((p) => p.pStyle === 'ListBullet');
    assert.equal(bulletParas.length, 3, 'one List Bullet paragraph per source bullet line');
    for (const p of bulletParas) {
      assert.ok(!p.text.trimStart().startsWith('·'), `bullet paragraph still carries the old glyph: ${JSON.stringify(p.text)}`);
      assert.ok(!p.text.trimStart().startsWith('-'), `bullet paragraph still carries a literal dash: ${JSON.stringify(p.text)}`);
    }
    assert.equal((documentXml.match(/<w:numPr>/g) || []).length, 0, 'numbering lives in the List Bullet style, not per paragraph (cheatsheet)');
    const listBulletBlock = stylesXml.match(/<w:style [^>]*w:styleId="ListBullet"[\s\S]*?<\/w:style>/);
    assert.ok(listBulletBlock, 'List Bullet style present in the cheatsheet document');
    assert.ok(!listBulletBlock[0].includes('contextualSpacing'), 'cheatsheet List Bullet style carries no contextualSpacing');
  });
});
