// @ts-check
/**
 * Title gate persistence (src/core/title-gate-apply.js) and its scan-ingest wiring (src/core/upsert.js
 * applyDecision). Pure verdicts are covered in test/title-gate.test.js.
 *
 * DB-backed on the shared test DB (npm test). Rows carry source `zz-test-tg-<pid>` / company
 * `<tag> ZZ Gate <pid>` and are deleted afterwards.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication } from '../src/core/applications.js';
import { applyDecision } from '../src/core/upsert.js';
import { classify, makePgLookups } from '../src/core/dedup.js';
import { normalizeListing, DEFAULT_TRACKING_PARAMS } from '../src/core/normalize.js';
import { recordEvent, listEvents } from '../src/core/events.js';
import { withTransaction } from '../src/core/db.js';
import { applyTitleGate, titleGateBlock, TITLE_GATE_NOTE_PREFIX } from '../src/core/title-gate-apply.js';

const PID = process.pid;
const SRC = `zz-test-tg-${PID}`;
const CO_SUFFIX = ` ZZ Gate ${PID}`;
const NOPTS = { trackingParams: DEFAULT_TRACKING_PARAMS, greenhouseBoards: [], aliases: {} };
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const createdIds = [];
let seq = 0;

/** @param {string} title @param {string} tag unique company prefix per test */
function makeRec(title, tag) {
  seq += 1;
  return normalizeListing({
    source: SRC, url: `https://example.test/${SRC}/${seq}-${Math.floor(Math.random() * 1e9)}`, title, company: `${tag}${CO_SUFFIX}`, location: 'Houston, TX', description: null,
  }, NOPTS);
}

/** Store a row carrying a rec's normalized fields (same url/external id, so a re-arrival is an update). */
async function store(/** @type {any} */ rec, /** @type {string|null} */ status = null) {
  const r = await client.query(
    `INSERT INTO ic_job_listings
       (title, company, status, url, url_normalized, source, external_id, record_kind, location, company_norm, title_norm, location_norm, dedup_hash, first_seen, last_seen, prescore)
     VALUES ($1,$2,$3,$4,$4,$5,$6,'listing',$7,$8,$9,$10,$11, now(), now(), 50) RETURNING id`,
    [rec.title, rec.company, status, rec.url_normalized, rec.source, rec.external_id, rec.location, rec.company_norm, rec.title_norm, rec.location_norm, rec.dedup_hash],
  );
  const id = Number(r.rows[0].id);
  createdIds.push(id);
  return id;
}

async function cleanup() {
  const byCo = (await client.query("SELECT id FROM ic_job_listings WHERE company LIKE '%' || $1", [CO_SUFFIX])).rows.map((r) => Number(r.id));
  const ids = [...new Set([...createdIds, ...byCo])];
  if (ids.length) {
    await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [ids]);
    await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  createdIds.length = 0;
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

const ctx = (/** @type {any} */ o = {}) => ({ runId: null, now: new Date(), prescore: 50, ...o });

/** Run one rec through classify + applyDecision, as the scan loop does. */
async function ingest(/** @type {any} */ rec, /** @type {any} */ o = {}) {
  const decision = await classify(rec, makePgLookups(client), {});
  const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, ctx(o)));
  createdIds.push(applied.id);
  return { applied, decision };
}

const statusRow = async (/** @type {number} */ id) => (await client.query('SELECT status, marked_at FROM ic_job_listings WHERE id = $1', [id])).rows[0];
const statusEvents = async (/** @type {number} */ id) => (await listEvents(client, id)).filter((e) => e.kind === 'status');
const openQueue = async (/** @type {number} */ id) => (await client.query('SELECT id FROM ic_job_review_queue WHERE candidate_id = $1 AND resolved_at IS NULL', [id])).rows;

describe('titleGateBlock: total classification of a row the gate may or may not touch', () => {
  const base = { status: null, recordKind: 'listing', duplicateOf: null, hasApplication: false, statusActor: null, hasOpenReview: false };
  test('free rows: null status, auto-set new/maybe, review without an open item', () => {
    assert.equal(titleGateBlock(base), null);
    assert.equal(titleGateBlock({ ...base, status: 'new', statusActor: 'auto' }), null);
    assert.equal(titleGateBlock({ ...base, status: 'maybe', statusActor: 'auto' }), null);
    assert.equal(titleGateBlock({ ...base, status: 'review' }), null);
  });
  test('protected rows each name their reason', () => {
    assert.equal(titleGateBlock({ ...base, hasApplication: true }), 'has_application');
    assert.equal(titleGateBlock({ ...base, status: 'new', statusActor: 'dashboard' }), 'human_status');
    assert.equal(titleGateBlock({ ...base, status: 'new', statusActor: 'apply' }), 'human_status');
    assert.equal(titleGateBlock({ ...base, status: 'new', statusActor: null }), 'status_no_event');
    assert.equal(titleGateBlock({ ...base, status: 'applied', statusActor: 'auto' }), 'status');
    assert.equal(titleGateBlock({ ...base, status: 'passed', statusActor: 'dashboard' }), 'status');
    assert.equal(titleGateBlock({ ...base, status: 'skip', statusActor: 'auto' }), 'already_skip');
    assert.equal(titleGateBlock({ ...base, duplicateOf: 3 }), 'duplicate');
    assert.equal(titleGateBlock({ ...base, recordKind: 'note' }), 'not_listing');
    assert.equal(titleGateBlock({ ...base, status: 'review', hasOpenReview: true }), 'open_review');
    assert.equal(titleGateBlock({ ...base, statusActor: 'dashboard' }), 'human_status', 'null status but a human last touched it');
  });
});

describe('scan ingest: a dropped title is skipped by auto and never queued', () => {
  test('new listing, Director level: status skip, one auto status event with the reason, no queue row', async () => {
    const { applied } = await ingest(makeRec('Director of IT', 'Aardvark'));
    assert.equal(applied.titleGate, 'director_level');
    assert.equal(applied.status, 'skip');
    assert.equal(applied.queued, null);
    const row = await statusRow(applied.id);
    assert.equal(row.status, 'skip');
    assert.ok(row.marked_at);
    const ev = await statusEvents(applied.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor, 'auto');
    assert.equal(ev[0].to_status, 'skip');
    assert.ok(ev[0].note?.startsWith(`${TITLE_GATE_NOTE_PREFIX}director_level`), ev[0].note ?? '');
  });

  test('new listing, non-technology function: skipped with reason non_tech_function', async () => {
    const { applied } = await ingest(makeRec('Chief Financial Officer', 'Bison'));
    assert.equal(applied.titleGate, 'non_tech_function');
    assert.equal((await statusRow(applied.id)).status, 'skip');
  });

  test('a passing title is untouched: status stays null, no gate event', async () => {
    const { applied } = await ingest(makeRec('Senior Director, Technology', 'Cheetah'));
    assert.equal(applied.titleGate, null);
    assert.equal((await statusRow(applied.id)).status, null);
    assert.equal((await statusEvents(applied.id)).length, 0);
  });

  test('an ambiguous pair that would be queued is not queued when the title drops', async () => {
    await store(makeRec('Director of IT Lead', 'Dingo'));
    const rec = makeRec('Director of IT', 'Dingo');
    const decision = await classify(rec, makePgLookups(client), {});
    assert.equal(decision.queue, true, 'premise: classify wants a queue row');
    const applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, ctx()));
    createdIds.push(applied.id);
    assert.equal(applied.titleGate, 'director_level');
    assert.equal(applied.queued, null);
    assert.equal((await openQueue(applied.id)).length, 0);
    assert.equal((await statusRow(applied.id)).status, 'skip');
  });

  test('re-arriving listing (same url) with no status is skipped', async () => {
    const rec = makeRec('Dir, Engineering', 'Emu');
    const id = await store(rec);
    const { applied, decision } = await ingest(rec);
    assert.equal(decision.outcome, 'update', 'premise');
    assert.equal(applied.id, id);
    assert.equal(applied.titleGate, 'director_level');
    assert.equal((await statusRow(id)).status, 'skip');
  });

  test('re-arriving listing already skipped is not skipped twice', async () => {
    const rec = makeRec('Director of IT', 'Falcon');
    const id = await store(rec, 'skip');
    await recordEvent(client, { listingId: id, kind: 'status', toStatus: 'skip', actor: 'auto' });
    const { applied } = await ingest(rec);
    assert.equal(applied.titleGate, null);
    assert.equal((await statusEvents(id)).length, 1);
  });

  test('never downgrades a row whose latest status event is by a human', async () => {
    const rec = makeRec('Director of IT', 'Gecko');
    const id = await store(rec, 'shortlisted');
    await recordEvent(client, { listingId: id, kind: 'status', toStatus: 'shortlisted', actor: 'dashboard' });
    const { applied } = await ingest(rec);
    assert.equal(applied.titleGate, null);
    assert.equal((await statusRow(id)).status, 'shortlisted');
    assert.equal((await statusEvents(id)).length, 1, 'no new status event');
  });

  test('never downgrades a row that has an application row', async () => {
    const rec = makeRec('Director of IT', 'Heron');
    const id = await store(rec);
    await createApplication(client, { listingId: id, actor: 'mcp' });
    const { applied } = await ingest(rec);
    assert.equal(applied.titleGate, null);
    assert.equal((await statusRow(id)).status, null);
  });

  test('bin/title-gate-backfill.js defaults to a dry run: lists the row, writes nothing', async () => {
    const id = await store(makeRec('Associate Director, Data', 'Jackal'));
    const out = spawnSync(process.execPath, ['bin/title-gate-backfill.js'], { encoding: 'utf8', env: process.env });
    assert.equal(out.status, 0, out.stderr + out.stdout);
    assert.match(out.stdout, /DRY RUN/);
    assert.match(out.stdout, /director_level: would skip \d+/);
    assert.match(out.stdout, /dry run, no writes performed/);
    assert.equal((await statusRow(id)).status, null, 'dry run changed nothing');
    assert.equal((await statusEvents(id)).length, 0);
  });

  test('applyTitleGate dryRun classifies without writing', async () => {
    const id = await store(makeRec('Director of IT', 'Ibis'));
    const r = await applyTitleGate(client, id, { dryRun: true });
    assert.deepEqual([r.verdict, r.reason, r.applied, r.blocked], ['drop', 'director_level', false, null]);
    assert.equal((await statusRow(id)).status, null);
    assert.equal((await statusEvents(id)).length, 0);
  });
});
