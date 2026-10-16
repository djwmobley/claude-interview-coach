// @ts-check
/**
 * Human actions on a target's draft (plan 19.6): preflight, edit, approve, discard, regenerate.
 *
 * Nothing here sends anything. Approve only records that Damian copied the note: it marks the draft and the
 * target approved, writes an audit row, and creates ONE followup reminder ("Send note manually") through the
 * existing followups table. The followup row carries a contact label, the org (cut to 80 characters, control
 * characters stripped) and a fixed action; it never carries draft or evidence text.
 *
 * Every action runs in one transaction with the target and the draft locked FOR UPDATE. Eligibility is the
 * shared blocked-first effective class (src/targets/effective.js) and is re-checked inside the transaction.
 * After an edit the gates are advisory (plan 19.1): they produce visible warnings, they do not block copying.
 */
import { effectiveClassOf, isBlockedRow } from '../targets/effective.js';
import { etDay, addDays, isBusinessDay } from '../targets/dates.js';
import { DraftError } from '../targets/draft-errors.js';
import { FIELDS, runGates, deriveSentences } from '../targets/draft-gates.js';
import { buildGateContext, TARGET_COLS } from '../targets/draft-context.js';
import { addresseeOf, composeNote, noteHash, cleanLabel } from '../targets/draft-note.js';
import { claimManual } from '../targets/drafts.js';
import { tokens } from '../targets/draft-text.js';
import { createFollowup } from '../core/followups.js';

export const FOLLOWUP_BUSINESS_DAYS = 3;
export const FIELD_MAX = 600;
export const FOLLOWUP_ACTION = 'Send note manually';

const EDITABLE = new Set(['awaiting_approval', 'gate_failed', 'review_failed']);

/** @typedef {import('../targets/draft-context.js').loadDraftConfig} LoadCfg */
/** @typedef {ReturnType<LoadCfg>} DraftConfig */

/** @param {string} ymd @param {number} n @returns {string} the ET business day n days after ymd */
export function addBusinessDays(ymd, n) {
  let d = ymd;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) left -= 1;
  }
  return d;
}

/**
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
function idOf(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 2_147_483_647) throw new DraftError('INVALID_BODY', `${name} must be a positive integer`);
  return v;
}

/**
 * @param {unknown} body
 * @param {string[]} keys the allowed keys
 * @returns {Record<string, unknown>}
 */
function objectBody(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DraftError('INVALID_BODY', 'request body must be a JSON object');
  for (const k of Object.keys(body)) if (!keys.includes(k)) throw new DraftError('INVALID_BODY', `unknown field: ${k.slice(0, 40).replace(/[^\w.-]/g, '_')}`);
  return /** @type {Record<string, unknown>} */ (body);
}

/** @param {any} t a locked target row */
function assertEligible(t) {
  if (isBlockedRow(t)) throw new DraftError('BLOCKED_NOT_ELIGIBLE', 'a row with a blocked party cannot have an approved draft');
  if (t.decision === 'approved') throw new DraftError('DECISION_LOCKED', 'the target is already approved');
  if (t.decision === 'discarded') throw new DraftError('DISCARDED', 'the target is discarded');
  if (effectiveClassOf(t) !== 'target') throw new DraftError('WRONG_STATE', 'the target is no longer a target');
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} targetId
 * @param {number|null} draftId
 * @param {boolean} lock
 */
async function loadRows(client, targetId, draftId, lock) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const t = await client.query(`SELECT ${TARGET_COLS} FROM ic_targets t WHERE t.id = $1${suffix}`, [targetId]);
  if (t.rowCount === 0) throw new DraftError('NOT_FOUND', 'target not found');
  if (draftId === null) return { target: t.rows[0], draft: null };
  const d = await client.query(`SELECT * FROM ic_target_drafts WHERE id = $1 AND target_id = $2${suffix}`, [draftId, targetId]);
  if (d.rowCount === 0) throw new DraftError('NOT_FOUND', 'draft not found');
  return { target: t.rows[0], draft: d.rows[0] };
}

/** @param {any} d a draft row @returns {{ hook: string, bridge: string, claim: string, ask: string }} */
function fieldsOfRow(d) {
  return { hook: String(d.hook ?? ''), bridge: String(d.bridge ?? ''), claim: String(d.claim ?? ''), ask: String(d.ask ?? '') };
}

/**
 * Run the gates over a stored draft.
 * @param {import('pg').ClientBase} client
 * @param {any} target
 * @param {any} draft
 * @param {Extract<DraftConfig, { ok: true }>} cfg
 * @param {'machine'|'edited'} mode
 */
async function gatesFor(client, target, draft, cfg, mode) {
  const ctx = await buildGateContext(client, target, (draft.evidence_ids ?? []).map(Number), cfg);
  return runGates({ fields: fieldsOfRow(draft), sentences: draft.sentences ?? [], mode, ctx });
}

/**
 * Verify everything a copy needs and return the exact text. Used by GET preflight and, with locking, by approve.
 * @param {import('pg').ClientBase} client
 * @param {{ target: any, draft: any }} rows
 * @param {DraftConfig} cfg
 * @returns {Promise<{ text: string, text_hash: string, warnings: string[], advisory: boolean }>}
 */
async function verifyForCopy(client, rows, cfg) {
  const { target, draft } = rows;
  assertEligible(target);
  if (draft.state !== 'awaiting_approval') throw new DraftError('DRAFT_STATE', 'the draft is not awaiting approval');
  const fields = fieldsOfRow(draft);
  if (FIELDS.some((k) => /** @type {any} */ (fields)[k].trim() === '')) throw new DraftError('DRAFT_STATE', 'the draft is incomplete');
  const signoff = cfg.ok ? cfg.facts.signoff : '';
  const addressee = addresseeOf(target);
  const text = composeNote(fields, addressee, signoff);
  const hash = noteHash(fields, addressee, signoff);
  if (draft.edited) {
    /** @type {string[]} */
    let warnings = ['gates_unavailable'];
    if (cfg.ok) warnings = (await gatesFor(client, target, draft, cfg, 'edited')).codes;
    return { text, text_hash: hash, warnings, advisory: true };
  }
  if (!cfg.ok) throw new DraftError('GATES_UNAVAILABLE', 'the draft checks cannot run right now');
  const g = await gatesFor(client, target, draft, cfg, 'machine');
  if (!g.pass) throw new DraftError('GATES_FAILED', 'the draft no longer passes its checks', { codes: g.codes.join(',') });
  return { text, text_hash: hash, warnings: [], advisory: false };
}

/**
 * GET preflight: re-checks eligibility and the checks, returns the exact text and its hash. Nothing is written.
 * @param {import('pg').ClientBase} client
 * @param {number} targetId
 * @param {number} draftId
 * @param {DraftConfig} cfg
 */
export async function preflightDraft(client, targetId, draftId, cfg) {
  const rows = await loadRows(client, targetId, draftId, false);
  const v = await verifyForCopy(client, rows, cfg);
  return { ...v, decision_version: Number(rows.target.decision_version), draft_version: Number(rows.draft.draft_version), draft_id: draftId };
}

/**
 * @param {unknown} body
 * @returns {{ draftId: number, expectedDraftVersion: number, fields: { hook: string, bridge: string, claim: string, ask: string } }}
 */
export function parseEdit(body) {
  const b = objectBody(body, ['draft_id', 'expected_draft_version', 'fields']);
  const draftId = idOf(b.draft_id, 'draft_id');
  const ev = b.expected_draft_version;
  if (typeof ev !== 'number' || !Number.isInteger(ev) || ev < 0 || ev > 2_000_000_000) throw new DraftError('INVALID_BODY', 'expected_draft_version must be a non-negative integer');
  const f = objectBody(b.fields, [...FIELDS]);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const k of FIELDS) {
    const v = f[k];
    if (typeof v !== 'string') throw new DraftError('INVALID_BODY', `${k} must be a string`);
    if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v)) throw new DraftError('INVALID_BODY', `${k} must be a single line`);
    if (v.trim() === '' || v.length > FIELD_MAX) throw new DraftError('INVALID_BODY', `${k} must be 1 to ${FIELD_MAX} characters`);
    fields[k] = v.trim();
  }
  return { draftId, expectedDraftVersion: ev, fields: /** @type {any} */ (fields) };
}

/**
 * Save Damian's edit: append the before/after record, replace the text, re-derive the sentence tags, run the
 * gates as advisory, and put the draft back to awaiting_approval (a parked draft may be edited and then copied).
 * @param {import('pg').ClientBase} client
 * @param {number} targetId
 * @param {unknown} body
 * @param {DraftConfig} cfg
 * @returns {Promise<{ draft_version: number, noop: boolean, warnings: string[] }>}
 */
export async function editDraft(client, targetId, body, cfg) {
  const p = parseEdit(body);
  await client.query('BEGIN');
  try {
    const { target, draft } = await loadRows(client, targetId, p.draftId, true);
    assertEligible(target);
    if (!EDITABLE.has(draft.state)) throw new DraftError('DRAFT_STATE', 'the draft cannot be edited in its current state');
    if (Number(draft.draft_version) !== p.expectedDraftVersion) throw new DraftError('DRAFT_VERSION_CONFLICT', 'the draft changed; reload it', { current_version: Number(draft.draft_version) });
    const before = fieldsOfRow(draft);
    if (FIELDS.every((k) => before[k] === p.fields[k])) {
      await client.query('COMMIT');
      return { draft_version: Number(draft.draft_version), noop: true, warnings: [] };
    }
    const sentences = deriveSentences(p.fields, { fields: before, sentences: Array.isArray(draft.sentences) ? draft.sentences : [] });
    const next = Number(draft.draft_version) + 1;
    /** @type {{ pass: boolean, advisory: boolean, mode: string, results: unknown[], codes: string[] }} */
    let gates = { pass: false, advisory: true, mode: 'edited', results: [], codes: ['gates_unavailable'] };
    const asRow = { ...draft, ...p.fields, sentences, edited: true };
    if (cfg.ok) gates = await gatesFor(client, target, asRow, cfg, 'edited');
    const signoff = cfg.ok ? cfg.facts.signoff : '';
    const hash = noteHash(p.fields, addresseeOf(target), signoff);
    await client.query(
      `INSERT INTO ic_target_draft_edits (draft_id, actor, before, after) VALUES ($1, 'damian', $2::jsonb, $3::jsonb)`,
      [
        draft.id,
        JSON.stringify({ fields: before, sentences: draft.sentences ?? null, state: draft.state, review_verdict: draft.review_verdict, gates: draft.gates ?? null }),
        JSON.stringify({ fields: p.fields, sentences, gates: { pass: gates.pass, codes: gates.codes } }),
      ],
    );
    await client.query(
      `UPDATE ic_target_drafts SET hook = $2, bridge = $3, claim = $4, ask = $5, word_count = $6, sentences = $7::jsonb, gates = $8::jsonb,
         edited = true, state = 'awaiting_approval', draft_version = $9, text_hash = $10, updated_at = now() WHERE id = $1`,
      [
        draft.id, p.fields.hook, p.fields.bridge, p.fields.claim, p.fields.ask, tokens(FIELDS.map((k) => p.fields[k]).join(' ')).length,
        JSON.stringify(sentences),
        JSON.stringify({ mode: 'edited', pass: gates.pass, advisory: true, results: gates.results }), next, hash,
      ],
    );
    await client.query('COMMIT');
    return { draft_version: next, noop: false, warnings: gates.codes };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * @param {unknown} body
 * @returns {{ draftId: number, textHash: string, expectedDecisionVersion: number, expectedDraftVersion: number }}
 */
export function parseApprove(body) {
  const b = objectBody(body, ['draft_id', 'text_hash', 'expected_decision_version', 'expected_draft_version']);
  const draftId = idOf(b.draft_id, 'draft_id');
  if (typeof b.text_hash !== 'string' || !/^[0-9a-f]{64}$/.test(b.text_hash)) throw new DraftError('INVALID_BODY', 'text_hash must be a sha256 hex string');
  const num = (/** @type {unknown} */ v, /** @type {string} */ n) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2_000_000_000) throw new DraftError('INVALID_BODY', `${n} must be a non-negative integer`);
    return v;
  };
  return { draftId, textHash: b.text_hash, expectedDecisionVersion: num(b.expected_decision_version, 'expected_decision_version'), expectedDraftVersion: num(b.expected_draft_version, 'expected_draft_version') };
}

/**
 * Approve: one transaction. The draft becomes approved, the target becomes approved with an audit row, and one
 * followup reminder is created. No calendar call, nothing sent.
 * @param {import('pg').ClientBase} client
 * @param {number} targetId
 * @param {unknown} body
 * @param {DraftConfig} cfg
 * @param {Date} now
 * @returns {Promise<{ draft_id: number, followup_id: number, decision_version: number, due: string }>}
 */
export async function approveDraft(client, targetId, body, cfg, now) {
  const p = parseApprove(body);
  await client.query('BEGIN');
  try {
    const rows = await loadRows(client, targetId, p.draftId, true);
    const { target, draft } = rows;
    if (Number(target.decision_version) !== p.expectedDecisionVersion) throw new DraftError('VERSION_CONFLICT', 'the target changed; reload it', { current_version: Number(target.decision_version) });
    if (Number(draft.draft_version) !== p.expectedDraftVersion) throw new DraftError('DRAFT_VERSION_CONFLICT', 'the draft changed; reload it', { current_version: Number(draft.draft_version) });
    const v = await verifyForCopy(client, rows, cfg);
    if (v.text_hash !== p.textHash) throw new DraftError('TEXT_CHANGED', 'the text changed since it was copied; reload it');
    const next = Number(target.decision_version) + 1;
    await client.query(`UPDATE ic_target_drafts SET state = 'approved', approved_at = now(), updated_at = now() WHERE id = $1`, [draft.id]);
    await client.query(
      `UPDATE ic_targets SET decision = 'approved', decision_reason = 'draft_approved', decided_by = 'damian', decided_at = now(), decision_version = $2, new_evidence_at = NULL WHERE id = $1`,
      [targetId, next],
    );
    await client.query(
      `INSERT INTO ic_target_decisions (target_id, actor, from_class, to_class, action, reason_code, note, decision_version)
       VALUES ($1, 'damian', 'target', 'target', 'approve', 'draft_approved', NULL, $2)`,
      [targetId, next],
    );
    const due = addBusinessDays(etDay(now), FOLLOWUP_BUSINESS_DAYS);
    const f = await createFollowup(client, {
      contact: cleanLabel(addresseeOf(target) ?? 'target contact', 80) || 'target contact',
      org: cleanLabel(target.company, 80) || null,
      due_at: due,
      channel: 'other',
      action: FOLLOWUP_ACTION,
      notify: ['email'],
      created_from: `target_draft:${draft.id}`,
    }, { now });
    await client.query('COMMIT');
    return { draft_id: Number(draft.id), followup_id: Number(f.row.id), decision_version: next, due };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Discard a draft (not the target). Approved drafts are locked.
 * @param {import('pg').ClientBase} client
 * @param {number} targetId
 * @param {unknown} body
 * @returns {Promise<{ draft_version: number }>}
 */
export async function discardDraft(client, targetId, body) {
  const b = objectBody(body, ['draft_id', 'expected_draft_version']);
  const draftId = idOf(b.draft_id, 'draft_id');
  const ev = b.expected_draft_version;
  if (typeof ev !== 'number' || !Number.isInteger(ev) || ev < 0 || ev > 2_000_000_000) throw new DraftError('INVALID_BODY', 'expected_draft_version must be a non-negative integer');
  await client.query('BEGIN');
  try {
    const { draft } = await loadRows(client, targetId, draftId, true);
    if (draft.state === 'approved') throw new DraftError('DECISION_LOCKED', 'an approved draft cannot be discarded');
    if (draft.state === 'discarded') throw new DraftError('DRAFT_STATE', 'the draft is already discarded');
    if (Number(draft.draft_version) !== ev) throw new DraftError('DRAFT_VERSION_CONFLICT', 'the draft changed; reload it', { current_version: Number(draft.draft_version) });
    const next = Number(draft.draft_version) + 1;
    await client.query(`UPDATE ic_target_drafts SET state = 'discarded', draft_version = $2, updated_at = now() WHERE id = $1`, [draft.id, next]);
    await client.query('COMMIT');
    return { draft_version: next };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Queue a manual regeneration (counts against the daily cap; the next scan stage generates it).
 * @param {import('pg').ClientBase} client
 * @param {number} targetId
 * @param {Date} now
 * @returns {Promise<{ draft_id: number }>}
 */
export async function regenerateDraft(client, targetId, now) {
  const r = await claimManual(client, { targetId, now });
  return { draft_id: r.id };
}
