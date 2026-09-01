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
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  TRANSITIONS, APPLICATION_STATES, ATS_TYPES,
  createApplication, transition, resume, retry, onDocumentLinked, markSubmitted, reconcileStale,
  getApplication, listApplicationEvents,
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
});

describe('ATS_TYPES / APPLICATION_STATES are exported, closed lists', () => {
  test('ATS_TYPES includes every plan-listed value', () => {
    for (const t of ['greenhouse', 'lever', 'workday', 'dayforce', 'indeed_easy', 'linkedin_easy', 'icims', 'smartrecruiters', 'unknown']) {
      assert.ok(ATS_TYPES.includes(t));
    }
  });
});
