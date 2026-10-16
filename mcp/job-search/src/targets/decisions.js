// @ts-check
/**
 * Human decisions on targets (plan 18.5): reclassify, discard, restore. One module so the HTTP route, the
 * tests and any later caller share one total state table and one transaction.
 *
 * Nothing here sends anything anywhere; it reads and writes ic_targets and ic_target_decisions only.
 *
 * State of a row = (effective class, status). The effective class is the shared definition in effective.js
 * (blocked first, then the manual decision class, then the machine class). Status comes from `decision`:
 * NULL open, reclassified, discarded, approved (reserved for PR5; every action on it is refused).
 *
 * planAction() is a pure, total function of (state, request): every pair has a defined outcome and every pair
 * not explicitly allowed is a refusal (409). applyDecision() runs it inside one transaction with the row locked
 * FOR UPDATE and an optimistic-concurrency check on the dedicated decision_version column.
 */
import { effectiveClassOf, isBlockedRow, CLASSES } from './effective.js';

/** Closed reason lists (plan 18.5). */
export const REASONS = Object.freeze({
  to_target: Object.freeze(['size_confirmed', 'trigger_confirmed', 'other_verified']),
  to_not_target: Object.freeze(['not_a_fit', 'already_known', 'blocked_relationship', 'stale']),
  discard: Object.freeze(['not_a_fit', 'already_known', 'blocked_relationship', 'stale']),
});

export const ACTIONS = Object.freeze(['reclassify', 'discard', 'restore']);
export const NOTE_MAX = 500;

/** Closed refusal codes and the HTTP status each maps to. */
export const REFUSALS = Object.freeze({
  INVALID_BODY: 400,
  INVALID_REASON: 400,
  INVALID_ID: 400,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  WRONG_STATE: 409,
  BLOCKED_NOT_ELIGIBLE: 409,
  DISCARDED: 409,
  NOT_DISCARDED: 409,
  DECISION_LOCKED: 409,
  AUDIT_MISSING: 409,
});

export class DecisionError extends Error {
  /**
   * @param {keyof typeof REFUSALS} code
   * @param {string} message
   * @param {Record<string, string|number|boolean|null>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DecisionError';
    this.code = code;
    this.status = REFUSALS[code];
    this.details = details;
  }
}

/**
 * @typedef {{ eff: string, blocked: boolean, status: 'open'|'reclassified'|'discarded'|'approved' }} TargetState
 * @typedef {{ action: 'reclassify', to: 'target'|'not-target' } | { action: 'discard' } | { action: 'restore' }} ActionReq
 * @typedef {{ outcome: 'ok' } | { outcome: 'noop' } | { outcome: 'refuse', code: keyof typeof REFUSALS, audit?: boolean }} Plan
 */

/**
 * @param {{ class: string, decision?: string|null, decision_class?: string|null, verdict_rule?: string|null, verdict_inputs?: any }} row
 * @returns {TargetState}
 */
export function stateOf(row) {
  const d = row.decision ?? null;
  /** @type {TargetState['status']} */
  const status = d === 'reclassified' || d === 'discarded' || d === 'approved' ? d : 'open';
  return { eff: effectiveClassOf(/** @type {any} */ (row)), blocked: isBlockedRow(/** @type {any} */ (row)), status };
}

/**
 * The total state table. A request whose action is not one of the three is refused (never allowed by default).
 * @param {TargetState} s
 * @param {ActionReq} req
 * @returns {Plan}
 */
export function planAction(s, req) {
  if (s.status === 'approved') return { outcome: 'refuse', code: 'DECISION_LOCKED' };
  if (s.status === 'discarded') {
    return req.action === 'restore' ? { outcome: 'ok' } : { outcome: 'refuse', code: 'DISCARDED' };
  }
  if (req.action === 'restore') return { outcome: 'refuse', code: 'NOT_DISCARDED' };
  if (req.action === 'discard') return { outcome: 'ok' };
  if (req.action !== 'reclassify') return { outcome: 'refuse', code: 'WRONG_STATE' };
  if (req.to !== 'target' && req.to !== 'not-target') return { outcome: 'refuse', code: 'WRONG_STATE' };
  if (s.eff === 'target') return req.to === 'target' ? { outcome: 'noop' } : { outcome: 'refuse', code: 'WRONG_STATE' };
  if (s.eff === 'needs-review') return { outcome: 'ok' };
  if (s.eff === 'not-target') {
    if (req.to === 'not-target') return { outcome: 'noop' };
    return s.blocked ? { outcome: 'refuse', code: 'BLOCKED_NOT_ELIGIBLE', audit: true } : { outcome: 'ok' };
  }
  return { outcome: 'refuse', code: 'WRONG_STATE' };
}

/**
 * Which actions the UI may offer for a state (derived from planAction, so the two can never disagree).
 * @param {TargetState} s
 * @returns {{ reclassify: Array<'target'|'not-target'>, discard: boolean, restore: boolean }}
 */
export function allowedActions(s) {
  /** @type {Array<'target'|'not-target'>} */
  const reclassify = [];
  for (const to of /** @type {const} */ (['target', 'not-target'])) {
    const p = planAction(s, { action: 'reclassify', to });
    if (p.outcome === 'ok') reclassify.push(to);
  }
  return {
    reclassify,
    discard: planAction(s, { action: 'discard' }).outcome === 'ok',
    restore: planAction(s, { action: 'restore' }).outcome === 'ok',
  };
}

/**
 * Validate a request body against the closed lists. Total: unknown keys, wrong types and out-of-list values are
 * each a distinct 400.
 * @param {'reclassify'|'discard'|'restore'} action
 * @param {unknown} body
 * @returns {{ req: ActionReq, reason: string|null, note: string|null, expected: number }}
 */
export function parseRequest(action, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DecisionError('INVALID_BODY', 'request body must be a JSON object');
  const b = /** @type {Record<string, unknown>} */ (body);
  const allowedKeys = action === 'reclassify'
    ? ['to', 'reason_code', 'note', 'expected_decision_version']
    : action === 'discard' ? ['reason_code', 'note', 'expected_decision_version'] : ['expected_decision_version'];
  for (const k of Object.keys(b)) {
    if (!allowedKeys.includes(k)) throw new DecisionError('INVALID_BODY', `unknown field: ${k.slice(0, 40).replace(/[^\w.-]/g, '_')}`);
  }
  const ev = b.expected_decision_version;
  if (typeof ev !== 'number' || !Number.isInteger(ev) || ev < 0 || ev > 2_000_000_000) throw new DecisionError('INVALID_BODY', 'expected_decision_version must be a non-negative integer');
  /** @type {string|null} */
  let note = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') throw new DecisionError('INVALID_BODY', 'note must be a string');
    if (b.note.length > NOTE_MAX) throw new DecisionError('INVALID_BODY', `note is limited to ${NOTE_MAX} characters`);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(b.note)) throw new DecisionError('INVALID_BODY', 'note contains control characters');
    note = b.note.trim() === '' ? null : b.note.trim();
  }
  if (action === 'restore') return { req: { action: 'restore' }, reason: null, note, expected: ev };
  const rc = b.reason_code;
  if (typeof rc !== 'string') throw new DecisionError('INVALID_REASON', 'reason_code is required');
  if (action === 'discard') {
    if (!REASONS.discard.includes(rc)) throw new DecisionError('INVALID_REASON', 'reason_code is not in the closed list');
    return { req: { action: 'discard' }, reason: rc, note, expected: ev };
  }
  const to = b.to;
  if (to !== 'target' && to !== 'not-target') throw new DecisionError('INVALID_BODY', "to must be 'target' or 'not-target'");
  const list = to === 'target' ? REASONS.to_target : REASONS.to_not_target;
  if (!list.includes(rc)) throw new DecisionError('INVALID_REASON', 'reason_code is not in the closed list');
  return { req: { action: 'reclassify', to }, reason: rc, note, expected: ev };
}

const ROW_SQL = `SELECT id, class, verdict_rule, verdict_inputs, decision, decision_class, decision_version
                 FROM ic_targets WHERE id = $1 FOR UPDATE`;

/**
 * Apply one action in one transaction. Returns a result for success and no-op; a refusal throws DecisionError
 * AFTER the transaction has committed (a blocked_refused audit row must survive its own refusal).
 * @param {import('pg').ClientBase} client a dedicated connection (BEGIN/COMMIT are issued here)
 * @param {number} id
 * @param {'reclassify'|'discard'|'restore'} action
 * @param {unknown} body
 * @returns {Promise<{ noop: boolean, id: number, decision_version: number }>}
 */
export async function applyDecision(client, id, action, body) {
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) throw new DecisionError('INVALID_ID', 'id must be a positive integer');
  const parsed = parseRequest(action, body);
  await client.query('BEGIN');
  /** @type {{ noop: boolean, id: number, decision_version: number }|DecisionError} */
  let result;
  try {
    result = await applyLocked(client, id, parsed);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  if (result instanceof DecisionError) throw result;
  return result;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {ReturnType<typeof parseRequest>} p
 * @returns {Promise<{ noop: boolean, id: number, decision_version: number }|DecisionError>}
 */
async function applyLocked(client, id, p) {
  const found = await client.query(ROW_SQL, [id]);
  if (found.rowCount === 0) return new DecisionError('NOT_FOUND', 'target not found');
  const row = found.rows[0];
  const current = Number(row.decision_version);
  if (current !== p.expected) return new DecisionError('VERSION_CONFLICT', 'the target changed; reload it', { current_version: current });
  const s = stateOf(row);
  const plan = planAction(s, p.req);
  if (plan.outcome === 'noop') return { noop: true, id, decision_version: current };

  const next = current + 1;
  /**
   * @param {string} action
   * @param {string|null} fromClass
   * @param {string|null} toClass
   * @param {string|null} reason
   */
  const audit = (action, fromClass, toClass, reason) => client.query(
    `INSERT INTO ic_target_decisions (target_id, actor, from_class, to_class, action, reason_code, note, decision_version)
     VALUES ($1, 'damian', $2, $3, $4, $5, $6, $7)`,
    [id, fromClass, toClass, action, reason, p.note, next],
  );

  if (plan.outcome === 'refuse') {
    if (!plan.audit) return new DecisionError(plan.code, 'that action is not allowed in the current state');
    // A refused promotion of a blocked row is recorded (and bumps the version) so the attempt is visible.
    await audit('blocked_refused', s.eff, p.req.action === 'reclassify' ? p.req.to : null, p.reason);
    await client.query('UPDATE ic_targets SET decision_version = $2 WHERE id = $1', [id, next]);
    return new DecisionError('BLOCKED_NOT_ELIGIBLE', 'a row with a blocked party cannot be promoted', { current_version: next });
  }

  if (p.req.action === 'reclassify') {
    await client.query(
      `UPDATE ic_targets SET decision = 'reclassified', decision_class = $2, decision_reason = $3, decided_by = 'damian', decided_at = now(),
         decision_version = $4, new_evidence_at = NULL WHERE id = $1`,
      [id, p.req.to, p.reason, next],
    );
    await audit('reclassify', s.eff, p.req.to, p.reason);
    return { noop: false, id, decision_version: next };
  }

  if (p.req.action === 'discard') {
    await client.query(
      `UPDATE ic_targets SET decision = 'discarded', decision_reason = $2, decided_by = 'damian', decided_at = now(),
         decision_version = $3, new_evidence_at = NULL WHERE id = $1`,
      [id, p.reason, next],
    );
    await audit('discard', s.eff, null, p.reason);
    return { noop: false, id, decision_version: next };
  }

  // restore: the prior class comes from the latest discard audit row, never from guesswork.
  const prior = await client.query(
    `SELECT from_class FROM ic_target_decisions WHERE target_id = $1 AND action = 'discard' ORDER BY decision_version DESC LIMIT 1`,
    [id],
  );
  const from = prior.rows[0]?.from_class;
  if (!CLASSES.includes(from)) return new DecisionError('AUDIT_MISSING', 'no discard audit row for this target');
  if (s.blocked && from !== 'not-target') {
    await audit('blocked_refused', null, from, null);
    await client.query('UPDATE ic_targets SET decision_version = $2 WHERE id = $1', [id, next]);
    return new DecisionError('BLOCKED_NOT_ELIGIBLE', 'a row with a blocked party cannot be restored to an active class', { current_version: next });
  }
  const clearsDecision = row.decision_class === null && from === row.class;
  if (clearsDecision) {
    await client.query(
      `UPDATE ic_targets SET decision = NULL, decision_class = NULL, decision_reason = NULL, decided_by = NULL, decided_at = NULL,
         decision_version = $2, new_evidence_at = NULL WHERE id = $1`,
      [id, next],
    );
  } else {
    await client.query(
      `UPDATE ic_targets SET decision = 'reclassified', decision_class = $2, decision_reason = NULL, decided_by = 'damian', decided_at = now(),
         decision_version = $3, new_evidence_at = NULL WHERE id = $1`,
      [id, from, next],
    );
  }
  await audit('restore', null, from, null);
  return { noop: false, id, decision_version: next };
}
