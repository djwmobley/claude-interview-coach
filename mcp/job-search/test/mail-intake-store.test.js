// @ts-check
/**
 * ic_mail_intake persistence and queries (sql/029) against the throwaway test database: idempotent upsert,
 * rules_version reprocessing, display-field minimization, one review item per Gmail thread, the 25-item cap,
 * surfaced and dismissed handling.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  loadKnownMailIds, persistMailIntake, collectUnsurfacedItems, markSurfaced, listMailIntakeForDashboard, dismissMailIntake,
} from '../src/core/mail-intake-store.js';

const P = `zzmi${process.pid}x`;
/** @type {pg.Client} */
let client;

/** @param {string} n @param {Partial<import('../src/core/mail-intake-store.js').IntakeRow>} [over] @returns {import('../src/core/mail-intake-store.js').IntakeRow} */
function row(n, over = {}) {
  return {
    message_id: `${P}${n}`, thread_id: `${P}t${n}`, bucket: 'recruiter_like', signal: 'strong', from_addr: `s${n}@firm.example`, from_name: 'Sam', reply_to: null,
    reply_to_differs: false, subject: `Subject ${n}`, snippet: `Snippet ${n}`, msg_date: `2026-10-${String(10 + (Number(n) % 14)).padStart(2, '0')}T12:00:00.000Z`,
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'], spam: false, body_unreadable: false, ...over,
  };
}
const mine = (/** @type {Array<{ message_id: string }>} */ list) => list.filter((i) => i.message_id.startsWith(P));

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
});
beforeEach(async () => { await client.query('DELETE FROM ic_mail_intake WHERE message_id LIKE $1', [`${P}%`]); });
after(async () => {
  await client.query('DELETE FROM ic_mail_intake WHERE message_id LIKE $1', [`${P}%`]);
  await client.end();
});

describe('persistMailIntake', () => {
  test('writes rows and is idempotent for the same id', async () => {
    assert.equal(await persistMailIntake(client, [row('1'), row('2')], 'v1'), 2);
    assert.equal(await persistMailIntake(client, [row('1'), row('2')], 'v1'), 2);
    const n = (await client.query('SELECT count(*)::int AS n FROM ic_mail_intake WHERE message_id LIKE $1', [`${P}%`])).rows[0].n;
    assert.equal(n, 2);
  });

  test('an empty list writes nothing', async () => {
    assert.equal(await persistMailIntake(client, [], 'v1'), 0);
  });

  test('display fields are kept only for recruiter_like, thread_reply and unsorted', async () => {
    await persistMailIntake(client, [
      row('1', { bucket: 'bulk_noise', signal: null }), row('2', { bucket: 'unsorted', signal: null }), row('3', { bucket: 'thread_reply', signal: 'thread_reply' }),
      row('4', { bucket: 'application_mail', signal: null }),
    ], 'v1');
    const r = await client.query('SELECT message_id, bucket, subject, snippet, from_name, labels, from_addr FROM ic_mail_intake WHERE message_id LIKE $1 ORDER BY message_id', [`${P}%`]);
    const by = Object.fromEntries(r.rows.map((x) => [x.bucket, x]));
    assert.equal(by.bulk_noise.subject, null);
    assert.equal(by.bulk_noise.snippet, null);
    assert.deepEqual(by.bulk_noise.labels, []);
    assert.equal(by.bulk_noise.from_addr, 's1@firm.example', 'the sender address is kept for the top-sender counts');
    assert.equal(by.application_mail.subject, null);
    assert.equal(by.unsorted.subject, 'Subject 2');
    assert.equal(by.thread_reply.snippet, 'Snippet 3');
  });

  test('a reprocess under a new rules_version keeps first_seen_at, surfaced_run_id and status, and follows the new bucket', async () => {
    await persistMailIntake(client, [row('1', { bucket: 'unsorted', signal: null })], 'v1');
    await client.query(`UPDATE ic_mail_intake SET surfaced_run_id = 77, status = 'dismissed', first_seen_at = '2026-01-01T00:00:00Z' WHERE message_id = $1`, [`${P}1`]);
    await persistMailIntake(client, [row('1', { bucket: 'recruiter_like', signal: 'weak' })], 'v2');
    const r = (await client.query('SELECT bucket, signal, rules_version, surfaced_run_id, status, first_seen_at FROM ic_mail_intake WHERE message_id = $1', [`${P}1`])).rows[0];
    assert.deepEqual([r.bucket, r.signal, r.rules_version, Number(r.surfaced_run_id), r.status], ['recruiter_like', 'weak', 'v2', 77, 'dismissed']);
    assert.equal(new Date(r.first_seen_at).toISOString(), '2026-01-01T00:00:00.000Z');
  });

  test('the bucket vocabulary is closed', async () => {
    await assert.rejects(persistMailIntake(client, [row('1', { bucket: 'whatever' })], 'v1'), /check/i);
  });
});

describe('loadKnownMailIds (rules_version reprocessing)', () => {
  test('current-version rows are skipped; older unsorted and bulk_noise rows are reprocessed; settled buckets stay skipped', async () => {
    await persistMailIntake(client, [
      row('1', { bucket: 'unsorted', signal: null }), row('2', { bucket: 'bulk_noise', signal: null }), row('3', { bucket: 'self', signal: null }),
      row('4', { bucket: 'recruiter_like' }), row('5', { bucket: 'application_mail', signal: null }),
    ], 'v1');
    const same = await loadKnownMailIds(client, 'v1');
    for (const n of ['1', '2', '3', '4', '5']) assert.ok(same.has(`${P}${n}`), `v1 knows ${n}`);
    const next = await loadKnownMailIds(client, 'v2');
    assert.equal(next.has(`${P}1`), false, 'unsorted is reprocessed');
    assert.equal(next.has(`${P}2`), false, 'bulk_noise is reprocessed');
    for (const n of ['3', '4', '5']) assert.ok(next.has(`${P}${n}`), `settled bucket ${n} stays skipped`);
  });
});

describe('review items', () => {
  test('one item per Gmail thread: the newest message of the thread', async () => {
    await persistMailIntake(client, [
      row('1', { thread_id: `${P}tt`, msg_date: '2026-10-20T10:00:00.000Z', subject: 'older' }),
      row('2', { thread_id: `${P}tt`, msg_date: '2026-10-22T10:00:00.000Z', subject: 'newest' }),
      row('3', { thread_id: `${P}tt`, bucket: 'thread_reply', signal: 'thread_reply', msg_date: '2026-10-21T10:00:00.000Z', subject: 'middle' }),
    ], 'v1');
    const { items } = await collectUnsurfacedItems(client, 25);
    const m = mine(items);
    assert.equal(m.length, 1);
    assert.equal(m[0].subject, 'newest');
  });

  test('the cap: 25 items, the rest are a count', async () => {
    await persistMailIntake(client, Array.from({ length: 30 }, (_, i) => row(String(i + 100))), 'v1');
    const { items, more, total } = await collectUnsurfacedItems(client, 25);
    assert.equal(items.length, 25);
    assert.equal(more, total - 25);
    assert.ok(more >= 5);
  });

  test('items beyond the cap stay unsurfaced and appear in the next report once the first ones are marked', async () => {
    await persistMailIntake(client, Array.from({ length: 4 }, (_, i) => row(String(i + 200), { msg_date: `2026-10-2${i}T10:00:00.000Z` })), 'v1');
    const first = await collectUnsurfacedItems(client, 2);
    const firstMine = mine(first.items);
    assert.equal(firstMine.length, 2);
    await markSurfaced(client, first.items.map((i) => i.message_id), 5);
    const second = mine((await collectUnsurfacedItems(client, 25)).items);
    assert.equal(second.length, 2);
    assert.equal(second.some((i) => firstMine.some((f) => f.message_id === i.message_id)), false);
  });

  test('markSurfaced also marks the rest of the thread, and a null run id marks nothing', async () => {
    await persistMailIntake(client, [row('1', { thread_id: `${P}tt` }), row('2', { thread_id: `${P}tt` })], 'v1');
    assert.equal(await markSurfaced(client, [`${P}1`], null), 0);
    assert.equal(await markSurfaced(client, [`${P}1`], 9), 2);
    assert.equal(mine((await collectUnsurfacedItems(client, 25)).items).length, 0);
  });

  test('dismiss removes the whole thread from the open items; the unsorted bucket never surfaces', async () => {
    await persistMailIntake(client, [
      row('1', { thread_id: `${P}tt` }), row('2', { thread_id: `${P}tt`, bucket: 'thread_reply', signal: 'thread_reply' }),
      row('3', { bucket: 'unsorted', signal: null }),
    ], 'v1');
    assert.equal(mine((await collectUnsurfacedItems(client, 25)).items).length, 1, 'the unsorted row is not a review item');
    assert.equal(await dismissMailIntake(client, `${P}1`), 2);
    assert.equal(mine((await collectUnsurfacedItems(client, 25)).items).length, 0);
  });
});

describe('listMailIntakeForDashboard', () => {
  test('returns open items, the subject-level unsorted list, and bucket counts', async () => {
    await persistMailIntake(client, [
      row('1'), row('2', { bucket: 'unsorted', signal: null, subject: 'Lunch on Sunday?' }), row('3', { bucket: 'bulk_noise', signal: null }),
    ], 'v1');
    const d = await listMailIntakeForDashboard(client);
    assert.equal(mine(d.items).length, 1);
    assert.equal(mine(d.unsorted)[0].subject, 'Lunch on Sunday?');
    assert.ok(d.counts.bulk_noise >= 1 && d.counts.unsorted >= 1 && d.counts.recruiter_like >= 1);
  });
});
