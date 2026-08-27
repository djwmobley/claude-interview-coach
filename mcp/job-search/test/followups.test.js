// @ts-check
/**
 * followups state machine against the real ic_context DB. Rows carry the
 * marker contact `ZZ-TEST-FU-<pid>` and are deleted afterwards.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { createFollowup, listFollowups, completeFollowup, snoozeFollowup, cancelFollowup, unsnoozeDue, selectDue, stampReminded, formatFollowup, parseIsoDate } from '../src/core/followups.js';
import { tool as followupsTool } from '../src/tools/followups.js';

const MARK = `ZZ-TEST-FU-${process.pid}`;
/** @type {pg.Client} */
let client;

async function cleanupListings() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [MARK])).rows.map((r) => r.id);
  if (ids.length === 0) return;
  await client.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [ids]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
}

/** Inserts a minimal listing row (FK target for createFollowup's listing_id) tagged with company MARK. */
async function insertListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Followups Listing Test', $1, $2, $3, 'listing', 'followups listing test co', 'followups listing test', 'legacy-unknown', $4, now()) RETURNING id`,
    [MARK, `zz-test-fu-listing-${process.pid}`, `zz-test-fu-listing-${process.pid}:${n}`, `zz-fu-hash-${n}`],
  );
  return Number(r.rows[0].id);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-%']);
  await cleanupListings();
});
after(async () => {
  await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-%']);
  await cleanupListings();
  await client.end();
});

const future = new Date(Date.now() + 3 * 86400000).toISOString();

describe('followups core', () => {
  test('parseIsoDate accepts date and datetime, rejects garbage', () => {
    assert.equal(parseIsoDate('2026-08-27', 'due_at').getDate(), 27);
    assert.ok(parseIsoDate('2026-08-27T09:00:00-05:00', 'due_at') instanceof Date);
    assert.throws(() => parseIsoDate('Thursday', 'due_at'), /ISO date/);
    assert.throws(() => parseIsoDate('2026-13-45', 'due_at'), /not a valid date|ISO date/);
    assert.throws(() => parseIsoDate('', 'due_at'), /required/);
  });

  test('parseIsoDate: leap-year boundary for Feb 29', () => {
    assert.throws(() => parseIsoDate('2027-02-29', 'due_at'), /not a valid date/, '2027 is not a leap year');
    assert.equal(parseIsoDate('2028-02-29', 'due_at').getUTCDate(), 29, '2028 is a leap year');
  });

  test('parseIsoDate: out-of-range calendar components are all refused (month 00, day 00, day 32, month 13)', () => {
    assert.throws(() => parseIsoDate('2027-00-15', 'due_at'), /not a valid date/);
    assert.throws(() => parseIsoDate('2027-01-00', 'due_at'), /not a valid date/);
    assert.throws(() => parseIsoDate('2027-01-32', 'due_at'), /not a valid date/);
    assert.throws(() => parseIsoDate('2027-13-01', 'due_at'), /not a valid date/);
  });

  test('parseIsoDate: out-of-range time-of-day components are all refused (hour 24, minute 60, second 60)', () => {
    assert.throws(() => parseIsoDate('2027-01-01T24:00:00', 'due_at'), /invalid time of day/);
    assert.throws(() => parseIsoDate('2027-01-01T09:60:00', 'due_at'), /invalid time of day/);
    assert.throws(() => parseIsoDate('2027-01-01T09:00:60', 'due_at'), /invalid time of day/);
  });

  test('parseIsoDate: the last valid instant of a day (23:59:59) is accepted', () => {
    const d = parseIsoDate('2027-01-01T23:59:59', 'due_at');
    assert.ok(d instanceof Date);
    assert.ok(!Number.isNaN(d.getTime()));
  });

  test('parseIsoDate: known accepted gap -- an out-of-real-world-range UTC offset is not bounds-checked', () => {
    // "-23:00" matches the shape regex and Date's own parser accepts it (no real timezone has ever used an
    // offset beyond -12:00..+14:00), so this currently passes when a stricter check arguably should refuse
    // it. Left unfixed deliberately: every caller of parseIsoDate in this codebase supplies either a bare
    // YYYY-MM-DD (turned into local 09:00 here) or a datetime the dashboard/CLI itself generates with a
    // real local offset -- no code path lets an operator type a raw offset string -- so bounding it would
    // add validation surface (and a real risk of rejecting a legitimate exotic zone, e.g. +14:00 Kiribati
    // or +05:45 Nepal, under time pressure) for an input nothing in this codebase can actually produce.
    // If a caller is ever added that accepts a raw offset from outside this codebase, this assumption
    // should be revisited.
    const d = parseIsoDate('2027-01-01T09:00:00-23:00', 'due_at');
    assert.ok(!Number.isNaN(d.getTime()));
  });

  test('create validates channel, notify, contact, action, due_at; defaults notify to email', async () => {
    await assert.rejects(createFollowup(client, { contact: MARK, due_at: future, channel: 'fax', action: 'x' }), /channel/);
    await assert.rejects(createFollowup(client, { contact: MARK, due_at: future, channel: 'phone', action: 'x', notify: ['sms'] }), /notify/);
    await assert.rejects(createFollowup(client, { contact: '', due_at: future, channel: 'phone', action: 'x' }), /contact/);
    await assert.rejects(createFollowup(client, { contact: MARK, due_at: future, channel: 'phone', action: '' }), /action_text/);
    await assert.rejects(createFollowup(client, { contact: MARK, due_at: 'next week', channel: 'phone', action: 'x' }), /ISO date/);
    await assert.rejects(createFollowup(client, { contact: MARK, due_at: future, channel: 'phone', action: 'x', listing_id: 999999999 }), /not found/);
    const { row, warnings } = await createFollowup(client, { contact: `${MARK} Nina`, org: 'East 57th', due_at: '2026-08-27', channel: 'phone', action: 'phone 469-404-8664, no third email' });
    assert.deepEqual(row.notify, ['email']);
    assert.equal(row.status, 'open');
    assert.deepEqual(warnings, []);
    const line = formatFollowup(row);
    assert.match(line, new RegExp(`^#${row.id} \\| ${MARK} Nina \\| East 57th \\| phone \\| due 2026-08-27 \\| open \\| phone 469-404-8664, no third email$`));
  });

  test('list default filter is open+snoozed ordered by due; complete/snooze/cancel transitions', async () => {
    const a = (await createFollowup(client, { contact: `${MARK} A`, due_at: '2026-09-02', channel: 'email', action: 'ping' })).row;
    const b = (await createFollowup(client, { contact: `${MARK} B`, due_at: '2026-09-01', channel: 'linkedin', action: 'nudge' })).row;
    const l1 = await listFollowups(client, { contact: MARK });
    const ids = l1.rows.map((r) => r.id);
    assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'ordered by due_at');
    // snooze: past rejected, future ok, status snoozed
    await assert.rejects(snoozeFollowup(client, a.id, '2020-01-01'), /future/);
    const s = await snoozeFollowup(client, a.id, future);
    assert.equal(s.row.status, 'snoozed');
    assert.ok((await listFollowups(client, { contact: MARK })).rows.some((r) => r.id === a.id), 'snoozed still listed by default');
    // complete
    const c = await completeFollowup(client, b.id);
    assert.equal(c.row.status, 'done');
    assert.ok(!(await listFollowups(client, { contact: MARK })).rows.some((r) => r.id === b.id), 'done excluded by default');
    assert.ok((await listFollowups(client, { contact: MARK, status: ['done'] })).rows.some((r) => r.id === b.id));
    assert.deepEqual((await completeFollowup(client, b.id)).warnings, ['already done']);
    // cancel; cancelled cannot be snoozed or completed
    const x = await cancelFollowup(client, a.id);
    assert.equal(x.row.status, 'cancelled');
    await assert.rejects(snoozeFollowup(client, a.id, future), /cancelled/);
    await assert.rejects(completeFollowup(client, a.id), /cancelled/);
    await assert.rejects(completeFollowup(client, 999999999), /not found/);
    await assert.rejects(listFollowups(client, { status: ['bogus'] }), /status must be/);
  });

  test('listFollowups: listingId option filters in SQL, not as a post-query in-memory filter, and raises the cap to 100', async () => {
    const listingId = await insertListing();
    const otherId = await insertListing();
    // 30 noise rows on a different listing, all due before the target row, so they sort ahead of it
    // under the default ORDER BY due_at. The old hard-coded LIMIT 25 on the un-scoped query would have
    // dropped the target row entirely once a caller filtered the result set by listing_id afterward.
    for (let i = 0; i < 30; i += 1) {
      const dueAt = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
      await createFollowup(client, { contact: `${MARK} Noise ${i}`, listing_id: otherId, due_at: dueAt, channel: 'email', action: 'noise' });
    }
    const target = (await createFollowup(client, { contact: `${MARK} Target`, listing_id: listingId, due_at: '2027-06-01', channel: 'email', action: 'target' })).row;
    const scoped = await listFollowups(client, { listingId, limit: 100 });
    assert.ok(scoped.rows.some((r) => r.id === target.id), 'target listing follow-up returned despite 30 earlier-due rows on another listing');
    assert.ok(scoped.rows.every((r) => r.listing_id === listingId), 'only rows for the requested listing are returned');
    assert.equal(scoped.total, 1);
    // the cap is still enforced -- listingId does not bypass the hard max of 100
    const capped = await listFollowups(client, { listingId: otherId, limit: 9999 });
    assert.ok(capped.rows.length <= 100);
    assert.equal(capped.total, 30);
    // These 30 open rows would otherwise sit at the front of every *un-scoped* system-wide listFollowups
    // call for the rest of this file (e.g. the "followups tool wrapper" test's plain `list`), so remove
    // them immediately rather than waiting for the file's closing after() hook.
    await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', [`${MARK} Noise %`]);
    await client.query('DELETE FROM ic_followups WHERE id = $1', [target.id]);
  });

  test('snoozed rows whose snoozed_until passed flip back to open and enter the due set', async () => {
    const r = (await createFollowup(client, { contact: `${MARK} S`, due_at: '2026-08-20', channel: 'other', action: 'x' })).row;
    await snoozeFollowup(client, r.id, future);
    const t0 = new Date(Date.now() + 4 * 86400000);
    const flipped = await unsnoozeDue(client, t0);
    assert.ok(flipped.includes(r.id));
    const due = await selectDue(client, t0);
    assert.ok(due.some((d) => d.id === r.id));
    // stamped rows are excluded until the next day
    await stampReminded(client, [r.id], t0);
    assert.ok(!(await selectDue(client, t0)).some((d) => d.id === r.id));
    assert.ok((await selectDue(client, new Date(t0.getTime() + 86400000))).some((d) => d.id === r.id), 'reminded yesterday is due again today');
  });

  test('calendar failure is a warning, not an error; success stores the event id; complete deletes it', async () => {
    const failing = { insertEvent: async () => { throw new Error('calendar down'); }, deleteEvent: async () => {} };
    const r1 = await createFollowup(client, { contact: `${MARK} C1`, due_at: future, channel: 'phone', action: 'x', notify: ['email', 'calendar'] }, { calendar: failing });
    assert.equal(r1.row.status, 'open');
    assert.equal(r1.row.calendar_event_id, null);
    assert.match(r1.warnings[0], /calendar event not created: calendar down/);
    const noCal = await createFollowup(client, { contact: `${MARK} C0`, due_at: future, channel: 'phone', action: 'x', notify: ['calendar'] }, { calendar: null });
    assert.match(noCal.warnings[0], /not configured/);
    /** @type {any[]} */
    const events = [];
    const deleted = [];
    const good = {
      insertEvent: async (/** @type {any} */ ev) => { events.push(ev); return 'evt-123'; },
      deleteEvent: async (/** @type {string} */ id) => { deleted.push(id); },
    };
    const r2 = await createFollowup(client, { contact: `${MARK} C2`, org: 'Org', due_at: '2026-08-27T09:00:00Z', channel: 'phone', action: 'call', notify: ['calendar'] }, { calendar: good });
    assert.equal(r2.row.calendar_event_id, 'evt-123');
    assert.equal(events[0].summary, `Follow up: ${MARK} C2 (Org)`);
    assert.equal(events[0].description, 'call');
    assert.equal(events[0].startIso, '2026-08-27T09:00:00.000Z');
    assert.equal(events[0].endIso, '2026-08-27T09:30:00.000Z');
    assert.equal(events[0].reminderMinutes, 60);
    const done = await completeFollowup(client, r2.row.id, { calendar: good });
    assert.deepEqual(deleted, ['evt-123']);
    assert.equal(done.row.calendar_event_id, null);
  });
});

describe('followups tool wrapper', () => {
  /** @type {import('../src/tools/_shared.js').ToolDeps} */
  const deps = /** @type {any} */ ({ withClient: async (fn) => fn(client), calendar: null, config: null, env: {} });
  test('create -> list -> complete through the tool surface', async () => {
    const c = /** @type {any} */ (await followupsTool.handler({ action: 'create', contact: `${MARK} T`, org: 'X', due_at: '2026-09-10', channel: 'email', action_text: 'send deck' }, deps));
    assert.equal(c.ok, true);
    assert.match(c.row, /send deck/);
    const l = /** @type {any} */ (await followupsTool.handler({ action: 'list', limit: 25 }, deps));
    assert.ok(l.rows.some((r) => r.includes(`${MARK} T`)));
    const d = /** @type {any} */ (await followupsTool.handler({ action: 'complete', id: c.id }, deps));
    assert.match(d.row, /\| done \|/);
    await assert.rejects(followupsTool.handler({ action: 'create', contact: 'x', due_at: '2026-09-10', action_text: 'y' }, deps), /channel/);
    await assert.rejects(followupsTool.handler({ action: 'snooze', id: c.id }, deps), /snoozed_until/);
  });
});
