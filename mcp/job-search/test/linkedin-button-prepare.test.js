// @ts-check
/**
 * src/apply/linkedin-button-prepare.js (auto-apply GAP 1; spec v1 F1.3, v2 B5/B6/B7/B8/B12): the
 * integration layer that loads a LinkedIn job page through the read-only Capability (goto/readHtml),
 * classifies it with src/apply/linkedin-apply-state.js, clicks ONLY an identified external button, and
 * persists from the branch. Fake client/cap/page/session throughout -- no real database, no real browser.
 * Lives under src/apply/ because it wires a raw-Playwright click adapter (test/safety.test.js forbids any
 * `.click(` call surface outside src/apply/).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepareLinkedInListing, checkLinkedInListingLive, LIVE_CHECK_HALT_BRANCHES, createLinkedInLiveCheck, openLinkedInProbeBrowser,
} from '../src/apply/linkedin-button-prepare.js';
import { registryFrom } from '../src/apply/probe-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** @param {string} name */
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', 'linkedin-apply-state', name), 'utf8');

const REGISTRY = registryFrom(['boards.greenhouse.io']);
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const JOB_URL = 'https://www.linkedin.com/jobs/view/4100000001/';
const LISTING = { id: 1, url: null, url_normalized: JOB_URL, apply_probed_at: null, probe_attempts: 0 };

function fakeClient() {
  /** @type {Array<{ text: string, params: unknown[] }>} */
  const queries = [];
  return { queries, async query(/** @type {string} */ text, /** @type {unknown[]} */ params) { queries.push({ text, params }); return { rows: [], rowCount: 0 }; } };
}
/** @param {ReturnType<typeof fakeClient>} c */
const writes = (c) => c.queries.filter((q) => /^\s*(UPDATE|INSERT)/i.test(q.text));

/**
 * @param {{ html?: string|null, gotoThrows?: { code: string }, landedUrl?: string, status?: number, inspect?: { count: number, name: string }, targetsAfterClick?: Array<{ id: unknown, url: string }>, urlsAfterClick?: string }} o
 */
function browser(o) {
  /** @type {string[]} */
  const clicks = [];
  let gotos = 0;
  let clicked = false;
  const cap = {
    goto: async () => {
      gotos++;
      if (o.gotoThrows) throw Object.assign(new Error('nav'), o.gotoThrows);
      return { status: o.status ?? 200, url: JOB_URL };
    },
    readHtml: async () => o.html ?? '',
  };
  const probeSession = {
    page: {
      url: async () => (clicked && o.urlsAfterClick ? o.urlsAfterClick : (o.landedUrl ?? JOB_URL)),
      inspect: async () => o.inspect ?? { count: 1, name: 'Apply to Chief Technology Officer on company website' },
      click: async (/** @type {string} */ sel) => { clicks.push(sel); clicked = true; },
    },
    session: {
      listTargets: async () => (clicked ? (o.targetsAfterClick ?? []) : []),
      closeTarget: async () => {},
    },
  };
  return { cap, probeSession, clicks, gotos: () => gotos };
}

function deps(overrides = {}) {
  /** @type {any[]} */
  const breakerTrips = [];
  /** @type {number[]} */
  const markedApplied = [];
  return {
    breakerTrips,
    markedApplied,
    d: {
      probeRegistry: REGISTRY, reprobeAfterHours: 48, now: new Date('2026-10-06T12:00:00Z'), dryRun: false, lookup: publicLookup,
      log: () => {}, sleep: async () => {}, probeTimeoutMs: 5,
      tripBreaker: async (/** @type {any} */ _c, /** @type {any} */ o) => { breakerTrips.push(o); },
      markListingApplied: async (/** @type {any} */ _c, /** @type {number} */ id) => { markedApplied.push(id); },
      ...overrides,
    },
  };
}

describe('prepareLinkedInListing: easy_apply', () => {
  test('writes apply_easy_only=true, apply_ats linkedin_easy (not exact), clears apply_url and the hint; never clicks', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('easy-apply.html') });
    const { d } = deps();
    const r = await prepareLinkedInListing(client, LISTING, { ...d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'easy_apply');
    assert.equal(r.outcome, 'resolved');
    assert.deepEqual(b.clicks, []);
    const [w] = writes(client);
    assert.match(w.text, /apply_easy_only = true/);
    assert.match(w.text, /apply_url = NULL/);
    assert.match(w.text, /apply_ats = 'linkedin_easy'/);
    assert.match(w.text, /apply_ats_confidence = 'inferred'/);
    assert.match(w.text, /apply_ats_hint = NULL/);
    assert.match(w.text, /probe_attempts = probe_attempts \+ 1/);
  });

  test('a live no-h1 Easy Apply page (2026-10-06 snapshot) persists easy_apply', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('live-2026-10-06/14581.html') });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'easy_apply');
    assert.match(writes(client)[0].text, /apply_easy_only = true/);
  });

  test('the sticky-header duplicate still classifies and persists easy_apply', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('sticky-duplicate.html') });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'easy_apply');
  });
});

describe('prepareLinkedInListing: external', () => {
  test('an anchor href resolves without any click and writes apply_easy_only=false', async () => {
    const client = fakeClient();
    const html = fixture('external-apply.html').replace(/<button type="button" class="jobs-apply-button h8e2dd"[^>]*>[\s\S]*?<\/button>/, '<a href="https://boards.greenhouse.io/acme/jobs/123">Apply</a>');
    const b = browser({ html });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'external');
    assert.equal(r.outcome, 'resolved');
    assert.deepEqual(b.clicks, []);
    const [w] = writes(client);
    assert.equal(w.params[1], 'https://boards.greenhouse.io/acme/jobs/123');
    assert.match(w.text, /apply_easy_only = false/);
  });

  test('a button opens a new off-LinkedIn tab: clicks the identified control path, never the shared selector', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('external-apply.html'), targetsAfterClick: [{ id: 'n', url: 'https://boards.greenhouse.io/acme/jobs/77' }] });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'external');
    assert.equal(r.outcome, 'resolved');
    assert.equal(b.clicks.length, 1);
    assert.match(b.clicks[0], /^html > body > /);
    assert.doesNotMatch(b.clicks[0], /jobs-apply-button/);
    assert.equal(writes(client)[0].params[1], 'https://boards.greenhouse.io/acme/jobs/77');
  });

  test('the live control turned out to be Easy Apply: the click is aborted and the branch is unknown (spec v2 B5)', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('external-apply.html'), inspect: { count: 1, name: 'Easy Apply' } });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'unknown');
    assert.deepEqual(b.clicks, []);
    const [w] = writes(client);
    assert.match(w.text, /apply_easy_only = false/);
    assert.doesNotMatch(w.text, /apply_easy_only = true/);
  });

  test('a click that lands on a linkedin.com host (/safety/go/) is unknown, not external (spec v2 B12)', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('external-apply.html'), targetsAfterClick: [{ id: 'n', url: 'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fx.example.com' }] });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'unknown');
    assert.match(writes(client)[0].text, /apply_easy_only = false/);
  });

  test('a click with no new tab and no hint (timeout) is unknown', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('external-apply.html') });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'unknown');
    assert.equal(r.outcome, 'unresolved');
  });

  test('a same-tab hint is stored, apply_ats untouched, apply_easy_only=false', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('external-apply.html'), urlsAfterClick: `${JOB_URL}?applicantTrackingSystemName=workday&companyName=Acme` });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'external');
    assert.equal(r.outcome, 'unresolved');
    const [w] = writes(client);
    assert.match(w.text, /apply_ats_hint/);
    assert.doesNotMatch(w.text, /apply_ats = /);
    assert.match(w.text, /apply_easy_only = false/);
  });

  test('no probe session for a button-only external control: unknown, never a click', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('external-apply.html') });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: null });
    assert.equal(r.branch, 'unknown');
  });
});

describe('prepareLinkedInListing: closed, already_applied, no_control', () => {
  test('closed: apply_easy_only=false and expired_at set, attempt counted', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('closed.html') });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'closed');
    const [w] = writes(client);
    assert.match(w.text, /expired_at = coalesce\(expired_at, \$2\)/);
    assert.match(w.text, /apply_easy_only = false/);
  });

  test('already_applied: apply_easy_only=false and the listing is marked applied', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('applied.html') });
    const x = deps();
    const r = await prepareLinkedInListing(client, LISTING, { ...x.d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'already_applied');
    assert.deepEqual(x.markedApplied, [LISTING.id]);
    assert.match(writes(client)[0].text, /apply_easy_only = false/);
  });

  test('no_control and unknown never set apply_easy_only=true and DO count an attempt (spec v2 B7)', async () => {
    for (const [html, branch] of [[fixture('rail-promoted-only.html'), 'no_control'], [fixture('easy-apply.html').replace('<html lang="en">', '<html lang="fr">'), 'unknown']]) {
      const client = fakeClient();
      const b = browser({ html });
      const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
      assert.equal(r.branch, branch);
      assert.equal(r.outcome, 'unresolved');
      const [w] = writes(client);
      assert.match(w.text, /apply_easy_only = false/);
      assert.match(w.text, /probe_attempts = probe_attempts \+ 1/);
    }
  });
});

describe('prepareLinkedInListing: load_failure, challenge, auth_wall', () => {
  test('A12: load_failure records apply_probed_at AND increments the lifetime probe_attempts, so the cap of 3 retires a page that never loads', async () => {
    const client = fakeClient();
    const b = browser({ gotoThrows: { code: 'TIMEOUT' } });
    const r = await prepareLinkedInListing(client, LISTING, { ...deps().d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'load_failure');
    assert.equal(r.outcome, 'skipped_load_failure');
    const [w] = writes(client);
    assert.match(w.text, /apply_probed_at = \$2/);
    assert.match(w.text, /probe_attempts = probe_attempts \+ 1/);
  });

  test('challenge persists nothing on the listing and trips the durable 24h breaker (spec v2 B8)', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('challenge.html') });
    const x = deps();
    const r = await prepareLinkedInListing(client, LISTING, { ...x.d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'challenge');
    assert.equal(r.outcome, 'halted_challenge');
    assert.equal(writes(client).length, 0);
    assert.equal(x.breakerTrips.length, 1);
    assert.equal(x.breakerTrips[0].hours, 24);
    assert.equal(x.breakerTrips[0].ats, 'linkedin_easy');
    assert.match(x.breakerTrips[0].reason, /challenge/);
  });

  test('a guard-refused landing on /authwall is auth_wall: nothing persisted, breaker tripped', async () => {
    const client = fakeClient();
    const b = browser({ gotoThrows: { code: 'URL_REJECTED' }, landedUrl: 'https://www.linkedin.com/authwall?trk=x' });
    const x = deps();
    const r = await prepareLinkedInListing(client, LISTING, { ...x.d, cap: b.cap, probeSession: b.probeSession });
    assert.equal(r.branch, 'auth_wall');
    assert.equal(r.outcome, 'halted_auth_wall');
    assert.equal(writes(client).length, 0);
    assert.equal(x.breakerTrips.length, 1);
  });
});

describe('prepareLinkedInListing: no page load when no real attempt is possible', () => {
  test('dry run, lifetime cap, and cooldown never load the page and never write', async () => {
    const cases = [
      [{ dryRun: true }, LISTING, 'skipped_dry_run'],
      [{}, { ...LISTING, probe_attempts: 3 }, 'skipped_lifetime_cap'],
      [{}, { ...LISTING, probe_attempts: 1, apply_probed_at: new Date('2026-10-06T00:00:00Z') }, 'skipped_cooldown'],
    ];
    for (const [over, listing, outcome] of cases) {
      const client = fakeClient();
      const b = browser({ html: fixture('easy-apply.html') });
      const r = await prepareLinkedInListing(client, /** @type {any} */ (listing), { ...deps(over).d, cap: b.cap, probeSession: b.probeSession });
      assert.equal(r.outcome, outcome);
      assert.equal(b.gotos(), 0);
      assert.equal(client.queries.length, 0);
    }
  });
});

describe('createLinkedInLiveCheck / openLinkedInProbeBrowser: the unlocked live check never reconciles', () => {
  function fakeSession() {
    const calls = /** @type {string[]} */ ([]);
    const page = { url: () => JOB_URL, goto: async () => { throw new Error('no network in tests'); }, context: () => ({ pages: () => [] }) };
    return {
      calls,
      connect: async () => ({
        reconcileTargets: async () => { calls.push('reconcileTargets'); },
        reconcile: async () => { calls.push('reconcile'); },
        attachPage: async () => page,
        closeAll: async () => { calls.push('closeAll'); },
      }),
    };
  }
  const env = /** @type {any} */ ({ SCAN_CDP_URL: 'http://127.0.0.1:1', JOBSEARCH_LOG_DIR: '.' });

  test('the live check (no lock held) never closes other pages, and always closes its own session', async () => {
    const s = fakeSession();
    const config = (await import('../src/core/config.js')).loadConfig();
    const client = { async query(/** @type {string} */ text) { return /FROM ic_job_listings WHERE id/.test(text) ? { rows: [{ id: 1, url: JOB_URL, url_normalized: JOB_URL, apply_probed_at: null, probe_attempts: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 }; } };
    const check = createLinkedInLiveCheck({ env, config, log: () => {}, withClient: async (fn) => fn(/** @type {any} */ (client)), connectSession: /** @type {any} */ (s.connect) });
    const r = await check(1);
    assert.equal(typeof r.branch, 'string');
    assert.deepEqual(s.calls, ['closeAll']);
  });

  test('the prepare-phase opener (lock held) still reconciles stale pages by default', async () => {
    const s = fakeSession();
    const config = (await import('../src/core/config.js')).loadConfig();
    const b = await openLinkedInProbeBrowser(/** @type {any} */ (s.connect), env, config, () => {});
    assert.ok(b);
    await /** @type {any} */ (b).close();
    assert.deepEqual(s.calls, ['reconcileTargets', 'reconcile', 'closeAll']);
  });
});

describe('checkLinkedInListingLive (pre-create / pre-worker check, spec v1 F1.4 and v2 B1)', () => {
  const liveDeps = (/** @type {any} */ over = {}) => {
    const x = deps();
    return {
      x,
      d: {
        ...x.d, adapterCfg: { dailyPages: 40, dailyDetails: 200 },
        breakerStatus: async () => ({ tripped: false }),
        reserveBudget: async () => ({ ok: true }),
        ...over,
      },
    };
  };

  test('easy_apply page: easy_apply, persisted without counting a probe attempt', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('easy-apply.html') });
    const { d } = liveDeps();
    const r = await checkLinkedInListingLive(client, LISTING, { ...d, cap: b.cap, page: b.probeSession.page });
    assert.equal(r.branch, 'easy_apply');
    const [w] = writes(client);
    assert.match(w.text, /apply_easy_only = true/);
    assert.doesNotMatch(w.text, /probe_attempts/);
  });

  test('an external page is not easy_apply and writes apply_easy_only=false without clicking', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('external-apply.html') });
    const { d } = liveDeps();
    const r = await checkLinkedInListingLive(client, LISTING, { ...d, cap: b.cap, page: b.probeSession.page });
    assert.equal(r.branch, 'external');
    assert.deepEqual(b.clicks, []);
    assert.match(writes(client)[0].text, /apply_easy_only = false/);
  });

  test('an auth wall during the check trips the breaker and reports a halting branch', async () => {
    const client = fakeClient();
    const b = browser({ html: fixture('auth-wall.html') });
    const { d, x } = liveDeps();
    const r = await checkLinkedInListingLive(client, LISTING, { ...d, cap: b.cap, page: b.probeSession.page });
    assert.equal(r.branch, 'auth_wall');
    assert.ok(LIVE_CHECK_HALT_BRANCHES.includes(r.branch));
    assert.equal(x.breakerTrips.length, 1);
  });

  test('a tripped breaker or an exhausted LinkedIn detail budget never loads the page', async () => {
    for (const [over, branch] of [[{ breakerStatus: async () => ({ tripped: true }) }, 'breaker'], [{ reserveBudget: async () => ({ ok: false }) }, 'budget_exhausted']]) {
      const client = fakeClient();
      const b = browser({ html: fixture('easy-apply.html') });
      const { d } = liveDeps(over);
      const r = await checkLinkedInListingLive(client, LISTING, { ...d, cap: b.cap, page: b.probeSession.page });
      assert.equal(r.branch, branch);
      assert.equal(b.gotos(), 0);
      assert.equal(writes(client).length, 0);
    }
  });
});
