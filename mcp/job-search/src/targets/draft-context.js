// @ts-check
/**
 * What the gates need to judge one draft, and the eligibility rule for drafting (plan 19.2 and 19.5).
 *
 * loadDraftConfig   the blocklist, the curated facts and the style checks; a total classification: ok, or a
 *                   closed skip reason (blocklist_unavailable, facts_missing, facts_invalid, facts_placeholder).
 * buildGateContext  the per-draft context: the target's company and trigger kind, the sanitized excerpts of
 *                   the signals that were sent to the drafter AND are linked to this target, and the names the
 *                   cited signals carry as structured contacts.
 * isEligibleTarget  effective class target (blocked first, effective.js), not discarded, not approved.
 */
import { loadBlockedAffiliates } from '../core/target-exclusion.js';
import { mentionForbiddenFrom } from '../core/mention-forbidden.js';
import { getEnv } from '../core/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveClassOf } from './effective.js';
import { loadPitchFacts } from './pitch-facts.js';
import { sanitizeExcerpt } from './draft-prompt.js';

export const SKIP_REASONS = Object.freeze([
  'weekend', 'test_guard', 'no_time', 'facts_missing', 'facts_invalid', 'facts_placeholder', 'blocklist_unavailable', 'locked',
  'stage_failed', 'stage_timeout', 'connect_timeout',
]);

const PACKAGE_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config');

/**
 * The buzzword list and the problem-comparison patterns (config/style-checks.json, shared with render_doc).
 * Read from the config dir, falling back to the package's own config when the dir has no copy.
 * @param {string} configDir
 * @returns {{ buzzwords: string[], problemComparisonPatterns: string[] }}
 */
export function loadStyleChecks(configDir) {
  const file = fs.existsSync(path.join(configDir, 'style-checks.json')) ? path.join(configDir, 'style-checks.json') : path.join(PACKAGE_CONFIG, 'style-checks.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    buzzwords: Array.isArray(j.buzzwords) ? j.buzzwords.map(String) : [],
    problemComparisonPatterns: Array.isArray(j.problemComparisonPatterns) ? j.problemComparisonPatterns.map(String) : [],
  };
}

/**
 * @param {string} configDir
 * @param {{ style?: { buzzwords: string[], problemComparisonPatterns: string[] } }} [o]
 * @returns {{ ok: true, blockedEntries: string[], facts: import('./pitch-facts.js').PitchFacts, style: { buzzwords: string[], problemComparisonPatterns: string[] } } | { ok: false, reason: string }}
 */
export function loadDraftConfig(configDir = getEnv().JOBSEARCH_CONFIG_DIR, o = {}) {
  const blocked = loadBlockedAffiliates(configDir);
  if (blocked.status !== 'ok') return { ok: false, reason: 'blocklist_unavailable' };
  // "Never target" (blocked.entries) is not "never mention": a former employer may be named in a fact or a draft.
  const mention = mentionForbiddenFrom(blocked.entries);
  const facts = loadPitchFacts(configDir, mention);
  if (facts.status === 'missing') return { ok: false, reason: 'facts_missing' };
  if (facts.status === 'invalid') return { ok: false, reason: facts.problem === 'placeholder' ? 'facts_placeholder' : 'facts_invalid' };
  let style;
  try {
    style = o.style ?? loadStyleChecks(configDir);
  } catch {
    return { ok: false, reason: 'facts_invalid' };
  }
  return { ok: true, blockedEntries: mention, facts, style };
}

/**
 * @param {{ class: string, decision?: string|null, decision_class?: string|null, verdict_rule?: string|null, verdict_inputs?: any }} t
 * @returns {boolean}
 */
export function isEligibleTarget(t) {
  const d = t.decision ?? null;
  if (d !== null && d !== 'reclassified') return false;
  return effectiveClassOf(/** @type {any} */ (t)) === 'target';
}

/** @param {unknown} contact a ic_target_signals.contact value @returns {string[]} */
function contactNames(contact) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {unknown} */ v, /** @type {number} */ depth) => {
    if (depth > 3 || !v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
      if (typeof x === 'string' && /name/i.test(k) && x.trim() !== '' && x.length <= 80) out.push(x);
      else if (x && typeof x === 'object') walk(x, depth + 1);
    }
  };
  walk(contact, 0);
  return out;
}

export const TARGET_COLS = `t.id, t.company, t.class, t.verdict_rule, t.verdict_inputs, t.trigger_kind, t.trigger_date, t.contact_name, t.contact_role,
  t.decision, t.decision_class, t.decision_version`;

/**
 * @param {import('pg').ClientBase} client
 * @param {any} target a TARGET_COLS row
 * @param {number[]} evidenceIds the signal ids that were sent to the drafter
 * @param {Extract<ReturnType<typeof loadDraftConfig>, { ok: true }>} cfg
 * @returns {Promise<import('./draft-gates.js').GateContext>}
 */
export async function buildGateContext(client, target, evidenceIds, cfg) {
  const ids = [...new Set(evidenceIds.filter((n) => Number.isInteger(n) && n > 0))];
  const r = ids.length
    ? await client.query(`SELECT id, excerpt, contact FROM ic_target_signals WHERE target_id = $1 AND id = ANY($2::int[])`, [target.id, ids])
    : { rows: [] };
  /** @type {Record<string, string>} */
  const evidence = {};
  /** @type {string[]} */
  const personNames = [];
  for (const s of r.rows) {
    evidence[String(s.id)] = sanitizeExcerpt(s.excerpt);
    personNames.push(...contactNames(s.contact));
  }
  return {
    company: String(target.company ?? ''),
    triggerKind: target.trigger_kind ?? null,
    blockedEntries: cfg.blockedEntries,
    style: cfg.style,
    evidence,
    facts: cfg.facts.facts,
    denylist: cfg.facts.denylist,
    candidateNames: cfg.facts.candidateNames,
    personNames,
    contactName: typeof target.contact_name === 'string' ? target.contact_name : null,
  };
}
