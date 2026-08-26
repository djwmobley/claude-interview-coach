// @ts-check
/**
 * Every adapter on fixtures: RawListing shape, tenant-qualified external ids
 * (through normalizeListing), keyword filtering, pagination as URL
 * construction, and the wall/warning events. No network, no DB.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, getAdapter, OFFLINE_SOURCES } from '../src/adapters/index.js';
import { greenhouse, mapJob } from '../src/adapters/greenhouse.js';
import { lever, mapPosting as mapLever, listUrl as leverUrl } from '../src/adapters/lever.js';
import { workday, mapPosting as mapWorkday, searchBody, searchUrl } from '../src/adapters/workday.js';
import { dayforce, parseList } from '../src/adapters/dayforce.js';
import { indeed, listUrl as indeedUrl, mapCard as mapIndeed } from '../src/adapters/indeed.js';
import { linkedin, listUrl as linkedinUrl, mapCard as mapLinkedin } from '../src/adapters/linkedin.js';
import { exec, parseBoardHtml, jobPostingsFromJsonLd } from '../src/adapters/exec-generic.js';
import { gmail, deps as gmailAuthDeps, extractSenderAddress, collectBodyParts } from '../src/adapters/gmail.js';
import { normalizeListing } from '../src/core/normalize.js';
import { classifyUrl, buildRegistry } from '../src/core/urlguard.js';
import { readFixture, readJsonFixture, testConfig, makeFixtureFetch, DEFAULT_MAP, fakeGmailAuthDeps } from './helpers/scan-fixtures.js';

const NOW = new Date('2026-08-25T12:00:00Z');
const RAW_KEYS = ['source', 'externalId', 'url', 'title', 'company', 'location', 'remoteMode', 'remoteDeclared', 'postedAt', 'salaryRaw', 'salaryMin', 'salaryMax', 'description', 'confidentialFirm'];

/** @param {any} l */
function assertRawShape(l) {
  assert.deepEqual(Object.keys(l).sort(), [...RAW_KEYS].sort());
  assert.equal(typeof l.source, 'string');
  assert.equal(typeof l.title, 'string');
  assert.ok(l.title.length > 0);
  assert.equal(typeof l.company, 'string');
  assert.equal(typeof l.remoteDeclared, 'boolean');
  for (const k of ['location', 'postedAt', 'salaryRaw', 'description', 'externalId', 'url', 'confidentialFirm']) assert.ok(l[k] === null || typeof l[k] === 'string', k);
  for (const k of ['salaryMin', 'salaryMax']) assert.ok(l[k] === null || Number.isInteger(l[k]), k);
  if (l.postedAt) assert.match(l.postedAt, /^\d{4}-\d{2}-\d{2}$/);
}

const profile = /** @type {any} */ ({
  name: 't', keywords: ['Chief Technology Officer', 'Chief Information Officer', 'CTO', 'CIO', 'Vice President', 'Chief', 'Director'], phrases: ['SVP Digital Transformation', 'VP Payments Strategy', 'VP Technology'],
  exclude_terms: ['Assistant'], locations: ['Houston, TX'], remote: 'any', posted_within_days: 7, max_pages: 2, sources: [],
});

/**
 * Minimal ctx over the fixture transport. Records fetches so pagination
 * can be asserted as URL construction only.
 * @param {{ maxPages?: number, map?: any[], cap?: any, env?: any }} [o]
 */
function makeCtx(o = {}) {
  const requests = [];
  const fetchImpl = makeFixtureFetch(o.map ?? DEFAULT_MAP, requests);
  const ac = new AbortController();
  const budget = { pages: 0, details: 0 };
  /** @type {import('../src/adapters/base.js').AdapterCtx} */
  const ctx = {
    signal: ac.signal,
    now: NOW,
    windowStart: new Date(NOW.getTime() - 7 * 86400000),
    maxPages: o.maxPages ?? 2,
    async fetchText(url, opts = {}) {
      const res = await fetchImpl(url, { method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body });
      return { status: res.status, url, text: await res.text(), contentType: res.headers.get('content-type') };
    },
    async fetchJson(url, opts = {}) {
      const r = await ctx.fetchText(url, opts);
      let json = null;
      try {
        json = JSON.parse(r.text);
      } catch {
        json = null;
      }
      return { status: r.status, url: r.url, json };
    },
    async reservePage() {
      budget.pages++;
    },
    async reserveDetail() {
      budget.details++;
    },
    capFor: async () => o.cap ?? null,
    config: testConfig(),
    env: o.env ?? { GOOGLE_TOKEN_FILE: 'zz-test-token-file.json' },
    log() {},
  };
  return { ctx, requests, budget };
}

/**
 * Drain an adapter generator with a simple scheduler stand-in: stop each
 * query after maxPages, collect listings/warnings/walls.
 * @param {import('../src/adapters/base.js').Adapter} adapter
 * @param {import('../src/adapters/base.js').AdapterCtx} ctx
 */
async function drain(adapter, ctx) {
  const listings = [];
  const batches = [];
  const warnings = [];
  const walls = [];
  const gen = adapter.search(profile, ctx);
  let directive;
  const pages = {};
  for (;;) {
    const s = await gen.next(directive);
    if (s.done) break;
    directive = undefined;
    const ev = s.value;
    if (ev.kind === 'listing') listings.push(ev.listing);
    else if (ev.kind === 'batch') {
      batches.push(ev);
      pages[ev.query] = (pages[ev.query] ?? 0) + 1;
      if (pages[ev.query] >= ctx.maxPages) directive = { stopQuery: true };
    } else if (ev.kind === 'warning') warnings.push(ev);
    else if (ev.kind === 'wall') walls.push(ev);
  }
  return { listings, batches, warnings, walls };
}

describe('adapter registry', () => {
  test('every adapter has the contract fields and matches adapters.json keys', () => {
    const cfg = testConfig();
    for (const [name, a] of Object.entries(ADAPTERS)) {
      assert.equal(a.name, name);
      assert.equal(typeof a.search, 'function');
      assert.equal(typeof a.needsBrowser, 'boolean');
      assert.equal(typeof a.dateOrdered, 'boolean');
      assert.ok(Array.isArray(a.domains) && Array.isArray(a.pathPatterns));
      assert.ok(a.blindSpots.length >= 1, `${name} states blind spots`);
      assert.ok(cfg.adapters.adapters[name], `${name} in adapters.json`);
      assert.ok(Object.isFrozen(a));
    }
    assert.deepEqual(OFFLINE_SOURCES, ['greenhouse', 'lever', 'workday', 'gmail']);
    assert.throws(() => getAdapter('nope'), (/** @type {any} */ e) => e.code === 'VALIDATION');
  });

  test('adapter path patterns agree with adapters.json (the registry the URL guard uses)', () => {
    const cfg = testConfig();
    for (const name of ['greenhouse', 'lever', 'workday', 'dayforce', 'indeed', 'linkedin', 'gmail']) {
      assert.deepEqual([...ADAPTERS[name].pathPatterns], cfg.adapters.adapters[name].pathPatterns, name);
      assert.deepEqual([...ADAPTERS[name].domains], cfg.adapters.adapters[name].domains, name);
    }
  });
});

describe('greenhouse', () => {
  test('real board fixture: shape, canonical url, tenant-qualified id, keyword filter, one page per board', async () => {
    const { ctx, requests, budget } = makeCtx();
    const r = await drain(greenhouse, ctx);
    for (const l of r.listings) assertRawShape(l);
    const gitlab = r.listings.filter((l) => l.company === 'GitLab');
    assert.ok(gitlab.length >= 2, 'gitlab fixture has matching titles');
    assert.ok(gitlab.every((l) => /vice president|chief|director/i.test(l.title)));
    assert.ok(!r.listings.some((l) => /account executive|ai engineer/i.test(l.title)), 'non-matching titles filtered');
    const cos = r.listings.find((l) => /chief of staff/i.test(l.title));
    assert.ok(cos);
    const n = normalizeListing(cos);
    assert.equal(n.external_id, 'greenhouse:gitlab/8700245002');
    assert.equal(n.url_normalized, 'https://boards.greenhouse.io/gitlab/jobs/8700245002');
    assert.equal(n.source, 'greenhouse');
    assert.equal(cos.postedAt, '2026-08-24');
    const zz = r.listings.filter((l) => l.company === 'ZZ-TEST-SCAN');
    assert.equal(zz.length, 3);
    assert.equal(normalizeListing(zz[0]).external_id, 'greenhouse:zztest/7000000001');
    assert.equal(budget.pages, 2, 'one page reserved per board');
    assert.deepEqual(requests.map((q) => q.method), ['GET', 'GET']);
    assert.equal(r.batches.length, 2);
  });

  test('same numeric id at two boards yields different external ids', () => {
    const a = normalizeListing(/** @type {any} */ (mapJob({ id: 123, title: 'CTO', absolute_url: '' }, { board: 'alpha', company: 'A' })));
    const b = normalizeListing(/** @type {any} */ (mapJob({ id: 123, title: 'CTO', absolute_url: '' }, { board: 'beta', company: 'B' })));
    assert.equal(a.external_id, 'greenhouse:alpha/123');
    assert.equal(b.external_id, 'greenhouse:beta/123');
    assert.notEqual(a.url_normalized, b.url_normalized);
  });

  test('fetchDetail decodes escaped HTML content and reserves a detail', async () => {
    const { ctx, budget } = makeCtx();
    const d = await greenhouse.fetchDetail({ url: 'https://boards.greenhouse.io/gitlab/jobs/8700245002', url_normalized: null, external_id: 'greenhouse:gitlab/8700245002', source: 'greenhouse' }, ctx);
    assert.ok(d.description && d.description.startsWith('<div><p>Synthetic detail'));
    assert.equal(budget.details, 1);
    const none = await greenhouse.fetchDetail({ url: 'https://boards.greenhouse.io/gitlab/jobs/1', url_normalized: null, external_id: null, source: 'greenhouse' }, ctx);
    assert.equal(none.description, null);
  });

  test('404 board yields a warning and an empty batch, never throws', async () => {
    const { ctx } = makeCtx({ map: [] });
    const r = await drain(greenhouse, ctx);
    assert.equal(r.listings.length, 0);
    assert.ok(r.warnings.every((w) => w.code === 'BOARD_NOT_FOUND'));
    assert.equal(r.batches.length, 2);
  });
});

describe('lever', () => {
  test('real postings fixture: shape, hosted url, tenant-qualified id, salaryRange, workplaceType, pagination URLs', async () => {
    const { ctx, requests } = makeCtx({ maxPages: 3 });
    const r = await drain(lever, ctx);
    for (const l of r.listings) assertRawShape(l);
    assert.ok(!r.listings.some((l) => /administrative business partner/i.test(l.title)), 'non-matching titles filtered');
    const vp = r.listings.find((l) => /vice president, engineering/i.test(l.title));
    assert.ok(vp);
    assert.equal(vp.company, 'Palantir Technologies');
    assert.equal(vp.remoteMode, 'hybrid');
    assert.equal(vp.salaryMin, 250000);
    assert.equal(vp.salaryMax, 320000);
    assert.ok(vp.description && vp.description.length > 20);
    const n = normalizeListing(vp);
    assert.equal(n.external_id, 'lever:palantir/aaaaaaaa-1111-4222-8333-444444444444');
    assert.equal(n.url_normalized, 'https://jobs.lever.co/palantir/aaaaaaaa-1111-4222-8333-444444444444');
    const dir = r.listings.find((l) => /director of product/i.test(l.title));
    assert.ok(dir && dir.remoteMode === 'remote' && dir.postedAt === '2020-09-13', 'adapter yields old rows; the scheduler applies the window');
    // fixture has fewer than PAGE_SIZE postings so only one page is fetched
    assert.equal(requests.length, 1);
    assert.equal(leverUrl('palantir', 0), 'https://api.lever.co/v0/postings/palantir?mode=json&limit=100');
    assert.equal(leverUrl('palantir', 200), 'https://api.lever.co/v0/postings/palantir?mode=json&limit=100&skip=200');
  });

  test('same uuid at two companies yields different external ids', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const a = normalizeListing(/** @type {any} */ (mapLever({ id, text: 'CTO', createdAt: 1, categories: {} }, { company: 'one', displayName: 'One' })));
    const b = normalizeListing(/** @type {any} */ (mapLever({ id, text: 'CTO', createdAt: 1, categories: {} }, { company: 'two', displayName: 'Two' })));
    assert.equal(a.external_id, `lever:one/${id}`);
    assert.equal(b.external_id, `lever:two/${id}`);
  });
});

describe('workday', () => {
  test('POST search body is a typed object, results map with relative dates and tenant-qualified ids', async () => {
    const { ctx, requests } = makeCtx({ maxPages: 3 });
    const r = await drain(workday, ctx);
    for (const l of r.listings) assertRawShape(l);
    assert.ok(requests.length >= 1);
    for (const q of requests) {
      assert.equal(q.method, 'POST');
      assert.equal(q.url, searchUrl({ tenant: 'example', site: 'External', wd: 'wd5' }));
      const body = JSON.parse(String(q.body));
      assert.deepEqual(Object.keys(body).sort(), ['appliedFacets', 'limit', 'offset', 'searchText']);
    }
    assert.equal(searchBody('CTO', 20), '{"appliedFacets":{},"limit":20,"offset":20,"searchText":"CTO"}');
    const cto = r.listings.find((l) => l.title === 'Chief Technology Officer');
    assert.ok(cto);
    assert.equal(cto.postedAt, '2026-08-22');
    assert.equal(cto.location, 'Houston, TX');
    const n = normalizeListing(cto);
    assert.equal(n.external_id, 'workday:example/external/r-10021');
    assert.equal(n.url_normalized, 'https://example.wd5.myworkdayjobs.com/external/job/houston-tx/chief-technology-officer_r-10021');
    const vp = r.listings.find((l) => /digital transformation/i.test(l.title));
    assert.ok(vp && vp.postedAt === '2026-08-25' && vp.salaryRaw === '$220,000 - $260,000');
    const old = r.listings.find((l) => /senior software engineer/i.test(l.title));
    assert.ok(old && old.postedAt === '2026-07-26', '30+ days ago is 30 days');
  });

  test('same req id at two tenants yields different external ids; fetchDetail reads jobPostingInfo', async () => {
    const jp = { title: 'CTO', externalPath: '/job/Houston-TX/CTO_R-1', locationsText: 'Houston, TX', postedOn: 'Posted Today' };
    const a = normalizeListing(/** @type {any} */ (mapWorkday(jp, { tenant: 'acme', site: 'External', wd: 'wd1', displayName: 'Acme' }, NOW)));
    const b = normalizeListing(/** @type {any} */ (mapWorkday(jp, { tenant: 'globex', site: 'Careers', wd: 'wd5', displayName: 'Globex' }, NOW)));
    assert.equal(a.external_id, 'workday:acme/external/r-1');
    assert.equal(b.external_id, 'workday:globex/careers/r-1');
    const { ctx, requests, budget } = makeCtx();
    const d = await workday.fetchDetail({ url: 'https://example.wd5.myworkdayjobs.com/External/job/Houston-TX/Chief-Technology-Officer_R-10021', url_normalized: null, external_id: null, source: 'workday' }, ctx);
    assert.ok(d.description && d.description.includes('Synthetic Workday detail'));
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/job/Houston-TX/Chief-Technology-Officer_R-10021');
    assert.equal(budget.details, 1);
  });
});

describe('dayforce', () => {
  test('parses anchors, dedups repeated postings, ignores other clients through the URL, extracts location', () => {
    const c = { host: 'example.dayforcehcm.com', lang: 'en-US', client: 'example', displayName: 'Example Dayforce Co' };
    const { listings, jsOnly } = parseList(readFixture('adapters/dayforce-list.html'), c);
    assert.equal(jsOnly, false);
    for (const l of listings) assertRawShape(l);
    assert.equal(listings.length, 4, '3 postings plus the other-client anchor (host guard, not the parser, rejects it later)');
    const cto = listings.find((l) => l.title === 'Chief Technology Officer');
    assert.ok(cto);
    assert.equal(cto.location, 'Houston, TX, US');
    const n = normalizeListing(cto);
    assert.equal(n.external_id, 'dayforce:example.dayforcehcm.com/example/48211');
    const vp = listings.find((l) => /vice president/i.test(l.title));
    assert.ok(vp && vp.remoteMode === 'hybrid' && vp.remoteDeclared === true);
    assert.equal(normalizeListing(/** @type {any} */ (vp)).external_id, 'dayforce:example.dayforcehcm.com/example/48212');
  });

  test('JS-only portal yields the UNRENDERABLE warning and zero listings', async () => {
    const { ctx } = makeCtx({ map: [{ prefix: 'https://example.dayforcehcm.com/', file: 'adapters/dayforce-jsonly.html' }] });
    const r = await drain(dayforce, ctx);
    assert.equal(r.listings.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].code, 'UNRENDERABLE');
  });

  test('search filters by title and reserves one page per client', async () => {
    const { ctx, budget } = makeCtx();
    const r = await drain(dayforce, ctx);
    assert.deepEqual(r.listings.map((l) => l.title).sort(), ['Chief Technology Officer', 'Vice President of Technology (Hybrid)']);
    assert.equal(budget.pages, 1);
  });
});

describe('indeed (fake capability)', () => {
  test('list URLs are constructed, cards map to viewjob URLs with indeed:<jk> ids, empty page yields a wall event', async () => {
    const gotos = [];
    const cards = readJsonFixture('adapters/indeed-mosaic-cards.json');
    let page = 0;
    const cap = Object.freeze({
      source: 'indeed',
      signal: new AbortController().signal,
      async goto(/** @type {string} */ url) {
        gotos.push(url);
        page++;
        return { status: 200, url: url.split('?')[0], cfMitigated: null };
      },
      async readHtml() {
        return '';
      },
      async readJson(/** @type {string} */ name) {
        if (name === 'indeedMosaicJobs') return page === 1 ? [...cards, ...Array.from({ length: 8 }, (_, i) => ({ jobkey: `f11e${String(i).padStart(12, '0')}`, title: `CTO filler ${i}`, company: 'Filler', location: 'Houston, TX', remote: false, postedMs: 1787000000000 }))] : [];
        if (name === 'indeedDomJobs') return [];
        if (name === 'indeedEmptyState') return true;
        if (name === 'wallMarkers') return { challengeCloudflare: false, challengeForm: false, recaptcha: false };
        throw new Error('unexpected extractor ' + name);
      },
      async scrollToBottom() {
        return { steps: 1, atBottom: true };
      },
    });
    const { ctx, budget } = makeCtx({ maxPages: 2, cap });
    const r = await drain(indeed, ctx);
    for (const l of r.listings) assertRawShape(l);
    assert.equal(r.listings.length, 11, 'broken card without jobkey dropped');
    const cio = r.listings.find((l) => /chief information/i.test(l.title));
    assert.ok(cio);
    const n = normalizeListing(cio);
    assert.equal(n.external_id, 'indeed:a1b2c3d4e5f60718');
    assert.equal(n.url_normalized, 'https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718');
    assert.equal(cio.salaryRaw, '$250,000 - $300,000 a year');
    assert.equal(normalizeListing(cio).salary_min, 250000);
    assert.equal(gotos.length >= 2, true);
    assert.equal(gotos[0], indeedUrl('Chief Technology Officer', 'Houston, TX', 7, 1));
    assert.ok(gotos[0].startsWith('https://www.indeed.com/jobs?q=Chief+Technology+Officer&l=Houston%2C+TX&fromage=7&sort=date'));
    assert.ok(gotos[1].includes('start=10'), 'pagination is URL construction');
    assert.equal(r.walls.length >= 1, true);
    assert.equal(r.walls[0].signals.emptyState, true);
    assert.equal(budget.pages, gotos.length);
    assert.equal(mapIndeed({ jobkey: 'xyz' }), null);
  });

  test('without the scan Chrome the adapter yields BROWSER_UNAVAILABLE and nothing else', async () => {
    const { ctx } = makeCtx({ cap: null });
    const r = await drain(indeed, ctx);
    assert.equal(r.listings.length, 0);
    assert.deepEqual(r.warnings.map((w) => w.code), ['BROWSER_UNAVAILABLE']);
  });
});

describe('linkedin (fake capability)', () => {
  test('list URL carries f_TPR/sortBy/start, cards map to /jobs/view/<id> with linkedin:<id>, hard cap 3 pages', async () => {
    const gotos = [];
    const cards = readJsonFixture('adapters/linkedin-cards.json');
    const cap = Object.freeze({
      source: 'linkedin',
      signal: new AbortController().signal,
      async goto(/** @type {string} */ url) {
        gotos.push(url);
        return { status: 200, url: url.split('?')[0], cfMitigated: null };
      },
      async readHtml() {
        return '';
      },
      async readJson(/** @type {string} */ name) {
        if (name === 'linkedinJobCards') return gotos.length <= 5 ? [...cards, ...Array.from({ length: 25 }, (_, i) => ({ id: String(5000000000 + gotos.length * 100 + i), title: 'CTO filler', company: 'F', location: 'Houston, TX', datetime: '2026-08-24' }))] : [];
        if (name === 'linkedinEmptyState') return true;
        if (name === 'wallMarkers') return { challengeCloudflare: false, challengeForm: false, recaptcha: false };
        throw new Error('unexpected extractor ' + name);
      },
      async scrollToBottom() {
        return { steps: 2, atBottom: true };
      },
    });
    const { ctx } = makeCtx({ maxPages: 5, cap });
    ctx.maxPages = 5;
    const r = await drain(linkedin, ctx);
    for (const l of r.listings) assertRawShape(l);
    const cto = r.listings.find((l) => l.company === 'Mercy Ships');
    assert.ok(cto);
    assert.equal(cto.location, 'Houston, TX');
    assert.equal(cto.remoteMode, 'hybrid');
    const n = normalizeListing(cto);
    assert.equal(n.external_id, 'linkedin:4012345678');
    assert.equal(n.url_normalized, 'https://www.linkedin.com/jobs/view/4012345678');
    assert.equal(linkedinUrl('CTO', 'Houston, TX', 7, 2, 'remote'), 'https://www.linkedin.com/jobs/search/?keywords=CTO&location=Houston%2C+TX&f_TPR=r604800&sortBy=DD&f_WT=2&start=25');
    // profile has 9 terms x 1 location; the first query must stop at 3 pages regardless of ctx.maxPages 5
    const firstQuery = gotos.filter((u) => u.includes('keywords=Chief+Technology+Officer'));
    assert.equal(firstQuery.length, 3, 'hard cap of 3 pages per query');
    assert.equal(mapLinkedin({ id: '12', title: 'x' }), null);
  });
});

describe('linkedin mapCard: verified-badge title text (scan-report-fixes item 1)', () => {
  test('strips the trailing " with verification" badge text at parse time', () => {
    const listing = mapLinkedin({ id: '4378403522', title: 'Executive Partner - CIO Advisory with verification', company: 'Gartner', location: 'Oklahoma, United States' });
    assert.ok(listing);
    assert.equal(listing.title, 'Executive Partner - CIO Advisory');
  });
  test('is case-insensitive and tolerates the extra whitespace the badge markup sometimes leaves', () => {
    const listing = mapLinkedin({ id: '4378403522', title: 'Executive Partner - CIO Advisory  WITH VERIFICATION  ', company: 'Gartner', location: 'Oklahoma, United States' });
    assert.ok(listing);
    assert.equal(listing.title, 'Executive Partner - CIO Advisory');
  });
  test('a title with no badge text is untouched', () => {
    const listing = mapLinkedin({ id: '4378403522', title: 'Chief Technology Officer', company: 'Acme', location: 'Houston, TX' });
    assert.ok(listing);
    assert.equal(listing.title, 'Chief Technology Officer');
  });
  test('a card whose title is empty after whitespace collapse maps to null, same as any other empty title', () => {
    assert.equal(mapLinkedin({ id: '4378403522', title: '   ', company: 'Gartner', location: 'Oklahoma, United States' }), null);
  });
});

describe('exec-generic', () => {
  const cfg = testConfig();
  const fetchBoard = cfg.execBoards.boards.find((b) => b.slug === 'exfetch');
  const browserBoard = cfg.execBoards.boards.find((b) => b.slug === 'exbrowser');

  test('JSON-LD ItemList: JobPosting mapping, confidential firm, off-domain url dropped, salary and remote', () => {
    assert.ok(fetchBoard);
    const r = parseBoardHtml(readFixture('adapters/exec-jsonld.html'), fetchBoard);
    assert.equal(r.method, 'jsonld');
    assert.equal(r.listings.length, 4);
    for (const l of r.listings) assertRawShape(l);
    const cto = r.listings.find((l) => l.title === 'Chief Technology Officer');
    assert.ok(cto);
    assert.equal(cto.source, 'exec:exfetch');
    assert.equal(cto.company, 'Confidential');
    assert.equal(cto.confidentialFirm, 'exfetch');
    assert.equal(cto.location, 'Houston, TX, US');
    assert.equal(cto.salaryMin, 300000);
    assert.equal(cto.postedAt, '2026-08-20');
    const n = normalizeListing(cto);
    assert.equal(n.company_norm, 'confidential:exfetch');
    assert.ok(n.description_hash);
    assert.equal(n.url_normalized, 'https://example-exec.test/opportunities/chief-technology-officer-9001');
    const cio = r.listings.find((l) => l.title === 'Chief Information Officer');
    assert.ok(cio && cio.company === 'Gulf Coast Health' && cio.confidentialFirm === null && cio.remoteMode === 'remote');
    const off = r.listings.find((l) => /off-domain/.test(l.title));
    assert.ok(off && off.url === null && off.externalId && off.externalId.startsWith('exfetch/'));
    assert.equal(normalizeListing(off).external_id, 'exec:exfetch:exfetch/chief-digital-officer-off-domain-link');
    assert.equal(jobPostingsFromJsonLd([{ '@graph': [{ '@type': ['JobPosting'], title: 'x' }] }]).length, 1);
  });

  test('selectors fallback keeps only on-domain links under the board path and strips fragments', () => {
    assert.ok(fetchBoard);
    const r = parseBoardHtml(readFixture('adapters/exec-selectors.html'), fetchBoard);
    assert.equal(r.method, 'selectors');
    assert.deepEqual(r.listings.map((l) => l.title), ['Chief Technology Officer', 'VP Payments Strategy', 'Office Manager']);
    assert.equal(r.listings[1].url, 'https://www.example-exec.test/opportunities/vp-payments-9004?utm_source=list');
    assert.equal(r.listings[1].location, 'Remote (US)');
    assert.equal(r.listings[1].remoteMode, 'remote');
    assert.equal(normalizeListing(r.listings[1]).url_normalized, 'https://example-exec.test/opportunities/vp-payments-9004', 'tracking param stripped and www. dropped by residual canonicalization');
  });

  test('anchors fallback dedups and skips the list page, short titles, and out-of-pattern paths', () => {
    assert.ok(fetchBoard);
    const board = { ...fetchBoard, selectors: undefined };
    const r = parseBoardHtml(readFixture('adapters/exec-anchors.html'), board);
    assert.equal(r.method, 'anchors');
    assert.deepEqual(r.listings.map((l) => l.title), ['Chief Operating Officer', 'SVP Digital Transformation']);
  });

  test('fetch board search: filters titles, reserves one page, scopes the guard to exec:<slug>', async () => {
    const sources = [];
    const { ctx, budget } = makeCtx();
    const inner = ctx.fetchText;
    ctx.fetchText = async (url, o) => {
      sources.push(o && o.source);
      return inner(url, o);
    };
    const r = await drain(exec, ctx);
    const fetched = r.listings.filter((l) => l.source === 'exec:exfetch');
    assert.deepEqual(fetched.map((l) => l.title).sort(), ['Chief Technology Officer', 'VP Payments Strategy']);
    assert.ok(sources.every((s) => s === 'exec:exfetch'));
    assert.equal(budget.pages, 2, 'both boards reserve a page; the browser board reports BROWSER_UNAVAILABLE without a scan Chrome');
    assert.ok(r.warnings.some((w) => w.code === 'BROWSER_UNAVAILABLE'));
  });

  test('browser board reads JSON-LD through the capability, then selectors, then html', async () => {
    assert.ok(browserBoard);
    const listItems = [{ href: '/en/opportunities/cto-1', title: 'Chief Technology Officer', location: 'Dallas, TX' }, { href: '/about', title: 'About the firm', location: null }];
    const cap = Object.freeze({
      source: 'exec:exbrowser',
      signal: new AbortController().signal,
      async goto(/** @type {string} */ url) {
        return { status: 200, url, cfMitigated: null };
      },
      async readHtml() {
        return '<html></html>';
      },
      async readJson(/** @type {string} */ name) {
        if (name === 'readJsonLd') return [];
        if (name === 'genericListItems') return listItems;
        if (name === 'wallMarkers') return {};
        throw new Error('unexpected ' + name);
      },
      async scrollToBottom() {
        return { steps: 0, atBottom: true };
      },
    });
    const { ctx } = makeCtx({ cap, map: [] });
    const r = await drain(exec, ctx);
    const b = r.listings.filter((l) => l.source === 'exec:exbrowser');
    assert.equal(b.length, 1);
    assert.equal(b[0].url, 'https://www.example-exec-js.test/en/opportunities/cto-1');
    assert.equal(b[0].location, 'Dallas, TX');
  });

  test('every fixture listing URL passes the URL guard registry for its source', () => {
    const registry = buildRegistry(cfg);
    const checks = [
      ['greenhouse', 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs'],
      ['lever', leverUrl('palantir', 100)],
      ['workday', searchUrl({ tenant: 'example', site: 'External', wd: 'wd5' })],
      ['dayforce', 'https://example.dayforcehcm.com/CandidatePortal/en-US/example'],
      ['indeed', indeedUrl('CTO', 'Houston, TX', 7, 2)],
      ['linkedin', linkedinUrl('CTO', 'Houston, TX', 7, 2)],
      ['exec:exfetch', 'https://www.example-exec.test/opportunities/chief-technology-officer-9001'],
      ['exec:exbrowser', 'https://www.example-exec-js.test/en/opportunities'],
      ['gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=x&maxResults=50'],
      ['gmail', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765401?format=full'],
    ];
    for (const [source, url] of checks) {
      const v = classifyUrl(url, registry, { source });
      assert.equal(v.allowed, true, `${source} ${url}: ${v.reason}`);
    }
    assert.equal(classifyUrl(searchUrl({ tenant: 'example', site: 'External', wd: 'wd5' }), registry, { source: 'workday', method: 'POST' }).allowed, true);
    assert.equal(classifyUrl('https://example.wd5.myworkdayjobs.com/External/job/x/y_R-1', registry, { source: 'workday', method: 'POST' }).allowed, false);
  });
});

describe('gmail', () => {
  /** Restore the real auth deps after every test so no other test in this file accidentally inherits a stub. */
  function withFakeAuth(fn) {
    return async () => {
      Object.assign(gmailAuthDeps, fakeGmailAuthDeps);
      try {
        await fn();
      } finally {
        // gmail.js's module-level deps object is reset per test file process anyway (node --test isolates
        // files), but resetting here keeps intra-file test order-independence explicit.
        Object.assign(gmailAuthDeps, fakeGmailAuthDeps);
      }
    };
  }

  test('extractSenderAddress: addr-spec inside <...> wins; a bare address is used as-is; never a substring match', () => {
    assert.equal(extractSenderAddress('LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>'), 'jobalerts-noreply@linkedin.com');
    assert.equal(extractSenderAddress('donotreply@jobalert.indeed.com'), 'donotreply@jobalert.indeed.com');
    assert.equal(extractSenderAddress('"Fake LinkedIn Job Alerts" <attacker@evil.test>'), 'attacker@evil.test', 'a spoofed display name never changes the extracted address');
    assert.equal(extractSenderAddress(null), null);
    assert.equal(extractSenderAddress('not an address'), null);
  });

  test('collectBodyParts walks nested multipart to any depth and keeps the first text/plain and text/html leaf', () => {
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('plain body') } },
            { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
          ],
        },
        { mimeType: 'application/octet-stream', body: { data: b64('ignored attachment') } },
      ],
    };
    const out = { text: null, html: null };
    collectBodyParts(payload, out);
    assert.equal(out.text, 'plain body');
    assert.equal(out.html, '<p>html body</p>');
  });

  test(
    'fixture run: messages.list then per-message get, per-sender parser dispatch, title filter, no fetch of job links themselves',
    withFakeAuth(async () => {
      const { ctx, requests } = makeCtx({ maxPages: 1 });
      const listings = [];
      const gen = gmail.search(profile, ctx);
      let directive;
      const batches = [];
      const warnings = [];
      for (;;) {
        const s = await gen.next(directive);
        if (s.done) break;
        directive = undefined;
        const ev = s.value;
        if (ev.kind === 'listing') listings.push(ev.listing);
        else if (ev.kind === 'batch') batches.push(ev);
        else if (ev.kind === 'warning') warnings.push(ev);
      }
      assert.equal(warnings.length, 0, JSON.stringify(warnings));
      assert.equal(batches.length, 1);
      assert.ok(listings.length > 0, 'at least one title-matching listing across the 10 fixture messages');
      for (const l of listings) assertRawShape(l);
      for (const l of listings) assert.equal(l.source, 'gmail');
      // Ladders' "Project Engineer" and Lensa's Uber gig-work postings match none of the profile's keywords.
      assert.ok(!listings.some((l) => l.title === 'Project Engineer'));
      assert.ok(!listings.some((l) => /drive with uber|alternatives to cash/i.test(l.title)));
      // Every recorded request is a GET to /gmail/v1/users/me/messages(/id)?; the adapter never fetches
      // the job links it discovers (LinkedIn, Indeed, Lensa, Ladders hosts never appear in requests).
      assert.ok(requests.length >= 11, `expected 1 list + 10 get calls, saw ${requests.length}`);
      for (const r of requests) {
        assert.equal(r.method, 'GET');
        assert.match(r.url, /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages/);
      }
      // Every request's HOST is gmail.googleapis.com; job-board domains appear only inside the Gmail
      // search `q` query string (as `from:` terms), never as a fetch target.
      assert.ok(requests.every((r) => new URL(r.url).hostname === 'gmail.googleapis.com'));
    }),
  );

  test(
    'no GOOGLE_TOKEN_FILE configured yields AUTH_UNAVAILABLE and nothing else',
    withFakeAuth(async () => {
      const { ctx } = makeCtx({ env: {} });
      const gen = gmail.search(profile, ctx);
      const first = await gen.next();
      assert.equal(first.done, false);
      assert.equal(first.value.kind, 'warning');
      assert.equal(first.value.code, 'AUTH_UNAVAILABLE');
      const second = await gen.next();
      assert.equal(second.done, true);
    }),
  );

  test(
    'GOOGLE_TOKEN_FILE set to an empty string (the unconfigured default) is treated as missing: AUTH_UNAVAILABLE and nothing else',
    withFakeAuth(async () => {
      const { ctx } = makeCtx({ env: { GOOGLE_TOKEN_FILE: '' } });
      const gen = gmail.search(profile, ctx);
      const first = await gen.next();
      assert.equal(first.done, false);
      assert.equal(first.value.kind, 'warning');
      assert.equal(first.value.code, 'AUTH_UNAVAILABLE');
      const second = await gen.next();
      assert.equal(second.done, true);
    }),
  );

  test(
    'readTokenFile throwing (missing file / missing scope) yields exactly one AUTH_UNAVAILABLE warning',
    withFakeAuth(async () => {
      gmailAuthDeps.readTokenFile = () => {
        throw new Error('token file not readable: nope.json');
      };
      const { ctx } = makeCtx();
      const events = [];
      const gen = gmail.search(profile, ctx);
      for (;;) {
        const s = await gen.next();
        if (s.done) break;
        events.push(s.value);
      }
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'warning');
      assert.equal(events[0].code, 'AUTH_UNAVAILABLE');
    }),
  );

  test(
    '401 on messages.list yields exactly one AUTH_UNAVAILABLE warning and no per-message retry',
    withFakeAuth(async () => {
      const map = [{ prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?', file: 'adapters/gmail-list-all.json', status: 401 }];
      const { ctx } = makeCtx({ map });
      const events = [];
      const gen = gmail.search(profile, ctx);
      for (;;) {
        const s = await gen.next();
        if (s.done) break;
        events.push(s.value);
      }
      assert.deepEqual(events.map((e) => e.code), ['AUTH_UNAVAILABLE']);
    }),
  );

  test(
    '401 on a messages.get after a successful list stops the source immediately (R9)',
    withFakeAuth(async () => {
      const map = [
        { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?', file: 'adapters/gmail-list-all.json' },
        { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765401', file: 'adapters/gmail-linkedin-alert-1.json', status: 401 },
      ];
      const { ctx, requests } = makeCtx({ map });
      const events = [];
      const listings = [];
      const gen = gmail.search(profile, ctx);
      for (;;) {
        const s = await gen.next();
        if (s.done) break;
        if (s.value.kind === 'listing') listings.push(s.value.listing);
        else events.push(s.value);
      }
      assert.deepEqual(events.map((e) => e.code), ['AUTH_UNAVAILABLE']);
      assert.equal(listings.length, 0);
      // Only the list call and the one 401'd get call were made; the loop stopped before trying the other 9 ids.
      assert.equal(requests.length, 2);
    }),
  );

  test(
    'a message From an address not in alert-senders.json yields UNKNOWN_SENDER, never parsed',
    withFakeAuth(async () => {
      const map = [
        { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?', file: 'adapters/gmail-list-all.json' },
      ];
      // Reuse the real fixture set but only ask for one id whose From is legitimate; then swap it for a spoofed one.
      const spoofed = readJsonFixture('adapters/gmail-linkedin-alert-1.json');
      spoofed.payload = { ...spoofed.payload, headers: spoofed.payload.headers.map((h) => (h.name === 'From' ? { name: 'From', value: 'Not A Real Sender <attacker@evil.test>' } : h)) };
      map.push({ prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765401', body: JSON.stringify(spoofed), file: undefined });
      for (const id of ['fedcba98765402', 'fedcba98765403', 'fedcba98765404', 'fedcba98765405', 'fedcba98765406', 'fedcba98765407', 'fedcba98765408', 'fedcba98765409', 'fedcba9876540a']) {
        map.push({ prefix: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, status: 404, body: '{}' });
      }
      const { ctx } = makeCtx({ map });
      const warnings = [];
      const listings = [];
      const gen = gmail.search(profile, ctx);
      for (;;) {
        const s = await gen.next();
        if (s.done) break;
        if (s.value.kind === 'warning') warnings.push(s.value);
        else if (s.value.kind === 'listing') listings.push(s.value.listing);
      }
      assert.ok(warnings.some((w) => w.code === 'UNKNOWN_SENDER' && /evil\.test/.test(w.message)));
      assert.equal(listings.length, 0);
    }),
  );

  test(
    'a message with no text/plain and no text/html part yields NO_BODY_PART',
    withFakeAuth(async () => {
      const map = [
        { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?', body: JSON.stringify({ messages: [{ id: 'fedcba98765401' }] }) },
        { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765401', body: JSON.stringify({ id: 'fedcba98765401', internalDate: String(NOW.getTime()), payload: { headers: [{ name: 'From', value: 'jobalerts-noreply@linkedin.com' }], mimeType: 'application/octet-stream', body: {} } }) },
      ];
      const { ctx } = makeCtx({ map });
      const warnings = [];
      const gen = gmail.search(profile, ctx);
      for (;;) {
        const s = await gen.next();
        if (s.done) break;
        if (s.value.kind === 'warning') warnings.push(s.value);
      }
      assert.deepEqual(warnings.map((w) => w.code), ['NO_BODY_PART']);
    }),
  );

  test(
    'a known sender whose parser finds zero listings yields PARSE_EMPTY, not silence',
    withFakeAuth(async () => {
      const emptyBody = Buffer.from('nothing job-shaped here, no View job: line', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      const map = [
        { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?', body: JSON.stringify({ messages: [{ id: 'fedcba98765401' }] }) },
        { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765401', body: JSON.stringify({ id: 'fedcba98765401', internalDate: String(NOW.getTime()), payload: { headers: [{ name: 'From', value: 'jobalerts-noreply@linkedin.com' }], mimeType: 'text/plain', body: { data: emptyBody } } }) },
      ];
      const { ctx } = makeCtx({ map });
      const warnings = [];
      const gen = gmail.search(profile, ctx);
      for (;;) {
        const s = await gen.next();
        if (s.done) break;
        if (s.value.kind === 'warning') warnings.push(s.value);
      }
      assert.deepEqual(warnings.map((w) => w.code), ['PARSE_EMPTY']);
    }),
  );

  test('adapter is registered with ignoresQuery:true and no fetchDetail', () => {
    assert.equal(gmail.ignoresQuery, true);
    assert.equal(gmail.fetchDetail, undefined);
    assert.equal(gmail.dateOrdered, false, 'R11: digest order is relevance, not chronology');
    for (const name of Object.keys(ADAPTERS)) {
      if (name === 'gmail') continue;
      assert.notEqual(ADAPTERS[name].ignoresQuery, true, `${name} must not set ignoresQuery`);
    }
  });
});
