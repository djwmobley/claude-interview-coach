// @ts-check
/**
 * The draft section of the Targets detail view (plan 19.6). Read only. Every string passes the blocked-affiliate
 * leak guard. A blocked target never reaches this module (the caller returns null for it).
 */
import { FIELDS } from '../targets/draft-gates.js';
import { addresseeOf, composeNote } from '../targets/draft-note.js';

/** States in which the page may offer each action. */
const EDITABLE = new Set(['awaiting_approval', 'gate_failed', 'review_failed']);
const DISCARDABLE = new Set(['awaiting_approval', 'gate_failed', 'review_failed', 'queued']);
const REGENERABLE = new Set(['gate_failed', 'review_failed', 'discarded']);

/** @param {unknown} d @returns {string|null} */
function isoTime(d) {
  return d instanceof Date ? d.toISOString() : typeof d === 'string' && d ? d : null;
}

/**
 * @param {any} q a read connection
 * @param {any} target the target row (TARGET_COLS plus company, contact fields)
 * @param {ReturnType<typeof import('../targets/leak-guard.js').makeLeakGuard>} g
 * @param {{ eligible: boolean, signoff: string }} o
 */
export async function loadDraftView(q, target, g, o) {
  const latest = await q.query(
    `SELECT id, state, origin, attempt, hook, bridge, claim, ask, word_count, gates, review_verdict, review_findings, sentences, fail_codes,
            draft_version, text_hash, edited, approved_at, created_at, updated_at
     FROM ic_target_drafts WHERE target_id = $1 ORDER BY id DESC LIMIT 1`,
    [target.id],
  );
  const d = latest.rows[0];
  if (!d) return { current: null, history: [], eligible: o.eligible };
  const hist = await q.query(
    `SELECT id, state, origin, attempt, fail_codes, created_at FROM ic_target_drafts WHERE target_id = $1 AND id <> $2 ORDER BY id DESC LIMIT 10`,
    [target.id, d.id],
  );
  const edits = await q.query(`SELECT count(*)::int AS n, max(at) AS last_at FROM ic_target_draft_edits WHERE draft_id = $1`, [d.id]);
  const fields = /** @type {Record<string, string|null>} */ ({});
  for (const k of FIELDS) fields[k] = d[k] === null ? null : g.text(String(d[k]));
  const complete = FIELDS.every((k) => typeof d[k] === 'string' && d[k].trim() !== '');
  const addressee = addresseeOf(target);
  const gates = d.gates && typeof d.gates === 'object' ? d.gates : null;
  const failing = gates && Array.isArray(gates.results) ? gates.results.filter((/** @type {any} */ r) => r && r.ok === false && typeof r.code === 'string').map((/** @type {any} */ r) => ({ gate: String(r.gate), code: String(r.code) })) : [];
  const findings = d.review_findings && typeof d.review_findings === 'object' ? d.review_findings : null;
  return {
    eligible: o.eligible,
    current: {
      id: Number(d.id),
      state: d.state,
      origin: d.origin,
      attempt: Number(d.attempt),
      fields,
      word_count: d.word_count === null ? null : Number(d.word_count),
      addressee: addressee === null ? null : g.text(addressee),
      note_preview: complete ? g.text(composeNote(/** @type {any} */ (Object.fromEntries(FIELDS.map((k) => [k, d[k]]))), addressee, o.signoff)) : null,
      edited: Boolean(d.edited),
      draft_version: Number(d.draft_version),
      gates: { mode: gates?.mode ?? null, pass: gates ? gates.pass === true : null, advisory: Boolean(d.edited), failing },
      review: {
        verdict: d.review_verdict,
        before_edit: Boolean(d.edited),
        reasons: findings && Array.isArray(findings.reasons) ? findings.reasons.filter((/** @type {unknown} */ r) => typeof r === 'string').slice(0, 9) : [],
        failure: findings && typeof findings.failure === 'string' ? findings.failure : null,
      },
      fail_codes: (d.fail_codes ?? []).filter((/** @type {unknown} */ c) => typeof c === 'string').slice(0, 20),
      edits: { count: edits.rows[0].n, last_at: isoTime(edits.rows[0].last_at) },
      created_at: isoTime(d.created_at),
      approved_at: isoTime(d.approved_at),
      can: {
        edit: o.eligible && EDITABLE.has(d.state),
        approve: o.eligible && d.state === 'awaiting_approval',
        discard: DISCARDABLE.has(d.state),
        regenerate: o.eligible && REGENERABLE.has(d.state),
      },
    },
    history: hist.rows.map((/** @type {any} */ h) => ({ id: Number(h.id), state: h.state, origin: h.origin, attempt: Number(h.attempt), fail_codes: (h.fail_codes ?? []).slice(0, 20), created_at: isoTime(h.created_at) })),
  };
}
