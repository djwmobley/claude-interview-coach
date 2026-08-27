// @ts-check
/**
 * remind.js against the real DB with Gmail/Calendar HTTP stubbed through an
 * injected fetch and the token layer stubbed through an injected googleHttp.
 * Also covers google.js helpers with a synthetic token file (fake values).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createFollowup, snoozeFollowup, stampReminded } from '../src/core/followups.js';
import { runRemind, buildDigest } from '../src/core/remind.js';
import { readTokenFile, tokenInfo, assertScopes, buildRfc2822, base64url, gmailSend, calendarInsertEvent, calendarDeleteEvent, calendarListEvents, expiryMs, SCOPE_GMAIL_SEND, SCOPE_GMAIL_READONLY, SCOPE_GMAIL_MODIFY, GMAIL_SEND_URL } from '../src/core/google.js';

const MARK = `ZZ-TEST-RM-${process.pid}`;
/** @type {pg.Client} */
let client;
let tmp = '';

// ic_report_state (spec R1) is a real singleton row, but by this point in the suite it lives in the
// throwaway, per-run "_test" database that bin/bootstrap-test-db.js/bin/run-tests.js set PG_DSN to
// (see npm test); tests here can write it freely without any snapshot/restore dance, since the whole
// database is recreated from scratch on the next `npm test` run and never shared with production.

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-%']);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-test-'));
});
after(async () => {
  await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-%']);
  await client.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Stub googleHttp returning fixed deps. */
const fakeGoogle = (/** @type {any} */ fetchImpl) => async () => ({ deps: { fetch: fetchImpl, accessToken: 'fake-token' }, info: { has_refresh_token: true, gmail_send_ok: true, calendar_ok: true, expiry: null, scope_count: 2 }, expiry: '2026-08-25T00:00:00.000Z' });

/** Fetch stub that records calls and answers with the given status. */
function fetchStub(status = 200) {
  /** @type {any[]} */
  const calls = [];
  const f = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => ({ id: 'msg-1', error: { message: 'nope' } }) };
  };
  return { f, calls };
}

describe('remind digest selection and sending', () => {
  test('selects exactly the due set: due within a day, snoozed flip, reminded-today excluded, done/cancelled excluded', async () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const mk = (/** @type {string} */ suffix, /** @type {string} */ due) => createFollowup(client, { contact: `${MARK} ${suffix}`, due_at: due, channel: 'phone', action: `act ${suffix}` }).then((r) => r.row);
    const dueToday = await mk('today', '2026-08-26T15:00:00Z');
    const dueTomorrow = await mk('tomorrow', '2026-08-27T09:00:00Z');
    const overdue = await mk('overdue', '2026-08-20T09:00:00Z');
    const later = await mk('later', '2026-08-30T09:00:00Z');
    const remindedToday = await mk('reminded', '2026-08-26T10:00:00Z');
    await stampReminded(client, [remindedToday.id], new Date('2026-08-26T07:00:00Z'));
    const remindedYesterday = await mk('reminded-yday', '2026-08-26T10:00:00Z');
    await stampReminded(client, [remindedYesterday.id], new Date('2026-08-25T07:00:00Z'));
    const snoozedPast = await mk('snoozed-past', '2026-08-20T09:00:00Z');
    await snoozeFollowup(client, snoozedPast.id, '2026-08-26T08:00:00Z', { now: new Date('2026-08-20T00:00:00Z') });
    const snoozedFuture = await mk('snoozed-future', '2026-08-20T09:00:00Z');
    await snoozeFollowup(client, snoozedFuture.id, '2026-09-05T08:00:00Z', { now: now });
    const done = await mk('done', '2026-08-26T10:00:00Z');
    await client.query(`UPDATE ic_followups SET status='done' WHERE id=$1`, [done.id]);

    const { f, calls } = fetchStub(200);
    /** @type {any[]} */
    const logged = [];
    const r = await runRemind({ client, tokenFile: 'unused', to: 'x@example.com', now, fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)), log: (x) => logged.push(x) });
    assert.equal(r.code, 0);
    assert.equal(r.sent, true);
    assert.equal(r.flipped, 1);
    // Decode the sent message and check exactly the expected contacts appear.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GMAIL_SEND_URL);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer fake-token');
    const raw = JSON.parse(calls[0].init.body).raw;
    const msg = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const expectIn = ['today', 'tomorrow', 'overdue', 'reminded-yday', 'snoozed-past'];
    const expectOut = ['later', `${MARK} reminded |`, 'snoozed-future', `${MARK} done`];
    for (const s of expectIn) assert.ok(msg.includes(`${MARK} ${s}`), `digest includes ${s}`);
    for (const s of expectOut) assert.ok(!msg.includes(s), `digest excludes ${s}`);
    assert.match(msg, new RegExp(`Subject:.*${expectIn.length} follow-ups? due`), 'subject count');
    assert.ok(msg.includes('(overdue)'));
    assert.equal(r.due, expectIn.length);
    assert.equal(r.stamped, expectIn.length);
    // Token values never logged.
    assert.ok(!JSON.stringify(logged).includes('fake-token'));
    // All stamped today
    const st = await client.query('SELECT count(*)::int AS n FROM ic_followups WHERE contact LIKE $1 AND reminded_at >= $2', [`${MARK}%`, now]);
    assert.equal(st.rows[0].n, expectIn.length);
    // Ids: dueToday etc exist (silence unused warnings)
    assert.ok(dueToday.id && dueTomorrow.id && overdue.id && later.id);
  });

  test('send failure leaves reminded_at NULL and exits 1', async () => {
    await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-%']);
    const now = new Date('2026-08-26T12:00:00Z');
    const row = (await createFollowup(client, { contact: `${MARK} fail`, due_at: '2026-08-26T15:00:00Z', channel: 'email', action: 'x' })).row;
    const { f } = fetchStub(500);
    const r = await runRemind({ client, tokenFile: 'unused', to: 'x@example.com', now, fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)) });
    assert.equal(r.code, 1);
    assert.equal(r.sent, false);
    assert.match(String(r.reason), /HTTP 500/);
    const chk = await client.query('SELECT reminded_at FROM ic_followups WHERE id = $1', [row.id]);
    assert.equal(chk.rows[0].reminded_at, null);
  });

  test('auth failure exits 1 without sending', async () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const { f, calls } = fetchStub(200);
    const r = await runRemind({ client, tokenFile: 'unused', to: 'x@example.com', now, fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (async () => { throw new Error('token file lacks scope'); }) });
    assert.equal(r.code, 1);
    assert.equal(calls.length, 0);
  });

  test('--dry-run sends nothing and stamps nothing', async () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const { f, calls } = fetchStub(200);
    const r = await runRemind({ client, tokenFile: 'unused', to: 'x@example.com', now, dryRun: true, fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)) });
    assert.equal(r.code, 0);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'dry_run');
    assert.equal(r.scopes_ok, true);
    assert.equal(calls.length, 0);
    const chk = await client.query('SELECT count(*)::int AS n FROM ic_followups WHERE contact LIKE $1 AND reminded_at IS NOT NULL', [`${MARK}%`]);
    assert.equal(chk.rows[0].n, 0);
  });

  test('empty tokenFile (the unconfigured GOOGLE_TOKEN_FILE default) throws a visible VALIDATION error before touching the DB or token layer', async () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const { f, calls } = fetchStub(200);
    await assert.rejects(
      runRemind({ client, tokenFile: '', to: 'x@example.com', now, fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (async () => { throw new Error('should not be called'); }) }),
      (/** @type {any} */ err) => {
        assert.equal(err.code, 'VALIDATION');
        assert.match(err.message, /GOOGLE_TOKEN_FILE is not set; add it to mcp\/job-search\/\.env/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test('empty to (the unconfigured REMINDER_TO default) throws a visible VALIDATION error', async () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const { f, calls } = fetchStub(200);
    await assert.rejects(
      runRemind({ client, tokenFile: 'unused', to: '', now, fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (async () => { throw new Error('should not be called'); }) }),
      (/** @type {any} */ err) => {
        assert.equal(err.code, 'VALIDATION');
        assert.match(err.message, /REMINDER_TO is not set; add it to mcp\/job-search\/\.env/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test('zero due rows AND zero scan runs since the (overridden, near-now) report marker on a weekend: no email, exit 0, token layer not even consulted', async () => {
    await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-%']);
    const { f, calls } = fetchStub(200);
    // 2000-01-02 00:00 America/Chicago is a Sunday (decision 26's "[NO SCAN]" weekday trigger does not
    // apply) far enough in the past that selectDue() cannot pick up any real (non-test) production
    // follow-up as due; reportSinceOverride is pinned to the real current time (independent of the
    // fictional `now` above) so the runs query against the real, shared ic_scan_runs table finds nothing
    // finished after it.
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now: new Date('2000-01-02T06:00:00Z'), reportSinceOverride: new Date(),
      fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (async () => { throw new Error('should not be called'); }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.due, 0);
    assert.equal(calls.length, 0);
  });

  test('a weekday with zero due rows and zero scan runs since the marker still sends, with [NO SCAN] in the subject (decision 26)', async () => {
    await client.query('DELETE FROM ic_followups WHERE contact LIKE $1', ['ZZ-TEST-%']);
    const { f, calls } = fetchStub(200);
    // 2026-08-26 is a Wednesday.
    const r = await runRemind({
      client, tokenFile: 'unused', to: 'x@example.com', now: new Date('2026-08-26T12:00:00Z'), reportSinceOverride: new Date(),
      fetch: /** @type {any} */ (f), googleHttp: /** @type {any} */ (fakeGoogle(f)),
    });
    assert.equal(r.code, 0);
    assert.equal(r.sent, true);
    assert.equal(r.no_scan, true);
    assert.match(String(r.subject), /^\[NO SCAN\]/);
    assert.equal(calls.length, 1);
  });

  test('digest body format: one line per item', () => {
    const now = new Date('2026-08-26T12:00:00Z');
    const d = buildDigest(/** @type {any} */ ([
      { id: 7, contact: 'Nina Guthrie', org: 'East 57th', channel: 'phone', due_at: new Date('2026-08-27T09:00:00Z'), status: 'open', action: 'phone 469-404-8664, no third email' },
    ]), now);
    assert.equal(d.subject, 'Follow-ups due: 1');
    assert.ok(d.body.includes('- #7 | Nina Guthrie | East 57th | phone | due 2026-08-27 | open | phone 469-404-8664, no third email'));
  });
});

describe('google.js helpers (synthetic token file, fake values)', () => {
  test('readTokenFile + tokenInfo + assertScopes; token values never in the info block', () => {
    const file = path.join(tmp, 'tok.json');
    fs.writeFileSync(file, JSON.stringify({ token: 'AT', refresh_token: 'RT', client_id: 'CID', client_secret: 'CS', scopes: [SCOPE_GMAIL_SEND], expiry: '2026-08-12T04:36:05' }));
    const t = readTokenFile(file);
    const info = tokenInfo(t);
    assert.equal(info.has_refresh_token, true);
    assert.equal(info.gmail_send_ok, true);
    assert.equal(info.calendar_ok, false);
    assert.ok(!JSON.stringify(info).includes('RT') && !JSON.stringify(info).includes('AT') && !JSON.stringify(info).includes('CS'));
    assertScopes(t, file, { gmail: true });
    assert.throws(() => assertScopes(t, file, { calendar: true }), /lacks scope .*calendar\.events/);
    assert.equal(expiryMs('2026-08-12T04:36:05'), Date.parse('2026-08-12T04:36:05Z'));
    assert.throws(() => readTokenFile(path.join(tmp, 'missing.json')), /not readable/);
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{');
    assert.throws(() => readTokenFile(path.join(tmp, 'bad.json')), /not valid JSON/);
  });

  test('R8: gmail.readonly / gmail.modify additions are additive; assertScopes({gmail:true}) (remind.js\'s need) is unaffected', () => {
    const file = path.join(tmp, 'tok-r8.json');
    fs.writeFileSync(file, JSON.stringify({ token: 'AT', refresh_token: 'RT', client_id: 'CID', client_secret: 'CS', scopes: [SCOPE_GMAIL_SEND], expiry: '2026-08-12T04:36:05' }));
    const t = readTokenFile(file);
    // remind.js's own need shape ({ gmail: true }) still passes on a gmail.send-only token exactly as before.
    assertScopes(t, file, { gmail: true });
    // A gmail.send-only token has no read scope; gmailRead must be enforced independently of gmail (send).
    const info = tokenInfo(t);
    assert.equal(info.gmail_read_ok, false);
    assert.throws(() => assertScopes(t, file, { gmailRead: true }), new RegExp(`lacks scope ${SCOPE_GMAIL_READONLY.replace(/[./]/g, '\\$&')} or ${SCOPE_GMAIL_MODIFY.replace(/[./]/g, '\\$&')}`));

    const readonlyFile = path.join(tmp, 'tok-r8-readonly.json');
    fs.writeFileSync(readonlyFile, JSON.stringify({ token: 'AT', refresh_token: 'RT', client_id: 'CID', client_secret: 'CS', scopes: [SCOPE_GMAIL_READONLY], expiry: '2026-08-12T04:36:05' }));
    const tr = readTokenFile(readonlyFile);
    assert.equal(tokenInfo(tr).gmail_read_ok, true);
    assert.equal(tokenInfo(tr).gmail_send_ok, false, 'gmail.readonly does not imply gmail.send');
    assertScopes(tr, readonlyFile, { gmailRead: true });
    assert.throws(() => assertScopes(tr, readonlyFile, { gmail: true }), /lacks scope .*gmail\.send/);

    const modifyFile = path.join(tmp, 'tok-r8-modify.json');
    fs.writeFileSync(modifyFile, JSON.stringify({ token: 'AT', refresh_token: 'RT', client_id: 'CID', client_secret: 'CS', scopes: [SCOPE_GMAIL_MODIFY], expiry: '2026-08-12T04:36:05' }));
    const tm = readTokenFile(modifyFile);
    assert.equal(tokenInfo(tm).gmail_read_ok, true, 'gmail.modify also satisfies the read check');
  });

  test('buildRfc2822 strips header injection; base64url has no padding', () => {
    const m = buildRfc2822({ to: 'a@b.c\r\nBcc: x@y.z', subject: 'Hi\nX-Injected: 1', body: 'line1\nline2', date: new Date(0) });
    assert.ok(m.startsWith('To: a@b.c Bcc: x@y.z\r\nSubject: Hi X-Injected: 1\r\n'));
    assert.ok(m.includes('\r\n\r\nline1\r\nline2'));
    assert.ok(!/=$/.test(base64url('ab')) && !base64url('ab').includes('+'));
  });

  test('gmailSend / calendar helpers use the injected fetch and bearer token', async () => {
    const { f, calls } = fetchStub(200);
    const id = await gmailSend({ fetch: /** @type {any} */ (f), accessToken: 'T' }, 'raw');
    assert.equal(id, 'msg-1');
    assert.equal(calls[0].init.method, 'POST');
    const ev = await calendarInsertEvent({ fetch: /** @type {any} */ (f), accessToken: 'T' }, { summary: 's', description: 'd', startIso: 'a', endIso: 'b' });
    assert.equal(ev, 'msg-1');
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.reminders.overrides[0].minutes, 60);
    await calendarDeleteEvent({ fetch: /** @type {any} */ (f), accessToken: 'T' }, 'e1');
    assert.equal(calls[2].init.method, 'DELETE');
    const bad = fetchStub(403);
    await assert.rejects(gmailSend({ fetch: /** @type {any} */ (bad.f), accessToken: 'T' }, 'raw'), /HTTP 403/);
    const gone = fetchStub(404);
    await calendarDeleteEvent({ fetch: /** @type {any} */ (gone.f), accessToken: 'T' }, 'e1');
  });

  test('calendarListEvents pages through nextPageToken and stops at maxResults (dashboard PR 1)', async () => {
    /** @type {any[]} */
    const calls = [];
    const pages = [
      { items: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' },
      { items: [{ id: 'c' }, { id: 'd' }], nextPageToken: 'p3' },
      { items: [{ id: 'e' }], nextPageToken: undefined },
    ];
    const f = async (/** @type {string} */ url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => pages[calls.length - 1] };
    };
    const items = await calendarListEvents({ fetch: /** @type {any} */ (f), accessToken: 'T' }, { timeMin: '2026-08-26T00:00:00Z', timeMax: '2026-09-09T00:00:00Z' });
    assert.equal(items.length, 5);
    assert.deepEqual(items.map((i) => /** @type {any} */ (i).id), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].includes('singleEvents=true') && calls[0].includes('orderBy=startTime'));
    assert.ok(!calls[0].includes('pageToken'));
    assert.ok(calls[1].includes('pageToken=p2'));
    assert.ok(calls[2].includes('pageToken=p3'));

    // maxResults stops paging early even though the server would still return a nextPageToken.
    const calls2 = /** @type {string[]} */ ([]);
    const f2 = async (/** @type {string} */ url) => {
      calls2.push(url);
      return { ok: true, status: 200, json: async () => ({ items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }], nextPageToken: 'more' }) };
    };
    const capped = await calendarListEvents({ fetch: /** @type {any} */ (f2), accessToken: 'T' }, { timeMin: 'a', timeMax: 'b', maxResults: 2 });
    assert.equal(capped.length, 2);
    assert.equal(calls2.length, 1, 'never fetches a second page once maxResults is already met');

    // calendarId defaults to primary but is overridable and URL-encoded.
    const calls3 = /** @type {string[]} */ ([]);
    const f3 = async (/** @type {string} */ url) => {
      calls3.push(url);
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    await calendarListEvents({ fetch: /** @type {any} */ (f3), accessToken: 'T' }, { timeMin: 'a', timeMax: 'b', calendarId: 'work@example.com' });
    assert.ok(calls3[0].startsWith('https://www.googleapis.com/calendar/v3/calendars/work%40example.com/events?'));
  });
});
