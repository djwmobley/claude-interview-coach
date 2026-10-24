// @ts-check
/**
 * Personal mail intake pass (src/adapters/gmail-intake.js), against a fake Gmail API: the list queries, the
 * staged metadata then body reads, the body cap and its overflow count, skipping settled ids, budget stops,
 * and the end-to-end gmail.search events. No network, no DB.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runMailIntake } from '../src/adapters/gmail-intake.js';
import { gmail, deps as gmailAuthDeps } from '../src/adapters/gmail.js';
import { defaultMailIntakeConfig } from '../src/core/mail-intake-config.js';
import { rulesVersionFor } from '../src/core/mail-intake.js';
import { JobSearchError } from '../src/core/errors.js';
import { fakeGmailAuthDeps, testConfig } from './helpers/scan-fixtures.js';
import { b64url, metaMessage, simonMessage, FIXTURES, SELF_ADDRESS, SENT_THREAD } from './helpers/mail-intake-fixtures.js';

const MSG = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';

/**
 * A fake Gmail API. `inbox` maps id -> { meta, full } where meta is the metadata response and full the format=full response.
 * @param {{ inbox: Record<string, { meta: any, full?: any }>, sent?: Array<{ id: string, threadId: string }>, sentFrom?: string, budget?: number, known?: Set<string> }} o
 */
function harness(o) {
  /** @type {string[]} */
  const urls = [];
  let pages = 0;
  const ctx = /** @type {any} */ ({
    signal: new AbortController().signal,
    now: new Date('2026-10-24T12:00:00Z'),
    windowStart: null,
    maxPages: 2,
    async fetchJson(/** @type {string} */ url) {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith('/messages')) {
        const q = u.searchParams.get('q') ?? '';
        if (q.startsWith('in:sent')) return { status: 200, url, json: { messages: o.sent ?? [] } };
        if (q.includes('-in:trash')) return { status: 200, url, json: { messages: Object.entries(o.inbox).map(([id, v]) => ({ id, threadId: v.meta.threadId })) } };
        return { status: 200, url, json: { messages: [] } };
      }
      const id = u.pathname.split('/').pop() ?? '';
      const format = u.searchParams.get('format');
      if (o.sent?.some((m) => m.id === id)) return { status: 200, url, json: metaMessage({ id, from: o.sentFrom ?? `Damian <${SELF_ADDRESS}>`, subject: 'Hi' }) };
      const entry = o.inbox[id];
      if (!entry) return { status: 404, url, json: null };
      return { status: 200, url, json: format === 'full' ? (entry.full ?? entry.meta) : entry.meta };
    },
    async reservePage() {
      pages++;
      if (o.budget !== undefined && pages > o.budget) throw new JobSearchError('BUDGET_EXHAUSTED', 'daily page budget exhausted for gmail');
    },
    async reserveDetail() {},
    capFor: async () => null,
    config: testConfig(),
    env: { GOOGLE_TOKEN_FILE: 'zz-test-token-file.json' },
    interactive: false,
    log() {},
    mailIntakeKnown: async () => o.known ?? new Set(),
  });
  return { ctx, urls, pageCount: () => pages };
}

/** Run the pass with the default config plus overrides. @param {any} ctx @param {any} [cfg] @param {{ registeredIds?: Set<string> }} [extra] */
const run = (ctx, cfg = {}, extra = {}) => runMailIntake({
  ctx, authHeader: { Authorization: 'Bearer fake' }, windowDays: 7, registeredAddresses: new Set(['jobalerts-noreply@linkedin.com']),
  registeredIds: extra.registeredIds ?? new Set(), cfg: { ...defaultMailIntakeConfig(), ...cfg },
});

const full = (/** @type {string} */ id, /** @type {string} */ text, /** @type {any} */ meta) => ({ ...meta, payload: { ...meta.payload, mimeType: 'text/plain', body: { data: b64url(text) } } });

describe('runMailIntake: queries', () => {
  test('lists the whole window excluding trash, sent and drafts, WITH spam, never the sent label for the main list', async () => {
    const { ctx, urls } = harness({ inbox: {} });
    await run(ctx);
    const main = urls.map((u) => new URL(u)).find((u) => (u.searchParams.get('q') ?? '').includes('-in:trash'));
    assert.ok(main, 'the main list ran');
    assert.equal(main.searchParams.get('q'), 'newer_than:7d -in:trash -in:sent -in:draft');
    assert.equal(main.searchParams.get('includeSpamTrash'), 'true');
    const sent = urls.map((u) => new URL(u)).find((u) => (u.searchParams.get('q') ?? '').startsWith('in:sent'));
    assert.ok(sent);
    assert.equal(sent.searchParams.get('includeSpamTrash'), null);
  });

  test('every request is a GET on /messages or /messages/<id> (read only)', async () => {
    const m = simonMessage(false);
    const { ctx, urls } = harness({ inbox: { [m.id]: { meta: m } } });
    await run(ctx);
    for (const u of urls) assert.match(u, new RegExp(`^${MSG.replace(/[/.]/g, '\\$&')}(/[0-9a-f]{8,32})?\\?`));
  });

  test('the profile address is learned from the newest sent message and thread ids come from the sent list', async () => {
    const { ctx } = harness({ inbox: {}, sent: [{ id: 'aaaaaaaa00000001', threadId: SENT_THREAD }] });
    const r = await run(ctx, { selfAddresses: [] });
    assert.equal(r.stats.self_known, true);
    assert.equal(r.stats.sent_threads, 1);
  });

  test('a self-sent alias mail is classified self using the learned profile address', async () => {
    const m = FIXTURES.aliasSelf();
    const { ctx } = harness({ inbox: { [m.id]: { meta: m } }, sent: [{ id: 'aaaaaaaa00000001', threadId: SENT_THREAD }] });
    const r = await run(ctx, { selfAddresses: [] });
    assert.equal(r.rows.find((x) => x.message_id === m.id)?.bucket, 'self');
  });
});

describe('runMailIntake: staged reads', () => {
  test('the Simon email is found from metadata alone: no body read is needed for a STRONG match', async () => {
    const m = simonMessage(true);
    const { ctx, urls } = harness({ inbox: { [m.id]: { meta: m } } });
    const r = await run(ctx);
    const row = r.rows.find((x) => x.message_id === m.id);
    assert.equal(row?.bucket, 'recruiter_like');
    assert.equal(row?.signal, 'strong');
    assert.equal(row?.spam, false);
    assert.deepEqual(row?.labels, ['INBOX', 'CATEGORY_PROMOTIONS']);
    assert.equal(urls.filter((u) => u.includes('format=full')).length, 0);
  });

  test('bodies are fetched only for candidates: bulk noise with no title signal is never read in full', async () => {
    const bulk = FIXTURES.newsletter();
    const plain = FIXTURES.personalPlain();
    const { ctx, urls } = harness({ inbox: { [bulk.id]: { meta: bulk }, [plain.id]: { meta: plain } } });
    const r = await run(ctx);
    const fulls = urls.filter((u) => u.includes('format=full'));
    assert.equal(fulls.length, 1);
    assert.ok(fulls[0].includes(plain.id));
    assert.equal(r.stats.bodies_read, 1);
  });

  test('a recruiter email whose recruiting words are only in the body is found by the body read', async () => {
    const quiet = metaMessage({ id: 'bbbbbbbb00000001', from: 'Simon <simon@boutique.example>', subject: 'Catching up', snippet: 'Hi Damian, hope you are well.', labels: ['INBOX'] });
    const body = 'Hope you are well. I am recruiting for a Chief Information Officer role at a client.';
    const { ctx } = harness({ inbox: { [quiet.id]: { meta: quiet, full: full(quiet.id, body, quiet) } } });
    const r = await run(ctx);
    const row = r.rows.find((x) => x.message_id === quiet.id);
    assert.deepEqual([row?.bucket, row?.signal], ['recruiter_like', 'strong']);
    assert.match(row?.snippet ?? '', /recruiting for a Chief Information Officer/);
  });

  test('an UNLISTED firm, List-Unsubscribe, the Simon subject, title only in the body: found by the body read as STRONG', async () => {
    const m = metaMessage({
      id: 'bbbbbbbb00000009', from: 'Simon Wilkinson <simon@unlistedsearch.example>', subject: 'Exciting New Opportunity \u2013 Let\u2019s Catch Up',
      snippet: 'Hi Damian, hope you are well and have a moment this week.', headers: { 'List-Unsubscribe': '<mailto:u@unlistedsearch.example>' },
    });
    const body = 'Hi Damian, I am recruiting for a Chief Information Officer role with a client in Houston.';
    const { ctx, urls } = harness({ inbox: { [m.id]: { meta: m, full: full(m.id, body, m) } } });
    const r = await run(ctx);
    const row = r.rows.find((x) => x.message_id === m.id);
    assert.deepEqual([row?.bucket, row?.signal], ['recruiter_like', 'strong']);
    assert.equal(urls.filter((u) => u.includes('format=full')).length, 1);
  });

  test('bulk mail without any recruiting cue is still not read in full', async () => {
    const m = FIXTURES.newsletter();
    const { ctx, urls } = harness({ inbox: { [m.id]: { meta: m } } });
    await run(ctx);
    assert.equal(urls.filter((u) => u.includes('format=full')).length, 0);
  });

  test('cue-only bulk candidates are read AFTER the stronger ones and only within the cap', async () => {
    const cue = metaMessage({ id: 'bbbbbbbb0000000a', from: 'F <f@firm.example>', subject: 'New opportunity', snippet: 'x', headers: { 'List-Unsubscribe': '<mailto:u@firm.example>' } });
    const plain = metaMessage({ id: 'bbbbbbbb0000000b', from: 'P <p@family.example>', subject: 'Hello', snippet: 'Hi', labels: ['INBOX'] });
    const { ctx, urls } = harness({ inbox: { [cue.id]: { meta: cue }, [plain.id]: { meta: plain } } });
    const r = await run(ctx, { maxBodies: 1 });
    const fulls = urls.filter((u) => u.includes('format=full'));
    assert.equal(fulls.length, 1);
    assert.ok(fulls[0].includes(plain.id), 'the stronger candidate used the single body slot');
    assert.equal(r.stats.not_read_beyond_cap, 1);
  });

  test('a body that cannot be decoded is recruiter_like with body_unreadable, never silently unsorted', async () => {
    const quiet = metaMessage({ id: 'bbbbbbbb00000002', from: 'Someone <s@elsewhere.example>', subject: 'Hello', snippet: 'Hi', labels: ['INBOX'] });
    const broken = { ...quiet, payload: { ...quiet.payload, mimeType: 'text/plain', body: { data: '!!! not base64url !!!' } } };
    const { ctx } = harness({ inbox: { [quiet.id]: { meta: quiet, full: broken } } });
    const r = await run(ctx);
    const row = r.rows.find((x) => x.message_id === quiet.id);
    assert.deepEqual([row?.bucket, row?.signal, row?.body_unreadable], ['recruiter_like', 'body_unreadable', true]);
    assert.equal(r.stats.body_unreadable, 1);
  });

  test('an InMail notice takes its sender name and subject from the body', async () => {
    const m = FIXTURES.linkedinInmail();
    const body = 'Jane Doe sent you a message\nSubject: CIO role at Orbit\nHello Damian, are you open to a chat?';
    const { ctx } = harness({ inbox: { [m.id]: { meta: m, full: full(m.id, body, m) } } });
    const r = await run(ctx);
    const row = r.rows.find((x) => x.message_id === m.id);
    assert.equal(row?.bucket, 'recruiter_like');
    assert.equal(row?.from_name, 'Jane Doe');
    assert.equal(row?.subject, 'CIO role at Orbit');
  });

  test('the body cap: only maxBodies candidates are read, the overflow is counted and left unpersisted for the next run', async () => {
    const inbox = /** @type {Record<string, { meta: any }>} */ ({});
    for (let i = 1; i <= 5; i++) {
      const m = metaMessage({ id: `cccccccc0000000${i}`, from: `P${i} <p${i}@family.example>`, subject: `Hello ${i}`, snippet: 'Hi', labels: ['INBOX'] });
      inbox[m.id] = { meta: m };
    }
    const { ctx, urls } = harness({ inbox });
    const r = await run(ctx, { maxBodies: 2 });
    assert.equal(urls.filter((u) => u.includes('format=full')).length, 2);
    assert.equal(r.stats.bodies_read, 2);
    assert.equal(r.stats.not_read_beyond_cap, 3);
    assert.equal(r.rows.length, 2, 'the three unread candidates are not persisted, so the next run reads them');
  });

  test('metadata cap: the remainder is reported, never silently dropped', async () => {
    const inbox = /** @type {Record<string, { meta: any }>} */ ({});
    for (let i = 1; i <= 4; i++) {
      const m = metaMessage({ id: `dddddddd0000000${i}`, from: `N${i} <n${i}@daily.example>`, subject: 'digest', snippet: 'x', headers: { 'List-Unsubscribe': '<mailto:u@daily.example>' } });
      inbox[m.id] = { meta: m };
    }
    const { ctx } = harness({ inbox });
    const r = await run(ctx, { maxMetadata: 3 });
    assert.equal(r.stats.metadata_read, 3);
    assert.equal(r.stats.metadata_unread, 1);
  });

  test('ids already settled at the current rules_version are skipped without a metadata read', async () => {
    const m = simonMessage(false);
    const { ctx, urls } = harness({ inbox: { [m.id]: { meta: m } }, known: new Set([m.id]) });
    const r = await run(ctx);
    assert.equal(r.stats.skipped_known, 1);
    assert.equal(r.rows.length, 0);
    assert.equal(urls.filter((u) => u.includes(`/${m.id}`)).length, 0);
  });

  test('ids from registered alert senders are counted without being read again', async () => {
    const m = FIXTURES.registeredAlert();
    const { ctx, urls } = harness({ inbox: { [m.id]: { meta: m } } });
    const r = await run(ctx, {}, { registeredIds: new Set([m.id]) });
    assert.equal(r.stats.registered, 1);
    assert.equal(r.rows[0].bucket, 'registered_alert');
    assert.equal(urls.filter((u) => u.includes(`/${m.id}`)).length, 0);
  });

  test('a page-budget refusal ends the pass with partial_budget and keeps what was read', async () => {
    const inbox = /** @type {Record<string, { meta: any }>} */ ({});
    for (let i = 1; i <= 4; i++) {
      const m = metaMessage({ id: `eeeeeeee0000000${i}`, from: `N${i} <n${i}@daily.example>`, subject: 'digest', snippet: 'x', headers: { 'List-Unsubscribe': '<mailto:u@daily.example>' } });
      inbox[m.id] = { meta: m };
    }
    // sent list (1) + main list (1) + two metadata reads, then refuse.
    const { ctx } = harness({ inbox, budget: 4 });
    const r = await run(ctx);
    assert.equal(r.stats.outcome, 'partial_budget');
    assert.equal(r.rows.length, 2);
    assert.ok(r.stats.metadata_unread >= 2);
  });

  test('an aborted run stops the pass with CANCELLED before any request', async () => {
    const h = harness({ inbox: {} });
    const ac = new AbortController();
    ac.abort();
    h.ctx.signal = ac.signal;
    await assert.rejects(run(h.ctx), (/** @type {any} */ e) => e.code === 'CANCELLED');
    assert.equal(h.urls.length, 0);
  });

  test('disabled in config: nothing is listed or read', async () => {
    const { ctx, urls } = harness({ inbox: {} });
    const r = await run(ctx, { enabled: false });
    assert.equal(r.stats.outcome, 'disabled');
    assert.equal(urls.length, 0);
  });

  test('stored display text is sanitized: no HTML, no URLs, at most 500 characters', async () => {
    const m = metaMessage({ id: 'ffffffff00000001', from: 'X <x@boutique.example>', subject: 'Chief Information Officer <b>role</b>', snippet: 'We are recruiting for a Chief Information Officer. <img src=x onerror=alert(1)> see https://evil.example/p?q=1 ' + 'z'.repeat(900), labels: ['INBOX'] });
    const { ctx } = harness({ inbox: { [m.id]: { meta: m } } });
    const r = await run(ctx);
    const row = r.rows[0];
    assert.equal(row.bucket, 'recruiter_like');
    assert.ok((row.snippet ?? '').length <= 500);
    assert.doesNotMatch(row.snippet ?? '', /<|https?:/);
    assert.doesNotMatch(row.subject ?? '', /<|>/);
  });

  test('rules_version is reported in the stats and tracks the config', async () => {
    const { ctx } = harness({ inbox: {} });
    const cfg = defaultMailIntakeConfig();
    const r = await run(ctx);
    assert.equal(r.rulesVersion, rulesVersionFor(cfg));
    assert.equal(r.stats.rules_version, r.rulesVersion);
  });
});

describe('gmail.search emits the mail_intake event and folds the stats into source_stats', () => {
  before(() => { Object.assign(gmailAuthDeps, fakeGmailAuthDeps); });
  after(() => { Object.assign(gmailAuthDeps, fakeGmailAuthDeps); });

  test('a full search run', async () => {
    const m = simonMessage(false);
    const h = harness({ inbox: { [m.id]: { meta: m } } });
    const base = h.ctx.fetchJson;
    h.ctx.fetchJson = async (/** @type {string} */ url) => {
      const q = new URL(url).searchParams.get('q') ?? '';
      // The alert-sender list and the discovery list find nothing; the intake lists answer as before.
      if (new URL(url).pathname.endsWith('/messages') && (q.includes('from:') || q.includes('subject:('))) return { status: 200, url, json: { messages: [] } };
      return base(url);
    };
    const events = [];
    const gen = gmail.search(/** @type {any} */ ({ name: 't', keywords: [], phrases: [], exclude_terms: [], posted_within_days: 7 }), h.ctx);
    for (;;) {
      const s = await gen.next();
      if (s.done) break;
      events.push(s.value);
    }
    const intake = events.find((e) => e.kind === 'mail_intake');
    assert.ok(intake, 'a mail_intake event was yielded');
    assert.equal(/** @type {any} */ (intake).rows[0].bucket, 'recruiter_like');
    const stats = /** @type {any} */ (events.find((e) => e.kind === 'source_stats')).stats;
    assert.equal(stats.mail_intake.counts.recruiter_like, 1);
    assert.ok(events.indexOf(intake) < events.findIndex((e) => e.kind === 'source_stats'), 'rows are yielded before the closing stats');
  });

  test('a hand-built config without mailIntake skips the pass (no event, no stats key)', async () => {
    const h = harness({ inbox: {} });
    const { mailIntake, ...rest } = h.ctx.config;
    h.ctx.config = rest;
    assert.ok(mailIntake);
    const events = [];
    const gen = gmail.search(/** @type {any} */ ({ name: 't', keywords: [], phrases: [], exclude_terms: [], posted_within_days: 7 }), h.ctx);
    for (;;) {
      const s = await gen.next();
      if (s.done) break;
      events.push(s.value);
    }
    assert.equal(events.some((e) => e.kind === 'mail_intake'), false);
    const stats = /** @type {any} */ (events.find((e) => e.kind === 'source_stats')).stats;
    assert.equal('mail_intake' in stats, false);
  });
});
