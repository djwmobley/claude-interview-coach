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
import { JobSearchError } from '../src/core/errors.js';

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
        if (o.gotoThrows) throw (typeof o.gotoThrows === 'function' ? o.gotoThrows(url) : o.gotoThrows);
        return o.gotoResult ?? { status: 200, url, cfMitigated: null };
      },
      async readJson(name) {
        if (name === 'linkedinGuestJobDetail') {
          if (o.guestDetailThrows) throw (typeof o.guestDetailThrows === 'function' ? o.guestDetailThrows() : o.guestDetailThrows);
          return o.guestDetail ?? null;
        }
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

  test('B goto throws ERR_HTTP_RESPONSE_CODE_FAILURE (live-observed shape): description null, reason not_found, never throws out of fetchDetail', async () => {
    const cap = fakeLinkedinCap({ gotoThrows: () => new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/9999999999999') });
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/view/9999999999999', url_normalized: 'https://www.linkedin.com/jobs/view/9999999999999', source: 'linkedin' }, ctxFor({ cap }));
    assert.deepEqual(r, { description: null, reason: 'not_found' });
  });

  test('B goto returns a normal 404/410 response (no throw): description null, reason not_found', async () => {
    for (const status of [404, 410]) {
      const cap = fakeLinkedinCap({ gotoResult: { status, url: 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/1', cfMitigated: null } });
      const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
      assert.deepEqual(r, { description: null, reason: 'not_found' }, `status ${status}`);
    }
  });

  test('B goto throws some other error: description null, reason guest_error carrying the message, never throws out of fetchDetail', async () => {
    const cap = fakeLinkedinCap({ gotoThrows: () => new Error('page.goto: net::ERR_CONNECTION_RESET') });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(r.description, null);
    assert.match(r.reason, /^guest_error: .*ERR_CONNECTION_RESET/);
  });

  test('B readJson throws (extractor not wired in some capability build): description null, reason guest_error, never throws out of fetchDetail', async () => {
    const cap = fakeLinkedinCap({ guestDetailThrows: () => new Error('unknown extractor: linkedinGuestJobDetail') });
    const r = await linkedin.fetchDetail(LISTING, ctxFor({ cap }));
    assert.equal(r.description, null);
    assert.match(r.reason, /^guest_error: /);
  });

  test('a CANCELLED error from B goto is rethrown, never swallowed into guest_error', async () => {
    const { JobSearchError: JSE } = await import('../src/core/errors.js');
    const cap = fakeLinkedinCap({ gotoThrows: () => new JSE('CANCELLED', 'run aborted') });
    await assert.rejects(linkedin.fetchDetail(LISTING, ctxFor({ cap })), (e) => e instanceof JSE && e.code === 'CANCELLED');
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

describe('capability.fetchAuthedJson (real makeCapability, not bypassed -- item 6a, hardened by the item-6 follow-up fix)', () => {
  const registry = registryFrom([
    { source: 'linkedin', domains: ['linkedin.com', 'www.linkedin.com'], pathPatterns: ['^/jobs/view/\\d+/?(\\?|$)', '^/voyager/api/jobs/jobPostings/\\d+/?$'] },
  ]);

  /**
   * A real top-level navigation (page.goto), not an in-page fetch: this is what the follow-up fix
   * switched to specifically so the request never depends on the page's CURRENT origin (the origin-
   * dependence bug this fixes). `cookiesUrlsSeen` records what `context().cookies(...)` was called with,
   * proving the read is explicitly URL-scoped rather than an implicit, origin-coupled `document.cookie`.
   * @param {{ cookies?: any[], gotoResult?: { status: number, ok: boolean, text: string }|null, gotoThrows?: boolean, pageUrl?: string }} o
   */
  function fakePage(o = {}) {
    const gotoCalls = [];
    const setHeadersCalls = [];
    const cookiesUrlsSeen = [];
    const page = {
      context: () => ({
        cookies: async (urls) => {
          cookiesUrlsSeen.push(urls);
          return o.cookies ?? [];
        },
      }),
      async setExtraHTTPHeaders(headers) {
        setHeadersCalls.push(headers);
      },
      async goto(url) {
        gotoCalls.push(url);
        if (o.gotoThrows) throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED');
        const r = o.gotoResult ?? { status: 200, ok: true, text: '{}' };
        if (!r) return null;
        return { status: () => r.status, ok: () => r.ok, headers: () => ({}), text: async () => r.text };
      },
      url: () => o.pageUrl ?? 'about:blank',
      async content() { return ''; },
    };
    return { page, gotoCalls, setHeadersCalls, cookiesUrlsSeen };
  }

  test('a URL outside the registry is refused (cookieState "refused") before any cookie read or navigation', async () => {
    const { page, gotoCalls, cookiesUrlsSeen } = fakePage();
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/not/registered');
    assert.equal(r.cookieState, 'refused');
    assert.equal(r.refusedReason, 'path_not_matching');
    assert.equal(r.status, null);
    assert.equal(gotoCalls.length, 0);
    assert.equal(cookiesUrlsSeen.length, 0);
  });

  test('no JSESSIONID cookie at all -> cookieState "missing", no navigation attempted', async () => {
    const { page, gotoCalls } = fakePage({ cookies: [] });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'missing');
    assert.equal(gotoCalls.length, 0);
  });

  test('an empty (post-quote-strip) JSESSIONID cookie -> cookieState "malformed"', async () => {
    const { page, gotoCalls } = fakePage({ cookies: [{ name: 'JSESSIONID', value: '""' }] });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'malformed');
    assert.equal(gotoCalls.length, 0);
  });

  test('a JSESSIONID cookie with a disallowed character -> cookieState "malformed"', async () => {
    const { page, gotoCalls } = fakePage({ cookies: [{ name: 'JSESSIONID', value: '"ajax:12345 with space"' }] });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'malformed');
    assert.equal(gotoCalls.length, 0);
  });

  test('cookie is read from the CONTEXT (URL-scoped), not the page: origin-independence fix -- A is attempted even when the page is on about:blank but the context holds a valid JSESSIONID', async () => {
    const { page, gotoCalls, setHeadersCalls, cookiesUrlsSeen } = fakePage({
      pageUrl: 'about:blank',
      cookies: [{ name: 'JSESSIONID', value: '"ajax:1234567890123456789"' }],
      gotoResult: { status: 200, ok: true, text: '{"data":{"jobPostingId":"1"}}' },
    });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1', { headers: { accept: 'application/vnd.linkedin.normalized+json+2.1' } });
    assert.equal(r.cookieState, 'valid');
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.deepEqual(r.json, { data: { jobPostingId: '1' } });
    assert.equal(gotoCalls.length, 1, 'A was attempted (a real navigation happened) despite the page starting on about:blank');
    assert.equal(gotoCalls[0], 'https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.ok(cookiesUrlsSeen[0], 'cookies() was called with an explicit URL filter, never a bare no-arg document.cookie-equivalent read');
    assert.equal(setHeadersCalls[0]['csrf-token'], 'ajax:1234567890123456789', 'surrounding quotes stripped from the cookie value');
    assert.equal(setHeadersCalls[0].accept, 'application/vnd.linkedin.normalized+json+2.1', 'caller-supplied headers pass through');
    assert.deepEqual(setHeadersCalls[1], {}, 'headers reset after the one navigation so a later, unrelated navigation never inherits them');
  });

  test('a non-JSON (or empty) response body resolves json: null rather than throwing', async () => {
    const { page } = fakePage({ cookies: [{ name: 'JSESSIONID', value: '"ajax:123"' }], gotoResult: { status: 200, ok: true, text: 'not json' } });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'valid');
    assert.equal(r.json, null);
  });

  test('a navigation error (e.g. a real network failure) resolves a graceful failure, never throws', async () => {
    const { page } = fakePage({ cookies: [{ name: 'JSESSIONID', value: '"ajax:123"' }], gotoThrows: true });
    const cap = makeCapability(/** @type {any} */ (page), { registry, source: 'linkedin', signal: new AbortController().signal });
    const r = await cap.fetchAuthedJson('https://www.linkedin.com/voyager/api/jobs/jobPostings/1');
    assert.equal(r.cookieState, 'valid');
    assert.equal(r.status, null);
    assert.equal(r.ok, false);
    assert.equal(r.json, null);
  });
});

describe('capability.js onPage hook wired to fetchAuthedJson (detail-pacing fix, spec item 1)', () => {
  const registry = registryFrom([
    { source: 'linkedin', domains: ['linkedin.com', 'www.linkedin.com'], pathPatterns: ['^/jobs/view/\\d+/?(\\?|$)', '^/voyager/api/jobs/jobPostings/\\d+/?$', '^/jobs-guest/jobs/api/jobPosting/\\d+/?$'] },
  ]);
  const LONG_DESC = 'x'.repeat(310);
  const LISTING = { url: 'https://www.linkedin.com/jobs/view/4461489435', url_normalized: 'https://www.linkedin.com/jobs/view/4461489435', source: 'linkedin' };

  /**
   * A fake page backing BOTH source A (fetchAuthedJson's own internal page.goto) and source B (cap.goto +
   * cap.readJson) so a single test can drive linkedin.fetchDetail()'s real two-source strategy through a
   * REAL makeCapability instance, with onPage counted like a real rate-limiter hook would be.
   * @param {{ cookies?: any[], voyagerResult?: { status: number, ok: boolean, text: string }, guestNavResult?: { status: number, ok: boolean, text: string }, guestDetail?: any, onPage?: () => Promise<void> }} o
   */
  function fakeLinkedinPage(o = {}) {
    const gotoCalls = [];
    // cap.goto() (used for source B) re-derives the landing URL from page.url() and re-runs guardUrl
    // against it after navigating, exactly like a real Playwright page would report its post-navigation
    // location -- so this fake must track and return the URL it was last sent to, never a fixed
    // 'about:blank' (which would fail that re-check and make every B navigation look like a guardUrl
    // refusal instead of a real fetch).
    let current = 'about:blank';
    const page = {
      context: () => ({ cookies: async () => o.cookies ?? [{ name: 'JSESSIONID', value: '"ajax:1234567890123456789"' }] }),
      async setExtraHTTPHeaders() {},
      async goto(url) {
        gotoCalls.push(url);
        current = url;
        const isVoyager = /\/voyager\/api\//.test(url);
        const r = (isVoyager ? o.voyagerResult : o.guestNavResult) ?? { status: 200, ok: true, text: '{}' };
        return { status: () => r.status, ok: () => r.ok, headers: () => ({}), text: async () => r.text };
      },
      url: () => current,
      async content() { return ''; },
      async evaluate() { return o.guestDetail ?? null; },
    };
    return { page, gotoCalls };
  }

  /** @param {{ page: any, onPage: () => Promise<void>, signal?: AbortSignal }} o */
  function ctxWithRealCap(o) {
    const cap = makeCapability(o.page, { registry, source: 'linkedin', signal: o.signal ?? new AbortController().signal, onPage: o.onPage });
    return {
      reserveDetail: async () => {},
      fetchJson: async () => ({ status: 404, url: '', json: null }),
      fetchText: async () => ({ status: 404, url: '', text: '', contentType: null }),
      capFor: async () => cap,
      config: { execBoards: { boards: [] } },
      log: () => {},
    };
  }

  test('A success (matching id, long description, B never attempted): onPage called exactly once', async () => {
    const { page, gotoCalls } = fakeLinkedinPage({
      voyagerResult: { status: 200, ok: true, text: JSON.stringify({ data: { jobPostingId: '4461489435', description: { text: LONG_DESC } } }) },
    });
    let onPageCalls = 0;
    const ctx = ctxWithRealCap({ page, onPage: async () => { onPageCalls++; } });
    const r = await linkedin.fetchDetail(LISTING, ctx);
    assert.equal(r.description, LONG_DESC);
    assert.equal(gotoCalls.length, 1, 'only A own navigation; B never attempted after an A success');
    assert.equal(onPageCalls, 1);
  });

  test('A fails (wrong id, falls back to B which succeeds): onPage called exactly twice', async () => {
    const { page, gotoCalls } = fakeLinkedinPage({
      voyagerResult: { status: 200, ok: true, text: JSON.stringify({ data: { jobPostingId: '9999999999', description: { text: LONG_DESC } } }) },
      guestNavResult: { status: 200, ok: true, text: '' },
      guestDetail: { blocked: false, matched: true, description: LONG_DESC, applyHref: null },
    });
    let onPageCalls = 0;
    const ctx = ctxWithRealCap({ page, onPage: async () => { onPageCalls++; } });
    const r = await linkedin.fetchDetail(LISTING, ctx);
    assert.equal(r.description, LONG_DESC);
    assert.equal(gotoCalls.length, 2, 'A own navigation, then B cap.goto');
    assert.equal(onPageCalls, 2, 'once for A (fetchAuthedJson), once for B (cap.goto)');
  });

  test('an unrecognized URL form never builds a capability at all: onPage called zero times', async () => {
    let onPageCalls = 0;
    let capForCalled = false;
    const ctx = {
      reserveDetail: async () => {},
      capFor: async () => { capForCalled = true; return null; },
      config: { execBoards: { boards: [] } },
      log: () => {},
    };
    const r = await linkedin.fetchDetail({ url: 'https://www.linkedin.com/jobs/search/?keywords=cto', url_normalized: null, source: 'linkedin' }, ctx);
    assert.deepEqual(r, { description: null, reason: 'unrecognized_url' });
    assert.equal(capForCalled, false, 'capFor is never even called for an unrecognized URL');
    assert.equal(onPageCalls, 0);
  });

  test('an abort signal firing during the onPage wait rejects CANCELLED and never navigates', async () => {
    const { page, gotoCalls } = fakeLinkedinPage({});
    const ctx = ctxWithRealCap({
      page,
      onPage: () => Promise.reject(new JobSearchError('CANCELLED', 'aborted during wait')),
    });
    await assert.rejects(linkedin.fetchDetail(LISTING, ctx), (/** @type {any} */ e) => e.code === 'CANCELLED');
    assert.equal(gotoCalls.length, 0, 'the CANCELLED rejection from onPage happens before page.goto is ever called');
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
