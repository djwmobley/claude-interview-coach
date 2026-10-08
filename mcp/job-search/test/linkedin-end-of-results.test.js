// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkedin, classifyLinkedInPage, pageStopThreshold, listUrl } from '../src/adapters/linkedin.js';
import { classifyPage } from '../src/browser/wall.js';
import { EXTRACTORS, linkedinSearchShell, wallMarkers } from '../src/browser/extractors.js';
import { sanitizeSnapshotHtml, createSnapshotSaver, MAX_SNAPSHOTS_PER_RUN } from '../src/core/linkedin-snapshot.js';
import { linkedinThrottleLines } from '../src/core/report.js';
import { testConfig } from './helpers/scan-fixtures.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const profileOf = (/** @type {string[]} */ kws) => /** @type {any} */ ({
  name: 't', keywords: kws, phrases: [], exclude_terms: [], locations: ['Houston, TX'], remote: 'any', posted_within_days: 7, max_pages: 3, sources: [],
});

/**
 * A page spec: n unique cards (ids from base), optionally raw duplicates, plus shell / marker overrides.
 * @param {Partial<{ ids: string[], status: number, finalPath: string, shell: boolean, keywords: string|null, location: string|null, markers: any, empty: boolean, html: string }>} o
 */
function page(o = {}) {
  return o;
}
let idCounter = 7000000000;
/** @param {number} n unique ids */
function ids(n) {
  return Array.from({ length: n }, () => String(idCounter++));
}

/**
 * @param {Array<ReturnType<typeof page>>} pages scripted per goto in order; beyond the script, an empty page
 * @param {{ snapshots?: any[], logs?: any[] }} [sink]
 */
function harness(pages, sink = {}) {
  /** @type {string[]} */
  const gotos = [];
  let cur = /** @type {any} */ ({});
  const cap = Object.freeze({
    source: 'linkedin',
    signal: new AbortController().signal,
    async goto(/** @type {string} */ url) {
      gotos.push(url);
      cur = pages[gotos.length - 1] ?? {};
      cur.__url = new URL(url);
      return { status: cur.status ?? 200, url: `https://www.linkedin.com${cur.finalPath ?? '/jobs/search/'}`, cfMitigated: null };
    },
    async readHtml() {
      return cur.html ?? '<html><body>page</body></html>';
    },
    async scrollToBottom() {
      return { steps: 1, atBottom: true };
    },
    async readJson(/** @type {string} */ name) {
      if (name === 'linkedinJobCards') {
        return (cur.ids ?? []).map((/** @type {string} */ id) => ({ id, title: 'CTO ' + id, company: 'Acme', location: 'Houston, TX', datetime: '2026-10-07' }));
      }
      if (name === 'linkedinEmptyState') return Boolean(cur.empty);
      if (name === 'wallMarkers') return { challengeCloudflare: false, challengeForm: false, recaptcha: false, guestInterstitial: false, loginForm: false, ...(cur.markers ?? {}) };
      if (name === 'linkedinSearchShell') {
        const u = cur.__url;
        return {
          shell: cur.shell ?? true,
          path: cur.finalPath ?? '/jobs/search/',
          keywords: cur.keywords !== undefined ? cur.keywords : u.searchParams.get('keywords'),
          location: cur.location !== undefined ? cur.location : u.searchParams.get('location'),
        };
      }
      throw new Error('unexpected extractor ' + name);
    },
  });
  const ctx = /** @type {any} */ ({
    signal: new AbortController().signal,
    now: NOW,
    windowStart: null,
    maxPages: 3,
    async reservePage() {},
    capFor: async () => cap,
    config: testConfig(),
    log(/** @type {any} */ f) {
      (sink.logs ??= []).push(f);
    },
    async saveSnapshot(/** @type {string} */ html, /** @type {any} */ meta) {
      (sink.snapshots ??= []).push({ html, meta });
    },
  });
  return { ctx, gotos, sink };
}

/** Drain with a scheduler stand-in honoring stopQuery only via the adapter's own stops (maxPages honored by adapter). */
async function run(/** @type {any} */ ctx, /** @type {string[]} */ kws) {
  const out = { listings: /** @type {any[]} */ ([]), batches: /** @type {any[]} */ ([]), walls: /** @type {any[]} */ ([]), warnings: /** @type {any[]} */ ([]), stats: /** @type {any[]} */ ([]) };
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
    else if (ev.kind === 'source_stats') out.stats.push(ev);
  }
  return out;
}

const pageLogs = (/** @type {any[]} */ logs) => logs.filter((l) => l.evt === 'linkedin_page');

describe('linkedin end of results (S1)', () => {
  test('real end of results: page 2 empty with search shell, same query, HTTP 200 -> no wall, query stops', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [] })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 0);
    assert.equal(h.gotos.length, 2, 'no page 3 after end of results');
    assert.deepEqual(r.batches.map((b) => b.parsed), [50, 0]);
    const logs = pageLogs(h.sink.logs ?? []);
    assert.deepEqual(logs.map((l) => l.classification), ['cards', 'end_of_results']);
    assert.equal(h.sink.snapshots?.length, 1, 'END_OF_RESULTS saves a snapshot');
    assert.equal(h.sink.snapshots?.[0].meta.classification, 'end_of_results');
  });

  test('soft-block blank page 2 without search shell is a wall (unrecognized path), snapshot saved', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [], shell: false })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 1);
    assert.equal(r.walls[0].pageIndex, 2);
    assert.equal(classifyPage(r.walls[0].signals).kind, 'unrecognized');
    assert.equal(h.sink.snapshots?.length, 1);
    assert.equal(pageLogs(h.sink.logs ?? [])[1].classification, 'unrecognized');
  });

  test('guest interstitial on page 2 is a wall even with a search shell', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [], shell: true, markers: { guestInterstitial: true } })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 1);
    const v = classifyPage(r.walls[0].signals);
    assert.equal(v.kind, 'wall');
    assert.equal(v.reason, 'guest_interstitial');
    assert.equal(pageLogs(h.sink.logs ?? [])[1].classification, 'wall');
  });

  test('redirect to a different query is a wall', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [], keywords: 'Barista' })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 1);
  });

  test('redirect to a different location is a wall', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [], location: 'Austin, TX' })]);
    assert.equal((await run(h.ctx, ['CTO'])).walls.length, 1);
  });

  for (const p of ['/login', '/checkpoint/challenge', '/authwall', '/uas/login']) {
    test(`final path ${p} is a wall`, async () => {
      const h = harness([page({ ids: ids(50) }), page({ ids: [], finalPath: p })]);
      const r = await run(h.ctx, ['CTO']);
      assert.equal(r.walls.length, 1);
      assert.equal(classifyPage(r.walls[0].signals).kind, 'wall');
    });
  }

  for (const [label, o] of /** @type {Array<[string, any]>} */ ([
    ['HTTP 429', { status: 429 }],
    ['HTTP 200 required (204)', { status: 204 }],
    ['cloudflare challenge', { markers: { challengeCloudflare: true } }],
    ['challenge form', { markers: { challengeForm: true } }],
    ['recaptcha', { markers: { recaptcha: true } }],
    ['login form present', { markers: { loginForm: true } }],
  ])) {
    test(`page 2 empty with ${label} is a wall`, async () => {
      const h = harness([page({ ids: ids(50) }), page({ ids: [], ...o })]);
      assert.equal((await run(h.ctx, ['CTO'])).walls.length, 1);
    });
  }

  test('page 2 empty with an empty-state marker keeps today empty classification (no source stop)', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [], empty: true })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 1);
    assert.equal(classifyPage(r.walls[0].signals).kind, 'empty');
    assert.equal(pageLogs(h.sink.logs ?? [])[1].classification, 'empty');
  });

  test('S2: page 1 with zero cards and no marker keeps today wall behavior', async () => {
    const h = harness([page({ ids: [] })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 1);
    assert.equal(r.walls[0].pageIndex, 1);
    assert.equal(classifyPage(r.walls[0].signals).kind, 'unrecognized');
    assert.equal(pageLogs(h.sink.logs ?? [])[0].classification, 'unrecognized');
  });

  test('page 3 empty after a non-empty page 2 is also end of results', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: ids(45) }), page({ ids: [] })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(r.walls.length, 0);
    assert.equal(h.gotos.length, 3);
  });
});

describe('linkedin pagination stop (S3) and duplicate-id inflation', () => {
  test('page below 0.8 x page-1 count stops the query', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: ids(39) }), page({ ids: ids(50) })]);
    await run(h.ctx, ['CTO']);
    assert.equal(h.gotos.length, 2);
  });
  test('page at 0.8 x page-1 count continues to page 3 (maxPages is the hard stop)', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: ids(40) }), page({ ids: ids(50) }), page({ ids: ids(50) })]);
    await run(h.ctx, ['CTO']);
    assert.equal(h.gotos.length, 3);
  });
  test('pageStopThreshold = max(0.8 x base, 10)', () => {
    assert.equal(pageStopThreshold(50), 40);
    assert.equal(pageStopThreshold(12), 10);
    assert.equal(pageStopThreshold(0), 10);
  });
  test('duplicate ids inflate the raw count but not the deduped count (page 1 stops under 10 unique)', async () => {
    const u = ids(9);
    const dupes = [...u, ...u, ...u, ...u, ...u, ...u, ...u]; // 63 raw, 9 unique
    const h = harness([page({ ids: dupes }), page({ ids: ids(50) })]);
    const r = await run(h.ctx, ['CTO']);
    assert.equal(h.gotos.length, 1, '9 unique < max(0.8 x 9, 10) so no page 2');
    assert.equal(r.batches[0].parsed, 9);
    assert.equal(r.listings.length, 9, 'a repeated id is yielded once');
  });
  test('baseline and comparison use the same deduped measure', async () => {
    const a = ids(45);
    const h = harness([page({ ids: [...a, ...a] }), page({ ids: ids(44) }), page({ ids: ids(50) })]);
    await run(h.ctx, ['CTO']);
    assert.equal(h.gotos.length, 3, 'page 2 deduped 44 >= 0.8 x 45 even though page 1 raw was 90');
  });
});

describe('classifyLinkedInPage (total)', () => {
  const base = { pageIndex: 2, page1Parsed: 50, deduped: 0, status: 200, finalPath: '/jobs/search/', requested: { keywords: 'CTO', location: 'Houston, TX' }, shell: { shell: true, path: '/jobs/search/', keywords: 'CTO', location: 'Houston, TX' }, markers: {}, emptyState: false };
  test('every input maps to one of the five classes', () => {
    const classes = new Set(['cards', 'end_of_results', 'empty', 'wall', 'unrecognized']);
    const variants = [
      { deduped: 3 }, {}, { emptyState: true }, { pageIndex: 1 }, { page1Parsed: 0 }, { status: 403 }, { status: null }, { shell: null },
      { shell: { shell: false } }, { markers: { guestInterstitial: true } }, { finalPath: '/login' }, { shell: { shell: true, path: '/jobs/search/', keywords: 'X', location: 'Houston, TX' } },
    ];
    for (const v of variants) {
      const c = classifyLinkedInPage(/** @type {any} */ ({ ...base, ...v }));
      assert.ok(classes.has(c.classification), JSON.stringify(v));
    }
  });
  test('only the all-conditions case is end_of_results', () => {
    assert.equal(classifyLinkedInPage(/** @type {any} */ (base)).classification, 'end_of_results');
    assert.equal(classifyLinkedInPage(/** @type {any} */ ({ ...base, pageIndex: 1 })).classification, 'unrecognized');
    assert.equal(classifyLinkedInPage(/** @type {any} */ ({ ...base, page1Parsed: 0 })).classification, 'unrecognized');
  });
  test('keyword comparison ignores case and surrounding whitespace', () => {
    const c = classifyLinkedInPage(/** @type {any} */ ({ ...base, shell: { ...base.shell, keywords: ' cto ' } }));
    assert.equal(c.classification, 'end_of_results');
  });
});

describe('suspected throttle (S5)', () => {
  const eor = () => [page({ ids: ids(50) }), page({ ids: [] })];
  test('3 of 3 queries ending on page 2 emits the warning and stats', async () => {
    const h = harness([...eor(), ...eor(), ...eor()]);
    const r = await run(h.ctx, ['CTO', 'CIO', 'COO']);
    const w = r.warnings.filter((x) => x.code === 'SUSPECTED_THROTTLE');
    assert.equal(w.length, 1);
    assert.match(w[0].message, /3 of 3/);
    assert.equal(r.stats.length, 1);
    assert.deepEqual({ ...r.stats[0].stats }, { eor_page2: 3, page1_nonempty: 3, suspected_throttle: true });
  });
  test('2 of 2 does not warn (threshold is 3)', async () => {
    const h = harness([...eor(), ...eor()]);
    const r = await run(h.ctx, ['CTO', 'CIO']);
    assert.equal(r.warnings.filter((x) => x.code === 'SUSPECTED_THROTTLE').length, 0);
  });
  test('3 of 4 non-empty-page-1 queries does not warn', async () => {
    const h = harness([...eor(), ...eor(), ...eor(), page({ ids: ids(50) }), page({ ids: ids(50) }), page({ ids: ids(50) })]);
    const r = await run(h.ctx, ['CTO', 'CIO', 'COO', 'CFO']);
    assert.equal(r.warnings.filter((x) => x.code === 'SUSPECTED_THROTTLE').length, 0);
  });
  test('end of results on page 3 does not count toward the throttle signal', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: ids(45) }), page({ ids: [] }), ...eor(), ...eor()]);
    const r = await run(h.ctx, ['CTO', 'CIO', 'COO']);
    assert.equal(r.warnings.filter((x) => x.code === 'SUSPECTED_THROTTLE').length, 0);
  });
  test('report headline line', () => {
    const lines = linkedinThrottleLines([{ run_id: 1, stats: { linkedin: { eor_page2: 4, page1_nonempty: 4, suspected_throttle: true } } }, { run_id: 2, stats: {} }, { run_id: 3, stats: { linkedin: { eor_page2: 1, page1_nonempty: 5, suspected_throttle: false } } }]);
    assert.deepEqual(lines, ['LINKEDIN SUSPECTED THROTTLE: 4 of 4 queries ended on page 2']);
    assert.deepEqual(linkedinThrottleLines([]), []);
    assert.deepEqual(linkedinThrottleLines(/** @type {any} */ (null)), []);
  });
});

describe('page event logging and snapshots (S6)', () => {
  test('every page logs query, page index, deduped card count and classification', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: ids(45) }), page({ ids: [] })]);
    await run(h.ctx, ['CTO']);
    const logs = pageLogs(h.sink.logs ?? []);
    assert.equal(logs.length, 3);
    assert.deepEqual(logs.map((l) => [l.query, l.page_index, l.deduped_cards, l.classification]), [
      ['CTO|Houston, TX', 1, 50, 'cards'], ['CTO|Houston, TX', 2, 45, 'cards'], ['CTO|Houston, TX', 3, 0, 'end_of_results'],
    ]);
  });
  test('ok pages save no snapshot', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: ids(45) }), page({ ids: ids(45) })]);
    await run(h.ctx, ['CTO']);
    assert.equal(h.sink.snapshots, undefined);
  });
  test('a ctx without saveSnapshot still works', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [] })]);
    delete h.ctx.saveSnapshot;
    assert.equal((await run(h.ctx, ['CTO'])).walls.length, 0);
  });
  test('snapshot failure never breaks the scan', async () => {
    const h = harness([page({ ids: ids(50) }), page({ ids: [] })]);
    h.ctx.saveSnapshot = async () => {
      throw new Error('disk full');
    };
    assert.equal((await run(h.ctx, ['CTO'])).walls.length, 0);
  });
  test('sanitizer strips scripts, code blobs, inputs values, tokens, emails, nav, query strings', () => {
    const html = [
      '<html><head><meta name="csrf-token" content="ajax:123456789"><script>var x="li_at=SECRET"</script><style>a{}</style></head><body>',
      '<header>Damian Mobley</header><nav>Me menu</nav>',
      '<code id="bpr-guid-1">{"miniProfile":"urn:li:fsd_profile:ACoAAB"}</code>',
      '<input type="hidden" name="csrfToken" value="ajax:999"><input value="x@y.com">',
      '<a href="https://www.linkedin.com/jobs/view/123?trackingId=abc&refId=zzz">job</a>',
      '<div class="jobs-search-results-list">results for jane@example.com</div>',
      '<p>JSESSIONID="ajax:55555555555"</p></body></html>',
    ].join('');
    const s = sanitizeSnapshotHtml(html);
    for (const bad of ['SECRET', 'Damian', 'miniProfile', 'ACoAAB', 'ajax:999', 'x@y.com', 'jane@example.com', 'trackingId', 'li_at', 'ajax:55555555555', 'ajax:123456789', 'Me menu']) {
      assert.ok(!s.includes(bad), `leaked ${bad}`);
    }
    assert.ok(s.includes('jobs-search-results-list'), 'structure retained');
    assert.ok(s.includes('/jobs/view/123'));
  });
  test('saver writes <run>-<hash>-p<page>.html, caps at 10 per run, creates the directory', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lisnap-')), 'linkedin-snapshots');
    const save = createSnapshotSaver({ dir, runId: 42 });
    const written = [];
    for (let i = 0; i < 14; i++) written.push(await save('<html><body>x</body></html>', { query: 'q' + i, pageIndex: 2, classification: 'wall' }));
    assert.equal(written.filter(Boolean).length, MAX_SNAPSHOTS_PER_RUN);
    assert.equal(MAX_SNAPSHOTS_PER_RUN, 10);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 10);
    for (const f of files) assert.match(f, /^42-[0-9a-f]{10}-p2\.html$/);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});

describe('wall.js guest interstitial (S4)', () => {
  test('zero cards with guest interstitial is a wall that stops the source', () => {
    const v = classifyPage({ parsed: 0, status: 200, guestInterstitial: true });
    assert.equal(v.kind, 'wall');
    assert.equal(v.stopSource, true);
  });
  test('interstitial beats an empty-state marker; parsed > 0 stays ok', () => {
    assert.equal(classifyPage({ parsed: 0, emptyState: true, guestInterstitial: true }).kind, 'wall');
    assert.equal(classifyPage({ parsed: 4, guestInterstitial: true }).kind, 'ok');
  });
  test('login form present at zero cards is a wall', () => {
    assert.equal(classifyPage({ parsed: 0, loginForm: true }).kind, 'wall');
  });
});

describe('extractors', () => {
  /** Minimal fake DOM: `present` selectors match; body text configurable. */
  function withDom(/** @type {{ present?: string[], text?: string, href?: string, title?: string }} */ o, /** @type {() => any} */ fn) {
    const g = /** @type {any} */ (globalThis);
    const saved = { document: g.document, location: g.location };
    g.document = {
      title: o.title ?? '',
      body: { innerText: o.text ?? '', textContent: o.text ?? '' },
      querySelector(/** @type {string} */ sel) {
        const parts = sel.split(',').map((x) => x.trim());
        return parts.some((p) => (o.present ?? []).includes(p)) ? {} : null;
      },
    };
    g.location = new URL(o.href ?? 'https://www.linkedin.com/jobs/search/?keywords=CTO&location=Houston%2C+TX&start=25');
    try {
      return fn();
    } finally {
      g.document = saved.document;
      g.location = saved.location;
    }
  }
  test('linkedinSearchShell is registered and reports path and the same params the page carries', () => {
    assert.equal(EXTRACTORS.linkedinSearchShell, linkedinSearchShell);
    const r = withDom({ present: ['.jobs-search-results-list'] }, () => linkedinSearchShell());
    assert.deepEqual({ ...r }, { shell: true, path: '/jobs/search/', keywords: 'CTO', location: 'Houston, TX' });
  });
  test('linkedinSearchShell: each affirmative element counts; none present is false', () => {
    for (const sel of ['.jobs-search-results-list', '.scaffold-layout__list', '.jobs-search-pagination', '.artdeco-pagination', '.jobs-search-results-list__subtitle', '.jobs-search-results-list__title-heading']) {
      assert.equal(withDom({ present: [sel] }, () => linkedinSearchShell()).shell, true, sel);
    }
    assert.equal(withDom({ present: [] }, () => linkedinSearchShell()).shell, false);
    assert.equal(withDom({ present: ['.global-nav'] }, () => linkedinSearchShell()).shell, false, 'chrome alone is not the search shell');
  });
  test('wallMarkers detects guest interstitial text and login form', () => {
    for (const text of ['Sign in to see more jobs', 'Join to view more results', 'Join LinkedIn to view more jobs', 'sign in to view more jobs']) {
      assert.equal(withDom({ text }, () => wallMarkers()).guestInterstitial, true, text);
    }
    assert.equal(withDom({ text: 'No more results' }, () => wallMarkers()).guestInterstitial, false);
    assert.equal(withDom({ present: ['input[name="session_key"]'] }, () => wallMarkers()).loginForm, true);
    assert.equal(withDom({ present: [] }, () => wallMarkers()).loginForm, false);
  });
});

describe('listUrl unchanged', () => {
  test('page 2 start offset', () => {
    assert.ok(listUrl('CTO', 'Houston, TX', 7, 2).includes('start=25'));
  });
});
