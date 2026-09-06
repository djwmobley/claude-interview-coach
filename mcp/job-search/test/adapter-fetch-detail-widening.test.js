// @ts-check
/**
 * fetchDetail widening (auto-apply PR B plan step 5): every scan adapter's fetchDetail now MAY return
 * externalApplyUrl/easyApplyOnly/applyProbe alongside description, but the legacy `{ description }` shape
 * (no new fields at all) must remain valid everywhere those fields cannot be determined. Exercised against
 * fully scripted fake ctx objects -- no real network, no live browser/DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { linkedin, extractLinkedInJobId } from '../src/adapters/linkedin.js';
import { indeed } from '../src/adapters/indeed.js';
import { greenhouse } from '../src/adapters/greenhouse.js';
import { workday } from '../src/adapters/workday.js';
import { dayforce } from '../src/adapters/dayforce.js';
import { exec } from '../src/adapters/exec-generic.js';
import { registryFrom } from '../src/core/urlguard.js';
import { makeCapability } from '../src/browser/capability.js';

/** @param {Record<string, any>} readJsonResponses */
function fakeCap(readJsonResponses = {}) {
  return {
    async goto() {},
    async readJson(name) {
      if (name in readJsonResponses) return readJsonResponses[name];
      return null;
    },
  };
}

function baseCtx(overrides = {}) {
  return {
    reserveDetail: async () => {},
    fetchJson: async () => ({ status: 404, url: '', json: null }),
    fetchText: async () => ({ status: 404, url: '', text: '', contentType: null }),
    capFor: async () => null,
    config: { execBoards: { boards: [] } },
    log: () => {},
    ...overrides,
  };
}

describe('fetchDetail widening: legacy shape stays valid', () => {
  test('linkedin: no capability available still returns a bare { description: null }', async () => {
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/view/123/', source: 'linkedin' }, baseCtx());
    assert.deepEqual(r, { description: null });
  });

  test('indeed: no url returns a bare { description: null }', async () => {
    const r = await indeed.fetchDetail({ url: null, source: 'indeed' }, baseCtx());
    assert.deepEqual(r, { description: null });
  });
});

describe('linkedin.js: extractLinkedInJobId (total classifier over URL forms, item 6c)', () => {
  const cases = [
    ['https://www.linkedin.com/jobs/view/4461489435', '4461489435'],
    ['https://www.linkedin.com/jobs/view/senior-software-engineer-4461489435', '4461489435'],
    ['https://www.linkedin.com/jobs/view/4461489435/', '4461489435'],
    ['https://www.linkedin.com/jobs/view/senior-software-engineer-4461489435/', '4461489435'],
    ['https://www.linkedin.com/jobs/search/?currentJobId=4461489435', '4461489435'],
    ['https://www.linkedin.com/jobs/search/?keywords=cto&currentJobId=4461489435&location=Houston', '4461489435'],
    ['https://m.linkedin.com/jobs/view/4461489435', '4461489435'],
    ['https://linkedin.com/jobs/view/4461489435', '4461489435'],
    ['https://www.linkedin.com/jobs/view/abc', null],
    ['https://www.linkedin.com/jobs/view/', null],
    ['https://www.linkedin.com/jobs/view/senior-role-abc', null],
    ['https://www.indeed.com/viewjob?jk=4461489435', null],
    ['https://www.linkedin.com/jobs/search/?keywords=cto', null],
    ['not a url', null],
  ];
  for (const [url, expected] of cases) {
    test(`${url} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(extractLinkedInJobId(url), expected);
    });
  }
});

describe('linkedin.js: fetchDetail A (voyager) / B (jobs-guest) two-source strategy (item 6c)', () => {
  /** @param {{ authedJson?: any, guestDetail?: any, reserveCalls?: string[], gotoCalls?: string[], authedCalls?: any[] }} o */
  function fakeLinkedinCap(o = {}) {
    return {
      async goto(url) {
        if (o.gotoCalls) o.gotoCalls.push(url);
      },
      async readJson(name) {
        if (name === 'linkedinGuestJobDetail') return o.guestDetail ?? null;
        return null;
      },
      async fetchAuthedJson(url, opts) {
        if (o.authedCalls) o.authedCalls.push({ url, opts });
        return typeof o.authedJson === 'function' ? o.authedJson(url, opts) : (o.authedJson ?? { cookieState: 'missing', status: null, ok: false, json: null });
      },
    };
  }

  /** @param {{ cap: any, reserveCalls?: number[] }} o */
  function ctxFor(o) {
    let count = 0;
    return baseCtx({
      capFor: async () => o.cap,
      reserveDetail: async () => {
        count++;
        if (o.reserveCalls) o.reserveCalls.push(count);
      },
    });
  }

  const LONG_DESC = 'x'.repeat(310);
  const LISTING = { url: 'https://www.linkedin.com/jobs/view/4461489435', url_normalized: 'https://www.linkedin.com/jobs/view/4461489435', source: 'linkedin' };

  test('an unrecognized URL form never calls capFor or reserveDetail (no network, no budget spent)', async () => {
    let capForCalled = false;
    let reserveCalled = false;
    const ctx = baseCtx({ capFor: async () => { capForCalled = true; return null; }, reserveDetail: async () => { reserveCalled = true; } });
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/search/?keywords=cto', url_normalized: null, source: 'linkedin' }, ctx);
    assert.deepEqual(r, { description: null, reason: 'unrecognized_url' });
    assert.equal(capForCalled, false);
    assert.equal(reserveCalled, false);
  });

  test('A success: valid cookie, id matches, description >= 300 chars -- B is never attempted', async () => {
    const gotoCalls = [];
    const cap = fakeLinkedinCap({
      gotoCalls,
      authedJson: {
        cookieState: 'valid', status: 200, ok: true,
        json: { data: { jobPostingId: '4461489435', description: { text: LONG_DESC }, applyMethod: { companyApplyUrl: 'https://boards.greenhouse.io/acme/jobs/123', easyApplyUrl: null } } },
      },
    });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(r.description, LONG_DESC);
    assert.equal(r.externalApplyUrl, 'https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(r.easyApplyOnly, false);
    assert.equal(gotoCalls.length, 0, 'B (guest goto) must never be attempted after an A success');
  });

  test('A success via entityUrn (no jobPostingId field): easyApplyOnly true only when easyApplyUrl exists and companyApplyUrl does not', async () => {
    const cap = fakeLinkedinCap({
      authedJson: {
        cookieState: 'valid', status: 200, ok: true,
        json: { data: { entityUrn: 'urn:li:fsd_jobPosting:4461489435', description: { text: LONG_DESC }, applyMethod: { easyApplyUrl: 'https://www.linkedin.com/jobs/view/4461489435/easy-apply' } } },
      },
    });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(r.description, LONG_DESC);
    assert.equal(r.externalApplyUrl, null);
    assert.equal(r.easyApplyOnly, true);
  });

  test('A rich-text object description: only .text is read, extra rich-text fields (attributes) ignored', async () => {
    const cap = fakeLinkedinCap({
      authedJson: {
        cookieState: 'valid', status: 200, ok: true,
        json: { data: { jobPostingId: '4461489435', description: { text: LONG_DESC, attributes: [{ type: 'BOLD', start: 0, length: 5 }] } } },
      },
    });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(r.description, LONG_DESC);
  });

  test('A 200 with the WRONG id falls back to B', async () => {
    const gotoCalls = [];
    const cap = fakeLinkedinCap({
      gotoCalls,
      authedJson: { cookieState: 'valid', status: 200, ok: true, json: { data: { jobPostingId: '9999999999', description: { text: LONG_DESC } } } },
      guestDetail: { blocked: false, matched: true, description: LONG_DESC, applyHref: 'https://boards.greenhouse.io/acme/jobs/123' },
    });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(gotoCalls.length, 1, 'B is attempted after an id mismatch');
    assert.equal(r.description, LONG_DESC);
    assert.equal(r.externalApplyUrl, 'https://boards.greenhouse.io/acme/jobs/123');
  });

  test('A missing cookie falls back to B without attempting A\'s network call twice', async () => {
    const gotoCalls = [];
    const authedCalls = [];
    const cap = fakeLinkedinCap({
      gotoCalls, authedCalls,
      authedJson: { cookieState: 'missing', status: null, ok: false, json: null },
      guestDetail: { blocked: false, matched: true, description: LONG_DESC, applyHref: null },
    });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(authedCalls.length, 1);
    assert.equal(gotoCalls.length, 1);
    assert.equal(r.description, LONG_DESC);
  });

  test('A malformed cookie also falls back to B', async () => {
    const cap = fakeLinkedinCap({
      authedJson: { cookieState: 'malformed', status: null, ok: false, json: null },
      guestDetail: { blocked: false, matched: true, description: LONG_DESC, applyHref: null },
    });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(r.description, LONG_DESC);
  });

  test('B authwall: blocked page -> description null, reason guest_blocked', async () => {
    const cap = fakeLinkedinCap({ guestDetail: { blocked: true, matched: false, description: null, applyHref: null } });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.deepEqual(r, { description: null, reason: 'guest_blocked' });
  });

  test('B: a page matching zero selectors (unmatched, not blocked) is ALSO guest_blocked', async () => {
    const cap = fakeLinkedinCap({ guestDetail: { blocked: false, matched: false, description: null, applyHref: null } });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.deepEqual(r, { description: null, reason: 'guest_blocked' });
  });

  test('B short description: page recognized (matched, not blocked) but text < 300 chars -- returned as-is, not guest_blocked', async () => {
    const shortText = 'A great role at Acme.';
    const cap = fakeLinkedinCap({ guestDetail: { blocked: false, matched: true, description: shortText, applyHref: null } });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(r.description, shortText);
    assert.equal(r.reason, undefined, 'thin-but-present data is not a fetchDetail-level failure; scan-run.js\'s own DETAIL_MIN_CHARS gate classifies it empty');
  });

  test('reservation is spent exactly once whether the call resolves via A alone or falls through to B', async () => {
    const reserveCallsA = [];
    const capA = fakeLinkedinCap({ authedJson: { cookieState: 'valid', status: 200, ok: true, json: { data: { jobPostingId: '4461489435', description: { text: LONG_DESC } } } } });
    await linkedin.fetchDetail(LISTING, ctxFor({ cap: capA, reserveCalls: reserveCallsA }));
    assert.equal(reserveCallsA.length, 1);

    const reserveCallsB = [];
    const capB = fakeLinkedinCap({ authedJson: { cookieState: 'missing', status: null, ok: false, json: null }, guestDetail: { blocked: false, matched: true, description: LONG_DESC, applyHref: null } });
    await linkedin.fetchDetail(LISTING, ctxFor({ cap: capB, reserveCalls: reserveCallsB }));
    assert.equal(reserveCallsB.length, 1);
  });
});

describe('capability.fetchAuthedJson (real makeCapability, not bypassed -- item 6a)', () => {
  const registry = registryFrom([
    { source: 'linkedin', domains: ['linkedin.com', 'www.linkedin.com'], pathPatterns: ['^/jobs/view/\\d+/?(\\?|$)', '^/voyager/api/jobs/jobPostings/\\d+/?$'] },
  ]);

  /** @param {{ cookies?: any[], evalResult?: any }} o */
  function fakePage(o = {}) {
    const evaluateCalls = [];
    const page = {
      context: () => ({ cookies: async () => o.cookies ?? [] }),
      async evaluate(fn, arg) {
        evaluateCalls.push(arg);
        return o.evalResult ?? { status: 200, ok: true, text: '{}' };
      },
      async goto() { return { status: () => 200, headers: () => ({}) }; },
      url: () => 'https://www.linkedin.com/jobs/view/1',
      async content() { return ''; },
    };
    return { page, evaluateCalls };
  }

  test('a URL outside the registry is refused (cookieState "refused") before any cookie read or network call', async () => {
    const { page, evaluateCalls } = fakePage();
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/not/registered');
    assert.equal(r.cookieState, 'refused');
    assert.equal(r.refusedReason, 'path_not_matching');
    assert.equal(r.status, null);
    assert.equal(evaluateCalls.length, 0);
  });

  test('no JSESSIONID cookie at all -> cookieState "missing", no network call attempted', async () => {
    const { page, evaluateCalls } = fakePage({ cookies: [] });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'missing');
    assert.equal(evaluateCalls.length, 0);
  });

  test('an empty (post-quote-strip) JSESSIONID cookie -> cookieState "malformed"', async () => {
    const { page, evaluateCalls } = fakePage({ cookies: [{ name: 'JSESSIONID', value: '""' }] });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'malformed');
    assert.equal(evaluateCalls.length, 0);
  });

  test('a JSESSIONID cookie with a disallowed character -> cookieState "malformed"', async () => {
    const { page, evaluateCalls } = fakePage({ cookies: [{ name: 'JSESSIONID', value: '"ajax:12345 with space"' }] });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'malformed');
    assert.equal(evaluateCalls.length, 0);
  });

  test('a valid quoted JSESSIONID cookie: quotes are stripped into the csrf-token header, evaluate runs inside the page, JSON is parsed', async () => {
    const { page, evaluateCalls } = fakePage({
      cookies: [{ name: 'JSESSIONID', value: '"ajax:1234567890123456789"' }],
      evalResult: { status: 200, ok: true, text: '{"data":{"jobPostingId":"1"}}' },
    });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1', { headers: { accept: 'application/vnd.linkedin.normalized+json+2.1' } });
    assert.equal(r.cookieState, 'valid');
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.deepEqual(r.json, { data: { jobPostingId: '1' } });
    assert.equal(evaluateCalls.length, 1);
    assert.equal(evaluateCalls[0].headers['csrf-token'], 'ajax:1234567890123456789', 'surrounding quotes stripped from the cookie value');
    assert.equal(evaluateCalls[0].headers.accept, 'application/vnd.linkedin.normalized+json+2.1', 'caller-supplied headers pass through');
  });

  test('a non-JSON (or empty) response body resolves json: null rather than throwing', async () => {
    const { page } = fakePage({ cookies: [{ name: 'JSESSIONID', value: '"ajax:123"' }], evalResult: { status: 200, ok: true, text: 'not json' } });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'valid');
    assert.equal(r.json, null);
  });
});

describe('indeed.js: applystart is easy-only', () => {
  test('no external anchor found -> easyApplyOnly true (Indeed applystart flow)', async () => {
    const cap = fakeCap({
      indeedApplyState: { href: null, easyApplyOnly: true },
      readJsonLd: [],
      bodyText: 'A great role at Acme.',
    });
    const ctx = baseCtx({ capFor: async () => cap });
    const r = await indeed.fetchDetail({ url: 'https://www.indeed.com/viewjob?jk=abc123', source: 'indeed' }, ctx);
    assert.equal(r.easyApplyOnly, true);
    assert.equal(r.externalApplyUrl, null);
  });

  test('an "Apply on company site" anchor off indeed.com is surfaced as externalApplyUrl', async () => {
    const cap = fakeCap({
      indeedApplyState: { href: 'https://boards.greenhouse.io/acme/jobs/123', easyApplyOnly: false },
      readJsonLd: [],
      bodyText: 'A great role at Acme.',
    });
    const ctx = baseCtx({ capFor: async () => cap });
    const r = await indeed.fetchDetail({ url: 'https://www.indeed.com/viewjob?jk=abc123', source: 'indeed' }, ctx);
    assert.equal(r.easyApplyOnly, false);
    assert.equal(r.externalApplyUrl, 'https://boards.greenhouse.io/acme/jobs/123');
  });
});

describe('greenhouse.js / workday.js / dayforce.js: own listing URL surfaced as externalApplyUrl', () => {
  test('greenhouse: externalApplyUrl equals the listing URL', async () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/123';
    const ctx = baseCtx({ fetchJson: async () => ({ status: 200, url, json: { content: 'Job content' } }) });
    const r = await greenhouse.fetchDetail({ url, url_normalized: url }, ctx);
    assert.equal(r.externalApplyUrl, url);
  });

  test('workday: externalApplyUrl equals the listing URL even when the description fetch fails', async () => {
    const url = 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Houston-TX/Director_R-12345';
    const ctx = baseCtx({ fetchJson: async () => ({ status: 500, url, json: null }) });
    const r = await workday.fetchDetail({ url, url_normalized: url }, ctx);
    assert.equal(r.description, null);
    assert.equal(r.externalApplyUrl, url);
  });

  test('dayforce: externalApplyUrl equals the listing URL', async () => {
    const url = 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/12345';
    const ctx = baseCtx({ fetchText: async () => ({ status: 200, url, text: '<html><body>Great role</body></html>', contentType: 'text/html' }) });
    const r = await dayforce.fetchDetail({ url, url_normalized: url }, ctx);
    assert.equal(r.externalApplyUrl, url);
  });
});

describe('exec-generic.js: HTML anchor apply-link extraction', () => {
  test('an anchor with "Apply" text is surfaced as a resolved absolute externalApplyUrl candidate', async () => {
    const url = 'https://execboard.example.com/jobs/42';
    const html = '<html><body><h1>CTO</h1><a href="https://boards.greenhouse.io/acme/jobs/123">Apply Now</a></body></html>';
    const ctx = baseCtx({
      fetchText: async () => ({ status: 200, url, text: html, contentType: 'text/html' }),
      config: { execBoards: { boards: [{ slug: 'execboard', mode: 'fetch' }] } },
    });
    const r = await exec.fetchDetail({ url, url_normalized: url, source: 'exec:execboard' }, ctx);
    assert.equal(r.externalApplyUrl, 'https://boards.greenhouse.io/acme/jobs/123');
  });

  test('no Apply-shaped anchor at all -> externalApplyUrl null, description still returned', async () => {
    const url = 'https://execboard.example.com/jobs/42';
    const html = '<html><body><h1>CTO</h1><p>A great role.</p></body></html>';
    const ctx = baseCtx({
      fetchText: async () => ({ status: 200, url, text: html, contentType: 'text/html' }),
      config: { execBoards: { boards: [{ slug: 'execboard', mode: 'fetch' }] } },
    });
    const r = await exec.fetchDetail({ url, url_normalized: url, source: 'exec:execboard' }, ctx);
    assert.equal(r.externalApplyUrl, null);
    assert.match(r.description, /A great role/);
  });
});
