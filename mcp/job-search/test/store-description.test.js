// @ts-check
/**
 * src/core/store-description.js: the single description chokepoint (detail-block fix, S4). Real test DB.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { storeDescription, screenPayload, purgeJunkDescription, DETAIL_OUTCOME_VALUES, outcomeForClass } from '../src/core/store-description.js';
import { insertListing, updateListing } from '../src/core/upsert.js';
import { normalizeListing } from '../src/core/normalize.js';

const TAG = `zz-test-storedesc-${process.pid}`;
const JUNK = 'Additional Verification Required Your Ray ID for this request is a401b81afaf76bd8 Return home -> Troubleshooting Cloudflare Errors';
const SENT = 'The Chief Information Security Officer will own the security program, report to the CEO, and lead a team across cloud, identity and governance. ';
const GOOD = `About the role. Responsibilities include strategy and delivery. Requirements: ten years of experience. ${SENT.repeat(8)}`;

describe('store-description (real DB)', () => {
  /** @type {pg.Client} */
  let client;
  /** @type {number[]} */
  const ids = [];

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
  });
  after(async () => {
    if (ids.length) {
      await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
    }
    await client.end();
  });

  /** @param {{ description?: string|null, detail_outcome?: string|null, detail_attempts?: number }} [o] */
  async function seed(o = {}) {
    const n = Math.floor(Math.random() * 1e9);
    const r = await client.query(
      `INSERT INTO ic_job_listings
         (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
          last_seen, status, url, url_normalized, prescore, remote_mode, remote_declared, description, detail_outcome, detail_attempts, fit_score, fit_basis)
       VALUES ('Store Desc Role', $1, 'indeed', $2, 'listing', $3, 'store desc role', 'legacy-unknown', $4,
          now(), 'new', $5, $5, 50, 'onsite', false, $6, $7, $8, 77, 'description')
       RETURNING id`,
      [`${TAG}-${n}`, `zz-sd-${n}`, `zz-sd-cn-${n}`, `zz-sd-hash-${n}`, `https://www.indeed.com/viewjob?jk=zz${n}`, o.description ?? null, o.detail_outcome ?? null, o.detail_attempts ?? 0],
    );
    const id = Number(r.rows[0].id);
    ids.push(id);
    return id;
  }
  const row = async (/** @type {number} */ id) => (await client.query('SELECT description, description_hash, detail_outcome, detail_attempts FROM ic_job_listings WHERE id = $1', [id])).rows[0];
  const events = async (/** @type {number} */ id) => (await client.query(`SELECT kind, actor, note FROM ic_job_events WHERE listing_id = $1 ORDER BY id`, [id])).rows;

  test('outcome constant covers every class plus the pre-existing values', () => {
    for (const v of ['fetched', 'empty', 'error', 'skipped_budget', 'skipped_gate', 'skipped_cancelled', 'not_queued', 'transient', 'too_short', 'unverified', 'blocked:cloudflare_challenge', 'blocked:indeed_verification', 'blocked:captcha', 'blocked:login_wall', 'blocked:http_403']) {
      assert.ok(DETAIL_OUTCOME_VALUES.includes(v), v);
    }
    assert.equal(outcomeForClass('ok'), 'fetched');
    assert.equal(outcomeForClass('blocked:captcha'), 'blocked:captcha');
  });

  test('ok text is written, outcome fetched, attempts reset, hash set', async () => {
    const id = await seed({ detail_outcome: 'empty', detail_attempts: 2 });
    const res = await storeDescription(client, id, GOOD, { source: 'indeed' });
    assert.equal(res.ok, true);
    assert.equal(res.stored, true);
    const r = await row(id);
    assert.equal(r.description, GOOD);
    assert.equal(r.detail_outcome, 'fetched');
    assert.equal(r.detail_attempts, 0);
    assert.ok(r.description_hash);
  });

  test('the real 12921 junk is not written: description stays NULL, outcome blocked, audit row holds the text', async () => {
    const id = await seed();
    const res = await storeDescription(client, id, JUNK, { source: 'indeed' });
    assert.equal(res.ok, false);
    assert.match(res.cls, /^blocked:/);
    const r = await row(id);
    assert.equal(r.description, null);
    assert.equal(r.detail_outcome, res.cls);
    assert.equal(r.detail_attempts, 0, 'a block never uses up the listing\'s attempts');
    const ev = await events(id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].kind, 'note');
    assert.equal(ev[0].actor, 'auto');
    assert.ok(ev[0].note.includes('a401b81afaf76bd8'));
  });

  test('audit note keeps only the first 500 chars', async () => {
    const id = await seed();
    await storeDescription(client, id, `Access denied. ${'x'.repeat(2000)}`, {});
    const ev = await events(id);
    assert.ok(ev[0].note.length < 600, String(ev[0].note.length));
  });

  test('overwrite-junk: an existing junk description is replaced by ok text', async () => {
    const id = await seed({ description: JUNK, detail_outcome: 'empty', detail_attempts: 1 });
    const res = await storeDescription(client, id, GOOD, { onlyIfMissing: true });
    assert.equal(res.stored, true);
    assert.equal(res.replacedJunk, true);
    assert.equal((await row(id)).description, GOOD);
  });

  test('overwrite-junk: an existing junk description is cleared by a non-ok fetch', async () => {
    const id = await seed({ description: JUNK, detail_outcome: 'empty' });
    const res = await storeDescription(client, id, 'Please verify you are a human.', {});
    assert.equal(res.replacedJunk, true);
    const r = await row(id);
    assert.equal(r.description, null);
    assert.match(r.detail_outcome, /^blocked:/);
  });

  test('a good existing description survives a blocked refetch and keeps its outcome', async () => {
    const id = await seed({ description: GOOD, detail_outcome: 'fetched' });
    const res = await storeDescription(client, id, JUNK, {});
    assert.equal(res.stored, false);
    const r = await row(id);
    assert.equal(r.description, GOOD);
    assert.equal(r.detail_outcome, 'fetched');
    assert.equal((await events(id)).length, 1);
  });

  test('onlyIfMissing keeps a good existing description', async () => {
    const id = await seed({ description: GOOD, detail_outcome: 'fetched' });
    const res = await storeDescription(client, id, `${GOOD} extra`, { onlyIfMissing: true });
    assert.equal(res.stored, false);
    assert.equal((await row(id)).description, GOOD);
  });

  test('transient does not count an attempt; too_short does', async () => {
    const a = await seed();
    await storeDescription(client, a, '', { httpStatus: 429 });
    let r = await row(a);
    assert.equal(r.detail_outcome, 'transient');
    assert.equal(r.detail_attempts, 0);
    const b = await seed();
    await storeDescription(client, b, 'A short legitimate stub about the role.', {});
    r = await row(b);
    assert.equal(r.detail_outcome, 'too_short');
    assert.equal(r.detail_attempts, 1);
    assert.equal(r.description, null);
  });

  test('screenPayload: list-supplied short snippets pass, blocked and detail-fetched short text do not', () => {
    const rec = { description: 'Short list snippet.', description_hash: 'h' };
    assert.equal(screenPayload(rec, null).description, 'Short list snippet.');
    assert.equal(screenPayload(rec, 'not_queued').description, 'Short list snippet.');
    const fetched = screenPayload(rec, 'fetched');
    assert.equal(fetched.description, null);
    assert.equal(fetched.detailOutcome, 'too_short');
    const blocked = screenPayload({ description: JUNK, description_hash: 'h' }, 'not_queued');
    assert.equal(blocked.description, null);
    assert.equal(blocked.description_hash, null);
    assert.ok(blocked.rejected);
  });

  test('purgeJunkDescription clears blocked text only, never a short snippet', async () => {
    const junkId = await seed({ description: JUNK, detail_outcome: 'empty' });
    assert.match(String(await purgeJunkDescription(client, junkId)), /^blocked:/);
    assert.equal((await row(junkId)).description, null);
    const snippetId = await seed({ description: 'Short snippet.', detail_outcome: 'not_queued' });
    assert.equal(await purgeJunkDescription(client, snippetId), null);
    assert.equal((await row(snippetId)).description, 'Short snippet.');
    const goodId = await seed({ description: GOOD });
    assert.equal(await purgeJunkDescription(client, goodId), null);
  });

  describe('upsert path (insertListing / updateListing)', () => {
    /** @param {string|null} description */
    function recFor(description) {
      const n = Math.floor(Math.random() * 1e9);
      return normalizeListing({ title: 'Store Desc Upsert Role', company: `${TAG}-up-${n}`, url: `https://www.indeed.com/viewjob?jk=zzup${n}`, location: 'Houston, TX', source: 'indeed', description });
    }
    const decisionNew = /** @type {any} */ ({ outcome: 'new', rootId: null, repostOf: null, inherit: null, queue: false });

    test('insert with a junk detail payload stores NULL, a blocked outcome and an audit row', async () => {
      const rec = recFor(JUNK);
      const { id } = await insertListing(client, rec, decisionNew, { runId: null, detailOutcome: 'fetched' });
      ids.push(id);
      const r = await row(id);
      assert.equal(r.description, null);
      assert.match(r.detail_outcome, /^blocked:/);
      assert.equal((await events(id)).length, 1);
    });

    test('insert with a good payload keeps it', async () => {
      const rec = recFor(GOOD);
      const { id } = await insertListing(client, rec, decisionNew, { runId: null, detailOutcome: 'fetched' });
      ids.push(id);
      assert.ok((await row(id)).description);
    });

    test('update with no payload clears a stored junk description; with an ok payload replaces it', async () => {
      const id = await seed({ description: JUNK, detail_outcome: 'empty' });
      const target = /** @type {any} */ ({ id });
      const decision = /** @type {any} */ ({ outcome: 'update', branch: 'fit-sweep', target, inherit: null });
      await updateListing(client, recFor(null), decision, { runId: null, detailOutcome: 'not_queued' }, { bumpTimesSeen: false });
      assert.equal((await row(id)).description, null);
      const id2 = await seed({ description: JUNK, detail_outcome: 'empty' });
      await updateListing(client, recFor(GOOD), /** @type {any} */ ({ outcome: 'update', branch: 'fit-sweep', target: { id: id2 }, inherit: null }), { runId: null, detailOutcome: 'fetched' }, { bumpTimesSeen: false });
      const r2 = await row(id2);
      assert.equal(r2.description, normalizeListing({ title: 't', company: 'c', url: 'https://www.indeed.com/viewjob?jk=1', source: 'indeed', description: GOOD }).description);
      assert.equal(r2.detail_outcome, 'fetched');
    });

    test('update with a blocked payload from a detail fetch records the block and never writes the text', async () => {
      const id = await seed();
      await updateListing(client, recFor(JUNK), /** @type {any} */ ({ outcome: 'update', branch: 'fit-sweep', target: { id }, inherit: null }), { runId: null, detailOutcome: 'fetched' }, { bumpTimesSeen: false });
      const r = await row(id);
      assert.equal(r.description, null);
      assert.match(r.detail_outcome, /^blocked:/);
    });
  });
});
