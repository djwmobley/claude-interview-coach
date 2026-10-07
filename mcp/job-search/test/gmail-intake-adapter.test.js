// @ts-check
/**
 * Gmail intake addendum, adapter side (G1/G2 per-message classification, stats, discovery; B7, B8): a fake
 * Gmail API routed by URL, the real parsers, and the real 2026-10 fixtures. Proves the total per-message
 * table, the source_stats event, sender dispatch for every new parser, and discovery's four branches,
 * per-sender cap, and budget outcomes.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gmail, deps as gmailAuthDeps, classifyMessageOutcome } from '../src/adapters/gmail.js';
import { alertSendersSchema } from '../src/core/config.js';
import { JobSearchError } from '../src/core/errors.js';
import { readJsonFixture, testConfig, fakeGmailAuthDeps } from './helpers/scan-fixtures.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENDERS = alertSendersSchema.parse(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config', 'alert-senders.json'), 'utf8')));
const NOW = new Date('2026-10-07T12:00:00Z');
const PROFILE = /** @type {any} */ ({ name: 't', keywords: [], phrases: [], exclude_terms: [], posted_within_days: 7 });
const LIST = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?';
const GET = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/';

/** @param {string} from @param {string} text */
function textMsg(id, from, text, subject = 'jobs') {
  const data = Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return { id, internalDate: String(NOW.getTime()), payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }], mimeType: 'text/plain', body: { data } } };
}

/** @param {string} id @param {string} from @param {string} subject @param {boolean} unsub */
function metaMsg(id, from, subject, unsub) {
  const headers = [{ name: 'From', value: from }, { name: 'Subject', value: subject }];
  if (unsub) headers.push({ name: 'List-Unsubscribe', value: '<mailto:x@example.test>' });
  return { id, payload: { headers } };
}

/**
 * @param {{ main: Record<string, any>, discovery?: Array<Record<string, any>>, budgetPages?: number, discoveryCfg?: any }} o
 *   main: id -> full message for the registered-sender query; discovery: successive list pages for the
 *   discovery query (each page id -> metadata message)
 */
function harness(o) {
  /** @type {string[]} */
  const urls = [];
  let pages = 0;
  const discoveryPages = [...(o.discovery ?? [])];
  /** @type {Record<string, any>} */
  const meta = {};
  for (const p of discoveryPages) Object.assign(meta, p);
  const ctx = /** @type {any} */ ({
    signal: new AbortController().signal, now: NOW, windowStart: null, maxPages: 2,
    async fetchJson(/** @type {string} */ url) {
      urls.push(url);
      if (url.startsWith(LIST)) {
        const q = new URL(url).searchParams.get('q') ?? '';
        if (q.includes('-from:')) {
          const page = discoveryPages.shift() ?? {};
          return { status: 200, url, json: { messages: Object.keys(page).map((id) => ({ id })) } };
        }
        return { status: 200, url, json: { messages: Object.keys(o.main).map((id) => ({ id })) } };
      }
      const id = url.slice(GET.length).split('?')[0];
      const msg = url.includes('format=metadata') ? meta[id] : o.main[id];
      return msg ? { status: 200, url, json: msg } : { status: 404, url, json: null };
    },
    async reservePage() {
      pages++;
      if (o.budgetPages !== undefined && pages > o.budgetPages) throw new JobSearchError('BUDGET_EXHAUSTED', 'daily page budget exhausted for gmail');
    },
    async reserveDetail() {},
    capFor: async () => null,
    config: { ...testConfig(), alertSenders: SENDERS.senders, alertIntake: { discovery: { ...SENDERS.discovery, ...(o.discoveryCfg ?? {}) }, health: SENDERS.health } },
    env: { GOOGLE_TOKEN_FILE: 'zz-test-token-file.json' },
    interactive: false,
    log() {},
  });
  return { ctx, urls };
}

async function drain(/** @type {any} */ ctx) {
  /** @type {any[]} */
  const listings = [];
  /** @type {any[]} */
  const warnings = [];
  /** @type {any} */
  let stats = null;
  const gen = gmail.search(PROFILE, ctx);
  for (;;) {
    const s = await gen.next();
    if (s.done) break;
    if (s.value.kind === 'listing') listings.push(s.value.listing);
    else if (s.value.kind === 'warning') warnings.push(s.value);
    else if (s.value.kind === 'source_stats') stats = s.value.stats;
  }
  return { listings, warnings, stats };
}

before(() => { Object.assign(gmailAuthDeps, fakeGmailAuthDeps); });
after(() => { Object.assign(gmailAuthDeps, fakeGmailAuthDeps); });

describe('classifyMessageOutcome: total', () => {
  test('one row per outcome', () => {
    assert.equal(classifyMessageOutcome({ listings: 0, markers: 0, incomplete: 0 }), 'no_job_markers');
    assert.equal(classifyMessageOutcome({ listings: 0, markers: 3, incomplete: 0 }), 'parse_empty');
    assert.equal(classifyMessageOutcome({ listings: 2, markers: 3, incomplete: 0 }), 'partial');
    assert.equal(classifyMessageOutcome({ listings: 3, markers: 3, incomplete: 1 }), 'partial');
    assert.equal(classifyMessageOutcome({ listings: 3, markers: 3, incomplete: 0 }), 'ok');
    assert.equal(classifyMessageOutcome({ listings: Number.NaN, markers: 0, incomplete: 0 }), 'parse_error');
  });
});

describe('gmail.search: dispatch, outcomes, source_stats', () => {
  test('every new sender is dispatched to its parser; outcomes and listings land in stats.by_sender', async () => {
    const main = {
      a0000000000001: readJsonFixture('adapters/gmail-dice-intellisearch-2.json'),
      a0000000000002: readJsonFixture('adapters/gmail-efinancialcareers-jobs-2.json'),
      a0000000000003: readJsonFixture('adapters/gmail-remotehunter-weekly-2.json'),
      a0000000000004: readJsonFixture('adapters/gmail-jobs2web-blackveatch-2.json'),
      a0000000000005: readJsonFixture('adapters/gmail-efinancialcareers-news-2.json'),
    };
    const { ctx } = harness({ main, discoveryCfg: { enabled: false } });
    const { listings, warnings, stats } = await drain(ctx);
    assert.ok(stats, 'a source_stats event closes the search');
    const by = stats.by_sender;
    assert.equal(by['dice@connect.dice.com'].listings, 1);
    assert.equal(by['emails@efinancialcareers.com'].emails, 2);
    assert.equal(by['emails@efinancialcareers.com'].ok, 1);
    assert.equal(by['emails@efinancialcareers.com'].no_job_markers, 1, 'the news mail is no_job_markers, not a warning');
    assert.equal(by['hello@mail.remotehunter.com'].listings, 5);
    assert.equal(by['blackveatch-jobnotification@noreply12.jobs2web.com'].listings, 10);
    assert.equal(by['blackveatch-jobnotification@noreply12.jobs2web.com'].parser_version, 1);
    assert.equal(listings.length, 1 + 10 + 5 + 10);
    assert.ok(!warnings.some((w) => w.code === 'PARSE_EMPTY'));
    assert.equal(stats.discovery.outcome, 'disabled');
  });

  test('parse_empty warns with the markers count; a mail with no markers does not warn; partial warns but still yields', async () => {
    const empty = textMsg('b0000000000001', 'jobalerts-noreply@linkedin.com', '--------------\nOnly\nView job: https://www.linkedin.com/comm/jobs/view/1234567/?x=1');
    const none = textMsg('b0000000000002', 'jobalerts-noreply@linkedin.com', 'Your weekly summary, no jobs here.');
    const partial = textMsg('b0000000000003', 'jobalerts-noreply@linkedin.com', [
      '--------------', 'CTO', 'Acme', 'Austin, TX', 'View job: https://www.linkedin.com/comm/jobs/view/7654321/?x=1',
      '--------------', 'Short', 'View job: https://www.linkedin.com/comm/jobs/view/7654322/?x=1',
    ].join('\n'));
    const { ctx } = harness({ main: { b0000000000001: empty, b0000000000002: none, b0000000000003: partial }, discoveryCfg: { enabled: false } });
    const { listings, warnings, stats } = await drain(ctx);
    const codes = warnings.map((w) => w.code).sort();
    assert.deepEqual(codes, ['PARSE_EMPTY', 'PARSE_PARTIAL']);
    assert.match(warnings.find((w) => w.code === 'PARSE_EMPTY').message, /1 job marker/);
    assert.equal(listings.length, 1);
    const s = stats.by_sender['jobalerts-noreply@linkedin.com'];
    assert.deepEqual([s.emails, s.parse_empty, s.no_job_markers, s.partial, s.markers, s.listings], [3, 1, 1, 1, 3, 1]);
  });

  test('an unregistered From is unhandled_sender and counted by address', async () => {
    const { ctx } = harness({ main: { c0000000000001: textMsg('c0000000000001', 'Promo <promo@new.example>', 'x') }, discoveryCfg: { enabled: false } });
    const { warnings, stats } = await drain(ctx);
    assert.ok(warnings.some((w) => w.code === 'UNKNOWN_SENDER'));
    assert.equal(stats.unhandled_senders['promo@new.example'], 1);
  });
});

describe('discovery (G2, B8)', () => {
  test('four branches; nothing parsed or stored; one shared keyword list in the query', async () => {
    const page = {
      d0000000000001: metaMsg('d0000000000001', 'not an address', 'jobs', true),
      d0000000000002: metaMsg('d0000000000002', 'Ignored <ignored@example.test>', 'Hiring now', true),
      d0000000000003: metaMsg('d0000000000003', 'Board <alerts@newboard.example>', 'New positions for you', true),
      d0000000000004: metaMsg('d0000000000004', 'Shop <deals@shop.example>', 'Weekly deals', true),
    };
    const { ctx, urls } = harness({ main: {}, discovery: [page], discoveryCfg: { ignoredSenders: ['ignored@example.test'] } });
    const { listings, stats } = await drain(ctx);
    assert.equal(listings.length, 0);
    const d = stats.discovery;
    assert.deepEqual([d.unparseable_from, d.ignored, d.unhandled_sender, d.not_alert_like], [1, 1, 1, 1]);
    assert.equal(stats.unhandled_senders['alerts@newboard.example'], 1);
    assert.equal(d.outcome, 'ok');
    const q = new URL(urls.find((u) => u.includes('-from%3A') || u.includes('-from:')) ?? '').searchParams.get('q') ?? '';
    for (const k of ['position', 'positions', 'roles', 'career', 'opportunity', 'hiring', 'jobs']) assert.match(q, new RegExp(`\\b${k}\\b`));
    assert.ok(urls.filter((u) => u.includes('format=metadata')).length === 4);
  });

  test('B8: a sender at perSenderMax is excluded from the next list query instead of eating the whole budget', async () => {
    const noisy1 = { e0000000000001: metaMsg('e0000000000001', 'n@noisy.example', 'jobs', true), e0000000000002: metaMsg('e0000000000002', 'n@noisy.example', 'jobs', true) };
    const next = { e0000000000003: metaMsg('e0000000000003', 'q@quiet.example', 'jobs', true) };
    const { ctx, urls } = harness({ main: {}, discovery: [noisy1, next], discoveryCfg: { perSenderMax: 2 } });
    const { stats } = await drain(ctx);
    assert.equal(stats.unhandled_senders['n@noisy.example'], 2);
    assert.equal(stats.unhandled_senders['q@quiet.example'], 1);
    const lists = urls.filter((u) => u.startsWith(LIST)).map((u) => new URL(u).searchParams.get('q') ?? '');
    assert.ok(lists.some((q) => q.includes('-from:n@noisy.example')), 'the saturated sender is excluded from the next query');
  });

  test('budget: none processed -> skipped_budget; some processed -> partial_budget; the main pass listings still yield', async () => {
    const main = { f0000000000001: readJsonFixture('adapters/gmail-dice-intellisearch-2.json') };
    const page = { f0000000000002: metaMsg('f0000000000002', 'a@x.example', 'jobs', true), f0000000000003: metaMsg('f0000000000003', 'b@x.example', 'jobs', true) };
    // main: 1 list + 1 get = 2 pages; discovery list = page 3.
    const none = await drain(harness({ main, discovery: [page], budgetPages: 2 }).ctx);
    assert.equal(none.stats.discovery.outcome, 'skipped_budget');
    assert.equal(none.listings.length, 1);
    const some = await drain(harness({ main, discovery: [page], budgetPages: 4 }).ctx);
    assert.equal(some.stats.discovery.outcome, 'partial_budget');
  });
});
