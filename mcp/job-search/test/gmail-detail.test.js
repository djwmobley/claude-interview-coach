// @ts-check
/**
 * src/core/gmail-detail.js (Gmail intake addendum G3; adversary amendments B1, B2, B3, B10): the pure
 * resolver over real fixture links, the tracker unwrap with a stubbed single-GET fetch, and the
 * description phase against the real test database (dedupe, the JSON-LD fetch, the rescore hand-off,
 * caps, the resolution cache, and the manual-apply surfacing). Nothing here touches the network.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as cheerio from 'cheerio';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { resolveGmailTarget, unwrapTracker, hostAllowed, decodeCustomerIo, runGmailDetail, collectGmailManualApply, jobPostingDescription } from '../src/core/gmail-detail.js';
import { loadRescoreIds } from '../src/core/triage.js';
import { readGmailFixture } from './helpers/scan-fixtures.js';

const GUARD = ['lensa.com', 'sg3email.lensa.com', 'email.lensa.com', 't.ladders.co', 'elinks.dice.com', 'www.dice.com', 'www.efinancialcareers.com', 'careers.bv.com', 'e.customeriomail.com'];

/** @param {string} name @param {string} selector */
function hrefFrom(name, selector) {
  const { html } = readGmailFixture(`adapters/gmail-${name}-2.json`);
  const $ = cheerio.load(String(html));
  return String($(selector).first().attr('href'));
}

/** @param {string} l */
function mailgun(l) {
  const tok = zlib.deflateSync(Buffer.from(`d=x&l=${encodeURIComponent(l)}`)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://email.mg1.lensa.com/c/${tok}`;
}

describe('resolveGmailTarget: one row per branch', () => {
  test('Mailgun token from a real digest decodes to lensa.com/cgw and is unwrapped over the network', () => {
    const href = hrefFrom('lensa-jobalert-digest', 'a[href*="/c/"]:not(:contains("edit settings"))');
    const r = resolveGmailTarget({ url: href });
    assert.ok(['network_unwrap', 'denied_link'].includes(r.branch), r.branch);
    const cgw = resolveGmailTarget({ url: mailgun('https://lensa.com/cgw/abc123?x=1') });
    assert.equal(cgw.branch, 'network_unwrap');
    assert.match(String(cgw.url), /^https:\/\/lensa\.com\/cgw\/abc123/);
  });
  test('a decoded lensa.com/profile-settings link is denied_link', () => {
    assert.equal(resolveGmailTarget({ url: mailgun('https://lensa.com/profile-settings/job-preferences/?tok=1') }).branch, 'denied_link');
  });
  test('a Customer.io token from the RemoteHunter fixture decodes to apply-with-ai: denied_apply_link', () => {
    const href = hrefFrom('remotehunter-weekly', 'a.job-title-link');
    assert.match(String(decodeCustomerIo(href)), /remotehunter\.com\/apply-with-ai\//);
    assert.equal(resolveGmailTarget({ url: href }).branch, 'denied_apply_link');
  });
  test('Ladders tracker -> network_unwrap; Dice job-detail -> generic; linkedin external id -> linkedin; null -> no_link', () => {
    assert.equal(resolveGmailTarget({ url: 'https://t.ladders.co/f/a/x~~/y~/z' }).branch, 'network_unwrap');
    assert.equal(resolveGmailTarget({ url: 'https://www.dice.com/job-detail/e58b886b-7029-48d3-8ee5-8129e74f8edd' }).branch, 'generic');
    assert.equal(resolveGmailTarget({ url: 'https://www.linkedin.com/jobs/view/4475196124', external_id: 'linkedin:4475196124' }).branch, 'linkedin');
    assert.equal(resolveGmailTarget({ url: 'https://www.indeed.com/viewjob?jk=76413b8d35383832' }).branch, 'indeed');
    assert.equal(resolveGmailTarget({ url: null }).branch, 'no_link');
    assert.equal(resolveGmailTarget({ url: 'https://example.org/somewhere' }).branch, 'unknown_target');
  });
  test('a 4-deep Mailgun nesting is unwrap_loop; throwing input is classify_error', () => {
    const deep = mailgun(mailgun(mailgun(mailgun('https://lensa.com/cgw/abc'))));
    assert.equal(resolveGmailTarget({ url: deep }).branch, 'unwrap_loop');
    assert.equal(resolveGmailTarget(/** @type {any} */ ({ get url() { throw new Error('boom'); } })).branch, 'classify_error');
  });
});

describe('unwrapTracker (B3, B10)', () => {
  /** @param {Record<string, { status: number, location?: string, text?: string }>} map */
  const fetchFrom = (map, /** @type {string[]} */ seen) => async (/** @type {string} */ url) => {
    seen.push(url);
    const r = map[url];
    if (!r) return { status: 404, location: null, text: '' };
    return { status: r.status, location: r.location ?? null, text: r.text ?? '' };
  };
  const charge = async () => true;
  test('a 302 chain ending on LinkedIn resolves without requesting the destination', async () => {
    const seen = /** @type {string[]} */ ([]);
    const r = await unwrapTracker('https://t.ladders.co/f/a/1', {
      fetchOnce: fetchFrom({ 'https://t.ladders.co/f/a/1': { status: 302, location: 'https://t.ladders.co/f/a/2' }, 'https://t.ladders.co/f/a/2': { status: 302, location: 'https://www.linkedin.com/jobs/view/4475196124' } }, seen),
      maxHops: 5, guardDomains: GUARD, chargeHop: charge,
    });
    assert.deepEqual([r.outcome, r.finalUrl], ['resolved', 'https://www.linkedin.com/jobs/view/4475196124']);
    assert.ok(!seen.some((u) => u.includes('linkedin.com')));
    assert.equal(resolveGmailTarget({ url: String(r.finalUrl) }, { noUnwrap: true }).branch, 'linkedin');
  });
  test('a hop outside the guard is blocked; 6 tracker hops is too_many_hops; an action word is refused before the request', async () => {
    const seen = /** @type {string[]} */ ([]);
    const blocked = await unwrapTracker('https://evil-t.ladders.co.example/f/a/1', { fetchOnce: fetchFrom({}, seen), maxHops: 5, guardDomains: GUARD, chargeHop: charge });
    assert.equal(blocked.outcome, 'blocked_by_guard');
    /** @type {Record<string, any>} */
    const chain = {};
    for (let i = 1; i <= 7; i++) chain[`https://t.ladders.co/f/a/${i}`] = { status: 302, location: `https://t.ladders.co/f/a/${i + 1}` };
    assert.equal((await unwrapTracker('https://t.ladders.co/f/a/1', { fetchOnce: fetchFrom(chain, []), maxHops: 5, guardDomains: GUARD, chargeHop: charge })).outcome, 'too_many_hops');
    const s2 = /** @type {string[]} */ ([]);
    const denied = await unwrapTracker('https://t.ladders.co/unsubscribe?u=1', { fetchOnce: fetchFrom({}, s2), maxHops: 5, guardDomains: GUARD, chargeHop: charge });
    assert.equal(denied.outcome, 'denied_hop');
    assert.equal(s2.length, 0);
    const budget = await unwrapTracker('https://t.ladders.co/f/a/1', { fetchOnce: fetchFrom(chain, []), maxHops: 5, guardDomains: GUARD, chargeHop: async () => false });
    assert.equal(budget.outcome, 'skipped_budget');
  });
  test('hostAllowed is exact or dot-suffix only', () => {
    assert.equal(hostAllowed('t.ladders.co', GUARD), true);
    assert.equal(hostAllowed('x.t.ladders.co', GUARD), true);
    assert.equal(hostAllowed('evilt.ladders.co', GUARD), false);
    assert.equal(hostAllowed('lensa.com.evil.test', GUARD), false);
  });
});

describe('runGmailDetail (real DB)', () => {
  const CO = `ZZ Gmail Detail ${process.pid}`;
  /** @type {pg.Client} */
  let c;
  /** @type {number[]} */
  const ids = [];
  const JSONLD = (/** @type {string} */ d) => `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'CTO', description: d })}</script></html>`;
  const config = {
    adapters: { adapters: {
      gmail: { detailRouting: { enabled: true, detailMaxAttempts: 3, maxHops: 5, unwrapPerDay: 300, generic: { perDay: 60, perRun: 30 }, linkedin: { perDay: 40, perRun: 20 }, indeed: { perDay: 20, perRun: 10 }, ats: { perDay: 20, perRun: 10 } } },
      'gmail-detail': { domains: GUARD },
    } },
  };
  /**
   * @param {{ source?: string, url?: string|null, externalId?: string|null, fit?: number|null, description?: string|null, fitBasis?: string|null, urlNormalized?: string|null }} o
   */
  async function seed(o) {
    const n = Math.floor(Math.random() * 1e9);
    const r = await c.query(
      `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, url, url_normalized, fit_score, description, fit_basis, first_seen)
       VALUES ('Gmail Detail CTO', $1, $2, $3, 'listing', 'zz gmail detail', 'gmail detail cto', 'country-us', $4, now(), $5, $6, $7, $8, $9, now() + interval '30 days') RETURNING id`,
      [CO, o.source ?? 'gmail', o.externalId ?? `gmail:zz:${n}`, `zz-gd-${n}`, o.url ?? null, o.urlNormalized ?? null, o.fit ?? 75, o.description ?? null, o.fitBasis ?? null],
    );
    ids.push(Number(r.rows[0].id));
    return Number(r.rows[0].id);
  }
  const reserveOk = async () => ({ ok: true, remainingPages: 0, remainingDetails: 1 });
  before(async () => {
    c = new pg.Client(pgConnectionConfig());
    await c.connect();
    await ensureAuxSchema(c);
  });
  const clean = async () => {
    if (ids.length) {
      await c.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
      await c.query('UPDATE ic_job_listings SET duplicate_of = NULL WHERE id = ANY($1::int[])', [ids]);
      await c.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
      ids.length = 0;
    }
    // Other files' gmail rows would also be candidates; only this file's rows matter, so park the rest.
    await c.query(`UPDATE ic_job_listings SET status = 'skip' WHERE source = 'gmail' AND company <> $1 AND status IS NULL`, [CO]);
    await c.query(`DELETE FROM ic_scan_budget WHERE source LIKE 'gmail-route:%'`);
  };
  beforeEach(clean);
  after(async () => {
    await clean();
    await c.end();
  });

  test('generic: a Dice job page with a JSON-LD description of 400 chars is stored; loadRescoreIds then returns a no_description row (A2 hand-off)', async () => {
    const id = await seed({ url: 'https://www.dice.com/job-detail/e58b886b-7029-48d3-8ee5-8129e74f8edd', fitBasis: 'no_description' });
    const desc = 'A senior technology leadership role. '.repeat(11);
    const stats = await runGmailDetail(c, {
      config, now: new Date(), log: () => {}, reserveBudget: reserveOk,
      fetchOnce: async () => ({ status: 200, location: null, text: JSONLD(desc) }),
    });
    const row = (await c.query('SELECT description, detail_outcome, detail_attempts, external_id, url_normalized FROM ic_job_listings WHERE id = $1', [id])).rows[0];
    assert.equal(row.detail_outcome, 'fetched');
    assert.ok(row.description.length >= 300);
    assert.equal(stats.fetched_by.generic, 1);
    assert.ok((await loadRescoreIds(c, 50)).includes(id));
  });

  test('B1 dedupe: a tracker resolving to a LinkedIn job that already has a native row with a description merges, no fetch, ids untouched', async () => {
    const native = await seed({ source: 'linkedin', externalId: 'linkedin:4475196124', urlNormalized: 'https://www.linkedin.com/jobs/view/4475196124', description: 'x'.repeat(400) });
    const gm = await seed({ url: 'https://t.ladders.co/f/a/zz', externalId: 'gmail:ladders:abc' });
    /** @type {string[]} */
    const fetched = [];
    const stats = await runGmailDetail(c, {
      config, now: new Date(), log: () => {}, reserveBudget: reserveOk,
      fetchOnce: async (url) => { fetched.push(url); return { status: 302, location: 'https://www.linkedin.com/jobs/view/4475196124', text: '' }; },
    });
    assert.deepEqual(fetched, ['https://t.ladders.co/f/a/zz'], 'only the tracker hop, never the LinkedIn page');
    const row = (await c.query('SELECT duplicate_of, external_id, url_normalized FROM ic_job_listings WHERE id = $1', [gm])).rows[0];
    assert.equal(Number(row.duplicate_of), native);
    assert.equal(row.external_id, 'gmail:ladders:abc', 'B1: the gmail row keeps its own identity');
    assert.equal(stats.deduped, 1);
  });

  test('B1 cache: a second run reuses the cached resolution and never unwraps the same link again', async () => {
    const gm = await seed({ url: 'https://t.ladders.co/f/a/cache1' });
    let hops = 0;
    const deps = { config, now: new Date(), log: () => {}, reserveBudget: reserveOk, fetchOnce: async () => { hops++; return { status: 302, location: 'https://www.linkedin.com/jobs/view/1111111111', text: '' }; } };
    await runGmailDetail(c, deps);
    const second = await runGmailDetail(c, deps);
    assert.equal(hops, 1);
    assert.equal(second.cache_hits, 1);
    const t = (await c.query('SELECT outcome FROM ic_gmail_targets WHERE listing_id = $1', [gm])).rows[0];
    assert.equal(t.outcome, 'routed_pending');
  });

  test('B2: unfetchable rows at fit 60+ surface as manual-apply items with their link; stuck ineligible counted', async () => {
    await seed({ url: null, fit: 70 });
    await seed({ url: 'https://www.remotehunter.com/apply-with-ai/8f85d1da-1dec-4472-8505-1ae13f3d76bc', fit: 80 });
    await seed({ url: null, fit: 40 });
    const stats = await runGmailDetail(c, { config, now: new Date(), log: () => {}, reserveBudget: reserveOk, fetchOnce: async () => { throw new Error('no network'); } });
    const list = (await collectGmailManualApply(c)).filter((x) => x.company === CO);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((x) => x.outcome).sort(), ['denied_apply_link', 'no_link']);
    assert.ok(stats.stuck_ineligible >= 2);
  });

  test('caps: perRun holds; a refused daily reservation is skipped_budget and the row is untouched', async () => {
    const a = await seed({ url: 'https://www.dice.com/job-detail/11111111-1111-4111-8111-111111111111' });
    const b = await seed({ url: 'https://www.dice.com/job-detail/22222222-2222-4222-8222-222222222222' });
    const one = { adapters: { adapters: { ...config.adapters.adapters, gmail: { detailRouting: { ...config.adapters.adapters.gmail.detailRouting, generic: { perDay: 60, perRun: 1 } } } } } };
    const s1 = await runGmailDetail(c, { config: one, now: new Date(), log: () => {}, reserveBudget: reserveOk, fetchOnce: async () => ({ status: 200, location: null, text: JSONLD('d'.repeat(400)) }) });
    assert.equal(s1.fetched_by.generic, 1);
    assert.equal(s1.deferred.skipped_run_cap, 1);
    const refused = async () => ({ ok: false, remainingPages: 0, remainingDetails: 0 });
    const s2 = await runGmailDetail(c, { config, now: new Date(), log: () => {}, reserveBudget: refused, fetchOnce: async () => { throw new Error('must not fetch'); } });
    assert.equal(s2.deferred.skipped_budget, 1);
    const untouched = (await c.query('SELECT detail_attempts FROM ic_job_listings WHERE id = ANY($1::int[]) AND description IS NULL', [[a, b]])).rows;
    assert.ok(untouched.every((r) => Number(r.detail_attempts) === 0));
  });

  test('jobPostingDescription reads the first JobPosting description as text', () => {
    assert.equal(jobPostingDescription(JSONLD('<p>Hello <b>world</b></p>')), 'Hello world');
    assert.equal(jobPostingDescription('<html></html>'), null);
  });
});
