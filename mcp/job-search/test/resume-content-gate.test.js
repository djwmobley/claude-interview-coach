// @ts-check
/**
 * Stale or foreign resume guard (S3): the pure content gate (evaluateResumeContent), the DOCX text
 * extractor, the file-level wrapper, and the real gate wired into linkDocument and the render_doc handler.
 * Dashes in fixtures are written as escapes (U+2013) so this file stays clean for the no-em-dash lint.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { linkDocument } from '../src/core/documents.js';
import { tool as renderDocTool } from '../src/tools/render_doc.js';
import {
  evaluateResumeContent, docxToText, checkResumeFile, containsWholeWord, findCompanyLines, parseIndexEntries, setGateHooksForTests,
} from '../src/core/resume-content-gate.js';

const EN = String.fromCharCode(0x2013);

/** @param {string[]} entries "Client|Period" pairs */
const indexOf = (entries) => `# Project Index\n\n${entries.map((e, i) => {
  const [client, period] = e.split('|');
  return `## p${i}.md\n- **Period:** ${period}\n- **Role:** Chief Technology Officer\n- **Client:** ${client}\n`;
}).join('\n')}`;

const INDEX = indexOf([`Advisicon|2026 ${EN} present`, `Immunotec|2023 ${EN} 2026`, `Monat|2019 ${EN} 2022`]);

/** @param {string[]} lines */
const resumeOf = (lines) => lines.join('\n');

const GOOD = resumeOf([
  'Jordan Reyes',
  'Houston, TX | jordan@example.com | 555-0100',
  'Executive leader. Previously at Advisicon, Immunotec, and Monat.',
  'EXPERIENCE',
  'Head of Technical Services',
  `Advisicon  |  Remote, US  |  2026 ${EN} Present`,
  'Chief Technology Officer',
  `Immunotec  |  Houston, TX  |  2023 ${EN} 2026`,
  'Chief Technology Officer',
  `MONAT Global  |  Miami, FL  |  2019 ${EN} 2022`,
]);

/** Build a minimal valid DOCX (zip with word/document.xml) in memory. @param {string} text one paragraph per line */
function makeDocx(text) {
  const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = text.split('\n').map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const name = Buffer.from('word/document.xml');
  const raw = Buffer.from(xml, 'utf8');
  const comp = zlib.deflateRawSync(raw);
  const crc = zlib.crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, comp, central, name, eocd]);
}

describe('evaluateResumeContent: the pure gate', () => {
  test('a fully valid resume passes', () => {
    assert.deepEqual(evaluateResumeContent(GOOD, INDEX), { ok: true, missing: [], reason: null });
  });

  test('zero parsed employers fails (never not-applicable)', () => {
    const v = evaluateResumeContent(GOOD, '# Project Index\n\nnothing here\n');
    assert.equal(v.ok, false);
    assert.match(String(v.reason), /no employers/);
  });

  test('an employer mentioned only in the summary fails', () => {
    const text = GOOD.replace(/^Immunotec {2}\|.*$/m, `Other Corp  |  Houston, TX  |  2023 ${EN} 2026`);
    const v = evaluateResumeContent(text, INDEX);
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ['Immunotec']);
  });

  test('a current role without a Present company line fails', () => {
    const text = GOOD.replace(`2026 ${EN} Present`, `2026 ${EN} 2026`);
    const v = evaluateResumeContent(text, INDEX);
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ['Advisicon']);
    assert.match(String(v.reason), /Present/);
  });

  test('a resume missing the current employer entirely (the 10-month gap incident) fails and names it', () => {
    const text = resumeOf(GOOD.split('\n').filter((l) => !l.startsWith('Advisicon') && !l.startsWith('Head of')));
    const v = evaluateResumeContent(text, INDEX);
    assert.equal(v.ok, false);
    assert.ok(v.missing.includes('Advisicon'));
  });

  test('matching is case-insensitive and whole-word: Monat vs "MONAT Global" passes, Ace vs "Acetech" fails', () => {
    assert.equal(containsWholeWord('MONAT Global', 'Monat'), true);
    assert.equal(containsWholeWord('Acetech', 'Ace'), false);
    assert.equal(containsWholeWord('Ace Hardware', 'Ace'), true);
    const aceIndex = indexOf([`Ace|2020 ${EN} 2021`]);
    const v = evaluateResumeContent(resumeOf([`Acetech  |  Austin, TX  |  2020 ${EN} 2021`]), aceIndex);
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ['Ace']);
    assert.equal(evaluateResumeContent(resumeOf([`Ace  |  Austin, TX  |  2020 ${EN} 2021`]), aceIndex).ok, true);
  });

  test('unreadable or empty input fails: empty text, non-string text, non-string index, no company lines', () => {
    assert.equal(evaluateResumeContent('', INDEX).ok, false);
    assert.equal(evaluateResumeContent('   \n ', INDEX).ok, false);
    assert.equal(evaluateResumeContent(/** @type {any} */ (null), INDEX).ok, false);
    assert.equal(evaluateResumeContent(GOOD, /** @type {any} */ (undefined)).ok, false);
    const noLines = evaluateResumeContent('Jordan Reyes\nAdvisicon Immunotec Monat 2026', INDEX);
    assert.equal(noLines.ok, false);
    assert.match(String(noLines.reason), /no company lines/);
  });

  test('company lines are found by pattern, not position, with any run of spaces around the pipes', () => {
    const lines = findCompanyLines(resumeOf(['intro', `Acme | Austin | 2020`, `no pipe 2020`, `A | B | no year`]));
    assert.deepEqual(lines, [['Acme', 'Austin', '2020']]);
  });

  test('index parsing is by heading block, so field order inside a block does not matter', () => {
    const idx = `## a.md\n- **Client:** Alpha\n- **Period:** 2025 ${EN} Present\n\n## b.md\n- **Period:** 2020 ${EN} 2021\n- **Client:** Beta\n`;
    assert.deepEqual(parseIndexEntries(idx), [{ client: 'Alpha', current: true }, { client: 'Beta', current: false }]);
  });
});

describe('docxToText and checkResumeFile', () => {
  /** @type {string} */
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-gate-'));
    fs.mkdirSync(path.join(tmp, 'data'));
    fs.writeFileSync(path.join(tmp, 'data', 'project-index.md'), INDEX);
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('round-trips paragraphs and decodes XML entities', () => {
    const text = docxToText(makeDocx('Smith & Sons <Ltd>\nsecond line'));
    assert.equal(text, 'Smith & Sons <Ltd>\nsecond line');
  });

  test('a file that is not a DOCX throws from docxToText and fails closed from checkResumeFile', () => {
    assert.throws(() => docxToText(Buffer.from('not a zip at all, just text')));
    const p = path.join(tmp, 'bad.docx');
    fs.writeFileSync(p, 'not a zip at all, just text');
    assert.equal(checkResumeFile(p, path.join(tmp, 'data', 'project-index.md')).ok, false);
  });

  test('a missing file, a zero-byte file, and a missing project index all fail', () => {
    const idx = path.join(tmp, 'data', 'project-index.md');
    assert.equal(checkResumeFile(path.join(tmp, 'nope.docx'), idx).ok, false);
    const empty = path.join(tmp, 'empty.docx');
    fs.writeFileSync(empty, '');
    assert.equal(checkResumeFile(empty, idx).ok, false);
    const good = path.join(tmp, 'good.docx');
    fs.writeFileSync(good, makeDocx(GOOD));
    assert.equal(checkResumeFile(good, path.join(tmp, 'data', 'missing-index.md')).ok, false);
  });

  test('a good and a stale DOCX against the CURRENT index; the verdict follows the index on every call', () => {
    const idxPath = path.join(tmp, 'data', 'project-index.md');
    const good = path.join(tmp, 'good2.docx');
    fs.writeFileSync(good, makeDocx(GOOD));
    assert.equal(checkResumeFile(good, idxPath).ok, true);
    fs.writeFileSync(idxPath, indexOf([`Advisicon|2026 ${EN} present`, `NewCo|2026 ${EN} present`]));
    const v = checkResumeFile(good, idxPath);
    assert.equal(v.ok, false);
    assert.deepEqual(v.missing, ['NewCo']);
    fs.writeFileSync(idxPath, INDEX);
  });

  test('S2: checking never modifies the file', () => {
    const p = path.join(tmp, 'untouched.docx');
    const bytes = makeDocx(GOOD);
    fs.writeFileSync(p, bytes);
    const before = fs.statSync(p).mtimeMs;
    checkResumeFile(p, path.join(tmp, 'data', 'project-index.md'));
    assert.equal(fs.statSync(p).mtimeMs, before);
    assert.ok(fs.readFileSync(p).equals(bytes));
  });
});

describe('the real gate wired into linkDocument and the render_doc handler', () => {
  /** @type {pg.Client} */
  let client;
  /** @type {string} */
  let root;
  /** @type {number[]} */
  const ids = [];

  /** @returns {Promise<number>} */
  async function insertListing() {
    const n = Math.floor(Math.random() * 1e9);
    const r = await client.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
       VALUES ('Gate Test', 'ZZ-GATE-TEST', $1, $2, 'listing', 'zz gate test', 'gate test', 'legacy-unknown', $3, now()) RETURNING id`,
      [`zz-test-gate-${process.pid}`, `zz-test-gate-${process.pid}:${n}`, `zz-gate-hash-${n}`],
    );
    ids.push(Number(r.rows[0].id));
    return Number(r.rows[0].id);
  }

  before(async () => {
    setGateHooksForTests(null);
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await ensureAuxSchema(client);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-gate-link-'));
    fs.mkdirSync(path.join(root, 'output', 'resumes'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'project-index.md'), INDEX);
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Good.docx'), makeDocx(GOOD));
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Stale.docx'), makeDocx(resumeOf([`Immunotec  |  Houston, TX  |  2023 ${EN} 2026`])));
  });
  after(async () => {
    if (ids.length) {
      await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
    }
    await client.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('linkDocument links a passing resume and refuses a stale one with STALE_RESUME naming the employer', async () => {
    const listingId = await insertListing();
    const out = path.join(root, 'output');
    const row = await linkDocument(client, out, { listingId, relPath: 'resumes/Good.docx', kind: 'resume' });
    assert.equal(row.rel_path, 'resumes/Good.docx');
    await assert.rejects(
      linkDocument(client, out, { listingId, relPath: 'resumes/Stale.docx', kind: 'resume' }),
      (err) => /** @type {any} */ (err).code === 'STALE_RESUME' && /** @type {any} */ (err).details.missing.includes('Advisicon'),
    );
    const rows = await client.query('SELECT rel_path FROM ic_job_documents WHERE listing_id = $1', [listingId]);
    assert.deepEqual(rows.rows.map((r) => r.rel_path), ['resumes/Good.docx']);
  });

  test('the gate runs only for resumes: a cover letter kind links regardless of content', async () => {
    const listingId = await insertListing();
    fs.mkdirSync(path.join(root, 'output', 'coverletters'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output', 'coverletters', 'Letter.docx'), 'any bytes');
    const row = await linkDocument(client, path.join(root, 'output'), { listingId, relPath: 'coverletters/Letter.docx', kind: 'coverletter' });
    assert.equal(row.kind, 'coverletter');
  });

  test('render_doc handler: force:true on a stale resume is still refused with code STALE_RESUME (S4)', async () => {
    const listingId = await insertListing();
    const savedRoot = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root; // the handler resolves output/ and data/ against repoRoot()
    try {
      const result = /** @type {any} */ (await renderDocTool.handler(
        { kind: 'resume', source: 'x.md', outName: 'Stale', checkOnly: false, force: true, reuse_existing: false, listingId },
        {
          renderDocFn: async () => ({ ok: true, output_path: path.join('output', 'resumes', 'Stale.docx'), checks: [] }),
          withClient: async (/** @type {any} */ fn) => fn(client),
        },
      ));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'STALE_RESUME');
      assert.match(result.missing, /Advisicon/);
      const rows = await client.query('SELECT id FROM ic_job_documents WHERE listing_id = $1', [listingId]);
      assert.equal(rows.rowCount, 0);
    } finally {
      if (savedRoot === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = savedRoot;
    }
  });
});
