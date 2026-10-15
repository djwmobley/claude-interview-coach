// @ts-check
/**
 * Replay fetch for the target finder tests (plan 14.6 tests). Serves recorded fixtures from
 * test/fixtures/targets/. It FAILS THE TEST (throws) on any non-GET method, any host outside the target
 * fetch registry, or any URL with no route: there is no live network in any target test.
 *
 * The log records every call so a test can assert the exact URLs, headers, and request count.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGET_FETCH_HOSTS } from '../../src/targets/fetch-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(HERE, '..', 'fixtures', 'targets');

/** @param {string} rel @returns {string} */
export function fixture(rel) {
  return fs.readFileSync(path.join(FIXTURE_DIR, rel), 'utf8');
}

/**
 * @typedef {Object} Route
 * @property {string|RegExp|((url: string) => boolean)} match
 * @property {number} [status]
 * @property {string} [body] literal body
 * @property {string} [file] fixture path under test/fixtures/targets
 * @property {Record<string, string>} [headers]
 */

/**
 * @param {Route[]} routes first match wins
 * @returns {{ fetch: typeof fetch, calls: Array<{ method: string, url: string, headers: Record<string, string>, redirect: string|undefined }> }}
 */
export function createReplayFetch(routes) {
  /** @type {Array<{ method: string, url: string, headers: Record<string, string>, redirect: string|undefined }>} */
  const calls = [];
  /** @type {any} */
  const impl = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    calls.push({ method, url: String(url), headers, redirect: init.redirect });
    if (method !== 'GET') throw new Error(`replay: non-GET method ${method} for ${url}`);
    if (!TARGET_FETCH_HOSTS.includes(u.hostname)) throw new Error(`replay: host outside the registry: ${u.hostname}`);
    if (u.protocol !== 'https:') throw new Error(`replay: non-https URL ${url}`);
    const route = routes.find((r) => (typeof r.match === 'string' ? String(url) === r.match || String(url).startsWith(r.match)
      : r.match instanceof RegExp ? r.match.test(String(url)) : r.match(String(url))));
    if (!route) throw new Error(`replay: no fixture route for ${url}`);
    const body = route.body ?? (route.file ? fixture(route.file) : '');
    return new Response(body, { status: route.status ?? 200, headers: route.headers ?? {} });
  };
  return { fetch: /** @type {typeof fetch} */ (impl), calls };
}

/**
 * Build an EFTS-style search response.
 * @param {Array<Record<string, any>>} hits each `_source` object plus an optional `_id`
 * @param {number} [total]
 */
export function searchJson(hits, total) {
  return JSON.stringify({
    hits: {
      total: { value: total ?? hits.length, relation: 'eq' },
      hits: hits.map((h) => {
        const { _id, ...source } = h;
        return { _id: _id ?? `${source.adsh}:primary_doc.xml`, _source: source };
      }),
    },
  });
}

/** Timing with no real waiting; records requested sleeps. @returns {{ timing: any, sleeps: number[] }} */
export function fastTiming() {
  /** @type {number[]} */
  const sleeps = [];
  let t = 0;
  return {
    sleeps,
    timing: {
      sleep: async (/** @type {number} */ ms) => { sleeps.push(ms); t += ms; },
      now: () => t,
    },
  };
}
