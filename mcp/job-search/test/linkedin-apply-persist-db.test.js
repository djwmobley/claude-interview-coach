// @ts-check
/**
 * src/apply/linkedin-button-prepare.js's persistLinkedInApplyState against the real isolated test DB (spec
 * v1 F1.1, v2 B4/B6/B7): the SQL each branch writes actually runs, the closed branch sets expired_at, the
 * already_applied branch marks a pre-application listing 'applied' with a status event (and leaves a later
 * status alone), easy_apply clears stale target fields, and load_failure never increments probe_attempts.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { persistLinkedInApplyState } from '../src/apply/linkedin-button-prepare.js';

const TAG = `ZZ-TEST-LIPERSIST-${process.pid}`;
const NOW = new Date('2026-10-06T12:00:00Z');
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const ids = [];

/** @param {{ status?: string|null, applyUrl?: string|null, applyAts?: string|null, hint?: unknown }} [o] */
async function seed(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const url = `https://www.linkedin.com/jobs/view/8${n}/`;
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen,
       url, url_normalized, status, apply_url, apply_ats, apply_ats_confidence, apply_ats_hint, probe_attempts)
     VALUES ('Persist Test', $1, 'linkedin', $2, 'listing', $3, 'persist test', 'country-us', $4, now(), $5, $5, $6, $7, $8, $9, $10, 0) RETURNING id`,
    [TAG, `zz-lipersist-${process.pid}:${n}`, `lipersist co ${n}`, `zz-lipersist-hash-${n}`, url, o.status === undefined ? 'new' : o.status,
      o.applyUrl ?? null, o.applyAts ?? null, o.applyAts ? 'exact' : null, o.hint ? JSON.stringify(o.hint) : null],
  );
  const id = Number(r.rows[0].id);
  ids.push(id);
  return { id, url: null, url_normalized: url, apply_probed_at: null, probe_attempts: 0 };
}

/** @param {number} id */
async function row(id) {
  return (await client.query('SELECT * FROM ic_job_listings WHERE id = $1', [id])).rows[0];
}

const OPTS = { now: NOW, countAttempt: true, resolveExternal: true, probeRegistry: null, reprobeAfterHours: 48, tripBreaker: async () => {} };

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
});

after(async () => {
  if (ids.length) {
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await client.end();
});

describe('persistLinkedInApplyState (real DB)', () => {
  test('easy_apply: apply_easy_only true, linkedin_easy inferred, stale apply_url and hint cleared, attempt counted', async () => {
    const l = await seed({ applyUrl: 'https://boards.greenhouse.io/x/jobs/1', applyAts: 'greenhouse', hint: { companyName: 'x' } });
    const r = await persistLinkedInApplyState(client, l, { branch: 'easy_apply' }, /** @type {any} */ (OPTS));
    assert.equal(r.outcome, 'resolved');
    const x = await row(l.id);
    assert.equal(x.apply_easy_only, true);
    assert.equal(x.apply_url, null);
    assert.equal(x.apply_ats, 'linkedin_easy');
    assert.equal(x.apply_ats_confidence, 'inferred');
    assert.equal(x.apply_ats_hint, null);
    assert.equal(x.probe_attempts, 1);
  });

  test('closed: expired_at set, apply_easy_only false', async () => {
    const l = await seed();
    await persistLinkedInApplyState(client, l, { branch: 'closed' }, /** @type {any} */ (OPTS));
    const x = await row(l.id);
    assert.ok(x.expired_at);
    assert.equal(x.apply_easy_only, false);
  });

  test('already_applied: a pre-application listing becomes applied with one status event; a later status is left alone', async () => {
    const l = await seed({ status: 'shortlisted' });
    await persistLinkedInApplyState(client, l, { branch: 'already_applied' }, /** @type {any} */ (OPTS));
    assert.equal((await row(l.id)).status, 'applied');
    const ev = await client.query(`SELECT to_status, actor FROM ic_job_events WHERE listing_id = $1 AND kind = 'status'`, [l.id]);
    assert.deepEqual(ev.rows.map((e) => [e.to_status, e.actor]), [['applied', 'apply']]);

    const later = await seed({ status: 'interviewing' });
    await persistLinkedInApplyState(client, later, { branch: 'already_applied' }, /** @type {any} */ (OPTS));
    assert.equal((await row(later.id)).status, 'interviewing');
  });

  test('load_failure: apply_probed_at set, probe_attempts unchanged (spec v2 B7)', async () => {
    const l = await seed();
    await persistLinkedInApplyState(client, l, { branch: 'load_failure' }, /** @type {any} */ (OPTS));
    const x = await row(l.id);
    assert.ok(x.apply_probed_at);
    assert.equal(x.probe_attempts, 0);
  });

  test('unknown and no_control: apply_easy_only false, attempt counted', async () => {
    for (const branch of ['unknown', 'no_control']) {
      const l = await seed();
      await persistLinkedInApplyState(client, l, { branch }, /** @type {any} */ (OPTS));
      const x = await row(l.id);
      assert.equal(x.apply_easy_only, false, branch);
      assert.equal(x.probe_attempts, 1, branch);
    }
  });

  test('check mode (countAttempt false): closed still sets expired_at without touching probe bookkeeping', async () => {
    const l = await seed();
    await persistLinkedInApplyState(client, l, { branch: 'closed' }, /** @type {any} */ ({ ...OPTS, countAttempt: false, resolveExternal: false }));
    const x = await row(l.id);
    assert.ok(x.expired_at);
    assert.equal(x.probe_attempts, 0);
    assert.equal(x.apply_probed_at, null);
  });
});
