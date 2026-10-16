// @ts-check
/**
 * The single definition of a target's effective state (plan 18.2, A1). Every read, count, tile, tool query and
 * the runner's weekly count builds its SQL from these fragments; no other copy of the rule may exist.
 *
 *   blocked          the MACHINE verdict says a blocked party is involved: the rule is excl_blocked* or
 *                    dedup_blocked_sibling, or verdict_inputs.blocked_hint is true. Blocked wins over any manual
 *                    decision, so a blocklist change after a manual target flips the row to not-target at the
 *                    next run.
 *   effective class  not-target when blocked, otherwise coalesce(decision_class, class).
 *
 * Discarded is a status (decision = 'discarded'), not a class: decision_class is kept so a restore has it.
 * Fragments take a table alias and return SQL text with no parameters.
 */

export const CLASSES = Object.freeze(['target', 'needs-review', 'not-target']);

/**
 * @param {string} [alias] table alias of ic_targets
 * @returns {string}
 */
export function blockedSql(alias = 't') {
  const a = alias;
  return `(left(${a}.verdict_rule, 12) = 'excl_blocked' OR ${a}.verdict_rule = 'dedup_blocked_sibling' OR coalesce(${a}.verdict_inputs->>'blocked_hint', '') = 'true')`;
}

/**
 * @param {string} [alias]
 * @returns {string}
 */
export function effectiveClassSql(alias = 't') {
  return `(CASE WHEN ${blockedSql(alias)} THEN 'not-target' ELSE coalesce(${alias}.decision_class, ${alias}.class) END)`;
}

/**
 * The same rule in JavaScript, for rows already loaded (the state machine re-derives it from the locked row so
 * the SQL and JS can never disagree: a test compares both over every combination).
 * @param {{ verdict_rule?: string|null, verdict_inputs?: any, decision_class?: string|null, class: string }} r
 * @returns {boolean}
 */
export function isBlockedRow(r) {
  const rule = String(r.verdict_rule ?? '');
  const hint = r.verdict_inputs && typeof r.verdict_inputs === 'object' ? r.verdict_inputs.blocked_hint : undefined;
  return rule.slice(0, 12) === 'excl_blocked' || rule === 'dedup_blocked_sibling' || String(hint ?? '') === 'true';
}

/**
 * @param {{ verdict_rule?: string|null, verdict_inputs?: any, decision_class?: string|null, class: string }} r
 * @returns {string}
 */
export function effectiveClassOf(r) {
  return isBlockedRow(r) ? 'not-target' : (r.decision_class ?? r.class);
}
