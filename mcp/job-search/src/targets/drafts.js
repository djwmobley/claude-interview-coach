// @ts-check
/**
 * The draft pipeline (plan 19.2 and 19.4): claim, generate, gate, review, park or await approval.
 *
 * Nothing here sends anything. The model is reached only through the injected callModel (the scan wires the
 * real `claude -p` caller from src/core/claude-spawn.js; tests inject a stub), so this module holds no process,
 * network or mail code.
 *
 * CLAIMS. A claim is a `queued` row carrying cap_day. claimDrafts() counts the day's claims and inserts the new
 * ones in ONE transaction under a transaction advisory lock, so two runs, or a crash between selection and
 * insert, can never exceed the cap. Automatic regenerations carry no cap_day and never count.
 *
 * EVERY draft row ends in a closed state: awaiting_approval, gate_failed or review_failed (parked), or
 * discarded. A row left `draft` by a crash is reaped to gate_failed (generation_interrupted) after 30 minutes.
 */
import { effectiveClassSql } from './effective.js';
import { etDay } from './dates.js';
import { runGates, FIELDS } from './draft-gates.js';
import { tokens } from './draft-text.js';
import { loadDraftConfig, buildGateContext, isEligibleTarget, TARGET_COLS } from './draft-context.js';
import {
  sanitizeExcerpt, buildDraftPrompt, buildReviewPrompt, newNonce, parseReviewReply, parseEnvelope, parseDraftReply, MAX_EVIDENCE,
} from './draft-prompt.js';
import { addresseeOf, noteHash } from './draft-note.js';
import { DraftError } from './draft-errors.js';

export const DAILY_CAP = 5;
export const CALL_TIMEOUT_MS = 120_000;
export const STALE_DRAFT_MINUTES = 30;
const CAP_LOCK_KEY = 7_311_027;
const RUN_LOCK_KEY = 7_311_028;

/** Failure codes that an automatic regeneration cannot improve (infrastructure or eligibility). */
const NO_REGEN = new Set(['model_error', 'model_timeout', 'no_evidence', 'ineligible', 'ineligible_after_generation', 'generation_interrupted', 'review_error']);

class StopError extends Error {
  /** @param {string} why */
  constructor(why) {
    super(why);
    this.why = why;
  }
}

/** @param {unknown} s @returns {string} text safe for a Postgres text column */
function dbText(s) {
  return String(s ?? '').replace(/[\x00]/g, '').slice(0, 600);
}

const EFF = effectiveClassSql('t');

/**
 * Close drafts a crashed run left in `draft`.
 * @param {import('pg').ClientBase} client
 * @returns {Promise<number>}
 */
export async function reapStale(client) {
  const r = await client.query(
    `UPDATE ic_target_drafts SET state = 'gate_failed', fail_codes = ARRAY['generation_interrupted'], updated_at = now()
     WHERE state = 'draft' AND updated_at < now() - make_interval(mins => $1::int)`,
    [STALE_DRAFT_MINUTES],
  );
  return r.rowCount ?? 0;
}

/**
 * Pick the day's new first-attempt drafts and insert their claim rows in one transaction.
 * @param {import('pg').ClientBase} client
 * @param {{ now: Date, cap?: number }} o
 * @returns {Promise<{ claimed: number[], used: number, cap: number }>}
 */
export async function claimDrafts(client, o) {
  const cap = o.cap ?? DAILY_CAP;
  const day = etDay(o.now);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [CAP_LOCK_KEY]);
    const used = Number((await client.query('SELECT count(*)::int AS n FROM ic_target_drafts WHERE cap_day = $1::date', [day])).rows[0].n);
    const room = Math.max(0, cap - used);
    /** @type {number[]} */
    let claimed = [];
    if (room > 0) {
      const ins = await client.query(
        `WITH cand AS (
           SELECT t.id FROM ic_targets t
           WHERE ${EFF} = 'target' AND (t.decision IS NULL OR t.decision = 'reclassified')
             AND NOT EXISTS (SELECT 1 FROM ic_target_drafts d WHERE d.target_id = t.id)
             AND EXISTS (SELECT 1 FROM ic_target_signals s WHERE s.target_id = t.id AND coalesce(btrim(s.excerpt), '') <> '')
           ORDER BY t.trigger_date DESC NULLS LAST, t.id ASC
           LIMIT $2
           FOR UPDATE OF t SKIP LOCKED
         )
         INSERT INTO ic_target_drafts (target_id, state, origin, attempt, cap_day)
         SELECT id, 'queued', 'auto_first', 1, $1::date FROM cand
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [day, room],
      );
      claimed = ins.rows.map((/** @type {any} */ r) => Number(r.id));
    }
    await client.query('COMMIT');
    return { claimed, used: used + claimed.length, cap };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * A manual regenerate (Damian asked). Counts against the cap; refused when the cap is used, when a live draft
 * exists, or when the target is not eligible. The row is queued; the next scan stage generates it.
 * @param {import('pg').ClientBase} client
 * @param {{ targetId: number, now: Date, cap?: number }} o
 * @returns {Promise<{ id: number }>}
 */
export async function claimManual(client, o) {
  const cap = o.cap ?? DAILY_CAP;
  const day = etDay(o.now);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [CAP_LOCK_KEY]);
    const t = await client.query(`SELECT ${TARGET_COLS} FROM ic_targets t WHERE t.id = $1 FOR UPDATE`, [o.targetId]);
    if (t.rowCount === 0) throw new DraftError('NOT_FOUND', 'target not found');
    if (!isEligibleTarget(t.rows[0])) throw new DraftError('WRONG_STATE', 'the target is not eligible for a draft');
    const used = Number((await client.query('SELECT count(*)::int AS n FROM ic_target_drafts WHERE cap_day = $1::date', [day])).rows[0].n);
    if (used >= cap) throw new DraftError('CAP_REACHED', 'the daily draft limit is used; try the next business day');
    /** @type {any} */
    let ins;
    try {
      ins = await client.query(
        `INSERT INTO ic_target_drafts (target_id, state, origin, attempt, cap_day) VALUES ($1, 'queued', 'manual', 1, $2::date) RETURNING id`,
        [o.targetId, day],
      );
    } catch (err) {
      if (err && typeof err === 'object' && /** @type {any} */ (err).code === '23505') throw new DraftError('DRAFT_LIVE', 'a live draft already exists for this target');
      throw err;
    }
    await client.query('COMMIT');
    return { id: Number(ins.rows[0].id) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Counts for the digest and the Home tile: the latest draft of each target that is still in play.
 * @param {import('pg').ClientBase} client
 * @returns {Promise<{ awaiting: number, parked: number }>}
 */
export async function draftCounts(client) {
  const r = await client.query(
    `SELECT count(*) FILTER (WHERE d.state = 'awaiting_approval')::int AS awaiting,
            count(*) FILTER (WHERE d.state IN ('gate_failed', 'review_failed'))::int AS parked
     FROM (SELECT DISTINCT ON (target_id) target_id, state FROM ic_target_drafts ORDER BY target_id, id DESC) d
     JOIN ic_targets t ON t.id = d.target_id
     WHERE t.decision IS NULL OR t.decision = 'reclassified'`,
  );
  return { awaiting: r.rows[0].awaiting, parked: r.rows[0].parked };
}

/**
 * @typedef {Object} PipelineDeps
 * @property {import('pg').ClientBase} client
 * @property {Date} now
 * @property {string} configDir
 * @property {(req: { kind: 'draft'|'review', prompt: string, timeoutMs: number, signal?: AbortSignal }) => Promise<{ ok: true, stdout: string } | { ok: false, reason: string }>} callModel
 * @property {number} deadlineAt epoch ms
 * @property {AbortSignal} [signal]
 * @property {(f: Record<string, unknown>) => void} [log]
 * @property {number} [cap]
 * @property {{ buzzwords: string[], problemComparisonPatterns: string[] }} [style]
 */

/**
 * @param {PipelineDeps} deps
 * @returns {number} ms left for one call, or throws StopError
 */
function callBudget(deps) {
  if (deps.signal?.aborted) throw new StopError('aborted');
  const left = deps.deadlineAt - Date.now();
  if (left < 2000) throw new StopError('deadline');
  return Math.min(CALL_TIMEOUT_MS, left - 500);
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} id
 * @param {{ state: string, codes?: string[], gates?: unknown, fields?: Record<string, string>|null, sentences?: unknown, evidenceIds?: number[], verdict?: 'PASS'|'FAIL'|null, findings?: unknown, textHash?: string|null }} p
 */
async function settle(client, id, p) {
  const f = p.fields ?? null;
  await client.query(
    `UPDATE ic_target_drafts SET state = $2, fail_codes = $3::text[], gates = coalesce($4::jsonb, gates),
       hook = coalesce($5, hook), bridge = coalesce($6, bridge), claim = coalesce($7, claim), ask = coalesce($8, ask),
       word_count = coalesce($9, word_count), sentences = coalesce($10::jsonb, sentences),
       evidence_ids = coalesce($11::int[], evidence_ids), review_verdict = $12, review_findings = $13::jsonb,
       text_hash = $14, updated_at = now()
     WHERE id = $1`,
    [
      id, p.state, p.codes ?? [], p.gates === undefined ? null : JSON.stringify(p.gates),
      f ? dbText(f.hook) : null, f ? dbText(f.bridge) : null, f ? dbText(f.claim) : null, f ? dbText(f.ask) : null,
      f ? tokens(FIELDS.map((k) => f[k]).join(' ')).length : null,
      p.sentences === undefined ? null : JSON.stringify(p.sentences), p.evidenceIds ?? null,
      p.verdict ?? null, p.findings === undefined ? null : JSON.stringify(p.findings), p.textHash ?? null,
    ],
  );
}

/**
 * Run one claimed row through the pipeline. Returns the final state. A StopError (deadline or abort) puts the
 * row back to `queued` and propagates.
 * @param {PipelineDeps} deps
 * @param {Extract<ReturnType<typeof loadDraftConfig>, { ok: true }>} cfg
 * @param {{ id: number, target_id: number, origin: string, regen_of: number|null }} row
 * @returns {Promise<string>}
 */
async function processRow(deps, cfg, row) {
  const { client } = deps;
  const log = deps.log ?? (() => {});
  const took = await client.query(`UPDATE ic_target_drafts SET state = 'draft', updated_at = now() WHERE id = $1 AND state = 'queued' RETURNING id`, [row.id]);
  if (took.rowCount === 0) return 'skipped';
  try {
    const tr = await client.query(`SELECT ${TARGET_COLS} FROM ic_targets t WHERE t.id = $1`, [row.target_id]);
    const target = tr.rows[0];
    if (!target || !isEligibleTarget(target)) {
      await settle(client, row.id, { state: 'discarded', codes: ['ineligible'] });
      return 'discarded';
    }
    const sig = await client.query(
      `SELECT id, excerpt FROM ic_target_signals WHERE target_id = $1 AND coalesce(btrim(excerpt), '') <> '' ORDER BY id DESC LIMIT $2`,
      [row.target_id, MAX_EVIDENCE],
    );
    const evidence = sig.rows.map((/** @type {any} */ s) => ({ id: Number(s.id), excerpt: sanitizeExcerpt(s.excerpt) })).filter((e) => e.excerpt !== '');
    if (evidence.length === 0) {
      await settle(client, row.id, { state: 'gate_failed', codes: ['no_evidence'] });
      return 'gate_failed';
    }
    const evidenceIds = evidence.map((e) => e.id);
    /** @type {string[]} */
    let priorCodes = [];
    if (row.regen_of) {
      const p = await client.query('SELECT fail_codes FROM ic_target_drafts WHERE id = $1', [row.regen_of]);
      priorCodes = (p.rows[0]?.fail_codes ?? []).filter((/** @type {unknown} */ c) => typeof c === 'string');
    }
    const prompt = buildDraftPrompt({
      company: String(target.company), triggerKind: String(target.trigger_kind), triggerDate: target.trigger_date instanceof Date ? target.trigger_date.toISOString().slice(0, 10) : null,
      evidence, facts: cfg.facts.facts, priorCodes,
    });

    /** @type {any} */
    let draftRes;
    try {
      draftRes = await deps.callModel({ kind: 'draft', prompt, timeoutMs: callBudget(deps), signal: deps.signal });
    } catch (err) {
      if (err instanceof StopError) throw err;
      draftRes = { ok: false, reason: 'exit' };
    }
    if (!draftRes || draftRes.ok !== true) {
      await settle(client, row.id, { state: 'gate_failed', codes: [draftRes && draftRes.reason === 'timeout' ? 'model_timeout' : 'model_error'] });
      return 'gate_failed';
    }
    const env = parseEnvelope(draftRes.stdout);
    const reply = env.ok ? parseDraftReply(env) : null;
    if (!reply) {
      await settle(client, row.id, { state: 'gate_failed', codes: [env.ok ? 'draft_unparseable' : (env.reason === 'model_error' ? 'model_error' : 'draft_unparseable')] });
      return 'gate_failed';
    }
    const fields = { hook: reply.hook, bridge: reply.bridge, claim: reply.claim, ask: reply.ask };
    const ctx = await buildGateContext(client, target, evidenceIds, cfg);
    const gate = runGates({ fields, sentences: reply.sentences, mode: 'machine', ctx });
    const gatesJson = { mode: gate.mode, pass: gate.pass, results: gate.results };
    if (!gate.pass) {
      await settle(client, row.id, { state: 'gate_failed', codes: gate.codes, gates: gatesJson, fields, sentences: reply.sentences, evidenceIds });
      return 'gate_failed';
    }

    // Independent review: separate call, JSON-encoded untrusted data, per-run nonce.
    const nonce = newNonce();
    const cited = new Set(reply.sentences.map((s) => s.src));
    /** @type {Record<string, string>} */
    const citedEvidence = {};
    for (const [id, text] of Object.entries(ctx.evidence)) if (cited.has(`e${id}`)) citedEvidence[`e${id}`] = text;
    /** @type {Record<string, string>} */
    const citedFacts = {};
    for (const f of cfg.facts.facts) if (cited.has(f.id)) citedFacts[f.id] = f.text;
    const reviewPrompt = buildReviewPrompt({
      nonce,
      data: { company: String(target.company), trigger_kind: target.trigger_kind, draft: fields, sentences: reply.sentences, evidence: citedEvidence, facts: citedFacts },
    });
    /** @type {any} */
    let reviewRes;
    try {
      reviewRes = await deps.callModel({ kind: 'review', prompt: reviewPrompt, timeoutMs: callBudget(deps), signal: deps.signal });
    } catch (err) {
      if (err instanceof StopError) throw err;
      reviewRes = { ok: false, reason: 'exit' };
    }
    /** @type {{ verdict: 'PASS'|'FAIL', reasons: string[], failure: string|null }} */
    let verdict;
    if (!reviewRes || reviewRes.ok !== true) {
      verdict = { verdict: 'FAIL', reasons: [], failure: 'review_error' };
    } else {
      const renv = parseEnvelope(reviewRes.stdout);
      verdict = renv.ok ? parseReviewReply(renv.result, nonce) : { verdict: 'FAIL', reasons: [], failure: 'review_error' };
    }
    const findings = { verdict: verdict.verdict, reasons: verdict.reasons, failure: verdict.failure };
    if (verdict.verdict !== 'PASS') {
      const codes = verdict.failure ? [verdict.failure] : ['review_fail', ...verdict.reasons];
      await settle(client, row.id, { state: 'review_failed', codes, gates: gatesJson, fields, sentences: reply.sentences, evidenceIds, verdict: 'FAIL', findings });
      return 'review_failed';
    }
    // Eligibility again, after generation.
    const again = await client.query(`SELECT ${TARGET_COLS} FROM ic_targets t WHERE t.id = $1`, [row.target_id]);
    if (!again.rows[0] || !isEligibleTarget(again.rows[0])) {
      await settle(client, row.id, { state: 'discarded', codes: ['ineligible_after_generation'], gates: gatesJson, fields, sentences: reply.sentences, evidenceIds, verdict: 'PASS', findings });
      return 'discarded';
    }
    const hash = noteHash(fields, addresseeOf(again.rows[0]), cfg.facts.signoff);
    await settle(client, row.id, { state: 'awaiting_approval', codes: [], gates: gatesJson, fields, sentences: reply.sentences, evidenceIds, verdict: 'PASS', findings, textHash: hash });
    return 'awaiting_approval';
  } catch (err) {
    if (err instanceof StopError) {
      await client.query(`UPDATE ic_target_drafts SET state = 'queued', updated_at = now() WHERE id = $1 AND state = 'draft'`, [row.id]).catch(() => {});
      throw err;
    }
    log({ evt: 'target_draft_failed', draft_id: row.id, err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    await client.query(`UPDATE ic_target_drafts SET state = 'gate_failed', fail_codes = ARRAY['generation_interrupted'], updated_at = now() WHERE id = $1 AND state = 'draft'`, [row.id]).catch(() => {});
    return 'gate_failed';
  }
}

/**
 * Run the draft pipeline once: reap, claim, process every queued row, and give each parked first attempt its
 * one automatic regeneration. Never throws for a model or data problem; returns counts.
 * @param {PipelineDeps} deps
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runDraftPipeline(deps) {
  const log = deps.log ?? (() => {});
  const cfg = loadDraftConfig(deps.configDir, { style: deps.style });
  if (!cfg.ok) return { ran: false, skipped: cfg.reason };
  const { client } = deps;
  const got = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [RUN_LOCK_KEY]);
  if (!got.rows[0].ok) return { ran: false, skipped: 'locked' };
  /** @type {Record<string, number>} */
  const tally = { reaped: 0, claimed: 0, awaiting_approval: 0, gate_failed: 0, review_failed: 0, discarded: 0, regenerated: 0 };
  /** @type {string|null} */
  let stopped = null;
  try {
    tally.reaped = await reapStale(client);
    const claim = await claimDrafts(client, { now: deps.now, cap: deps.cap });
    tally.claimed = claim.claimed.length;
    for (;;) {
      const next = await client.query(
        `SELECT id, target_id, origin, regen_of FROM ic_target_drafts WHERE state = 'queued' ORDER BY id ASC LIMIT 1`,
      );
      if (next.rowCount === 0) break;
      const row = { id: Number(next.rows[0].id), target_id: Number(next.rows[0].target_id), origin: String(next.rows[0].origin), regen_of: next.rows[0].regen_of === null ? null : Number(next.rows[0].regen_of) };
      const state = await processRow(deps, cfg, row);
      if (state === 'skipped') continue;
      tally[state] = (tally[state] ?? 0) + 1;
      if ((state === 'gate_failed' || state === 'review_failed') && row.origin !== 'auto_regen') {
        const codes = (await client.query('SELECT fail_codes FROM ic_target_drafts WHERE id = $1', [row.id])).rows[0]?.fail_codes ?? [];
        if (!codes.some((/** @type {string} */ c) => NO_REGEN.has(c))) {
          const ins = await client.query(
            `INSERT INTO ic_target_drafts (target_id, state, origin, attempt, regen_of) VALUES ($1, 'queued', 'auto_regen', 2, $2) ON CONFLICT DO NOTHING RETURNING id`,
            [row.target_id, row.id],
          );
          if (ins.rowCount) tally.regenerated += 1;
        }
      }
    }
  } catch (err) {
    if (err instanceof StopError) stopped = err.why;
    else {
      log({ evt: 'target_draft_pipeline_failed', err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
      stopped = 'error';
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [RUN_LOCK_KEY]).catch(() => {});
  }
  const counts = await draftCounts(client).catch(() => ({ awaiting: 0, parked: 0 }));
  return { ran: true, ...tally, stopped, awaiting: counts.awaiting, parked: counts.parked };
}

