// @ts-check
/**
 * Verifies tools/docx_metadata.py's apply_document_metadata() fix-up ran
 * for all three DOCX writers (tools/md_to_docx.py, tools/cheatsheet_to_docx.py,
 * tools/cover_letter_to_docx.py). Renders a minimal fixture through each
 * writer with the real python-docx library (skips cleanly, not failing, if
 * python-docx is not importable in this environment, matching
 * docx-output.test.js's convention) and inspects docProps/core.xml and
 * docProps/app.xml directly via the shared ZIP reader.
 *
 * The cheat sheet and cover letter writers resolve their author name from
 * "data/profile.md" relative to the process cwd (mirrors how
 * mcp/job-search/src/core/render.js invokes them: cwd is always repo root
 * in production). Rather than depending on the repo's real, gitignored
 * data/profile.md (which does not exist in a fresh worktree and must not
 * be mutated by a test), each test that needs it runs the writer with cwd
 * pointed at an isolated temp directory containing its own throwaway
 * data/profile.md fixture.
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
const MD_TO_DOCX = path.join(ROOT, 'tools', 'md_to_docx.py');
const CHEATSHEET_TO_DOCX = path.join(ROOT, 'tools', 'cheatsheet_to_docx.py');
const COVER_LETTER_TO_DOCX = path.join(ROOT, 'tools', 'cover_letter_to_docx.py');

const TELL_PATTERN = /python[- ]?docx/i;

let pythonDocxAvailable = false;
let tmpDir = '';

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-metadata-test-'));
  try {
    execFileSync('python', ['-c', 'import docx'], { stdio: 'ignore', windowsHide: true });
    pythonDocxAvailable = true;
  } catch {
    pythonDocxAvailable = false;
  }
});

/**
 * @param {string} script
 * @param {string[]} args
 * @param {string} cwd
 */
function renderTo(script, args, cwd) {
  execFileSync('python', [script, ...args], { cwd, windowsHide: true, stdio: 'pipe' });
}

/**
 * Asserts the metadata fix-up landed on a rendered .docx buffer.
 * @param {Buffer} buf
 * @param {string} expectedAuthor
 */
function assertMetadataFixedUp(buf, expectedAuthor) {
  const coreXml = readZipEntryText(buf, 'docProps/core.xml');
  const appXml = readZipEntryText(buf, 'docProps/app.xml');

  assert.match(coreXml, /<dc:creator>([^<]*)<\/dc:creator>/, 'core.xml has a creator element');
  const creator = coreXml.match(/<dc:creator>([^<]*)<\/dc:creator>/)[1];
  assert.equal(creator, expectedAuthor, 'core.xml author matches the resolved candidate name');

  const lastModifiedBy = coreXml.match(/<cp:lastModifiedBy>([^<]*)<\/cp:lastModifiedBy>/);
  assert.ok(lastModifiedBy, 'core.xml has a non-empty lastModifiedBy element');
  assert.equal(lastModifiedBy[1], expectedAuthor, 'core.xml lastModifiedBy matches the resolved candidate name');

  const now = Date.now();
  for (const field of ['created', 'modified']) {
    const re = new RegExp(`<dcterms:${field}[^>]*>([^<]*)</dcterms:${field}>`);
    const m = coreXml.match(re);
    assert.ok(m, `core.xml has a ${field} element`);
    const stamped = Date.parse(m[1]);
    assert.ok(Number.isFinite(stamped), `core.xml ${field} value parses as a date`);
    assert.ok(Math.abs(now - stamped) <= 60_000, `core.xml ${field} is within 60 seconds of now (got ${m[1]})`);
  }

  assert.match(appXml, /<Application>Microsoft Office Word<\/Application>/, 'app.xml Application field reads Microsoft Office Word');

  assert.doesNotMatch(coreXml, TELL_PATTERN, 'docProps/core.xml carries no python-docx fingerprint');
  assert.doesNotMatch(appXml, TELL_PATTERN, 'docProps/app.xml carries no python-docx fingerprint');
}

describe('docx metadata fix-up: author, timestamps, and no generator fingerprint', () => {
  test('resume (md_to_docx.py): author resolved from the block-0 header name line', (t) => {
    if (!pythonDocxAvailable) {
      t.skip('python-docx not importable in this environment');
      return;
    }
    const mdPath = path.join(tmpDir, 'resume-fixture.md');
    fs.writeFileSync(
      mdPath,
      [
        'Jordan Reyes',
        'Austin, TX | jordan.reyes@example.test',
        'Chief Technology Officer',
        '---',
        'Results-driven executive.',
        '---',
        'Cloud Architecture · Platform Engineering',
        '---',
        'EXPERIENCE',
        '',
        'Chief Technology Officer',
        'Example Corp | Austin, TX | 2020 - Present',
        'Global logistics platform.',
        '· Led a cloud migration.',
        '',
      ].join('\n'),
      'utf8',
    );
    const outPath = path.join(tmpDir, 'resume-fixture.docx');
    renderTo(MD_TO_DOCX, [mdPath, outPath], ROOT);
    const buf = fs.readFileSync(outPath);
    assertMetadataFixedUp(buf, 'Jordan Reyes');
  });

  test('cheat sheet (cheatsheet_to_docx.py): author resolved from data/profile.md', (t) => {
    if (!pythonDocxAvailable) {
      t.skip('python-docx not importable in this environment');
      return;
    }
    const profileCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-metadata-profile-'));
    fs.mkdirSync(path.join(profileCwd, 'data'), { recursive: true });
    fs.writeFileSync(path.join(profileCwd, 'data', 'profile.md'), '# Profile\n\n- **Name:** Taylor Fixture\n- **Title:** VP Engineering\n', 'utf8');

    const mdPath = path.join(tmpDir, 'cheatsheet-fixture.md');
    fs.writeFileSync(mdPath, ['# Cheat Sheet', '', '## Key Points', '- First point', '- Second point', ''].join('\n'), 'utf8');
    const outPath = path.join(tmpDir, 'cheatsheet-fixture.docx');
    renderTo(CHEATSHEET_TO_DOCX, [mdPath, outPath], profileCwd);
    const buf = fs.readFileSync(outPath);
    assertMetadataFixedUp(buf, 'Taylor Fixture');
  });

  test('cover letter (cover_letter_to_docx.py): author resolved from data/profile.md', (t) => {
    if (!pythonDocxAvailable) {
      t.skip('python-docx not importable in this environment');
      return;
    }
    const profileCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-metadata-profile-'));
    fs.mkdirSync(path.join(profileCwd, 'data'), { recursive: true });
    fs.writeFileSync(path.join(profileCwd, 'data', 'profile.md'), '# Profile\n\n- **Name:** Taylor Fixture\n- **Title:** VP Engineering\n', 'utf8');

    const txtPath = path.join(tmpDir, 'cover-letter-fixture.txt');
    fs.writeFileSync(
      txtPath,
      [
        'Taylor Fixture',
        'taylor@example.test | (555) 987-6543',
        '',
        'September 16, 2026',
        '',
        'Hiring Manager',
        'Example Corp',
        '',
        'Re: VP Engineering role',
        '',
        'I am excited to apply for this role given my background in platform engineering.',
        '',
        'Taylor Fixture',
        '',
      ].join('\n'),
      'utf8',
    );
    const outPath = path.join(tmpDir, 'cover-letter-fixture.docx');
    renderTo(COVER_LETTER_TO_DOCX, [txtPath, outPath], profileCwd);
    const buf = fs.readFileSync(outPath);
    assertMetadataFixedUp(buf, 'Taylor Fixture');
  });

  test('cheat sheet: missing data/profile.md fails loudly instead of falling back silently', (t) => {
    if (!pythonDocxAvailable) {
      t.skip('python-docx not importable in this environment');
      return;
    }
    const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-metadata-noprofile-'));
    const mdPath = path.join(tmpDir, 'cheatsheet-noprofile-fixture.md');
    fs.writeFileSync(mdPath, '# Cheat Sheet\n\n- A point\n', 'utf8');
    const outPath = path.join(tmpDir, 'cheatsheet-noprofile-fixture.docx');
    assert.throws(
      () => renderTo(CHEATSHEET_TO_DOCX, [mdPath, outPath], emptyCwd),
      /profile\.md/,
      'converter exits non-zero and never writes a document with no resolvable author',
    );
    assert.ok(!fs.existsSync(outPath), 'no docx written when the author cannot be resolved');
  });
});
