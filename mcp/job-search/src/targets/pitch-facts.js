// @ts-check
/**
 * The curated candidate facts file (plan 19.1). Drafts state candidate facts only from here.
 *
 * config/target-pitch-facts.json is gitignored (personal data); config/target-pitch-facts.example.json is the
 * committed placeholder. Shape:
 *
 *   { "facts": [{ "id": "c1", "text": "one plain sentence", "tags": ["optional"] }],
 *     "signoff": "Best,\nYour Name",       // supplied by code on copy, never counted in the 90 words
 *     "candidate_names": ["Your Name"],    // names that must never appear in a draft body
 *     "denylist": ["confidential term"] }  // phrases that must never appear in a draft body
 *
 * The loader is a total classification: ok, missing, invalid (a closed problem code, never the file's content).
 * The file must hold NO current-employer detail: a fact tagged employer, a fact that talks about the current
 * employer, or a fact that names a blocked party (BUILT_IN_BLOCKED plus blocked_affiliates) makes the whole file
 * invalid, and the draft stage then skips (facts_invalid). A copy of the example (marked placeholder) is also
 * invalid (facts_placeholder).
 */
import fs from 'node:fs';
import path from 'node:path';
import { foldText, squash, squashLeet, hasPhrase } from './draft-text.js';
import { EMPLOYER_PATTERNS } from './draft-gates.js';

export const FACTS_FILE = 'target-pitch-facts.json';
export const MAX_FACTS = 12;
export const FACT_MAX_CHARS = 300;
export const PROBLEM_CODES = Object.freeze([
  'not_object', 'facts_shape', 'fact_shape', 'fact_id', 'fact_text', 'fact_tags', 'employer_fact', 'blocked_fact',
  'signoff_shape', 'names_shape', 'denylist_shape', 'placeholder', 'unreadable',
]);

/**
 * @typedef {Object} PitchFacts
 * @property {'ok'|'missing'|'invalid'} status
 * @property {string|null} problem closed code when invalid
 * @property {Array<{ id: string, text: string, tags: string[] }>} facts
 * @property {string} signoff
 * @property {string[]} candidateNames
 * @property {string[]} denylist
 */

/** @returns {PitchFacts} */
function empty(/** @type {'missing'|'invalid'} */ status, /** @type {string|null} */ problem) {
  return { status, problem, facts: [], signoff: '', candidateNames: [], denylist: [] };
}

/** @param {unknown} v @returns {boolean} a single visible line */
function plainLine(v) {
  return typeof v === 'string' && v.trim() !== '' && !/[\p{C}]/u.test(v);
}

/**
 * @param {unknown} raw parsed JSON
 * @param {string[]} blockedEntries
 * @returns {PitchFacts}
 */
export function validatePitchFacts(raw, blockedEntries) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty('invalid', 'not_object');
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (o._placeholder === true) return empty('invalid', 'placeholder');
  if (!Array.isArray(o.facts) || o.facts.length < 1 || o.facts.length > MAX_FACTS) return empty('invalid', 'facts_shape');
  /** @type {PitchFacts['facts']} */
  const facts = [];
  const seen = new Set();
  for (const f of o.facts) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return empty('invalid', 'fact_shape');
    const x = /** @type {Record<string, unknown>} */ (f);
    if (typeof x.id !== 'string' || !/^c\d{1,2}$/.test(x.id) || seen.has(x.id)) return empty('invalid', 'fact_id');
    seen.add(x.id);
    if (!plainLine(x.text) || /** @type {string} */ (x.text).length > FACT_MAX_CHARS) return empty('invalid', 'fact_text');
    const tags = x.tags === undefined ? [] : x.tags;
    if (!Array.isArray(tags) || tags.length > 8 || tags.some((t) => typeof t !== 'string' || t.length > 40)) return empty('invalid', 'fact_tags');
    const text = /** @type {string} */ (x.text);
    if (tags.some((t) => /employer/i.test(t)) || EMPLOYER_PATTERNS.some((re) => re.test(foldText(text)))) return empty('invalid', 'employer_fact');
    for (const e of blockedEntries) {
      if (typeof e !== 'string' || squash(e).length < 3) continue;
      if (hasPhrase(text, e) || (squash(e).length >= 4 && squash(text).includes(squash(e))) || (squashLeet(e).length >= 4 && squashLeet(text).includes(squashLeet(e)))) return empty('invalid', 'blocked_fact');
    }
    facts.push({ id: x.id, text, tags: /** @type {string[]} */ (tags) });
  }
  const signoff = o.signoff === undefined ? '' : o.signoff;
  if (typeof signoff !== 'string' || signoff.length > 120 || signoff.split(/\r?\n/).length > 3 || /:\/\/|@|www/i.test(signoff)) return empty('invalid', 'signoff_shape');
  for (const line of String(signoff).split(/\r?\n/)) if (line !== '' && !plainLine(line)) return empty('invalid', 'signoff_shape');
  for (const e of blockedEntries) if (typeof e === 'string' && squash(e).length >= 3 && squash(signoff).includes(squash(e))) return empty('invalid', 'blocked_fact');
  const names = o.candidate_names === undefined ? [] : o.candidate_names;
  if (!Array.isArray(names) || names.length > 5 || names.some((n) => !plainLine(n) || /** @type {string} */ (n).length > 60)) return empty('invalid', 'names_shape');
  const deny = o.denylist === undefined ? [] : o.denylist;
  if (!Array.isArray(deny) || deny.length > 50 || deny.some((n) => !plainLine(n) || /** @type {string} */ (n).length > 80)) return empty('invalid', 'denylist_shape');
  return { status: 'ok', problem: null, facts, signoff, candidateNames: /** @type {string[]} */ (names), denylist: /** @type {string[]} */ (deny) };
}

/**
 * Load the facts file. Never throws.
 * @param {string} configDir
 * @param {string[]} blockedEntries
 * @returns {PitchFacts}
 */
export function loadPitchFacts(configDir, blockedEntries) {
  const file = path.join(configDir, FACTS_FILE);
  /** @type {string} */
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? /** @type {any} */ (err).code : '';
    return code === 'ENOENT' ? empty('missing', null) : empty('invalid', 'unreadable');
  }
  try {
    return validatePitchFacts(JSON.parse(text), blockedEntries);
  } catch {
    return empty('invalid', 'not_object');
  }
}
