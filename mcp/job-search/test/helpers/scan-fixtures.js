// @ts-check
/**
 * Shared helpers for the stage 3 tests: fixture transport, fake scan
 * session, test config, test profiles, and lock-aware runScan.
 *
 * The fake session/page below is TEST code standing in for playwright's
 * Page. It implements only what browser/capability.js calls and records
 * every navigation so har.test.js can audit it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig, loadConfig } from '../../src/core/config.js';
import { runScan } from '../../src/core/scan-run.js';
import { computeProfileRev } from '../../src/core/upsert.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, '..', 'fixtures');
export const CONFIG_DIR = path.join(FIXTURES, 'scan', 'config');

/** @param {string} rel */
export function readFixture(rel) {
  return fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
}

/** @param {string} rel */
export function readJsonFixture(rel) {
  return JSON.parse(readFixture(rel));
}

/**
 * Decode one Gmail messages.get(format=full) fixture (test/fixtures/adapters/gmail-*.json):
 * base64url-decodes the first text/plain and text/html leaf and the internalDate.
 * @param {string} rel path under FIXTURES, e.g. 'adapters/gmail-linkedin-alert-1.json'
 * @returns {{ json: any, text: string|null, html: string|null, now: Date }}
 */
export function readGmailFixture(rel) {
  const json = readJsonFixture(rel);
  /** @type {{ text: string|null, html: string|null }} */
  const parts = { text: null, html: null };
  /** @param {any} part */
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && !parts.text && part.body && typeof part.body.data === 'string') {
      parts.text = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
    if (part.mimeType === 'text/html' && !parts.html && part.body && typeof part.body.data === 'string') {
      parts.html = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
    if (Array.isArray(part.parts)) for (const p of part.parts) walk(p);
  };
  walk(json.payload);
  const ms = Number(json.internalDate);
  return { json, text: parts.text, html: parts.html, now: Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date() };
}

/** Test config: real adapters.json plus test boards (one synthetic Greenhouse board, example Workday/Dayforce, two exec boards). */
export function testConfig() {
  return loadConfig({ dir: CONFIG_DIR, fresh: true });
}

/**
 * @typedef {{ method: string, url: string, body?: string|null }} RecordedRequest
 */

/** Default URL-prefix map for the fixture transport. */
export const DEFAULT_MAP = [
  { prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs/7000000001', file: 'adapters/greenhouse-zztest-detail.json' },
  { prefix: 'https://boards-api.greenhouse.io/v1/boards/zztest/jobs', file: 'adapters/greenhouse-zztest-jobs.json' },
  { prefix: 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/8700245002', file: 'adapters/greenhouse-job-detail.json' },
  { prefix: 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs', file: 'adapters/greenhouse-gitlab-jobs.json' },
  { prefix: 'https://api.lever.co/v0/postings/palantir', file: 'adapters/lever-palantir-postings.json' },
  { prefix: 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs', file: 'adapters/workday-search.json' },
  { prefix: 'https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/job/', file: 'adapters/workday-detail.json' },
  { prefix: 'https://example.dayforcehcm.com/CandidatePortal/en-US/example/Posting/View/', file: 'adapters/dayforce-list.html' },
  { prefix: 'https://example.dayforcehcm.com/CandidatePortal/en-US/example', file: 'adapters/dayforce-list.html' },
  { prefix: 'https://www.example-exec.test/opportunities/', file: 'adapters/exec-jsonld.html' },
  { prefix: 'https://www.example-exec.test/opportunities', file: 'adapters/exec-selectors.html' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?', file: 'adapters/gmail-list-all.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765401', file: 'adapters/gmail-linkedin-alert-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765402', file: 'adapters/gmail-linkedin-jobsnoreply-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765403', file: 'adapters/gmail-linkedin-multi-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765404', file: 'adapters/gmail-indeed-jobalert-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765405', file: 'adapters/gmail-indeed-jobalert-2.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765406', file: 'adapters/gmail-indeed-match-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765407', file: 'adapters/gmail-lensa-jobalert-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765408', file: 'adapters/gmail-lensa-aggregated-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba98765409', file: 'adapters/gmail-lensa24-1.json' },
  { prefix: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/fedcba9876540a', file: 'adapters/gmail-ladders-1.json' },
];

/**
 * Fake auth deps for gmail.js's injectable seam (never touches the real
 * token file). Overwrite gmail.js's exported `deps` with these before
 * calling gmail.search() or running a scan that includes 'gmail'.
 */
export const fakeGmailAuthDeps = Object.freeze({
  readTokenFile: () => ({ client_id: 'zz-test-client', client_secret: 'zz-test-secret', refresh_token: 'zz-test-refresh', access_token: 'zz-test-access', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], expiry: null, token_uri: 'https://oauth2.googleapis.com/token' }),
  makeOAuthClient: () => ({}),
  getAccessToken: async () => ({ token: 'zz-test-access-token', expiry: null }),
});

/**
 * In-process fixture fetch. Records every request when `recorder` is given.
 * @param {Array<{ prefix: string, file?: string, body?: string, status?: number }>} map
 * @param {RecordedRequest[]} [recorder]
 * @returns {typeof fetch}
 */
export function makeFixtureFetch(map = DEFAULT_MAP, recorder) {
  return async (input, init) => {
    const url = String(input);
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (recorder) recorder.push({ method, url, body: init && typeof init.body === 'string' ? init.body : null });
    const entry = map.find((m) => url.startsWith(m.prefix));
    if (!entry) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const body = entry.body ?? readFixture(/** @type {string} */ (entry.file));
    const ct = (entry.file ?? '').endsWith('.json') ? 'application/json' : 'text/html';
    return new Response(body, { status: entry.status ?? 200, headers: { 'content-type': ct } });
  };
}

/**
 * In-memory stand-in for budget.reserveBudget so fixture runs never consume
 * the real ic_scan_budget rows (the daily LinkedIn cap is only 40 pages).
 * Same contract: ok=false when a cap would be exceeded.
 * @param {{ pages?: number, details?: number }} [used] starting usage
 * @returns {import('../../src/core/budget.js').reserveBudget}
 */
export function memoryReserve(used = {}) {
  /** @type {Record<string, { pages: number, details: number }>} */
  const state = {};
  return async (_client, source, want, caps) => {
    const s = (state[source] ??= { pages: used.pages ?? 0, details: used.details ?? 0 });
    const p = want.pages ?? 0;
    const d = want.details ?? 0;
    if (s.pages + p > caps.dailyPages || s.details + d > caps.dailyDetails) {
      return { ok: false, remainingPages: caps.dailyPages - s.pages, remainingDetails: caps.dailyDetails - s.details };
    }
    s.pages += p;
    s.details += d;
    return { ok: true, remainingPages: caps.dailyPages - s.pages, remainingDetails: caps.dailyDetails - s.details };
  };
}

/** DNS stub: every host resolves to one public address. */
export const fakeLookup = async () => [{ address: '93.184.216.34', family: 4 }];

/**
 * Fake scan session: a stand-in for browser/session.js used by the HAR and
 * run tests. `evaluate` dispatches on the extractor function NAME, which is
 * how capability.js hands named extractors through.
 * @param {{ recorder?: RecordedRequest[], indeedCards?: any[], linkedinCards?: any[], jsonld?: any[], listItems?: any[], html?: string, emptyState?: boolean }} [o]
 */
export function makeFakeSession(o = {}) {
  const state = { attached: 0, closed: 0, reconciled: 0, disconnected: false };
  const connectSession = async () => {
    const session = {
      async attachPage() {
        state.attached++;
        let current = 'about:blank';
        const fake = {
          async goto(/** @type {string} */ url) {
            current = url;
            if (o.recorder) o.recorder.push({ method: 'GET', url });
            return { status: () => 200, headers: () => ({}) };
          },
          url: () => current,
          async content() {
            return o.html ?? '<html><body></body></html>';
          },
          async evaluate(/** @type {Function} */ fn, /** @type {unknown} */ arg) {
            switch (fn.name) {
              case 'indeedMosaicJobs': return o.indeedCards ?? null;
              case 'indeedDomJobs': return [];
              case 'indeedEmptyState': return o.emptyState ?? true;
              case 'linkedinJobCards': return o.linkedinCards ?? [];
              case 'linkedinEmptyState': return o.emptyState ?? true;
              case 'linkedinJobDetail': return { title: 't', company: 'c', location: 'l', description: 'Fake LinkedIn detail description text.' };
              case 'wallMarkers': return { challengeCloudflare: false, challengeForm: false, recaptcha: false, title: 'x', url: current.split('?')[0] };
              case 'scrollStep': return { before: 100, after: 100, atBottom: true };
              case 'readJsonLd': return o.jsonld ?? [];
              case 'genericListItems': return o.listItems ?? [];
              case 'bodyText': return 'fake body text';
              case 'readScriptJson': return null;
              default: throw new Error(`fake page: unknown extractor ${fn.name} (${JSON.stringify(arg)})`);
            }
          },
          async waitForTimeout() {},
          async close() {
            state.closed++;
          },
        };
        return /** @type {any} */ (fake);
      },
      async reconcile() {
        state.reconciled++;
        return 0;
      },
      async closeAll() {
        state.disconnected = true;
      },
      openPages: () => state.attached - state.closed,
    };
    return session;
  };
  return { connectSession, state };
}

/** Connected pg client for tests. */
export async function newClient() {
  const c = new pg.Client(pgConnectionConfig());
  await c.connect();
  return c;
}

/**
 * Insert (or replace) a test profile.
 * @param {pg.Client} client
 * @param {string} name
 * @param {Partial<{ keywords: string[], phrases: string[], exclude_terms: string[], locations: string[], remote: string, posted_within_days: number, max_pages: number, sources: string[] }>} [p]
 */
export async function upsertTestProfile(client, name, p = {}) {
  const profile = {
    name,
    keywords: p.keywords ?? ['Chief Technology Officer', 'Chief Information Officer', 'CTO', 'CIO', 'Vice President', 'Chief'],
    phrases: p.phrases ?? ['SVP Digital Transformation', 'VP Payments Strategy', 'VP Technology'],
    exclude_terms: p.exclude_terms ?? ['Assistant'],
    locations: p.locations ?? ['Houston, TX'],
    remote: p.remote ?? 'any',
    posted_within_days: p.posted_within_days ?? 7,
    max_pages: p.max_pages ?? 2,
    sources: p.sources ?? ['greenhouse'],
  };
  const rev = computeProfileRev(profile);
  await client.query(
    `INSERT INTO ic_search_profiles (name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (name) DO UPDATE SET keywords=$2, phrases=$3, exclude_terms=$4, locations=$5, remote=$6, posted_within_days=$7, max_pages=$8, sources=$9, rev=$10, updated_at=now()`,
    [name, profile.keywords, profile.phrases, profile.exclude_terms, profile.locations, profile.remote, profile.posted_within_days, profile.max_pages, profile.sources, rev],
  );
  return { ...profile, rev };
}

/**
 * Delete everything a test run created: listings by company (only when the
 * caller names companies; test files run in parallel and must not delete each
 * other's rows), run rows by profile (run items cascade), queue rows, and the
 * profile.
 * @param {pg.Client} client
 * @param {{ profile: string, companies?: string[] }} o
 */
export async function cleanupScan(client, o) {
  const companies = o.companies ?? [];
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = ANY($1::text[])', [companies])).rows.map((r) => r.id);
  if (ids.length) {
    await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_scan_run_items WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await client.query('DELETE FROM ic_job_review_queue WHERE run_id IN (SELECT id FROM ic_scan_runs WHERE profile = $1)', [o.profile]);
  await client.query('DELETE FROM ic_scan_runs WHERE profile = $1', [o.profile]);
  await client.query('DELETE FROM ic_search_profiles WHERE name = $1', [o.profile]);
}

/**
 * runScan that waits out another test's advisory lock (node --test runs
 * files in parallel). Gives up after `timeoutMs`.
 * @param {import('../../src/core/scan-run.js').RunArgs} args
 * @param {import('../../src/core/scan-run.js').RunDeps} deps
 * @param {import('../../src/core/scan-run.js').RunOpts} opts
 * @param {number} [timeoutMs]
 */
export async function runScanWaiting(args, deps, opts, timeoutMs = 120000) {
  const started = Date.now();
  for (;;) {
    const r = /** @type {any} */ (await runScan(args, deps, opts));
    if (r.status !== 'locked') return r;
    if (Date.now() - started > timeoutMs) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
}

/** Deps that never touch the network and never sleep. */
export function offlineDeps(/** @type {Partial<import('../../src/core/scan-run.js').RunDeps>} */ extra = {}) {
  return {
    config: testConfig(),
    fetch: makeFixtureFetch(),
    lookup: fakeLookup,
    sleep: async () => {},
    random: () => 0,
    reserveBudget: memoryReserve(),
    ...extra,
  };
}
