// @ts-check
/**
 * Target finder source-text safety (plan: target-finder-2026-10-15, sections 14.2 and 15.2 items 1, 9, 12).
 *
 * Everything an adapter reads from the outside world is UNTRUSTED DATA. This module is the single place
 * that turns source text into the bounded, normalized strings the rest of the system stores or hands on:
 *
 *   sanitizeText      NFKC, control characters, Unicode Cf (zero-width, bidi, soft hyphen) removed,
 *                     whitespace collapsed, length-capped. Used for every excerpt, name, and text field.
 *   sanitizeName      the same, capped at NAME_MAX; an oversized name is reported, never truncated into a
 *                     plausible-looking shorter name (adapters turn it into unparseable: name_too_long).
 *   boundExtracted    bounds the `extracted` jsonb: depth, key count, array length, string length, total
 *                     serialized size. A value that cannot be bounded is dropped, never passed through.
 *   findBlockedHits   scans the FULL document (before any truncation) for blocked names on the normalized
 *                     and space-stripped forms and returns windows to place FIRST in `text`.
 *   buildSignalText   puts blocked-hit windows first, then the remaining parts, capped.
 *   DRAFTER_INPUT_FIELDS  the exact, closed list of fields a later drafting step may read.
 *
 * Source text is never used to build a regex, URL, path, shell argument, or SQL fragment. The one regex
 * built here is made from a blocked-name ENTRY (operator config), never from document text.
 */
import crypto from 'node:crypto';
import { normalizeName, strippedForm } from '../core/target-exclusion.js';

export const EXCERPT_MAX = 1000;
export const TEXT_MAX = 4000;
export const NAME_MAX = 200;
export const EXTRACTED_MAX_BYTES = 8192;
export const EXTRACTED_STRING_MAX = 500;
/** Hard cap on any single document before a regex touches it (plan 15.2 item 9). */
export const DOC_READ_MAX = 300 * 1024;
export const BLOCKED_WINDOW_MAX = 5;

/**
 * The exact field list a drafting step may read from a target and its signals. Closed: the drafter input
 * is built by picking exactly these keys, so a new extracted field never reaches a prompt by accident.
 * Raw excerpt text is included because the hook needs it; it is framed as untrusted by the drafter.
 */
export const DRAFTER_INPUT_FIELDS = Object.freeze([
  'company', 'trigger_kind', 'trigger_date', 'evidence_url', 'pe_firm', 'role', 'contact_role', 'contact_name', 'excerpt',
]);

/** @param {Record<string, unknown>} source @returns {Record<string, unknown>} only DRAFTER_INPUT_FIELDS, in order */
export function pickDrafterInput(source) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of DRAFTER_INPUT_FIELDS) out[k] = source && Object.prototype.hasOwnProperty.call(source, k) ? source[k] : null;
  return out;
}

const CONTROL_RE = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}]/gu;
// Cf already covers zero-width, soft hyphen, and the bidi controls (U+200E/F, U+202A-E, U+2066-9, U+061C);
// the explicit class is belt and braces for a runtime whose Unicode tables differ.
const FORMAT_RE = /[\p{Cf}\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\u00AD\u034F\uFEFF]/gu;

/**
 * @param {unknown} s
 * @param {number} max
 * @returns {string}
 */
export function sanitizeText(s, max) {
  if (s === null || s === undefined) return '';
  let t = typeof s === 'string' ? s : (typeof s === 'number' || typeof s === 'boolean' ? String(s) : '');
  // Bound the work before normalization: a pathological input never costs more than a few multiples of max.
  if (t.length > max * 4 + 1024) t = t.slice(0, max * 4 + 1024);
  t = t.normalize('NFKC').replace(FORMAT_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

/**
 * @param {unknown} s
 * @returns {{ value: string, too_long: boolean }}
 */
export function sanitizeName(s) {
  const raw = typeof s === 'string' ? s : (typeof s === 'number' ? String(s) : '');
  const full = normalizeName(raw.length > NAME_MAX * 8 ? raw.slice(0, NAME_MAX * 8) : raw).replace(FORMAT_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (raw.length > NAME_MAX * 8 || full.length > NAME_MAX) return { value: full.slice(0, NAME_MAX), too_long: true };
  return { value: full, too_long: false };
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function boundValue(value, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return sanitizeText(value, EXTRACTED_STRING_MAX);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => boundValue(v, depth + 1));
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(/** @type {object} */ (value)).slice(0, 40)) {
      const key = sanitizeText(k, 60);
      if (key) out[key] = boundValue(/** @type {Record<string, unknown>} */ (value)[k], depth + 1);
    }
    return out;
  }
  return null; // bigint, function, symbol
}

/**
 * Bound the `extracted` jsonb. Anything over EXTRACTED_MAX_BYTES is reduced to the identifying core plus a
 * `truncated` marker so the row still says what it was.
 * @param {Record<string, unknown>} extracted
 * @returns {Record<string, unknown>}
 */
export function boundExtracted(extracted) {
  const bounded = /** @type {Record<string, unknown>} */ (boundValue(extracted && typeof extracted === 'object' ? extracted : {}, 0));
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= EXTRACTED_MAX_BYTES) return bounded;
  const keep = ['parse_outcome', 'parse_reason', 'parser_version', 'source', 'trigger_kind', 'company', 'company_norm', 'accession', 'filing_date', 'event_date'];
  /** @type {Record<string, unknown>} */
  const core = { truncated: true };
  for (const k of keep) if (k in bounded) core[k] = bounded[k];
  return core;
}

/** @param {unknown} value stable JSON of the value, sha256 hex */
export function contentHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

/** @param {unknown} v @returns {string} */
export function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = /** @type {Record<string, unknown>} */ (v);
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

/** @param {string} s @returns {string} */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a whole document for scanning: NFKC, format characters removed. Length-capped at DOC_READ_MAX.
 * @param {unknown} doc
 * @returns {string}
 */
export function normalizeDocument(doc) {
  const raw = typeof doc === 'string' ? doc.slice(0, DOC_READ_MAX) : '';
  return raw.normalize('NFKC').replace(FORMAT_RE, '');
}

/**
 * Scan the FULL (already read-capped, not yet truncated) document for blocked names. Each entry is matched
 * on its space-stripped form (letters and digits with any non-alphanumeric run between characters allowed),
 * which subsumes the whole-phrase form. Over-matching is intended: a hit only ever raises friction.
 * @param {unknown} doc
 * @param {string[]} blockedEntries
 * @param {{ minLength?: number }} [opts]
 * @returns {{ hits: Array<{ entry: string, window: string }>, scanned_chars: number }}
 */
export function findBlockedHits(doc, blockedEntries, opts = {}) {
  const minLen = opts.minLength ?? 4;
  const text = normalizeDocument(doc);
  /** @type {Array<{ entry: string, window: string }>} */
  const hits = [];
  for (const entry of blockedEntries) {
    const stripped = strippedForm(normalizeName(entry));
    if (stripped.length < minLen) continue;
    const re = new RegExp(stripped.split('').map(escapeRe).join('[^a-z0-9]*'), 'i');
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 80);
    hits.push({ entry, window: sanitizeText(text.slice(start, m.index + m[0].length + 80), 260) });
    if (hits.length >= BLOCKED_WINDOW_MAX) break;
  }
  return { hits, scanned_chars: text.length };
}

/**
 * Build the classifier `text` field: blocked-hit windows FIRST (so a later truncation can never drop them),
 * then the remaining parts, capped at TEXT_MAX.
 * @param {Array<{ entry: string, window: string }>} blockedHits
 * @param {Array<unknown>} parts
 * @returns {string}
 */
export function buildSignalText(blockedHits, parts) {
  const head = blockedHits.map((h) => `[blocked-term ${sanitizeText(h.entry, 60)}] ${h.window}`);
  const rest = parts.map((p) => sanitizeText(p, TEXT_MAX)).filter(Boolean);
  return sanitizeText([...head, ...rest].join(' | '), TEXT_MAX);
}

/** @param {unknown} s @returns {string} */
export function makeExcerpt(s) {
  return sanitizeText(s, EXCERPT_MAX);
}
