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
import { linkRenderedDocument } from '../src/tools/render_doc.js';

const CO = `ZZ-TEST-RENDER-DOC-LINK-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {string} */
let root;
/** @type {number[]} */
const listingIds = [];

/** @param {Partial<{ status: string|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status)
     VALUES ('Render Doc Link Test', $1, $2, $3, 'listing', 'render doc link test co', 'render doc link test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-test-render-doc-link-${process.pid}`, `zz-test-render-doc-link-${process.pid}:${n}`, `zz-render-doc-link-hash-${n}`, o.status ?? null],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
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
