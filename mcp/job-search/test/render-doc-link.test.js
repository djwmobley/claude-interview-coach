// @ts-check
/**
 * src/tools/render_doc.js's linkRenderedDocument() (apply pipeline slice 3, plan section "2. Listing to
 * documents"): the DB-linking step run after a successful render. Deliberately does not invoke Python or
 * the real preflight pipeline (that is test/render_doc.test.js's job, against src/core/render.js
 * directly, unchanged by this slice) -- this file fabricates a real on-disk DOCX and a real render
 * result shape, then asserts linkRenderedDocument() itself: linkDocument + the 'document' event it
 * records, and onDocumentLinked's drafting -> docs_ready flip, including the "post-drafting render is a
 * visible no-op" case the plan calls out by name. Real test DB, matching test/applications.test.js and
 * test/documents.test.js conventions.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { listEvents } from '../src/core/events.js';
import { createApplication, getApplication } from '../src/core/applications.js';
import { linkRenderedDocument, reuseExistingDocument } from '../src/tools/render_doc.js';

const CO = `ZZ-TEST-RENDER-DOC-LINK-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {string} */
let root;
/** @type {number[]} */
const listingIds = [];

/** @param {Partial<{ status: string|null, company: string }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status)
     VALUES ('Render Doc Link Test', $1, $2, $3, 'listing', 'render doc link test co', 'render doc link test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [o.company ?? CO, `zz-test-render-doc-link-${process.pid}`, `zz-test-render-doc-link-${process.pid}:${n}`, `zz-render-doc-link-hash-${n}`, o.status ?? null],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** A renderFn stub matching core/render.js's renderToPath signature, writing arbitrary bytes without
 * invoking Python. `calls` (when supplied) records every (targetAbs) it was asked to render, so a test can
 * assert a sibling that should be REUSED never reaches this function. */
function stubRenderFn(calls) {
  return async (_req, targetAbs) => {
    if (calls) calls.push(targetAbs);
    fs.writeFileSync(targetAbs, 'stub-rendered-bytes');
    return { ok: true, output_path: path.relative(root, targetAbs), bytes: 20, checks: [] };
  };
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-render-doc-link-'));
  fs.mkdirSync(path.join(root, 'output', 'resumes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'output', 'coverletters'), { recursive: true });
  fs.writeFileSync(path.join(root, 'output', 'resumes', 'Jordan Reyes - CTO.docx'), 'fake-resume-bytes');
  fs.writeFileSync(path.join(root, 'output', 'coverletters', 'Jordan Reyes - Cover Letter - Acme.docx'), 'fake-cover-bytes');
});
after(async () => {
  await cleanup();
  await client.end();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('linkRenderedDocument: path handling', () => {
  test('converts renderDoc-style output_path (OS separators, output/ prefix) to a forward-slash relPath under output/', async () => {
    const listingId = await insertListing();
    const outputPath = path.join('output', 'resumes', 'Jordan Reyes - CTO.docx'); // exactly what renderDoc() returns
    const { document } = await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath, root });
    assert.equal(document.rel_path, 'resumes/Jordan Reyes - CTO.docx');
  });

  test('also accepts an already-absolute output_path', async () => {
    const listingId = await insertListing();
    const abs = path.join(root, 'output', 'resumes', 'Jordan Reyes - CTO.docx');
    const { document } = await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: abs, root });
    assert.equal(document.rel_path, 'resumes/Jordan Reyes - CTO.docx');
  });
});

describe('linkRenderedDocument: kind mapping (plan section 2, "map cover_letter to coverletter, rename neither side")', () => {
  test('kind resume stores document kind resume', async () => {
    const listingId = await insertListing();
    const { document } = await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root });
    assert.equal(document.kind, 'resume');
  });

  test('kind cover_letter stores document kind coverletter', async () => {
    const listingId = await insertListing();
    const { document } = await linkRenderedDocument(client, {
      listingId, kind: 'cover_letter', outputPath: 'output/coverletters/Jordan Reyes - Cover Letter - Acme.docx', root,
    });
    assert.equal(document.kind, 'coverletter');
  });
});

describe('linkRenderedDocument: records exactly one document event (linkDocument\'s own recordEvent, no second call)', () => {
  test('a fresh link writes one "document" kind event on the listing', async () => {
    const listingId = await insertListing();
    await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root });
    const events = await listEvents(client, listingId, { limit: 50 });
    const docEvents = events.filter((e) => e.kind === 'document');
    assert.equal(docEvents.length, 1);
    assert.match(docEvents[0].note ?? '', /linked resumes\/Jordan Reyes - CTO\.docx/);
  });
});

describe('linkRenderedDocument: application_link (onDocumentLinked pass-through)', () => {
  test('no application yet: application_link is a visible no-op { ignored: true, reason: "no_application" }', async () => {
    const listingId = await insertListing();
    const { application_link } = await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root });
    assert.deepEqual(application_link, { ignored: true, reason: 'no_application' });
  });

  test('an application in drafting: linking a resume flips it to docs_ready, surfaced on application_link', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const { application_link } = await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root });
    assert.equal(application_link.ignored, false);
    assert.equal(/** @type {any} */ (application_link).application.state, 'docs_ready');
    const row = await getApplication(client, app.id);
    assert.equal(row.state, 'docs_ready');
    assert.ok(row.resume_doc_id);
  });

  test('post-drafting render is a VISIBLE no-op: a second render (cover letter) after docs_ready reports { ignored: true, reason: "not_drafting" }, never silently', async () => {
    const listingId = await insertListing();
    await createApplication(client, { listingId });
    await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root });
    // application is now docs_ready; a further render for the same listing must not silently re-link.
    const { application_link } = await linkRenderedDocument(client, {
      listingId, kind: 'cover_letter', outputPath: 'output/coverletters/Jordan Reyes - Cover Letter - Acme.docx', root,
    });
    assert.deepEqual(application_link, { ignored: true, reason: 'not_drafting' });
    // The document itself is still linked (documents and application state are separate concerns) --
    // only the application-state side effect is a no-op.
    const events = await listEvents(client, listingId, { limit: 50 });
    assert.equal(events.filter((e) => e.kind === 'document').length, 2);
  });

  test('a cheatsheet render never flips the application (unsupported_doc_kind), even while drafting', async () => {
    const listingId = await insertListing();
    fs.mkdirSync(path.join(root, 'output', 'cheatsheets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output', 'cheatsheets', 'Jordan Reyes - Cheatsheet.docx'), 'fake-cheatsheet-bytes');
    await createApplication(client, { listingId });
    const { application_link } = await linkRenderedDocument(client, {
      listingId, kind: 'cheatsheet', outputPath: 'output/cheatsheets/Jordan Reyes - Cheatsheet.docx', root,
    });
    assert.deepEqual(application_link, { ignored: true, reason: 'unsupported_doc_kind' });
  });
});

describe('linkRenderedDocument: applicationId (one-click apply PR A spec item 4, adversary finding 1)', () => {
  test('with applicationId, links THAT SPECIFIC application, not "most recent for the listing"', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const { application_link } = await linkRenderedDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root, applicationId: app.id,
    });
    assert.equal(application_link.ignored, false);
    assert.equal(/** @type {any} */ (application_link).application.id, app.id);
    assert.equal(/** @type {any} */ (application_link).application.state, 'docs_ready');
  });

  test('a mismatched applicationId/listingId pair is rejected with VALIDATION, no link happens', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const otherListingId = await insertListing();
    await assert.rejects(
      linkRenderedDocument(client, { listingId: otherListingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root, applicationId: app.id }),
      /belongs to listing/,
    );
    const row = await getApplication(client, app.id);
    assert.equal(row.state, 'drafting', 'the rejected call never touched the application');
  });

  test('without applicationId, the pre-existing listing-scoped behavior is unchanged (backward compatible)', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const { application_link } = await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Jordan Reyes - CTO.docx', root });
    assert.equal(/** @type {any} */ (application_link).application.id, app.id);
  });
});

describe('reuseExistingDocument (submit-on-resume spec section 2, amendment A4)', () => {
  test('a non-empty existing DOCX is linked exactly like a fresh render: ok:true, document + application_link present', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Reuse Happy Path.docx'), 'fake-resume-bytes');
    const result = await reuseExistingDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/Reuse Happy Path.docx', root,
    });
    assert.equal(result.ok, true);
    assert.equal(/** @type {any} */ (result).document.rel_path, 'resumes/Reuse Happy Path.docx');
    assert.equal(/** @type {any} */ (result).application_link.ignored, false);
    assert.equal(/** @type {any} */ (result).reused, true);
    const row = await getApplication(client, app.id);
    assert.equal(row.state, 'docs_ready');
    assert.ok(row.resume_doc_id);
  });

  test('reuseExistingDocument scopes the link to a specific applicationId, like linkRenderedDocument', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Reuse Application Scoped.docx'), 'fake-resume-bytes');
    const result = await reuseExistingDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/Reuse Application Scoped.docx', root, applicationId: app.id,
    });
    assert.equal(result.ok, true);
    assert.equal(/** @type {any} */ (result).application_link.application.id, app.id);
  });

  test('EMPTY_DOCX without a source: refuses exactly as before (documented blind spot -- no markdown to render a sibling from)', async () => {
    const listingId = await insertListing();
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Empty Resume.docx'), '');
    const result = await reuseExistingDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/Empty Resume.docx', root,
    });
    assert.deepEqual(result, { ok: false, code: 'EMPTY_DOCX' });
    const docs = await client.query('SELECT id FROM ic_job_documents WHERE listing_id = $1', [listingId]);
    assert.equal(docs.rowCount, 0);
  });

  test('EXISTS_OTHER_LISTING without a source: refuses exactly as before, no re-link', async () => {
    const listingA = await insertListing();
    const listingB = await insertListing();
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Shared Name.docx'), 'shared-bytes');
    await linkRenderedDocument(client, { listingId: listingA, kind: 'resume', outputPath: 'output/resumes/Shared Name.docx', root });

    const result = await reuseExistingDocument(client, {
      listingId: listingB, kind: 'resume', outputPath: 'output/resumes/Shared Name.docx', root,
    });
    assert.equal(result.ok, false);
    assert.equal(/** @type {any} */ (result).code, 'EXISTS_OTHER_LISTING');
    assert.equal(/** @type {any} */ (result).otherListingId, listingA);
    // listingB never got a document row out of this refused call.
    const docs = await client.query('SELECT id FROM ic_job_documents WHERE listing_id = $1', [listingB]);
    assert.equal(docs.rowCount, 0);
  });

  test('a row already linked to THIS SAME listing is not a conflict: reuse still links normally', async () => {
    const listingId = await insertListing();
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Same Listing Reuse.docx'), 'bytes');
    await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Same Listing Reuse.docx', root });
    const result = await reuseExistingDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/Same Listing Reuse.docx', root,
    });
    assert.equal(result.ok, true);
  });
});

describe('reuseExistingDocument: cross-listing collision resolved via a listing-unique sibling (render_doc PR "resolve cross-listing DOCX filename collisions")', () => {
  test('EXISTS_OTHER_LISTING: renders and links a company-suffixed sibling instead of refusing, leaving the other listing\'s document untouched', async () => {
    const listingA = await insertListing();
    const listingB = await insertListing({ company: 'Acme Robotics, Inc.' });
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Cross Listing.docx'), 'listingA-bytes');
    await linkRenderedDocument(client, { listingId: listingA, kind: 'resume', outputPath: 'output/resumes/Cross Listing.docx', root });

    const calls = [];
    const result = await reuseExistingDocument(client, {
      listingId: listingB, kind: 'resume', outputPath: 'output/resumes/Cross Listing.docx', root,
      source: 'fx/clean.md', outName: 'Cross Listing', renderFn: stubRenderFn(calls),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(/** @type {any} */ (result).reused, false);
    assert.equal(/** @type {any} */ (result).conflict_code, 'EXISTS_OTHER_LISTING');
    const expectedRel = path.join('output', 'resumes', 'Cross Listing - Acme Robotics Inc.docx');
    assert.equal(/** @type {any} */ (result).renamed_to, expectedRel);
    assert.equal(/** @type {any} */ (result).document.rel_path, 'resumes/Cross Listing - Acme Robotics Inc.docx');
    // listingA's original document is untouched: still exactly one row, same rel_path.
    const docsA = await client.query('SELECT rel_path FROM ic_job_documents WHERE listing_id = $1', [listingA]);
    assert.equal(docsA.rows.length, 1);
    assert.equal(docsA.rows[0].rel_path, 'resumes/Cross Listing.docx');
  });

  test('EMPTY_DOCX: renders and links a company-suffixed sibling instead of refusing', async () => {
    const listingId = await insertListing({ company: 'Vertex Analytics' });
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Empty Target.docx'), '');

    const calls = [];
    const result = await reuseExistingDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/Empty Target.docx', root,
      source: 'fx/clean.md', outName: 'Empty Target', renderFn: stubRenderFn(calls),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(/** @type {any} */ (result).reused, false);
    assert.equal(/** @type {any} */ (result).conflict_code, 'EMPTY_DOCX');
    assert.equal(/** @type {any} */ (result).renamed_to, path.join('output', 'resumes', 'Empty Target - Vertex Analytics.docx'));
    const docs = await client.query('SELECT id FROM ic_job_documents WHERE listing_id = $1 AND rel_path = $2', [listingId, 'resumes/Empty Target - Vertex Analytics.docx']);
    assert.equal(docs.rowCount, 1);
  });

  test('second-level fallback: a company-suffixed sibling already taken by ANOTHER listing falls back to the listingId-qualified name', async () => {
    const listingA = await insertListing({ company: 'Shared Co' });
    const listingB = await insertListing({ company: 'Shared Co' });
    const listingC = await insertListing({ company: 'Shared Co' });
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Fallback Test.docx'), 'listingA-bytes');
    await linkRenderedDocument(client, { listingId: listingA, kind: 'resume', outputPath: 'output/resumes/Fallback Test.docx', root });
    // listingB already occupies the company-suffixed sibling name that listingC would otherwise try first.
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Fallback Test - Shared Co.docx'), 'listingB-bytes');
    await linkRenderedDocument(client, { listingId: listingB, kind: 'resume', outputPath: 'output/resumes/Fallback Test - Shared Co.docx', root });

    const calls = [];
    const result = await reuseExistingDocument(client, {
      listingId: listingC, kind: 'resume', outputPath: 'output/resumes/Fallback Test.docx', root,
      source: 'fx/clean.md', outName: 'Fallback Test', renderFn: stubRenderFn(calls),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1, 'renders exactly once, at the second-level (listingId-qualified) candidate');
    const expectedRel = path.join('output', 'resumes', `Fallback Test - Shared Co ${listingC}.docx`);
    assert.equal(/** @type {any} */ (result).renamed_to, expectedRel);
    // listingA and listingB documents are both untouched.
    const docsA = await client.query('SELECT rel_path FROM ic_job_documents WHERE listing_id = $1', [listingA]);
    const docsB = await client.query('SELECT rel_path FROM ic_job_documents WHERE listing_id = $1', [listingB]);
    assert.equal(docsA.rows[0].rel_path, 'resumes/Fallback Test.docx');
    assert.equal(docsB.rows[0].rel_path, 'resumes/Fallback Test - Shared Co.docx');
  });

  test('a company-suffixed sibling already on disk, non-empty, and linked to THIS SAME listing is reused, never re-rendered', async () => {
    const listingId = await insertListing({ company: 'Reuse Sibling Co' });
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Same Listing Sibling.docx'), '');
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'Same Listing Sibling - Reuse Sibling Co.docx'), 'already-rendered-bytes');
    await linkRenderedDocument(client, { listingId, kind: 'resume', outputPath: 'output/resumes/Same Listing Sibling - Reuse Sibling Co.docx', root });

    const calls = [];
    const result = await reuseExistingDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/Same Listing Sibling.docx', root,
      source: 'fx/clean.md', outName: 'Same Listing Sibling', renderFn: stubRenderFn(calls),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 0, 'the sibling was already real and already this listing\'s: never re-rendered');
    assert.equal(/** @type {any} */ (result).reused, true);
    assert.equal(/** @type {any} */ (result).renamed_to, path.join('output', 'resumes', 'Same Listing Sibling - Reuse Sibling Co.docx'));
  });

  test('null/blank company: skips the company-suffixed name and goes straight to the listingId-only sibling', async () => {
    const listingId = await insertListing({ company: '' });
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'No Company.docx'), '');

    const calls = [];
    const result = await reuseExistingDocument(client, {
      listingId, kind: 'resume', outputPath: 'output/resumes/No Company.docx', root,
      source: 'fx/clean.md', outName: 'No Company', renderFn: stubRenderFn(calls),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(/** @type {any} */ (result).renamed_to, path.join('output', 'resumes', `No Company - ${listingId}.docx`));
  });
});
