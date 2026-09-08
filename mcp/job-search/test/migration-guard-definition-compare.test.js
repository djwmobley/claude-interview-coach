// @ts-check
/**
 * ic_ensure_widened_check() (defined in sql/009_pipeline_events_documents.sql, used by sql/009, 011, and
 * both widen sites in sql/012_applications.sql): the shared helper that replaced the name-keyed CHECK
 * guard responsible for the 2026-09-06 incident. See sql/009's own doc comment on the function for the
 * failure mode: a name-keyed guard in sql/011 only checked "does a constraint named
 * ic_job_events_actor_auto_check already exist" -- when sql/012 had already widened the same column under
 * a DIFFERENT name (ic_job_events_actor_apply_check), a later run of sql/011 alone (a plain server
 * startup, via ensureAuxSchema) decided nothing covered it yet, dropped the wider constraint, and
 * reinstalled its own narrower one -- which then failed outright because a live row already carried
 * actor='apply', a value the narrower constraint rejects.
 *
 * Two scenarios, matching the fix's own test requirements:
 *   (a) against the real, shared ic_job_events table (already fully migrated by bin/bootstrap-test-db.js's
 *       MIGRATIONS list, which applies 011 before 012): insert an actor='apply' row, then re-run 011,
 *       009, and 012's SQL text directly -- each must be a no-op, the wide constraint must survive intact,
 *       and no error may be raised.
 *   (b) against a private scratch table this file creates and drops itself (never the shared
 *       ic_job_events table -- narrowing that mid-suite would break every other test file's actor/kind
 *       inserts, per test/migration-011.test.js's and test/migration-012.test.js's own established rule):
 *       starting with NO check constraint on the column at all, calling ic_ensure_widened_check() with
 *       011's target set installs it, and a second call with 012's wider target set widens it further.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');
const SQL_009 = fs.readFileSync(path.join(SQL_DIR, '009_pipeline_events_documents.sql'), 'utf8');
const SQL_011 = fs.readFileSync(path.join(SQL_DIR, '011_triage_actor.sql'), 'utf8');
const SQL_012 = fs.readFileSync(path.join(SQL_DIR, '012_applications.sql'), 'utf8');

const CO = `ZZ-TEST-MIGGUARD-${process.pid}`;
const SCRATCH_TABLE = `zz_test_migguard_scratch_${process.pid}`;
/** @type {pg.Client} */
let client;

/** @param {string} actor */
async function insertEventRow(actor) {
  const n = Math.floor(Math.random() * 1e9);
  const listing = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Migration Guard Test', $1, $2, $3, 'listing', 'migguard test co', 'migguard test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-migguard-${process.pid}`, `zz-test-migguard-${process.pid}:${n}`, `zz-migguard-hash-${n}`],
  );
  const listingId = Number(listing.rows[0].id);
  await client.query(`INSERT INTO ic_job_events (listing_id, kind, to_status, actor) VALUES ($1, 'status', 'new', $2)`, [listingId, actor]);
  return listingId;
}

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [CO])).rows.map((r) => r.id);
  if (ids.length === 0) return;
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await cleanup();
  // Belt and braces, matching migration-011.test.js's and migration-012.test.js's own pattern: make sure
  // the shared column is at least as wide as 012 leaves it before this file's own assertions run. Always
  // a no-op or a widen, never a narrow.
  await client.query(SQL_009);
  await client.query(SQL_011);
  await client.query(SQL_012);
});

after(async () => {
  await cleanup();
  await client.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
  await client.query(`DROP TABLE IF EXISTS zz_test_migguard_compound_${process.pid}`);
  await client.end();
});

describe('ic_ensure_widened_check against the real ic_job_events.actor column (scenario a)', () => {
  test('an actor="apply" row exists, then re-running 011, 009, and 012 is a no-op with no error', async () => {
    const id = await insertEventRow('apply');

    await assert.doesNotReject(client.query(SQL_011), 're-running sql/011 after sql/012 has already widened the column must not error');
    await assert.doesNotReject(client.query(SQL_009), 're-running sql/009 must not error');
    await assert.doesNotReject(client.query(SQL_012), 're-running sql/012 must not error');

    // The row inserted before the re-runs must still be there and still readable -- if the old
    // name-keyed guard had narrowed the constraint back and the ADD CONSTRAINT failed mid-DO-block, the
    // enclosing BEGIN/COMMIT in each file would still leave prior statements in that same file committed,
    // but subsequent files (and any query on the same connection afterward) would fail with 25P02 until
    // the client's transaction was cleared -- proven here by simply continuing to use `client`.
    const row = await client.query('SELECT actor FROM ic_job_events WHERE listing_id = $1', [id]);
    assert.equal(row.rows[0].actor, 'apply');

    const actorConstraints = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'ic_job_events' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%actor%'
    `);
    assert.equal(actorConstraints.rowCount, 1, 'exactly one CHECK constraint must remain on actor');
    assert.equal(actorConstraints.rows[0].conname, 'ic_job_events_actor_apply_check', 'the wider (012) constraint must survive intact, not be replaced by 011\'s narrower one');

    // Every value 012 ever allowed, including 'apply', must still be accepted.
    for (const actor of ['dashboard', 'mcp', 'cli', 'migration', 'seed', 'auto', 'apply']) {
      await assert.doesNotReject(insertEventRow(actor), `actor="${actor}" must still be accepted after the re-runs`);
    }
  });
});

describe('ic_ensure_widened_check against a private scratch column (scenario b)', () => {
  before(async () => {
    await client.query(`DROP TABLE IF EXISTS ${SCRATCH_TABLE}`);
    await client.query(`CREATE TABLE ${SCRATCH_TABLE} (id serial PRIMARY KEY, actor text NOT NULL)`);
  });

  test('starting from no CHECK constraint at all: 011\'s target set installs one', async () => {
    const before_ = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c'
    `, [SCRATCH_TABLE]);
    assert.equal(before_.rowCount, 0, 'the scratch table must start with no CHECK constraint on actor');

    await client.query(
      `SELECT ic_ensure_widened_check($1, 'actor', 'zz_migguard_scratch_actor_auto_check', ARRAY['dashboard','mcp','cli','migration','seed','auto'])`,
      [SCRATCH_TABLE],
    );

    const after_ = await client.query(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c'
    `, [SCRATCH_TABLE]);
    assert.equal(after_.rowCount, 1);
    assert.equal(after_.rows[0].conname, 'zz_migguard_scratch_actor_auto_check');

    await assert.doesNotReject(client.query(`INSERT INTO ${SCRATCH_TABLE} (actor) VALUES ('auto')`));
    await assert.rejects(client.query(`INSERT INTO ${SCRATCH_TABLE} (actor) VALUES ('apply')`), /violates check constraint/i);
  });

  test('then 012\'s wider target set widens it further, under a different constraint name', async () => {
    await client.query(
      `SELECT ic_ensure_widened_check($1, 'actor', 'zz_migguard_scratch_actor_apply_check', ARRAY['dashboard','mcp','cli','migration','seed','auto','apply'])`,
      [SCRATCH_TABLE],
    );

    const after_ = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c'
    `, [SCRATCH_TABLE]);
    assert.equal(after_.rowCount, 1, 'the narrower constraint must have been dropped, not left alongside the wider one');
    assert.equal(after_.rows[0].conname, 'zz_migguard_scratch_actor_apply_check');

    await assert.doesNotReject(client.query(`INSERT INTO ${SCRATCH_TABLE} (actor) VALUES ('apply')`));

    // And critically: re-applying 011's OWN (narrower) call again now must be a no-op, never a regression
    // back to the narrower constraint -- this is the exact bug this whole change fixes.
    await client.query(
      `SELECT ic_ensure_widened_check($1, 'actor', 'zz_migguard_scratch_actor_auto_check', ARRAY['dashboard','mcp','cli','migration','seed','auto'])`,
      [SCRATCH_TABLE],
    );
    const final = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c'
    `, [SCRATCH_TABLE]);
    assert.equal(final.rowCount, 1);
    assert.equal(final.rows[0].conname, 'zz_migguard_scratch_actor_apply_check', 're-running the narrower widen after the wider one must not regress the constraint');
    await assert.doesNotReject(client.query(`INSERT INTO ${SCRATCH_TABLE} (actor) VALUES ('apply')`), 'the wide constraint must still accept apply after the narrower re-run');
  });
});

describe('a compound multi-column CHECK is recognized as non-canonical and replaced, never treated as covering', () => {
  // ic_ensure_widened_check() first requires an existing CHECK's pg_get_constraintdef() text to match one
  // of a small set of canonical single-column enumeration shapes (col = ANY (ARRAY[...]), its cast
  // variant, col = 'v'::type, or col IN (...)), each anchored to the WHOLE definition -- only THEN does it
  // extract and compare literal values. A compound constraint that ORs an unrelated column's equality test
  // alongside the real actor list does not match any of those shapes (it contains OR and a second column),
  // so it is never treated as covering regardless of which literals happen to appear inside it -- it is
  // classified as not covering (with a RAISE NOTICE naming the constraint and why) and replaced.
  const SCRATCH2 = `zz_test_migguard_compound_${process.pid}`;

  before(async () => {
    await client.query(`DROP TABLE IF EXISTS ${SCRATCH2}`);
    await client.query(`CREATE TABLE ${SCRATCH2} (id serial PRIMARY KEY, actor text NOT NULL, note text)`);
    // A row is valid if actor is one of the 6 narrow values, OR note is literally 'apply'. 'apply' here
    // constrains note, not actor -- an actor='apply' row is rejected unless note also happens to be
    // 'apply', which is not what "actor accepts apply" means. Both actor and note are in this
    // constraint's conkey, so the lookup-by-column in ic_ensure_widened_check finds it under p_column =
    // 'actor'.
    await client.query(`
      ALTER TABLE ${SCRATCH2} ADD CONSTRAINT zz_migguard_compound_check CHECK (
        (actor = ANY (ARRAY['dashboard','mcp','cli','migration','seed','auto']::text[]))
        OR (note = 'apply'::text)
      )
    `);
  });

  test('the compound constraint is dropped and replaced with the real widen, not left in place', async () => {
    // Ground truth first: actor='apply' with an unrelated note is in fact rejected today.
    await assert.rejects(
      client.query(`INSERT INTO ${SCRATCH2} (actor, note) VALUES ('apply', 'unrelated')`),
      /violates check constraint/i,
      'sanity check: the compound constraint does not actually accept actor=apply in general',
    );

    // Ask the helper to ensure the same widen 012 applies for real (adds 'apply' to actor's target set).
    // Because the existing constraint's shape is not one of the recognized canonical forms, the helper
    // must classify it as not covering and replace it, regardless of which literals it happens to contain.
    await client.query(
      `SELECT ic_ensure_widened_check($1, 'actor', 'zz_migguard_compound_apply_check', ARRAY['dashboard','mcp','cli','migration','seed','auto','apply'])`,
      [SCRATCH2],
    );

    const after_ = await client.query(`
      SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.contype = 'c'
    `, [SCRATCH2]);
    assert.equal(after_.rowCount, 1, 'the compound constraint must have been dropped, and exactly one canonical constraint installed in its place');
    assert.equal(after_.rows[0].conname, 'zz_migguard_compound_apply_check', 'the non-canonical compound constraint must be replaced by the real widen, never left in place');

    // And the practical consequence: actor='apply' now genuinely succeeds regardless of note.
    await assert.doesNotReject(
      client.query(`INSERT INTO ${SCRATCH2} (actor, note) VALUES ('apply', 'still-unrelated')`),
      'actor=apply must now be accepted unconditionally -- the widen actually took effect',
    );
  });
});

describe('ic_ensure_widened_check is schema-qualified: a same-named table in another schema cannot fool it', () => {
  // Before schema-qualification, the constraint lookup joined pg_class on an unqualified t.relname, so a
  // second table sharing p_table's name in a different schema on the search path could be picked up by
  // that join -- a wide canonical constraint on the OTHER schema's same-named table's same-named column
  // would be misread as covering the actually-targeted table, leaving the real target's own (narrower)
  // constraint untouched. p_schema now defaults to current_schema() and is used in both the pg_namespace
  // filter and the schema-qualified ALTER TABLE target.
  const SCRATCH_NAME = `zz_test_migguard_schema_${process.pid}`;
  const OTHER_SCHEMA = `zz_test_migguard_otherschema_${process.pid}`;

  before(async () => {
    await client.query(`DROP TABLE IF EXISTS public.${SCRATCH_NAME}`);
    await client.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${OTHER_SCHEMA}`);

    // public.<name>: narrow constraint (the actual target).
    await client.query(`CREATE TABLE public.${SCRATCH_NAME} (id serial PRIMARY KEY, actor text NOT NULL)`);
    await client.query(`ALTER TABLE public.${SCRATCH_NAME} ADD CONSTRAINT zz_migguard_schema_public_narrow CHECK (actor IN ('dashboard','mcp'))`);

    // <other schema>.<same name>: already has the exact wide canonical constraint this test asks for.
    await client.query(`CREATE TABLE ${OTHER_SCHEMA}.${SCRATCH_NAME} (id serial PRIMARY KEY, actor text NOT NULL)`);
    await client.query(`ALTER TABLE ${OTHER_SCHEMA}.${SCRATCH_NAME} ADD CONSTRAINT zz_migguard_schema_other_wide CHECK (actor IN ('dashboard','mcp','cli','migration','seed','auto','apply'))`);
  });

  after(async () => {
    await client.query(`DROP TABLE IF EXISTS public.${SCRATCH_NAME}`);
    await client.query(`DROP SCHEMA IF EXISTS ${OTHER_SCHEMA} CASCADE`);
  });

  test('the public table is still widened for real, and the other schema\'s table is left untouched', async () => {
    // p_schema defaults to current_schema() (this test connection's search_path is the ordinary default,
    // 'public'), so this call targets public.<name>, not <other schema>.<name>, even though both tables
    // share the same bare name.
    await client.query(
      `SELECT ic_ensure_widened_check($1, 'actor', 'zz_migguard_schema_public_wide', ARRAY['dashboard','mcp','cli','migration','seed','auto','apply'])`,
      [SCRATCH_NAME],
    );

    const pub = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [`public.${SCRATCH_NAME}`]);
    assert.equal(pub.rowCount, 1);
    assert.equal(pub.rows[0].conname, 'zz_migguard_schema_public_wide', 'the public table\'s narrow constraint must have been replaced by the real widen, not skipped because the other schema already looked wide');
    await assert.doesNotReject(client.query(`INSERT INTO public.${SCRATCH_NAME} (actor) VALUES ('apply')`), 'the public table must genuinely accept apply now');

    const other = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [`${OTHER_SCHEMA}.${SCRATCH_NAME}`]);
    assert.equal(other.rowCount, 1);
    assert.equal(other.rows[0].conname, 'zz_migguard_schema_other_wide', 'the other schema\'s table must be completely untouched -- neither dropped nor renamed');
  });
});
