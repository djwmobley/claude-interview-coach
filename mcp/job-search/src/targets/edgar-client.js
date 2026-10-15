// @ts-check
/**
 * EDGAR client shared by the Form D, full-text search, and 8-K adapters (plan 14.3 + 15.2 items 6 and 8).
 *
 *   loadSecContact      config/target-sec-contact.json (gitignored, no default). Valid only when the file
 *                       parses and the contact string holds an email address. Missing or invalid means every
 *                       EDGAR adapter is skipped with a warning (zero requests) and the run proceeds.
 *   validators          cik ^\d{1,10}$, accession ^\d{10}-\d{2}-\d{6}$, filenames without "/" or "..".
 *                       Every URL is built ONLY from validated parts, never from source text.
 *   createEdgarClient   sequential, at least minGapMs between requests, per-budget caps (form_d 90, 8-K 50,
 *                       full-text 50, shared discovery 10; 200 total), one backoff retry on 429/403/503 then
 *                       the whole EDGAR side is aborted for the run (sec_blocked), never hammered.
 *
 * The client calls the network only through the fetch guard (GET, registry hosts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getEnv } from '../core/config.js';
import { sleep as realSleep } from '../core/ratelimit.js';
import { FetchRefused } from './fetch-guard.js';
import { sanitizeText } from './signal-text.js';

export const SEC_CONTACT_FILE = 'target-sec-contact.json';
export const EDGAR_BUDGETS = Object.freeze({ form_d: 90, '8k': 50, fts: 50, discovery: 10 });
export const EDGAR_TOTAL_CAP = 200;
export const MIN_REQUEST_GAP_MS = 250;
export const BACKOFF_MS = 2000;
export const DOC_READ_BYTES = 300 * 1024;
export const SEARCH_READ_BYTES = 2 * 1024 * 1024;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const PLACEHOLDER_EMAIL_RE = /@(?:example\.(?:com|org|net)|invalid|localhost)$/i;

const contactSchema = z.object({ contact: z.string().min(3).max(200) });

/**
 * @param {string} [configDir]
 * @returns {{ ok: true, userAgent: string } | { ok: false, reason: 'missing'|'invalid'|'no_email'|'placeholder' }}
 */
export function loadSecContact(configDir = getEnv().JOBSEARCH_CONFIG_DIR) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(configDir, SEC_CONTACT_FILE), 'utf8');
  } catch {
    return { ok: false, reason: 'missing' };
  }
  let parsed;
  try {
    parsed = contactSchema.parse(JSON.parse(raw));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  // The value ends up in an HTTP header: refuse control characters and newlines outright.
  const contact = parsed.contact.trim();
  if (/[\u0000-\u001f\u007f]/.test(contact)) return { ok: false, reason: 'invalid' };
  const m = EMAIL_RE.exec(contact);
  if (!m) return { ok: false, reason: 'no_email' };
  if (PLACEHOLDER_EMAIL_RE.test(m[0])) return { ok: false, reason: 'placeholder' };
  return { ok: true, userAgent: contact };
}

// ---------------------------------------------------------------------------
// Validators and URL builders (plan 15.2 item 8)
// ---------------------------------------------------------------------------

export const CIK_RE = /^\d{1,10}$/;
export const ADSH_RE = /^\d{10}-\d{2}-\d{6}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

/** @param {unknown} v @returns {string|null} the CIK without leading zeros, or null */
export function validCik(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : (typeof v === 'string' ? v.trim() : '');
  if (!CIK_RE.test(s)) return null;
  const n = s.replace(/^0+/, '');
  return n === '' ? null : n;
}

/** @param {unknown} v @returns {string|null} the dashed accession number, or null */
export function validAdsh(v) {
  return typeof v === 'string' && ADSH_RE.test(v.trim()) ? v.trim() : null;
}

/** @param {unknown} v @returns {string|null} a bare filename (no "/" or ".."), or null */
export function validFilename(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return null;
  return FILENAME_RE.test(s) ? s : null;
}

/** @param {string} adsh dashed @returns {string} 18-digit folder form */
export function adshFolder(adsh) {
  return adsh.replace(/-/g, '');
}

/**
 * The filing index page: https://www.sec.gov/Archives/edgar/data/<cik>/<18-digit folder>/<dashed>-index.htm
 * (the 18-digit folder is part of the real path; plan 14.4's shorter form is corrected here).
 * @param {string} cik validated
 * @param {string} adsh validated dashed
 */
export function indexUrl(cik, adsh) {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${adshFolder(adsh)}/${adsh}-index.htm`;
}

/** @param {string} cik @param {string} adsh @param {string} filename validated */
export function docUrl(cik, adsh, filename) {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${adshFolder(adsh)}/${filename}`;
}

/** @param {string} cik validated, no leading zeros */
export function submissionsUrl(cik) {
  return `https://data.sec.gov/submissions/CIK${cik.padStart(10, '0')}.json`;
}

/**
 * @param {Record<string, string|number|undefined>} params
 * @returns {string}
 */
export function searchUrl(params) {
  const u = new URL('https://efts.sec.gov/LATEST/search-index');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

/** @param {Date} d @returns {string} */
export function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

/** @param {Date} now @param {number} days @returns {string} */
export function daysBefore(now, days) {
  return isoDay(new Date(now.getTime() - days * 86_400_000));
}

// ---------------------------------------------------------------------------
// Search response parsing (shape-tolerant; unknown shapes are reported, never guessed)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SearchHit
 * @property {string|null} adsh
 * @property {string[]} ciks
 * @property {string[]} display_names
 * @property {string|null} file_date
 * @property {string|null} form
 * @property {string[]|null} items null when the source field is absent
 * @property {string|null} filename from _id "<adsh>:<filename>"
 * @property {boolean} shape_ok true when the hit had an object _source
 */

/** @param {unknown} v @returns {string[]} */
function strArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x)) : [];
}

/**
 * @param {string} text
 * @returns {{ ok: boolean, total: number|null, hits: SearchHit[] }}
 */
export function parseSearchResponse(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, total: null, hits: [] };
  }
  const outer = json && typeof json === 'object' ? /** @type {any} */ (json).hits : null;
  const list = outer && typeof outer === 'object' ? outer.hits : null;
  if (!Array.isArray(list)) return { ok: false, total: null, hits: [] };
  const totalRaw = outer.total && typeof outer.total === 'object' ? outer.total.value : outer.total;
  const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : null;
  const hits = list.map((h) => {
    const src = h && typeof h === 'object' && h._source && typeof h._source === 'object' ? h._source : null;
    const id = h && typeof h === 'object' && typeof h._id === 'string' ? h._id : '';
    const colon = id.indexOf(':');
    return /** @type {SearchHit} */ ({
      adsh: src && typeof src.adsh === 'string' ? src.adsh : (colon > 0 ? id.slice(0, colon) : null),
      ciks: src ? strArray(src.ciks) : [],
      display_names: src ? strArray(src.display_names) : [],
      file_date: src && typeof src.file_date === 'string' ? src.file_date : null,
      form: src && typeof src.form === 'string' ? src.form : (src && typeof src.file_type === 'string' ? src.file_type : null),
      items: src && Array.isArray(src.items) ? strArray(src.items) : null,
      filename: colon > 0 ? id.slice(colon + 1) : null,
      shape_ok: Boolean(src),
    });
  });
  return { ok: true, total, hits };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EdgarResult
 * @property {boolean} ok
 * @property {'capped'|'blocked'|'refused'|'http_error'|'network_error'|null} reason
 * @property {number|null} status
 * @property {string} text
 * @property {boolean} truncated
 */

/**
 * @param {Object} opts
 * @param {import('./fetch-guard.js').FetchGuard} opts.guard
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, minGapMs?: number, backoffMs?: number, budgets?: Record<string, number>, totalCap?: number }} [opts.timing]
 */
export function createEdgarClient({ guard, timing = {} }) {
  const sleep = timing.sleep ?? ((/** @type {number} */ ms) => realSleep(ms));
  const clock = timing.now ?? Date.now;
  const minGap = timing.minGapMs ?? MIN_REQUEST_GAP_MS;
  const backoff = timing.backoffMs ?? BACKOFF_MS;
  const budgets = { ...EDGAR_BUDGETS, ...(timing.budgets ?? {}) };
  const totalCap = timing.totalCap ?? EDGAR_TOTAL_CAP;
  /** @type {Record<string, number>} */
  const used = { form_d: 0, '8k': 0, fts: 0, discovery: 0 };
  let total = 0;
  let lastAt = -Infinity;
  let blocked = false;
  /** @type {string[]} */
  const warnings = [];

  /** @param {string} budget @returns {boolean} true when one more request is allowed */
  function hasBudget(budget) {
    return Object.prototype.hasOwnProperty.call(budgets, budget) && used[budget] < budgets[budget] && total < totalCap;
  }

  /**
   * @param {string} url
   * @param {string} budget one of EDGAR_BUDGETS
   * @param {{ maxBytes?: number }} [o]
   * @returns {Promise<EdgarResult>}
   */
  async function request(url, budget, o = {}) {
    /** @type {EdgarResult} */
    const fail = { ok: false, reason: null, status: null, text: '', truncated: false };
    if (blocked) return { ...fail, reason: 'blocked' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!hasBudget(budget)) return { ...fail, reason: 'capped' };
      const wait = lastAt + minGap - clock();
      if (wait > 0) await sleep(wait);
      used[budget] += 1;
      total += 1;
      lastAt = clock();
      let res;
      try {
        res = await guard.get(url, { accept: '*/*', maxBytes: o.maxBytes ?? SEARCH_READ_BYTES });
      } catch (err) {
        if (err instanceof FetchRefused) return { ...fail, reason: 'refused' };
        return { ...fail, reason: 'network_error' };
      }
      if (res.status === 429 || res.status === 403 || res.status === 503) {
        if (attempt === 0) {
          await sleep(Math.max(backoff, res.retryAfterMs ?? 0));
          continue;
        }
        blocked = true;
        warnings.push('sec_blocked');
        return { ...fail, reason: 'blocked', status: res.status };
      }
      if (res.status < 200 || res.status >= 300) return { ...fail, reason: 'http_error', status: res.status };
      return { ok: true, reason: null, status: res.status, text: res.text, truncated: res.truncated };
    }
    return { ...fail, reason: 'blocked' };
  }

  return {
    request,
    hasBudget,
    get blocked() { return blocked; },
    get used() { return { ...used, total }; },
    get warnings() { return [...warnings]; },
    budgets,
    /** @param {string} url @param {string} budget */
    search: (url, budget = 'discovery') => request(url, budget, { maxBytes: SEARCH_READ_BYTES }),
    /** @param {string} url @param {string} budget */
    document: (url, budget) => request(url, budget, { maxBytes: DOC_READ_BYTES }),
  };
}

/** @typedef {ReturnType<typeof createEdgarClient>} EdgarClient */

/**
 * Common skip decision for the three EDGAR adapters.
 * @param {string} [configDir]
 * @returns {{ ok: true, userAgent: string } | { ok: false, skipped: 'sec_contact_missing', detail: string }}
 */
export function secContactOrSkip(configDir) {
  const c = loadSecContact(configDir);
  if (c.ok) return c;
  return { ok: false, skipped: 'sec_contact_missing', detail: sanitizeText(`config/${SEC_CONTACT_FILE} ${c.reason}`, 80) };
}
