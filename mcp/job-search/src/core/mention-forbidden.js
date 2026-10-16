// @ts-check
/**
 * Two lists, one module: "never target" and "never mention".
 *
 *   TARGET_EXCLUDE      every built-in plus config/blocked-affiliates.json. Unchanged: every target, exclusion and
 *                       effective-class path keeps using it (it is what loadBlockedAffiliates() returns).
 *   MENTION_FORBIDDEN   what a pitch fact or an outreach draft may never name: the current employer plus the
 *                       blocked affiliates. A former employer is excluded from targets but may be mentioned (the
 *                       resume names it).
 *
 * Total classification, not an allow-list: every built-in carries an explicit role in BUILT_IN_ROLES. Only the role
 * former_employer lifts the mention ban. A role that is anything else, or missing, is mention-forbidden, and so is
 * every configured affiliate. Unknown input defaults to forbidden (friction, never a silent pass).
 *
 * Matching (NFKC, confusables, squash) is done by the callers (pitch-facts.js, draft-gates.js) on the strings
 * this module returns; the strings themselves are untouched.
 */
import { BUILT_IN_ROLES, BUILT_IN_BLOCKED } from '../apply/exclusions.js';

export const ROLE_CURRENT_EMPLOYER = 'current_employer';
export const ROLE_FORMER_EMPLOYER = 'former_employer';

/** The only role that may be mentioned. */
const MENTIONABLE_ROLES = Object.freeze([ROLE_FORMER_EMPLOYER]);

/**
 * @param {unknown} role
 * @returns {boolean} true when an entry with this role must never be mentioned
 */
export function roleIsMentionForbidden(role) {
  return !(typeof role === 'string' && MENTIONABLE_ROLES.includes(role));
}

/**
 * The names of the built-ins that may not be mentioned (role is not former_employer).
 * @param {Record<string, unknown>} [roles]
 * @returns {string[]}
 */
export function builtInMentionForbidden(roles = BUILT_IN_ROLES) {
  return BUILT_IN_BLOCKED.filter((n) => roleIsMentionForbidden(Object.prototype.hasOwnProperty.call(roles, n) ? roles[n] : undefined));
}

/**
 * Derive MENTION_FORBIDDEN from a TARGET_EXCLUDE list (built-ins first, then affiliates, as
 * loadBlockedAffiliates() returns it). Only the leading built-in block is role-classified, so an affiliate entry that
 * happens to repeat a former employer's name stays forbidden. When the list does not start with the built-ins in
 * order, nothing is lifted: every entry is forbidden.
 * @param {string[]} entries
 * @param {Record<string, unknown>} [roles] test seam
 * @returns {string[]}
 */
export function mentionForbiddenFrom(entries, roles = BUILT_IN_ROLES) {
  if (!Array.isArray(entries)) return [];
  const n = BUILT_IN_BLOCKED.length;
  const leading = entries.slice(0, n);
  const hasBuiltIns = leading.length === n && leading.every((e, k) => e === BUILT_IN_BLOCKED[k]);
  if (!hasBuiltIns) return [...entries];
  const forbiddenBuiltIns = new Set(builtInMentionForbidden(roles));
  return [...leading.filter((e) => forbiddenBuiltIns.has(e)), ...entries.slice(n)];
}
