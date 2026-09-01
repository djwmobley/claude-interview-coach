// @ts-check
/**
 * src/core/documents.js (dashboard PR 1, pr1-spec-decisions.md "resolveOutputPath" and
 * "suggestDocuments"). resolveOutputPath/listOutputFiles/suggestDocuments are pure filesystem/pure
 * functions tested against a fixture output/ tree under the OS temp dir -- never the real repo output/.
 * linkDocument/unlinkDocument/listDocuments touch the real ic_context test DB (ic_job_documents).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  resolveOutputPath, listOutputFiles, suggestDocuments, linkDocument, unlinkDocument, listDocuments,
  DOCUMENT_DIRS, DOC_STOPWORDS, tokenize, companyTokensFor, titleTokensFor,
} from '../src/core/documents.js';

/** @type {string} */
let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-output-'));
  for (const dir of DOCUMENT_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveOutputPath: ordered classification, one case per reason', () => {
  test('not_string', () => {
    assert.deepEqual(resolveOutputPath(root, /** @type {any} */ (42)), { ok: false, reason: 'not_string' });
    assert.deepEqual(resolveOutputPath(root, /** @type {any} */ (null)), { ok: false, reason: 'not_string' });
  });

  test('empty: blank, or leading/trailing whitespace', () => {
    assert.deepEqual(resolveOutputPath(root, ''), { ok: false, reason: 'empty' });
    assert.deepEqual(resolveOutputPath(root, '   '), { ok: false, reason: 'empty' });
    assert.deepEqual(resolveOutputPath(root, ' resumes/a.docx'), { ok: false, reason: 'empty' });
    assert.deepEqual(resolveOutputPath(root, 'resumes/a.docx '), { ok: false, reason: 'empty' });
  });

  test('bad_char: backslash, colon, percent, control characters', () => {
    assert.deepEqual(resolveOutputPath(root, 'resumes\\a.docx'), { ok: false, reason: 'bad_char' });
    assert.deepEqual(resolveOutputPath(root, 'C:/resumes/a.docx'), { ok: false, reason: 'bad_char' });
    assert.deepEqual(resolveOutputPath(root, 'resumes/a%2e.docx'), { ok: false, reason: 'bad_char' });
    assert.deepEqual(resolveOutputPath(root, 'resumes/a\0.docx'), { ok: false, reason: 'bad_char' });
    assert.deepEqual(resolveOutputPath(root, 'resumes/a\t.docx'), { ok: false, reason: 'bad_char' });
  });

  test('bad_segment: leading/double/trailing slash, dot segments, trailing dot or space', () => {
    assert.deepEqual(resolveOutputPath(root, '/resumes/a.docx'), { ok: false, reason: 'bad_segment' });
    assert.deepEqual(resolveOutputPath(root, 'resumes//a.docx'), { ok: false, reason: 'bad_segment' });
    assert.deepEqual(resolveOutputPath(root, 'resumes/a.docx/'), { ok: false, reason: 'bad_segment' });
    assert.deepEqual(resolveOutputPath(root, './resumes/a.docx'), { ok: false, reason: 'bad_segment' });
    assert.deepEqual(resolveOutputPath(root, '../resumes/a.docx'), { ok: false, reason: 'bad_segment' });
    assert.deepEqual(resolveOutputPath(root, 'resumes./a.docx'), { ok: false, reason: 'bad_segment' });
    assert.deepEqual(resolveOutputPath(root, 'resumes /a.docx'), { ok: false, reason: 'bad_segment' });
  });

  test('bad_depth: not exactly two segments', () => {
    assert.deepEqual(resolveOutputPath(root, 'a.docx'), { ok: false, reason: 'bad_depth' });
    assert.deepEqual(resolveOutputPath(root, 'resumes/sub/a.docx'), { ok: false, reason: 'bad_depth' });
  });

  test('bad_dir: first segment not one of the six exact, case-sensitive directory names', () => {
    assert.deepEqual(resolveOutputPath(root, 'Resumes/a.docx'), { ok: false, reason: 'bad_dir' });
    assert.deepEqual(resolveOutputPath(root, 'invoices/a.docx'), { ok: false, reason: 'bad_dir' });
  });

  test('bad_ext: extname not one of .docx/.pdf/.md/.html/.txt; x.docx.exe fails, x.exe.docx is a docx', () => {
    fs.writeFileSync(path.join(root, 'resumes', 'x.docx.exe'), 'x');
    fs.writeFileSync(path.join(root, 'resumes', 'x.exe.docx'), 'x');
    assert.deepEqual(resolveOutputPath(root, 'resumes/x.docx.exe'), { ok: false, reason: 'bad_ext' });
    const ok = resolveOutputPath(root, 'resumes/x.exe.docx');
    assert.equal(ok.ok, true);
  });

  test('not_found: well-formed path, no such file', () => {
    assert.deepEqual(resolveOutputPath(root, 'resumes/nope.docx'), { ok: false, reason: 'not_found' });
  });

  test('not_file: a directory at that path', () => {
    fs.mkdirSync(path.join(root, 'resumes', 'adir.docx'), { recursive: true });
    assert.deepEqual(resolveOutputPath(root, 'resumes/adir.docx'), { ok: false, reason: 'not_file' });
  });

  test('success: canonical relPath rebuilt from on-disk casing', () => {
    fs.writeFileSync(path.join(root, 'resumes', '20260803-Brightline Energy-CIO.docx'), 'x');
    const r = resolveOutputPath(root, 'resumes/20260803-Brightline Energy-CIO.docx');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.relPath, 'resumes/20260803-Brightline Energy-CIO.docx');
      assert.ok(fs.existsSync(r.absPath));
    }
  });

  test('outside_root: the "resumes" directory itself is a junction pointing outside output/ (skipped with a visible message if unavailable)', () => {
    // A junction/symlink one level DEEPER than a DOCUMENT_DIRS entry would make the path three segments
    // long, which bad_depth already refuses before outside_root is ever reached (resolveOutputPath's
    // ordered classification runs bad_depth before touching the filesystem at all). The meaningful case
    // per pr1-spec-decisions.md is a top-level DOCUMENT_DIRS entry itself resolving outside output/, so
    // the junction replaces the "resumes" directory, not a subdirectory of it.
    const junctionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-junction-root-'));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.docx'), 'x');
    const linkPath = path.join(junctionRoot, 'resumes');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'junction');
    } catch (err) {
      console.log(`[skip] outside_root junction test: fs.symlinkSync(..., 'junction') not permitted on this machine (${/** @type {Error} */ (err).message})`);
      fs.rmSync(junctionRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return;
    }
    try {
      assert.deepEqual(resolveOutputPath(junctionRoot, 'resumes/secret.docx'), { ok: false, reason: 'outside_root' });
    } finally {
      fs.rmSync(junctionRoot, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('listOutputFiles', () => {
  test('depth 1, skips ~$ lock files and non-allowed extensions, parses both date shapes and human names', () => {
    fs.mkdirSync(path.join(root, 'markdown'), { recursive: true });
    fs.writeFileSync(path.join(root, 'markdown', '20260803-brightline-cio.md'), 'x');
    fs.writeFileSync(path.join(root, 'markdown', '2026-08-13-e57-cto.md'), 'x');
    fs.writeFileSync(path.join(root, 'markdown', 'Damian Mobley - CTO.md'), 'x');
    fs.writeFileSync(path.join(root, 'markdown', '~$20260803-brightline-cio.md'), 'lock file');
    fs.writeFileSync(path.join(root, 'markdown', 'notes.txt.bak'), 'x');
    const files = listOutputFiles(root).filter((f) => f.dir === 'markdown');
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    assert.ok(!byName['~$20260803-brightline-cio.md'], 'lock file skipped');
    assert.ok(!byName['notes.txt.bak'], 'disallowed extension skipped');
    assert.equal(byName['20260803-brightline-cio.md'].date, '2026-08-03');
    assert.equal(byName['20260803-brightline-cio.md'].slug, 'brightline-cio');
    assert.equal(byName['20260803-brightline-cio.md'].humanName, false);
    assert.equal(byName['2026-08-13-e57-cto.md'].date, '2026-08-13');
    assert.equal(byName['2026-08-13-e57-cto.md'].slug, 'e57-cto');
    assert.equal(byName['Damian Mobley - CTO.md'].date, null);
    assert.equal(byName['Damian Mobley - CTO.md'].humanName, true);
    assert.equal(byName['Damian Mobley - CTO.md'].kind, 'markdown');
  });

  test('a missing subdirectory is simply empty, not an error', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-empty-'));
    assert.deepEqual(listOutputFiles(emptyRoot), []);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });
});

describe('tokenize / companyTokensFor / titleTokensFor', () => {
  test('tokenize lowercases, splits on non-alnum, keeps digit+letter runs together', () => {
    assert.deepEqual(tokenize('E57 / Harbor Relief Foundation'), ['e57', 'harbor', 'relief', 'foundation']);
    assert.deepEqual(tokenize(''), []);
  });

  test('companyTokensFor segments on / & and, drops DOC_STOPWORDS, no length floor', () => {
    const toks = companyTokensFor('brightline', {});
    assert.ok(toks.has('brightline'));
    const slashed = companyTokensFor('jpmorgan chase & co', {});
    assert.ok(slashed.has('jpmorgan') && slashed.has('chase'), '"&" splits into segments before tokenizing');
    const withStopword = companyTokensFor('the brightline group corp', {});
    assert.ok(withStopword.has('brightline'));
    assert.ok(!withStopword.has('the') && !withStopword.has('group') && !withStopword.has('corp'), 'DOC_STOPWORDS dropped');
    const e57 = companyTokensFor('e57', {});
    assert.ok(e57.has('e57'), 'no length floor: a 3-char token like e57 counts');
    const withAlias = companyTokensFor('harbor relief foundation', { 'east 57th': 'harbor relief foundation' });
    assert.ok(withAlias.has('east') && withAlias.has('57th'), 'alias tokens folded in when they map to the same company_norm');
  });

  test('titleTokensFor drops DOC_STOPWORDS and tokens shorter than 3 chars', () => {
    const toks = titleTokensFor('Chief Technology Officer, a VP of AI');
    assert.ok(!toks.has('chief') && !toks.has('officer') && !toks.has('vp') && !toks.has('of') && !toks.has('a'));
    assert.ok(!toks.has('ai'), 'shorter than 3 chars is dropped even though it is not a stopword');
    assert.ok(toks.has('technology'));
  });

  test('DOC_STOPWORDS is closed and distinct from an arbitrary title-only word', () => {
    assert.ok(DOC_STOPWORDS.includes('worldwide'));
    assert.ok(!DOC_STOPWORDS.includes('technology'));
  });
});

describe('suggestDocuments: candidacy threshold and total order', () => {
  // titleTokensFor('Chief Information Officer') = {'information'} ('chief'/'officer' are DOC_STOPWORDS).
  const listing = { title: 'Chief Information Officer', company_norm: 'brightline', first_seen_at: '2026-08-01T00:00:00Z' };
  /** @param {any} o */
  const file = (o) => ({ dir: 'resumes', ext: '.docx', kind: 'resume', date: null, slug: '', humanName: false, ...o });

  test('company-only overlap of 1 is never enough; title-only overlap is never enough', () => {
    assert.deepEqual(suggestDocuments(listing, [file({ name: 'brightline-notes.docx', relPath: 'resumes/brightline-notes.docx' })]), []);
    assert.deepEqual(suggestDocuments(listing, [file({ name: 'information-notes.docx', relPath: 'resumes/information-notes.docx' })]), []);
  });

  test('companyHits >= 1 and companyHits + titleHits >= 2 makes a candidate, scored correctly', () => {
    const files = [
      file({ name: '20260801-brightline-information.docx', relPath: 'resumes/20260801-brightline-information.docx', date: '2026-08-01' }),
      file({ name: 'brightline-notes.docx', relPath: 'resumes/brightline-notes.docx' }), // companyHits 1, titleHits 0: excluded
      file({ name: 'unrelated.docx', relPath: 'resumes/unrelated.docx' }), // excluded entirely
    ];
    const out = suggestDocuments(listing, files);
    assert.deepEqual(out.map((r) => r.file), ['resumes/20260801-brightline-information.docx']);
    assert.equal(out[0].companyHits, 1);
    assert.equal(out[0].titleHits, 1);
    assert.equal(out[0].score, 2);
  });

  test('total order: date distance to first_seen_at breaks a tie in score and titleHits', () => {
    const files = [
      file({ name: '20260601-brightline-information.md', relPath: 'markdown/20260601-brightline-information.md', dir: 'markdown', ext: '.md', kind: 'markdown', date: '2026-06-01' }), // 61 days away
      file({ name: '20260801-brightline-information.docx', relPath: 'resumes/20260801-brightline-information.docx', date: '2026-08-01' }), // 0 days away
    ];
    const out = suggestDocuments(listing, files);
    assert.deepEqual(out.map((r) => r.file), ['resumes/20260801-brightline-information.docx', 'markdown/20260601-brightline-information.md']);
  });

  test('total order: undated files sort after every dated file', () => {
    const files = [
      file({ name: 'brightline-information-undated.docx', relPath: 'resumes/brightline-information-undated.docx', date: null }),
      file({ name: '20260101-brightline-information.docx', relPath: 'resumes/20260101-brightline-information.docx', date: '2026-01-01' }),
    ];
    const out = suggestDocuments(listing, files);
    assert.deepEqual(out.map((r) => r.file), ['resumes/20260101-brightline-information.docx', 'resumes/brightline-information-undated.docx']);
  });

  test('total order: kind priority (resume before coverletter) beats relPath, relPath asc is the final tiebreak', () => {
    const files = [
      file({ name: 'zzz-brightline-information.docx', relPath: 'coverletters/zzz-brightline-information.docx', dir: 'coverletters', kind: 'coverletter' }),
      file({ name: 'zzz-brightline-information.docx', relPath: 'resumes/zzz-brightline-information.docx' }),
      file({ name: 'aaa-brightline-information.docx', relPath: 'resumes/aaa-brightline-information.docx' }),
    ];
    const out = suggestDocuments(listing, files);
    assert.deepEqual(out.map((r) => r.file), [
      'resumes/aaa-brightline-information.docx',
      'resumes/zzz-brightline-information.docx',
      'coverletters/zzz-brightline-information.docx',
    ]);
  });

  test('never links: suggestDocuments takes no client and performs no database writes', () => {
    assert.equal(typeof suggestDocuments, 'function');
    assert.equal(suggestDocuments.constructor.name, 'Function', 'not an async function; nothing to await, nothing it could persist');
  });
});

describe('linkDocument / unlinkDocument / listDocuments (real test DB)', () => {
  /** @type {pg.Client} */
  let client;
  /** @type {number} */
  let listingId;
  const SRC = `zz-test-documents-${process.pid}`;

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await ensureAuxSchema(client);
    const r = await client.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
       VALUES ('Doc Test', 'Doc Test Co', $1, $2, 'listing', 'doc test co', 'doc test', 'legacy-unknown', 'zz-doc-hash', now()) RETURNING id`,
      [SRC, `${SRC}:1`],
    );
    listingId = Number(r.rows[0].id);
    fs.mkdirSync(path.join(root, 'resumes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'resumes', 'link-me.docx'), 'x');
  });
  after(async () => {
    await client.query('DELETE FROM ic_job_documents WHERE listing_id = $1', [listingId]);
    await client.query('DELETE FROM ic_job_events WHERE listing_id = $1', [listingId]);
    await client.query('DELETE FROM ic_followups WHERE listing_id = $1', [listingId]);
    await client.query('DELETE FROM ic_job_listings WHERE id = $1', [listingId]);
    await client.end();
  });

  test('linkDocument re-resolves the path, refuses an invalid one, records a document event, and is idempotent per (listing, rel_path)', async () => {
    await assert.rejects(linkDocument(client, root, { listingId, relPath: 'resumes/does-not-exist.docx', kind: 'resume' }), /not_found/);
    await assert.rejects(linkDocument(client, root, { listingId, relPath: 'resumes/link-me.docx', kind: 'bogus-kind' }), /kind/);
    const row = await linkDocument(client, root, { listingId, relPath: 'resumes/link-me.docx', kind: 'resume', label: 'v1' });
    assert.equal(row.rel_path, 'resumes/link-me.docx');
    assert.equal(row.actor, 'mcp');
    const again = await linkDocument(client, root, { listingId, relPath: 'resumes/link-me.docx', kind: 'resume', label: 'v2', actor: 'dashboard' });
    assert.equal(again.id, row.id, 'same (listing, rel_path) updates in place rather than duplicating');
    assert.equal(again.label, 'v2');
    const list = await listDocuments(client, listingId);
    assert.equal(list.length, 1);
    const events = await client.query(`SELECT kind, note, actor FROM ic_job_events WHERE listing_id = $1 AND kind = 'document' ORDER BY id`, [listingId]);
    assert.ok(events.rows.some((e) => e.note.includes('linked') && e.actor === 'mcp'));
  });

  test('unlinkDocument removes the row, records a document event, 404s on an unknown id', async () => {
    const linked = await linkDocument(client, root, { listingId, relPath: 'resumes/link-me.docx', kind: 'resume' });
    const out = await unlinkDocument(client, { id: linked.id });
    assert.equal(out.listing_id, listingId);
    assert.equal((await listDocuments(client, listingId)).length, 0);
    await assert.rejects(unlinkDocument(client, { id: 999999999 }), /not found/);
  });

  test('linkDocument records exactly one document event when the same (listing, rel_path) is linked twice (repeated seed runs do not accumulate audit noise)', async () => {
    fs.writeFileSync(path.join(root, 'resumes', 'link-twice.docx'), 'x');
    await client.query(`DELETE FROM ic_job_documents WHERE listing_id = $1 AND rel_path = 'resumes/link-twice.docx'`, [listingId]);
    await client.query(`DELETE FROM ic_job_events WHERE listing_id = $1 AND kind = 'document' AND note LIKE '%link-twice%'`, [listingId]);

    const first = await linkDocument(client, root, { listingId, relPath: 'resumes/link-twice.docx', kind: 'resume', label: 'v1' });
    const second = await linkDocument(client, root, { listingId, relPath: 'resumes/link-twice.docx', kind: 'resume', label: 'v2' });
    assert.equal(second.id, first.id);
    assert.equal(second.label, 'v2', 'the update branch still applies, it just does not record a second event');

    const events = await client.query(
      `SELECT id FROM ic_job_events WHERE listing_id = $1 AND kind = 'document' AND note LIKE '%link-twice%'`,
      [listingId],
    );
    assert.equal(events.rows.length, 1, 'exactly one document event across insert + update, not two');
  });
});
