// @ts-check
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIndeedPage, isChallengeHost, hasChallengeText, normalizeSourceName, pairOf, classifyPage, classifyDetail } from '../src/browser/wall.js';
import { EXTRACTORS } from '../src/browser/extractors.js';
import { indeed } from '../src/adapters/indeed.js';

const noSleep = async () => {};
const LONG = 'You will own the platform roadmap and lead engineering. '.repeat(40);

/** @param {any} input @param {any[]} probes probes returned in order (last repeats) */
function run(input, probes) {
  let n = 0;
  const calls = { reads: 0 };
  const readProbe = async () => {
    calls.reads++;
    const p = probes[Math.min(n++, probes.length - 1)];
    if (p instanceof Error) throw p;
    return p;
  };
  return classifyIndeedPage({ sleep: noSleep, readProbe, ...input }).then((v) => ({ ...v, reads: calls.reads }));
}

describe('source identity', () => {
  test('normalizeSourceName trims and lowercases; bad input throws', () => {
    assert.equal(normalizeSourceName('  Indeed '), 'indeed');
    assert.equal(normalizeSourceName('LinkedIn:Detail'), 'linkedin:detail');
    for (const bad of ['', '   ', null, undefined, 5, {}]) assert.throws(() => normalizeSourceName(/** @type {any} */ (bad)));
  });
  test('pairOf strips one trailing :detail and rebuilds the detail key', () => {
    assert.deepEqual(pairOf(' Indeed '), { base: 'indeed', detail: 'indeed:detail' });
    assert.deepEqual(pairOf('LinkedIn:DETAIL'), { base: 'linkedin', detail: 'linkedin:detail' });
    assert.deepEqual(pairOf('x:detail:detail'), { base: 'x:detail', detail: 'x:detail:detail' });
    assert.throws(() => pairOf(''));
  });
});

describe('challenge host', () => {
  const yes = ['https://challenges.cloudflare.com/cdn-cgi/x', 'https://hcaptcha.com/1', 'https://newassets.HCAPTCHA.com/x', 'https://recaptcha.net/a', 'https://www.recaptcha.net/a', 'https://www.google.com/recaptcha/api2/anchor'];
  const no = ['https://www.google.com/maps', 'https://www.google.com/', 'https://evilhcaptcha.com/', 'https://hcaptcha.com.evil.test/', 'not a url', '', null, undefined, 'https://www.indeed.com/jobs'];
  for (const u of yes) test(`host yes: ${u}`, () => assert.equal(isChallengeHost(u), true));
  for (const u of no) test(`host no: ${u}`, () => assert.equal(isChallengeHost(u), false));
});

describe('classifyIndeedPage (table)', () => {
  /** @type {Array<[string, any, any[], string, string|null]>} */
  const rows = [
    ['list parsed > 0 is ok without reading the DOM', { stage: 'list', parsed: 15 }, [], 'ok', null],
    ['15 parsed cards plus a reCAPTCHA frame stays ok', { stage: 'list', parsed: 15 }, [{ frameUrls: ['https://www.google.com/recaptcha/api2/anchor'], bodyText: 'x' }], 'ok', null],
    ['detail with description is ok even with challenge text', { stage: 'detail', descriptionExtracted: true }, [{ bodyText: 'just a moment' }], 'ok', null],
    ['403 plus challenge marker is CHALLENGE (status never consulted)', { stage: 'list', parsed: 0, status: 403 }, [{ challengeCloudflare: true, bodyText: LONG }], 'challenge', 'challenge_marker'],
    ['challenge form marker is CHALLENGE', { stage: 'detail', descriptionExtracted: false }, [{ challengeForm: true, bodyText: LONG }], 'challenge', 'challenge_marker'],
    ['Ray ID footer plus verification text is CHALLENGE', { stage: 'detail', descriptionExtracted: false }, [{ bodyText: 'Additional Verification Required. Ray ID: 8a1b2c3d' }], 'challenge', 'challenge_text'],
    ['hCaptcha frame with empty body is CHALLENGE', { stage: 'list', parsed: 0 }, [{ frameUrls: ['https://newassets.hcaptcha.com/captcha/v1/x'], bodyText: '' }], 'challenge', 'challenge_frame'],
    ['verify you are human early in a long body is CHALLENGE', { stage: 'detail', descriptionExtracted: false }, [{ bodyText: 'Please verify you are human. ' + LONG }], 'challenge', 'challenge_text'],
    ['long description containing "just a moment" deep in the body is not a challenge', { stage: 'detail', descriptionExtracted: false }, [{ bodyText: LONG + ' just a moment ' + LONG }], 'default', null],
    ['www.google.com frame outside /recaptcha/ is not a challenge', { stage: 'list', parsed: 0 }, [{ frameUrls: ['https://www.google.com/maps/embed'], bodyText: LONG }], 'default', null],
    ['unparseable frame URL is not a challenge', { stage: 'list', parsed: 0 }, [{ frameUrls: ['::::'], bodyText: LONG }], 'default', null],
    ['plain page with no challenge signal is default', { stage: 'list', parsed: 0 }, [{ bodyText: LONG }], 'default', null],
    ['unreadable probe (throws) is default, no re-read', { stage: 'list', parsed: 0 }, [new Error('boom')], 'default', null],
    ['null probe is default, no re-read', { stage: 'detail', descriptionExtracted: false }, [null], 'default', null],
  ];
  for (const [name, input, probes, kind, reason] of rows) {
    test(name, async () => {
      const v = await run(input, probes);
      assert.equal(v.kind, kind);
      if (reason) assert.equal(v.reason, reason);
      assert.equal(v.reread, false);
    });
  }

  test('blank page is re-read once, then classified (challenge appears on re-read)', async () => {
    const v = await run({ stage: 'list', parsed: 0 }, [{ bodyText: '' }, { bodyText: 'Verify you are human' }]);
    assert.equal(v.kind, 'challenge');
    assert.equal(v.reread, true);
    assert.equal(v.reads, 2);
  });
  test('blank page that stays blank is re-read exactly once and is default', async () => {
    let slept = 0;
    const v = await run({ stage: 'detail', descriptionExtracted: false, sleep: async () => { slept++; } }, [{ bodyText: ' ' }]);
    assert.equal(v.kind, 'default');
    assert.equal(v.reads, 2);
    assert.equal(slept, 1);
  });
  test('hasChallengeText guard: long body, match late, does not fire', () => {
    assert.equal(hasChallengeText('a'.repeat(400) + ' just a moment ' + 'b'.repeat(500)), false);
    assert.equal(hasChallengeText('just a moment...'), true);
  });
});

describe('callers keep today for every other source', () => {
  test('classifyPage: no indeedChallenge flag means byte-for-byte today', () => {
    assert.equal(classifyPage({ parsed: 0, status: 403 }).reason, 'http_403');
    assert.equal(classifyPage({ parsed: 0, status: 403, indeedChallenge: true }).reason, 'indeed_verification');
    assert.equal(classifyPage({ parsed: 3, indeedChallenge: true }).kind, 'ok');
    assert.equal(classifyPage({ parsed: 0, status: 200, url: 'https://www.indeed.com/jobs' }).kind, 'unrecognized');
  });
  test('classifyDetail: plain 403 keeps blocked:http_403; indeed challenge flag outranks it', () => {
    assert.equal(classifyDetail({ text: LONG, httpStatus: 403, source: 'linkedin' }), 'blocked:http_403');
    assert.equal(classifyDetail({ text: LONG, httpStatus: 403, source: 'indeed' }), 'blocked:http_403');
    assert.equal(classifyDetail({ text: LONG, httpStatus: 403, wallSignals: { indeedChallenge: true } }), 'blocked:indeed_verification');
    assert.equal(classifyDetail({ text: 'Additional verification required', source: 'linkedin' }), 'blocked:indeed_verification');
  });
});

describe('both Indeed paths call the shared classifier', () => {
  /** @param {Record<string, any>} resp @param {{ status?: number }} [nav] */
  function fakeCap(resp, nav = {}) {
    const reads = [];
    return {
      reads,
      async goto(/** @type {string} */ url) { return { status: nav.status ?? 200, url, cfMitigated: null }; },
      async readJson(/** @type {string} */ name) {
        reads.push(name);
        if (name in resp) { const v = resp[name]; return typeof v === 'function' ? v() : v; }
        return null;
      },
    };
  }
  const baseCtx = (/** @type {any} */ cap, extra = {}) => ({ reserveDetail: async () => {}, reservePage: async () => {}, capFor: async () => cap, log: () => {}, maxPages: 1, sleep: noSleep, ...extra });

  test('detail path: 403 + challenge marker flags indeedChallenge; no body-text description passes as OK', async () => {
    const cap = fakeCap({ wallMarkers: { challengeCloudflare: true }, readJsonLd: [], indeedChallengeProbe: { challengeCloudflare: true, bodyText: 'Additional verification required' }, bodyText: 'Additional verification required' }, { status: 403 });
    const r = await indeed.fetchDetail({ url: 'https://www.indeed.com/viewjob?jk=abc12345' }, /** @type {any} */ (baseCtx(cap)));
    assert.equal(r.detailSignals.wallSignals.indeedChallenge, true);
    assert.equal(classifyDetail({ text: r.description, httpStatus: r.detailSignals.httpStatus, wallSignals: r.detailSignals.wallSignals }), 'blocked:indeed_verification');
    assert.ok(cap.reads.includes('indeedChallengeProbe'));
  });
  test('detail path: a JSON-LD description is OK, the probe is never read, signals unchanged', async () => {
    const markers = { challengeCloudflare: false };
    const cap = fakeCap({ wallMarkers: markers, readJsonLd: [{ '@type': 'JobPosting', description: LONG }], bodyText: 'ignored' });
    const r = await indeed.fetchDetail({ url: 'https://www.indeed.com/viewjob?jk=abc12345' }, /** @type {any} */ (baseCtx(cap)));
    assert.equal(r.description, LONG);
    assert.equal(r.detailSignals.wallSignals, markers);
    assert.ok(!cap.reads.includes('indeedChallengeProbe'));
  });
  test('detail path: plain 403, no challenge signal, keeps today (no flag)', async () => {
    const cap = fakeCap({ wallMarkers: { challengeCloudflare: false }, readJsonLd: [], indeedChallengeProbe: { bodyText: LONG }, bodyText: LONG }, { status: 403 });
    const r = await indeed.fetchDetail({ url: 'https://www.indeed.com/viewjob?jk=abc12345' }, /** @type {any} */ (baseCtx(cap)));
    assert.equal(r.detailSignals.wallSignals.indeedChallenge, undefined);
    assert.equal(classifyDetail({ text: r.description, httpStatus: 403, wallSignals: r.detailSignals.wallSignals }), 'blocked:http_403');
  });
  test('list path: zero cards plus hCaptcha frame yields a wall event with indeedChallenge, which classifyPage reports first', async () => {
    const cap = fakeCap({ indeedMosaicJobs: [], indeedDomJobs: [], wallMarkers: { challengeCloudflare: false }, indeedEmptyState: false, indeedChallengeProbe: { frameUrls: ['https://newassets.hcaptcha.com/x'], bodyText: '' } }, { status: 403 });
    const events = [];
    const gen = indeed.search({ name: 't', keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'], posted_within_days: 7 }, /** @type {any} */ (baseCtx(cap)));
    for await (const ev of gen) events.push(ev);
    const wall = events.find((e) => e.kind === 'wall');
    assert.ok(wall);
    assert.equal(wall.signals.indeedChallenge, true);
    assert.equal(classifyPage(wall.signals).reason, 'indeed_verification');
  });
  test('list path: zero cards with no challenge signal keeps today (http_403)', async () => {
    const cap = fakeCap({ indeedMosaicJobs: [], indeedDomJobs: [], wallMarkers: { challengeCloudflare: false }, indeedEmptyState: false, indeedChallengeProbe: { bodyText: LONG } }, { status: 403 });
    const events = [];
    for await (const ev of indeed.search({ name: 't', keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'], posted_within_days: 7 }, /** @type {any} */ (baseCtx(cap)))) events.push(ev);
    const wall = events.find((e) => e.kind === 'wall');
    assert.equal(wall.signals.indeedChallenge, undefined);
    assert.equal(classifyPage(wall.signals).reason, 'http_403');
  });
  test('the probe extractor is registered', () => {
    assert.equal(typeof EXTRACTORS.indeedChallengeProbe, 'function');
  });
});
