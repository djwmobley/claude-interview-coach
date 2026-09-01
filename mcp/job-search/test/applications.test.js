// @ts-check
/**
 * src/core/applications.js (apply pipeline slice 1): the TRANSITIONS state machine, createApplication,
 * transition/resume/retry, onDocumentLinked, markSubmitted, and reconcileStale. Runs against the real
 * test DB (ic_job_applications / ic_job_application_events / ic_job_events), matching the house pattern
 * in test/documents.test.js and test/mark_jobs.test.js: rows carry a `ZZ-TEST-APPLICATIONS-<pid>` company
 * so cleanup can find everything this file created without touching unrelated data.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  TRANSITIONS, APPLICATION_STATES, ATS_TYPES,
  createApplication, transition, resume, retry, onDocumentLinked, markSubmitted, reconcileStale,
  getApplication, getApplicationForListing, approve, listApplicationEvents,
  recordSubmitRequestSent, hasSubmitRequestSentThisAttempt, markAppliedByHand,
} from '../src/core/applications.js';

const CO = `ZZ-TEST-APPLICATIONS-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

/** @param {Partial<{ status: string|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, status)
     VALUES ('Applications Test', $1, $2, $3, 'listing', 'applications test co', 'applications test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-test-applications-${process.pid}`, `zz-test-applications-${process.pid}:${n}`, `zz-applications-hash-${n}`, o.status ?? null],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** jsonb-typed columns of ic_job_applications that seedApplication's dynamic column list might target. */
const JSONB_COLS = new Set(['pending_question', 'answers']);

/** Seed an application row directly at a given state (bypassing applications.js's own validation --
 * this is DB-level test fixture setup, not a claim that the app layer can reach every state this way). */
async function seedApplication(state = 'drafting', extra = {}) {
  const listingId = await insertListing();
  const cols = ['listing_id', 'state', ...Object.keys(extra)];
  const vals = [listingId, state, ...Object.values(extra)];
  const placeholders = cols.map((c, i) => `$${i + 1}${JSONB_COLS.has(c) ? '::jsonb' : ''}`);
  const r = await client.query(
    `INSERT INTO ic_job_applications (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id, listing_id`,
    vals,
  );
  return { id: Number(r.rows[0].id), listingId: Number(r.rows[0].listing_id) };
}

/** @param {number} listingId @param {'resume'|'coverletter'|'cheatsheet'} kind @param {string} relPath */
async function insertDocument(listingId, kind, relPath) {
  const r = await client.query(
    `INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, $2, $3, 'mcp') RETURNING id`,
    [listingId, kind, relPath],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
});

describe('TRANSITIONS is frozen and total', () => {
  test('APPLICATION_STATES is a permutation of TRANSITIONS keys with no extras and no omissions', () => {
    assert.deepEqual([...Object.keys(TRANSITIONS)].sort(), [...APPLICATION_STATES].sort());
  });
  test('confirmed and withdrawn are terminal (no outgoing edges)', () => {
    assert.deepEqual(TRANSITIONS.confirmed, []);
    assert.deepEqual(TRANSITIONS.withdrawn, []);
  });
});

describe('createApplication', () => {
  test('creates a row in drafting and records one state event with from_state null', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    assert.equal(app.state, 'drafting');
    assert.equal(app.ats_type, 'unknown');
    assert.equal(app.account_email, 'djwmobley@gmail.com');
    const events = await listApplicationEvents(client, app.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'state');
    assert.equal(events[0].from_state, null);
    assert.equal(events[0].to_state, 'drafting');
    assert.equal(events[0].actor, 'mcp');
  });

  test('rejects an unknown ats_type with VALIDATION', async () => {
    const listingId = await insertListing();
    await assert.rejects(createApplication(client, { listingId, atsType: 'bogus-ats' }), /ats_type must be one of/);
  });

  test('a second active application for the same listing is a clean VALIDATION error, not a raw pg error', async () => {
    const listingId = await insertListing();
    await createApplication(client, { listingId });
    await assert.rejects(createApplication(client, { listingId }), (err) => {
      assert.equal(/** @type {any} */ (err).code, 'VALIDATION');
      assert.match(/** @type {Error} */ (err).message, /active application already exists/);
      return true;
    });
  });

  test('a withdrawn application does not block a fresh createApplication for the same listing', async () => {
    const listingId = await insertListing();
    const first = await createApplication(client, { listingId });
    await transition(client, first.id, 'withdrawn', { actor: 'mcp' });
    const second = await createApplication(client, { listingId });
    assert.notEqual(second.id, first.id);
    assert.equal(second.state, 'drafting');
  });
});

describe('transition(): every TRANSITIONS edge is accepted', () => {
  /** @type {Array<[string, string]>} */
  const edges = [];
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) edges.push([from, to]);
  }

  for (const [from, to] of edges) {
    test(`${from} -> ${to}`, async () => {
      const { id } = await seedApplication(from);
      const opts = to === 'needs_human' ? { actor: 'apply', pending_question: { kind: 'question', label: 'test question' } } : { actor: 'apply' };
      const row = await transition(client, id, to, opts);
      assert.equal(row.state, to);
      const events = await listApplicationEvents(client, id);
      const last = events[events.length - 1];
      assert.equal(last.from_state, from);
      assert.equal(last.to_state, to);
    });
  }
});

describe('transition(): a sample of illegal transitions is rejected', () => {
  const illegal = [
    ['drafting', 'approved'],
    ['drafting', 'submitted'],
    ['confirmed', 'submitted'],
    ['withdrawn', 'drafting'],
    ['submitted', 'submitting'],
    ['needs_human', 'docs_ready'],
  ];
  for (const [from, to] of illegal) {
    test(`${from} -> ${to} is rejected`, async () => {
      const { id } = await seedApplication(from);
      await assert.rejects(transition(client, id, to, { actor: 'mcp' }), /cannot transition/);
      const row = await getApplication(client, id);
      assert.equal(row.state, from, 'state is unchanged after a rejected transition');
    });
  }

  test('transitioning a nonexistent application raises NOT_FOUND', async () => {
    await assert.rejects(transition(client, 999999999, 'withdrawn', {}), (err) => {
      assert.equal(/** @type {any} */ (err).code, 'NOT_FOUND');
      return true;
    });
  });

  test('an unrecognized actor is rejected before any row is touched', async () => {
    const { id } = await seedApplication('drafting');
    await assert.rejects(transition(client, id, 'withdrawn', { actor: 'not-a-real-actor' }), /actor must be one of/);
    const row = await getApplication(client, id);
    assert.equal(row.state, 'drafting');
  });
});

describe('pending_question shape rules', () => {
  test('entering needs_human with no pending_question is rejected', async () => {
    const { id } = await seedApplication('drafting');
    await assert.rejects(transition(client, id, 'needs_human', { actor: 'apply' }), /pending_question is required/);
  });

  test('pending_question with no kind is rejected', async () => {
    const { id } = await seedApplication('drafting');
    await assert.rejects(transition(client, id, 'needs_human', { actor: 'apply', pending_question: {} }), /pending_question\.kind/);
  });

  test('kind "credential" requires target and username', async () => {
    const { id: id1 } = await seedApplication('drafting');
    await assert.rejects(
      transition(client, id1, 'needs_human', { actor: 'apply', pending_question: { kind: 'credential' } }),
      /pending_question\.target/,
    );
    const { id: id2 } = await seedApplication('drafting');
    await assert.rejects(
      transition(client, id2, 'needs_human', { actor: 'apply', pending_question: { kind: 'credential', target: 'ic-jobsearch/foo' } }),
      /pending_question\.username/,
    );
    const { id: id3 } = await seedApplication('drafting');
    const row = await transition(client, id3, 'needs_human', {
      actor: 'apply', pending_question: { kind: 'credential', target: 'ic-jobsearch/foo', username: 'a@b.com' },
    });
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'credential');
  });

  test('kind "question" requires label', async () => {
    const { id: id1 } = await seedApplication('drafting');
    await assert.rejects(
      transition(client, id1, 'needs_human', { actor: 'apply', pending_question: { kind: 'question' } }),
      /pending_question\.label/,
    );
    const { id: id2 } = await seedApplication('drafting');
    const row = await transition(client, id2, 'needs_human', { actor: 'apply', pending_question: { kind: 'question', label: 'salary?' } });
    assert.equal(row.state, 'needs_human');
  });

  test('an unrecognized kind is permitted as-is (total classification, generic card)', async () => {
    const { id } = await seedApplication('drafting');
    const row = await transition(client, id, 'needs_human', { actor: 'apply', pending_question: { kind: 'captcha' } });
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'captcha');
  });

  test('leaving needs_human clears pending_question', async () => {
    const { id } = await seedApplication('needs_human', { pending_question: JSON.stringify({ kind: 'question', label: 'x' }) });
    const row = await transition(client, id, 'submitted', { actor: 'apply' });
    assert.equal(row.state, 'submitted');
    assert.equal(row.pending_question, null);
  });
});

describe('resume() and retry(): needs_human/failed -> approved, incrementing attempt', () => {
  test('resume() moves needs_human -> approved and increments attempt', async () => {
    const { id } = await seedApplication('needs_human', { pending_question: JSON.stringify({ kind: 'question', label: 'x' }), attempt: 2 });
    const row = await resume(client, id, { actor: 'dashboard' });
    assert.equal(row.state, 'approved');
    assert.equal(row.attempt, 3);
    assert.equal(row.pending_question, null);
  });

  test('resume() rejects when the application is not in needs_human', async () => {
    const { id } = await seedApplication('drafting');
    await assert.rejects(resume(client, id, {}), /resume\(\) requires application \d+ to be in state "needs_human"/);
  });

  test('retry() moves failed -> approved and increments attempt', async () => {
    const { id } = await seedApplication('failed', { attempt: 1, error: 'boom' });
    const row = await retry(client, id, { actor: 'dashboard' });
    assert.equal(row.state, 'approved');
    assert.equal(row.attempt, 2);
  });

  test('retry() rejects when the application is not failed', async () => {
    const { id } = await seedApplication('needs_human', { pending_question: JSON.stringify({ kind: 'question', label: 'x' }) });
    await assert.rejects(retry(client, id, {}), /retry\(\) requires application \d+ to be in state "failed"/);
  });
});

describe('onDocumentLinked', () => {
  test('no application for the listing is a strict no-op', async () => {
    const listingId = await insertListing();
    const docId = await insertDocument(listingId, 'resume', 'resumes/no-app.docx');
    const out = await onDocumentLinked(client, listingId, 'resume', docId);
    assert.deepEqual(out, { ignored: true, reason: 'no_application' });
  });

  test('an application that is not drafting is a strict no-op (never overwrites doc links after drafting)', async () => {
    const { id, listingId } = await seedApplication('approved');
    const docId = await insertDocument(listingId, 'resume', 'resumes/not-drafting.docx');
    const out = await onDocumentLinked(client, listingId, 'resume', docId);
    assert.deepEqual(out, { ignored: true, reason: 'not_drafting' });
    const row = await getApplication(client, id);
    assert.equal(row.resume_doc_id, null);
  });

  test('an unsupported doc kind is a strict no-op even while drafting', async () => {
    const { listingId } = await seedApplication('drafting');
    const docId = await insertDocument(listingId, 'cheatsheet', 'cheatsheets/x.docx');
    const out = await onDocumentLinked(client, listingId, 'cheatsheet', docId);
    assert.deepEqual(out, { ignored: true, reason: 'unsupported_doc_kind' });
  });

  test('cross-listing integrity: a document belonging to a different listing is rejected', async () => {
    const { listingId } = await seedApplication('drafting');
    const otherListingId = await insertListing();
    const docId = await insertDocument(otherListingId, 'resume', 'resumes/other-listing.docx');
    await assert.rejects(onDocumentLinked(client, listingId, 'resume', docId), /belongs to listing/);
  });

  test('a nonexistent document id is rejected', async () => {
    const { listingId } = await seedApplication('drafting');
    await assert.rejects(onDocumentLinked(client, listingId, 'resume', 999999999), /not found/);
  });

  test('linking a resume while drafting sets resume_doc_id and transitions to docs_ready', async () => {
    const { id, listingId } = await seedApplication('drafting');
    const docId = await insertDocument(listingId, 'resume', 'resumes/link.docx');
    const out = await onDocumentLinked(client, listingId, 'resume', docId, { actor: 'mcp' });
    assert.equal(out.ignored, false);
    assert.equal(out.application.state, 'docs_ready');
    const row = await getApplication(client, id);
    assert.equal(row.resume_doc_id, docId);
    assert.equal(row.state, 'docs_ready');
  });

  test('linking a cover letter while drafting sets coverletter_doc_id but does not transition', async () => {
    const { id, listingId } = await seedApplication('drafting');
    const docId = await insertDocument(listingId, 'coverletter', 'coverletters/link.docx');
    const out = await onDocumentLinked(client, listingId, 'coverletter', docId, { actor: 'mcp' });
    assert.equal(out.ignored, false);
    assert.equal(out.application.state, 'drafting');
    const row = await getApplication(client, id);
    assert.equal(row.coverletter_doc_id, docId);
    assert.equal(row.state, 'drafting');
  });
});

describe('markSubmitted: listing status guard', () => {
  test('writes "applied" when the listing status is pre-application (NULL or triage group)', async () => {
    const { id, listingId } = await seedApplication('submitting', { attempt: 1 });
    await client.query(`UPDATE ic_job_listings SET status = 'new' WHERE id = $1`, [listingId]);
    const row = await markSubmitted(client, id, { confirmationRef: 'ref-123' });
    assert.equal(row.state, 'submitted');
    assert.equal(row.confirmation_ref, 'ref-123');
    assert.ok(row.submitted_at);
    const listing = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [listingId]);
    assert.equal(listing.rows[0].status, 'applied');
  });

  test('leaves an already-closed listing status untouched and records a note event', async () => {
    const { id, listingId } = await seedApplication('submitting');
    await client.query(`UPDATE ic_job_listings SET status = 'lost' WHERE id = $1`, [listingId]);
    await markSubmitted(client, id, { confirmationRef: 'ref-456' });
    const listing = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [listingId]);
    assert.equal(listing.rows[0].status, 'lost', 'listing status must not be overwritten');
    const events = await listApplicationEvents(client, id);
    assert.ok(events.some((e) => e.kind === 'note' && e.note.includes('lost')));
  });

  test('leaves a listing already past applied (interviewing) untouched', async () => {
    const { id, listingId } = await seedApplication('submitting');
    await client.query(`UPDATE ic_job_listings SET status = 'interviewing' WHERE id = $1`, [listingId]);
    await markSubmitted(client, id, {});
    const listing = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [listingId]);
    assert.equal(listing.rows[0].status, 'interviewing');
  });
});

describe('reconcileStale', () => {
  test('moves a stale "submitting" application to failed with a recorded reason', async () => {
    const { id } = await seedApplication('submitting');
    await client.query(`UPDATE ic_job_applications SET updated_at = now() - interval '30 minutes' WHERE id = $1`, [id]);
    const results = await reconcileStale(client, { maxAgeMinutes: 10 });
    assert.ok(results.some((r) => r.id === id));
    const row = await getApplication(client, id);
    assert.equal(row.state, 'failed');
    assert.equal(row.error, 'stale submitting reconciled');
  });

  test('does not touch a recently-updated "submitting" application', async () => {
    const { id } = await seedApplication('submitting');
    await reconcileStale(client, { maxAgeMinutes: 10 });
    const row = await getApplication(client, id);
    assert.equal(row.state, 'submitting');
  });

  test('a stale "submitting" application that already recorded submit_request_sent goes to needs_human, never failed (apply pipeline slice 5, duplicate-application guard)', async () => {
    // Seeded via real transitions (not the raw-SQL seedApplication helper) so the 'state' event
    // hasSubmitRequestSentThisAttempt scopes its lookup against actually exists -- exactly how a real
    // approved -> submitting transition always behaves in production.
    const { id } = await seedApplication('approved');
    await transition(client, id, 'submitting', { actor: 'apply' });
    await recordSubmitRequestSent(client, id);
    await client.query(`UPDATE ic_job_applications SET updated_at = now() - interval '30 minutes' WHERE id = $1`, [id]);
    const results = await reconcileStale(client, { maxAgeMinutes: 10 });
    assert.ok(results.some((r) => r.id === id));
    const row = await getApplication(client, id);
    assert.equal(row.state, 'needs_human');
    assert.equal(row.pending_question.kind, 'post_submit_uncertain');
  });

  test('a submit_request_sent event from an EARLIER attempt never leaks into this attempt\'s stale-reconcile decision', async () => {
    // Simulate: attempt 1 sent the submit request and then failed; attempt 2 (Retry -> approved ->
    // submitting again) never got that far before going stale. The OLD submit_request_sent event must not
    // cause the new stale-submitting row to be treated as "already sent" this time.
    const { id } = await seedApplication('approved');
    await transition(client, id, 'submitting', { actor: 'apply' });
    await recordSubmitRequestSent(client, id);
    await transition(client, id, 'failed', { actor: 'apply', error: 'first attempt failed' });
    await retry(client, id, {});
    await transition(client, id, 'submitting', { actor: 'apply' });
    await client.query(`UPDATE ic_job_applications SET updated_at = now() - interval '30 minutes' WHERE id = $1`, [id]);
    await reconcileStale(client, { maxAgeMinutes: 10 });
    const row = await getApplication(client, id);
    assert.equal(row.state, 'failed', 'the second attempt never sent a submit request, so it must be treated as a plain failure');
  });
});

describe('recordSubmitRequestSent / hasSubmitRequestSentThisAttempt (apply pipeline slice 5)', () => {
  test('false before any submit_request_sent event; true right after one is recorded for the current submitting attempt', async () => {
    const { id } = await seedApplication('approved');
    assert.equal(await hasSubmitRequestSentThisAttempt(client, id), false);
    await transition(client, id, 'submitting', { actor: 'apply' });
    assert.equal(await hasSubmitRequestSentThisAttempt(client, id), false);
    await recordSubmitRequestSent(client, id);
    assert.equal(await hasSubmitRequestSentThisAttempt(client, id), true);
  });

  test('an application that never reached submitting reports false, never throws', async () => {
    const { id } = await seedApplication('drafting');
    assert.equal(await hasSubmitRequestSentThisAttempt(client, id), false);
  });
});

describe('markAppliedByHand (apply pipeline slice 5, "I applied by hand")', () => {
  test('needs_human -> submitted, no attempt increment, listing status moves to applied when pre-application', async () => {
    const { id, listingId } = await seedApplication('needs_human', { pending_question: { kind: 'unrecognized_page', label: 'x' } });
    const before = await getApplication(client, id);
    const row = await markAppliedByHand(client, id);
    assert.equal(row.state, 'submitted');
    assert.equal(row.attempt, before.attempt, 'markAppliedByHand must never increment attempt');
    const listing = await client.query('SELECT status FROM ic_job_listings WHERE id = $1', [listingId]);
    assert.equal(listing.rows[0].status, 'applied');
    const events = await listApplicationEvents(client, id);
    assert.ok(events.some((e) => e.kind === 'state' && e.to_state === 'submitted'));
  });

  test('rejects when the application is not currently needs_human', async () => {
    const { id } = await seedApplication('drafting');
    await assert.rejects(() => markAppliedByHand(client, id), /needs_human/);
  });
});

describe('ATS_TYPES / APPLICATION_STATES are exported, closed lists', () => {
  test('ATS_TYPES includes every plan-listed value', () => {
    for (const t of ['greenhouse', 'lever', 'workday', 'dayforce', 'indeed_easy', 'linkedin_easy', 'icims', 'smartrecruiters', 'unknown']) {
      assert.ok(ATS_TYPES.includes(t));
    }
  });
});

describe('getApplicationForListing (apply pipeline slice 3)', () => {
  test('returns null when the listing has no application', async () => {
    const listingId = await insertListing();
    assert.equal(await getApplicationForListing(client, listingId), null);
  });

  test('returns the most recent non-withdrawn application, never a withdrawn one', async () => {
    const listingId = await insertListing();
    const first = await createApplication(client, { listingId });
    await transition(client, first.id, 'withdrawn', { actor: 'mcp' });
    const second = await createApplication(client, { listingId });
    const found = await getApplicationForListing(client, listingId);
    assert.equal(found.id, second.id);
    assert.equal(found.state, 'drafting');
  });
});

describe('approve() (apply pipeline slice 3): docs_ready -> approved, hashes stored in one transaction', () => {
  /** @type {string} */
  let outputRoot;
  const RESUME_REL = 'resumes/ZZ-Approve-Test.docx';
  const COVER_REL = 'coverletters/ZZ-Approve-Test-Cover.docx';
  const RESUME_BYTES = 'resume-fixture-bytes';
  const COVER_BYTES = 'coverletter-fixture-bytes';

  before(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-approve-'));
    fs.mkdirSync(path.join(outputRoot, 'resumes'), { recursive: true });
    fs.mkdirSync(path.join(outputRoot, 'coverletters'), { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'resumes', 'ZZ-Approve-Test.docx'), RESUME_BYTES);
    fs.writeFileSync(path.join(outputRoot, 'coverletters', 'ZZ-Approve-Test-Cover.docx'), COVER_BYTES);
  });
  after(() => {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  /** @param {string} state @param {{ resumeRelPath?: string, coverletterRelPath?: string }} [docs] */
  async function seedWithDocs(state, docs = {}) {
    const listingId = await insertListing();
    const resumeDocId = docs.resumeRelPath ? await insertDocument(listingId, 'resume', docs.resumeRelPath) : null;
    const coverletterDocId = docs.coverletterRelPath ? await insertDocument(listingId, 'coverletter', docs.coverletterRelPath) : null;
    const r = await client.query(
      `INSERT INTO ic_job_applications (listing_id, state, resume_doc_id, coverletter_doc_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [listingId, state, resumeDocId, coverletterDocId],
    );
    return { id: Number(r.rows[0].id), listingId, resumeDocId, coverletterDocId };
  }

  test('happy path: resume + cover letter both linked, both hashes stored, approved_at set, state -> approved', async () => {
    const { id } = await seedWithDocs('docs_ready', { resumeRelPath: RESUME_REL, coverletterRelPath: COVER_REL });
    const row = await approve(client, id, { outputRoot, actor: 'dashboard' });
    assert.equal(row.state, 'approved');
    assert.equal(row.resume_hash, crypto.createHash('sha256').update(RESUME_BYTES).digest('hex'));
    assert.equal(row.coverletter_hash, crypto.createHash('sha256').update(COVER_BYTES).digest('hex'));
    assert.ok(row.approved_at, 'approved_at must be set by approve()');
    const events = await listApplicationEvents(client, id);
    const last = events[events.length - 1];
    assert.equal(last.kind, 'state');
    assert.equal(last.from_state, 'docs_ready');
    assert.equal(last.to_state, 'approved');
  });

  test('resume only: coverletter_hash stays null, resume_hash is still stored', async () => {
    const { id } = await seedWithDocs('docs_ready', { resumeRelPath: RESUME_REL });
    const row = await approve(client, id, { outputRoot });
    assert.equal(row.state, 'approved');
    assert.equal(row.resume_hash, crypto.createHash('sha256').update(RESUME_BYTES).digest('hex'));
    assert.equal(row.coverletter_hash, null);
  });

  test('blocked from a state other than docs_ready, row left unchanged', async () => {
    const { id } = await seedWithDocs('drafting', { resumeRelPath: RESUME_REL });
    await assert.rejects(approve(client, id, { outputRoot }), /requires application \d+ to be in state "docs_ready"/);
    const row = await getApplication(client, id);
    assert.equal(row.state, 'drafting');
    assert.equal(row.resume_hash, null);
  });

  test('blocked without a linked resume document, even in docs_ready', async () => {
    const { id } = await seedWithDocs('docs_ready', {});
    await assert.rejects(approve(client, id, { outputRoot }), /requires application \d+ to have a linked resume document/);
  });

  test('a nonexistent application raises NOT_FOUND', async () => {
    await assert.rejects(approve(client, 999999999, { outputRoot }), (err) => {
      assert.equal(/** @type {any} */ (err).code, 'NOT_FOUND');
      return true;
    });
  });
});
