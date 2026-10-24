// @ts-check
/**
 * LinkedIn client-side rendering: the total list-page classification run over real and synthetic page
 * fixtures, the capability's hydration wait, and the adapter's wait / reload / wall flow. The two real
 * fixtures are the sanitized snapshots of the false-positive walls of 2026-10-08/09/12: a loading skeleton
 * the Ember app had not rendered yet. No real browser is started; the fixtures run through the REAL named
 * extractors against a cheerio-backed document stand-in.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { linkedin, mapCard } from '../src/adapters/linkedin.js';
import { classifyLinkedInPage, LIST_CLASSES, WALL_CLASSES } from '../src/core/linkedin-listclass.js';
import { classifyPage } from '../src/browser/wall.js';
import { EXTRACTORS } from '../src/browser/extractors.js';
import { makeCapability } from '../src/browser/capability.js';
import { makeReloadReserver } from '../src/core/scan-run.js';
import { testConfig } from './helpers/scan-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (/** @type {string} */ n) => fs.readFileSync(path.join(HERE, 'fixtures', 'linkedin', n), 'utf8');
const SKELETON_P2 = FIX('2161-508d1077e7-p2.html');
const SKELETON_P1 = FIX('2165-6471e56548-p1.html');
const REQ = { keywords: 'CTO', location: 'Houston, TX' };

// ---------------------------------------------------------------------------------------------------------
// A document stand-in over cheerio, enough for the named extractors.
// ---------------------------------------------------------------------------------------------------------

/** @param {string} html @param {string} href */
function installDom(html, href) {
  const $ = cheerio.load(html);
  /** @param {any} el */
  const wrap = (el) => (el ? {
    getAttribute: (/** @type {string} */ n) => (el.attribs && n in el.attribs ? el.attribs[n] : null),
    get textContent() { return $(el).text(); },
    querySelector: (/** @type {string} */ s) => wrap($(el).find(s).get(0)),
  } : null);
  const bodyText = $('body').text();
  /** @type {any} */ (globalThis).document = {
    querySelector: (/** @type {string} */ s) => wrap($(s).get(0)),
    querySelectorAll: (/** @type {string} */ s) => $(s).toArray().map(wrap),
    body: { innerText: bodyText, textContent: bodyText },
    title: $('title').text(),
  };
  /** @type {any} */ (globalThis).location = { href };
}
function removeDom() {
  delete (/** @type {any} */ (globalThis)).document;
  delete (/** @type {any} */ (globalThis)).location;
}
afterEach(removeDom);

/**
 * Classify a page the way the adapter does: real extractors over the fixture, then the total classifier.
 * @param {string} html
 * @param {{ href?: string, pageIndex?: number, page1Parsed?: number, status?: number, retried?: boolean, finalPath?: string }} [o]
 */
function classifyHtml(html, o = {}) {
  const pageIndex = o.pageIndex ?? 1;
  const href = o.href ?? `https://www.linkedin.com${o.finalPath ?? '/jobs/search/'}?keywords=CTO&location=Houston%2C%20TX`;
  installDom(html, href);
  try {
    const hydration = /** @type {any} */ (EXTRACTORS.linkedinHydration)();
    const cards = /** @type {any[]} */ (/** @type {any} */ (EXTRACTORS.linkedinJobCards)());
    const valid = new Set(cards.filter((c) => mapCard(c)).map((c) => c.id));
    const markers = /** @type {any} */ (EXTRACTORS.wallMarkers)();
    const emptyState = /** @type {any} */ (EXTRACTORS.linkedinEmptyState)();
    const shell = /** @type {any} */ (EXTRACTORS.linkedinSearchShell)();
    return {
      hydration,
      verdict: classifyLinkedInPage({
        pageIndex, page1Parsed: o.page1Parsed ?? 0, deduped: valid.size, status: o.status ?? 200,
        finalPath: o.finalPath ?? '/jobs/search/', cfMitigated: null, requested: REQ, shell, markers, emptyState, retried: o.retried ?? false,
      }),
    };
  } finally {
    removeDom();
  }
}

const card = (/** @type {string} */ id) => `<li data-occludable-job-id="${id}"><div data-job-id="${id}"><a href="/jobs/view/${id}/"><strong>Chief Technology Officer</strong></a><div class="job-card-container__primary-description">Acme</div></div></li>`;
const cardsPage = (/** @type {number} */ n, /** @type {string} */ extra = '') => `<html><head><title>Jobs</title></head><body><div class="jobs-search-results-list"><ul>${Array.from({ length: n }, (_, i) => card(String(7000000000 + i))).join('')}</ul></div>${extra}</body></html>`;
const SHELL_ONLY = '<html><head><title>Jobs</title></head><body><div class="jobs-search-results-list"></div><nav class="artdeco-pagination"></nav></body></html>';
const EMPTY_WITH_SHELL = '<html><head><title>Jobs</title></head><body><div class="jobs-search-results-list"></div><div class="jobs-search-no-results-banner">No matching jobs found.</div></body></html>';

describe('real skeleton fixtures', () => {
  test('the skeleton carries no shell, no cards, no empty state and no wall marker (so it can never be mistaken for a login or a block)', () => {
    const r = classifyHtml(SKELETON_P1);
    assert.deepEqual(r.hydration, { cards: 0, empty: false, shell: false });
    installDom(SKELETON_P1, 'https://www.linkedin.com/jobs/search/?keywords=CTO');
    try {
      const m = /** @type {any} */ (EXTRACTORS.wallMarkers)();
      assert.equal(m.guestInterstitial || m.loginForm || m.recaptcha || m.challengeForm || m.challengeCloudflare, false);
    } finally {
      removeDom();
    }
  });
  test('both captured walls are the same skeleton', () => {
    assert.equal(SKELETON_P1, SKELETON_P2);
  });
  test('page 1: unknown on the first look, unhydrated_after_retry once reloaded', () => {
    assert.equal(classifyHtml(SKELETON_P1).verdict.classification, 'unknown');
    assert.equal(classifyHtml(SKELETON_P1, { retried: true }).verdict.classification, 'unhydrated_after_retry');
  });
  test('page 2 after a parsed page 1: still no shell, so never an end of results', () => {
    assert.equal(classifyHtml(SKELETON_P2, { pageIndex: 2, page1Parsed: 40 }).verdict.classification, 'unknown');
    assert.equal(classifyHtml(SKELETON_P2, { pageIndex: 2, page1Parsed: 40, retried: true }).verdict.classification, 'unhydrated_after_retry');
  });
  test('unhydrated_after_retry and unknown are walls; the run loop stops the source on both', () => {
    for (const c of ['unhydrated_after_retry', 'unknown']) assert.ok(WALL_CLASSES.includes(c));
    // The signals the adapter attaches to such a wall event classify as a stop in wall.js.
    assert.equal(classifyPage({ parsed: 0, url: 'https://www.linkedin.com/jobs/search/' }).stopSource, true);
  });
});

describe('every branch of the total classification, including the overlaps', () => {
  /** @type {Array<[string, string, any, string]>} */
  const cases = [
    ['results: cards on a normal page', cardsPage(25), {}, 'results'],
    ['results beat explicit_empty when both are present', cardsPage(3, '<div class="jobs-search-no-results"></div>'), {}, 'results'],
    ['explicit_empty: empty selector with the shell, page 1', EMPTY_WITH_SHELL, {}, 'explicit_empty'],
    ['explicit_empty beats end_of_results on page 2 (empty search with shell)', EMPTY_WITH_SHELL, { pageIndex: 2, page1Parsed: 25 }, 'explicit_empty'],
    ['end_of_results: page 2+, page 1 parsed, shell, no cards', SHELL_ONLY, { pageIndex: 2, page1Parsed: 25 }, 'end_of_results'],
    ['the shell with no cards on page 1 is unknown, never an end of results', SHELL_ONLY, {}, 'unknown'],
    ['the shell on page 2 when page 1 parsed nothing is unknown', SHELL_ONLY, { pageIndex: 2, page1Parsed: 0 }, 'unknown'],
    ['the shell with no cards stays unknown after a reload (shell present, so not unhydrated)', SHELL_ONLY, { retried: true }, 'unknown'],
    ['login: the final path is /login (checked before anything else)', SKELETON_P1, { finalPath: '/login' }, 'login'],
    ['login: /authwall', SHELL_ONLY, { finalPath: '/authwall' }, 'login'],
    ['login: /checkpoint/challenge', SHELL_ONLY, { finalPath: '/checkpoint/challenge' }, 'login'],
    ['login: an inline login form on a logged-out skeleton', '<html><body><div id="app-boot-bg-loader"></div><input name="session_key"></body></html>', {}, 'login'],
    ['login beats results: a guest interstitial over cards', cardsPage(10, '<div>Sign in to see more jobs</div>'), {}, 'login'],
    ['throttle_or_block: a recaptcha frame beats results', cardsPage(10, '<iframe title="recaptcha challenge"></iframe>'), {}, 'throttle_or_block'],
    ['throttle_or_block: HTTP 429 beats results', cardsPage(10), { status: 429 }, 'throttle_or_block'],
    ['throttle_or_block: HTTP 403 beats an empty state', EMPTY_WITH_SHELL, { status: 403 }, 'throttle_or_block'],
    ['login beats throttle_or_block when both are present', cardsPage(1, '<iframe title="recaptcha"></iframe><div>Join to view more jobs</div>'), {}, 'login'],
    ['a card whose id is too short for mapCard is not results', '<html><body><div data-job-id="123"><a href="/jobs/view/123/"><strong>X</strong></a></div></body></html>', {}, 'unknown'],
    ['a card without a title is not results', '<html><body><div data-job-id="7000000009"></div></body></html>', {}, 'unknown'],
  ];
  for (const [label, html, o, want] of cases) {
    test(label, () => {
      assert.equal(classifyHtml(html, o).verdict.classification, want);
    });
  }
  test('the cases above reach all seven classes, and the classifier never returns anything else', () => {
    const seen = new Set(cases.map(([, , , want]) => want));
    seen.add('unhydrated_after_retry');
    assert.deepEqual([...seen].sort(), [...LIST_CLASSES].sort());
    for (const [, html, o] of cases) assert.ok(LIST_CLASSES.includes(classifyHtml(html, o).verdict.classification));
  });
});

// ---------------------------------------------------------------------------------------------------------
// The capability's hydration wait, over a fake page with a virtual clock.
// ---------------------------------------------------------------------------------------------------------

describe('capability.waitForHydration', () => {
  /**
   * @param {Array<{ cards?: number, empty?: boolean, shell?: boolean }>} script one state per poll; the last repeats
   * @param {{ onSleep?: (total: number) => void }} [o]
   */
  function fakePage(script, o = {}) {
    const st = { polls: 0, slept: 0 };
    const page = {
      async evaluate() {
        const s = script[Math.min(st.polls, script.length - 1)];
        st.polls++;
        return { cards: 0, empty: false, shell: false, ...s };
      },
      async waitForTimeout(/** @type {number} */ ms) {
        st.slept += ms;
        if (o.onSleep) o.onSleep(st.slept);
      },
    };
    return { page, st };
  }
  const capOf = (/** @type {any} */ page, signal = new AbortController().signal) => /** @type {any} */ (makeCapability(page, { registry: /** @type {any} */ ({}), source: 'linkedin', signal }));

  test('cards that appear after a delay end the wait and report what was seen', async () => {
    const { page, st } = fakePage([{}, {}, { cards: 25, shell: true }]);
    const r = await capOf(page).waitForHydration({ maxMs: 15000 });
    assert.equal(r.reason, 'cards');
    assert.equal(r.cards, 25);
    assert.equal(st.polls, 3);
    assert.equal(st.slept, 1000);
  });
  test('the explicit empty-state selector ends the wait', async () => {
    const { page } = fakePage([{}, { empty: true }]);
    assert.equal((await capOf(page).waitForHydration()).reason, 'empty');
  });
  test('the shell alone does NOT end the wait: it runs to the full 15 s and times out', async () => {
    const { page, st } = fakePage([{ shell: true }]);
    const r = await capOf(page).waitForHydration({ maxMs: 15000 });
    assert.equal(r.reason, 'timeout');
    assert.equal(st.slept, 15000);
    assert.equal(st.polls, 31);
  });
  test('page 2 with the shell up and cards arriving at 5 s (the adapter\'s real options): the wait keeps going and reports cards, not an end of results', async () => {
    const script = [...Array.from({ length: 10 }, () => ({ shell: true })), { shell: true, cards: 22 }];
    const { page, st } = fakePage(script);
    const r = await capOf(page).waitForHydration({ maxMs: 15000, settleShellMs: null });
    assert.equal(r.reason, 'cards');
    assert.equal(r.cards, 22);
    assert.equal(st.slept, 5000);
  });
  test('page 2+ (settleShellMs): the shell must hold with no cards for the settle time, then the wait ends', async () => {
    const { page, st } = fakePage([{ shell: true }]);
    const r = await capOf(page).waitForHydration({ maxMs: 15000, settleShellMs: 2000 });
    assert.equal(r.reason, 'shell_settled');
    assert.equal(st.slept, 2000);
  });
  test('settle restarts when the shell disappears (still loading)', async () => {
    const { page, st } = fakePage([{ shell: true }, { shell: true }, { shell: false }, { shell: true }]);
    const r = await capOf(page).waitForHydration({ maxMs: 15000, settleShellMs: 2000 });
    assert.equal(r.reason, 'shell_settled');
    assert.ok(st.slept >= 3500, `settle restarted: slept ${st.slept}`);
  });
  test('maxMs is capped at 30 s', async () => {
    const { page, st } = fakePage([{}]);
    const r = await capOf(page).waitForHydration({ maxMs: 999999 });
    assert.equal(r.reason, 'timeout');
    assert.equal(st.slept, 30000);
  });
  test('the run abort signal (which the 40-minute run deadline also fires) stops the wait mid-way', async () => {
    const ac = new AbortController();
    const { page, st } = fakePage([{}], { onSleep: (total) => { if (total >= 1500) ac.abort(); } });
    await assert.rejects(capOf(page, ac.signal).waitForHydration({ maxMs: 15000 }), /run aborted/);
    assert.ok(st.slept < 15000, `stopped early after ${st.slept} ms`);
  });
  test('an already-aborted signal never polls', async () => {
    const ac = new AbortController();
    ac.abort();
    const { page, st } = fakePage([{}]);
    await assert.rejects(capOf(page, ac.signal).waitForHydration(), /run aborted/);
    assert.equal(st.polls, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The adapter: wait, parse, reload once, wall.
// ---------------------------------------------------------------------------------------------------------

const profileOf = (/** @type {string[]} */ kws) => /** @type {any} */ ({
  name: 't', keywords: kws, phrases: [], exclude_terms: [], locations: ['Houston, TX'], remote: 'any', posted_within_days: 7, max_pages: 3, sources: [],
});
let idc = 7100000000;
const ids = (/** @type {number} */ n) => Array.from({ length: n }, () => String(idc++));

/**
 * A scripted page per goto: `ids` are what the page shows once rendered; `renderAfterWait` false keeps it
 * a skeleton through the wait; `renderAfterReload` true makes a reload render it.
 * @param {Array<{ ids?: string[], renderAfterWait?: boolean, renderAfterReload?: boolean, finalPath?: string, status?: number, markers?: any, shell?: boolean, empty?: boolean }>} pages
 * @param {{ reserveReload?: () => boolean, hydrationThrows?: Error }} [o]
 */
function harness(pages, o = {}) {
  const st = { gotos: 0, reloads: 0, waits: /** @type {any[]} */ ([]), snapshots: /** @type {any[]} */ ([]), logs: /** @type {any[]} */ ([]) };
  /** @type {any} */
  let cur = {};
  let rendered = false;
  const nav = () => ({ status: cur.status ?? 200, url: `https://www.linkedin.com${cur.finalPath ?? '/jobs/search/'}`, cfMitigated: null });
  const cap = {
    source: 'linkedin',
    signal: new AbortController().signal,
    async goto() { cur = pages[st.gotos] ?? {}; st.gotos++; rendered = false; return nav(); },
    async reload() { st.reloads++; rendered = Boolean(cur.renderAfterReload); return nav(); },
    async waitForHydration(/** @type {any} */ opts) {
      if (o.hydrationThrows) throw o.hydrationThrows;
      st.waits.push(opts);
      if (cur.renderAfterWait !== false) rendered = true;
      return { reason: rendered ? 'cards' : 'timeout', waitedMs: rendered ? 1500 : 15000, cards: rendered ? (cur.ids ?? []).length : 0, empty: false, shell: false };
    },
    async readHtml() { return '<html><body>page</body></html>'; },
    async scrollToBottom() { return { steps: 1, atBottom: true }; },
    async readJson(/** @type {string} */ name) {
      if (name === 'linkedinJobCards') return rendered ? (cur.ids ?? []).map((/** @type {string} */ id) => ({ id, title: 'CTO ' + id, company: 'Acme', location: 'Houston, TX', datetime: '2026-10-07' })) : [];
      if (name === 'linkedinEmptyState') return Boolean(rendered && cur.empty);
      if (name === 'wallMarkers') return { challengeCloudflare: false, challengeForm: false, recaptcha: false, guestInterstitial: false, loginForm: false, ...(cur.markers ?? {}) };
      if (name === 'linkedinSearchShell') return { shell: Boolean(rendered && (cur.shell ?? false)), path: cur.finalPath ?? '/jobs/search/', keywords: null, location: null };
      throw new Error('unexpected extractor ' + name);
    },
  };
  const ctx = /** @type {any} */ ({
    signal: cap.signal, now: new Date('2026-10-24T12:00:00Z'), windowStart: null, maxPages: 3,
    async reservePage() {},
    reserveReload: o.reserveReload ?? (() => true),
    capFor: async () => cap,
    config: testConfig(),
    log(/** @type {any} */ f) { st.logs.push(f); },
    async saveSnapshot(/** @type {string} */ html, /** @type {any} */ meta) { st.snapshots.push(meta); return `/var/logs/linkedin-snapshots/9-abc-p${meta.pageIndex}.html`; },
  });
  return { ctx, st };
}

async function run(/** @type {any} */ ctx, /** @type {string[]} */ kws) {
  const out = { listings: /** @type {any[]} */ ([]), batches: /** @type {any[]} */ ([]), walls: /** @type {any[]} */ ([]), warnings: /** @type {any[]} */ ([]) };
  const gen = linkedin.search(profileOf(kws), ctx);
  /** @type {any} */
  let directive;
  for (;;) {
    const s = await gen.next(directive);
    if (s.done) break;
    directive = undefined;
    const ev = /** @type {any} */ (s.value);
    if (ev.kind === 'listing') out.listings.push(ev);
    else if (ev.kind === 'batch') out.batches.push(ev);
    else if (ev.kind === 'wall') {
      out.walls.push(ev);
      directive = { stopQuery: true };
    } else if (ev.kind === 'warning') out.warnings.push(ev);
  }
  return out;
}

describe('linkedin adapter: hydration wait, one reload, one wall', () => {
  test('cards that appear only after the wait are parsed: one navigation, no reload, no wall; page 1 has no shell settle', async () => {
    const h = harness([{ ids: ids(6) }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.listings.length, 6);
    assert.equal(r.walls.length, 0);
    assert.equal(h.st.gotos, 1);
    assert.equal(h.st.reloads, 0);
    assert.deepEqual(h.st.waits, [{ maxMs: 15000, settleShellMs: null }]);
  });
  test('page 2 after a parsed page 1 waits the same full window as page 1: the shell never ends the wait early', async () => {
    const h = harness([{ ids: ids(25) }, { ids: [], shell: true }]);
    await run(h.ctx, ['CTO']);
    assert.deepEqual(h.st.waits[1], { maxMs: 15000, settleShellMs: null });
  });
  test('page 2 whose cards render during the wait is parsed, never an end of results', async () => {
    const h = harness([{ ids: ids(25) }, { ids: ids(12), shell: true }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.listings.length, 37);
    assert.equal(r.walls.length, 0);
    assert.equal(h.st.logs.filter((l) => l.evt === 'linkedin_page').at(1)?.classification, 'results');
  });
  test('a permanent skeleton yields exactly ONE wall after exactly one reload, with a snapshot basename and the reason', async () => {
    const h = harness([{ ids: [], renderAfterWait: false }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(h.st.reloads, 1);
    assert.equal(h.st.gotos, 1);
    assert.equal(r.walls.length, 1);
    const w = r.walls[0];
    assert.equal(w.wallKind, 'unhydrated_after_retry');
    assert.match(w.detail, /after one reload/);
    assert.equal(w.snapshot, '9-abc-p1.html', 'basename only');
    assert.equal(h.st.snapshots.length, 1, 'one snapshot for the final page, not one per look');
    assert.equal(h.st.waits.length, 2, 'waited before and after the reload');
    assert.equal(classifyPage(w.signals).stopSource, true);
  });
  test('cards present but every id fails mapCard: still a wall, with its own reason, and the log reports raw count and rejects', async () => {
    const h = harness([{ ids: ['123', '456', '789'], renderAfterReload: true }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.listings.length, 0);
    assert.equal(r.walls.length, 1);
    assert.match(r.walls[0].detail, /^cards present but unparseable \(3 rejected by mapCard\)/);
    const log = h.st.logs.filter((l) => l.evt === 'linkedin_page').at(-1);
    assert.equal(log.deduped_cards, 3);
    assert.equal(log.mapcard_rejects, 3);
  });
  test('a page that hydrates after the reload is parsed with no wall', async () => {
    const h = harness([{ ids: ids(6), renderAfterWait: false, renderAfterReload: true }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(h.st.reloads, 1);
    assert.equal(r.walls.length, 0);
    assert.equal(r.listings.length, 6);
  });
  test('the per-run reload cap: with the real LinkedIn reserver, 5 permanent skeletons reload 3 times and the last 2 are unknown (reload cap reached)', async () => {
    const h = harness(Array.from({ length: 5 }, () => ({ ids: [], renderAfterWait: false })), { reserveReload: makeReloadReserver('linkedin') });
    const r = await run(h.ctx, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(h.st.reloads, 3);
    assert.deepEqual(r.walls.map((w) => w.wallKind), ['unhydrated_after_retry', 'unhydrated_after_retry', 'unhydrated_after_retry', 'unknown', 'unknown']);
    assert.match(r.walls[4].detail, /reload cap reached/);
  });
  test('makeReloadReserver: 3 for linkedin, then false; other sources never reload', () => {
    const li = makeReloadReserver('linkedin');
    assert.deepEqual([li(), li(), li(), li(), li()], [true, true, true, false, false]);
    assert.equal(makeReloadReserver('indeed')(), false);
    assert.equal(makeReloadReserver('linkedin')(), true, 'each run gets a fresh reserver');
  });
  test('login is decided before any wait: no hydration wait, no reload', async () => {
    const h = harness([{ ids: [], renderAfterWait: false, finalPath: '/authwall' }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(h.st.waits.length, 0);
    assert.equal(h.st.reloads, 0);
    assert.equal(r.walls[0].wallKind, 'login');
  });
  test('an inline login form is decided before any wait', async () => {
    const h = harness([{ ids: [], renderAfterWait: false, markers: { loginForm: true } }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(h.st.waits.length, 0);
    assert.equal(r.walls[0].wallKind, 'login');
  });
  test('HTTP 429 is throttle_or_block, decided before any wait and never reloaded', async () => {
    const h = harness([{ ids: [], renderAfterWait: false, status: 429 }]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(h.st.waits.length, 0);
    assert.equal(h.st.reloads, 0);
    assert.equal(r.walls[0].wallKind, 'throttle_or_block');
  });
  test('a guest interstitial that appears while the page renders is still login (markers are read again after the wait)', async () => {
    const h = harness([{ ids: ids(5), markers: {} }]);
    const origRead = h.ctx.capFor;
    h.ctx.capFor = async () => {
      const cap = /** @type {any} */ (await origRead());
      let marks = 0;
      return { ...cap, async readJson(/** @type {string} */ n) { if (n === 'wallMarkers') return { guestInterstitial: ++marks > 1 }; return cap.readJson(n); } };
    };
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls[0].wallKind, 'login');
    assert.equal(r.listings.length, 0);
  });
  test('an aborted wait (run abort or the run deadline) propagates; no wall, no reload', async () => {
    const h = harness([{ ids: [], renderAfterWait: false }], { hydrationThrows: new Error('run aborted') });
    await assert.rejects(run(h.ctx, ['CTO']), /run aborted/);
    assert.equal(h.st.reloads, 0);
  });
  test('a cap without waitForHydration or reload (older fakes) still classifies: skeleton is a single unknown wall', async () => {
    const h = harness([{ ids: [], renderAfterWait: false }]);
    const origRead = h.ctx.capFor;
    h.ctx.capFor = async () => {
      const cap = /** @type {any} */ (await origRead());
      const { waitForHydration, reload, ...rest } = cap;
      return rest;
    };
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 1);
    assert.equal(r.walls[0].wallKind, 'unknown');
  });
});
