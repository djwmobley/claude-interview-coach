// @ts-check
/**
 * Target decisions (PR4, plan 18.2 and 18.5): the shared effective-state definition, the total state table,
 * optimistic concurrency, the audit trail, restore, and blocked-first precedence after a blocklist change.
 * Runs against the isolated "_test" database. No network, no shell, no browser.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { loadTargetRules } from '../src/core/target-classify.js';
import { persistItems } from '../src/targets/store.js';
import { classifyPhase } from '../src/targets/runner.js';
import { effectiveClassSql, blockedSql, effectiveClassOf, isBlockedRow } from '../src/targets/effective.js';
import { planAction, allowedActions, stateOf, applyDecision, parseRequest, DecisionError, REASONS } from '../src/targets/decisions.js';
import { seedTarget, cleanup } from './helpers/targets-pr4.js';
import { indexUrl } from '../src/targets/edgar-client.js';

const TAG = `zz-test-dec-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {pg.Client} */
let other;

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  other = new pg.Client(pgConnectionConfig());
  await other.connect();
  await ensureAuxSchema(client);
  await cleanup(client, TAG);
});
beforeEach(() => cleanup(client, TAG));
after(async () => {
  await cleanup(client, TAG);
  await client.end();
  await other.end();
});

/** @param {number} id */
async function row(id) {
  return (await client.query(`SELECT class, decision, decision_class, decision_reason, decision_version, decided_by, new_evidence_at FROM ic_targets WHERE id = $1`, [id])).rows[0];
}
/** @param {number} id */
async function audit(id) {
  return (await client.query(`SELECT action, from_class, to_class, reason_code, note, decision_version, actor FROM ic_target_decisions WHERE target_id = $1 ORDER BY decision_version`, [id])).rows;
}
/** @param {Promise<unknown>} p @param {string} code */
async function refused(p, code) {
  const err = await p.then(() => null, (e) => e);
  assert.ok(err instanceof DecisionError, `expected a DecisionError ${code}, got ${err}`);
  assert.equal(err.code, code);
  return err;
}

describe('the shared effective-state definition (A1)', () => {
  test('the SQL fragment and the JavaScript twin agree on every combination', async () => {
    const rules = ['excl_blocked_company', 'excl_blocked_suspect', 'dedup_blocked_sibling', 'excl_blocklist_unavailable', 'excl_unknown_company', 'target_all_checks_passed'];
    const hints = [undefined, true, false, 'true', 'false', null];
    const decisionClasses = [null, 'target', 'needs-review', 'not-target'];
    const classes = ['target', 'needs-review', 'not-target'];
    let n = 0;
    for (const rule of rules) for (const hint of hints) for (const dc of decisionClasses) for (const cls of classes) {
      const inputs = hint === undefined ? {} : { blocked_hint: hint };
      n += 1;
      const id = await seedTarget(client, { tag: TAG, n: `agree${n}`, cls, rule, inputs, decisionClass: dc, decision: dc ? 'reclassified' : null });
      const r = await client.query(`SELECT ${effectiveClassSql('t')} AS eff, ${blockedSql('t')} AS blk, t.class, t.verdict_rule, t.verdict_inputs, t.decision_class FROM ic_targets t WHERE t.id = $1`, [id]);
      const t = r.rows[0];
      assert.equal(t.eff, effectiveClassOf(t), `${rule} hint=${String(hint)} dc=${dc} cls=${cls}`);
      assert.equal(t.blk, isBlockedRow(t), `blocked: ${rule} hint=${String(hint)}`);
    }
    assert.equal(n, 6 * 6 * 4 * 3);
  });

  test('blocked wins over a manual decision; excl_blocklist_unavailable is NOT blocked', () => {
    assert.equal(effectiveClassOf({ class: 'needs-review', verdict_rule: 'excl_blocked_suspect', decision_class: 'target' }), 'not-target');
    assert.equal(effectiveClassOf({ class: 'target', verdict_rule: 'dedup_blocked_sibling', decision_class: 'target' }), 'not-target');
    assert.equal(effectiveClassOf({ class: 'target', verdict_rule: 'x', verdict_inputs: { blocked_hint: true }, decision_class: 'target' }), 'not-target');
    assert.equal(effectiveClassOf({ class: 'needs-review', verdict_rule: 'excl_blocklist_unavailable', decision_class: 'target' }), 'target');
    assert.equal(effectiveClassOf({ class: 'needs-review', verdict_rule: 'x', decision_class: null }), 'needs-review');
  });
});

describe('the total state table (A4)', () => {
  /** [label, row, to-target, to-not-target, discard, restore]; ok | noop | a refusal code */
  const MATRIX = [
    ['target, open', { class: 'target', verdict_rule: 'target_all_checks_passed' }, 'noop', 'WRONG_STATE', 'ok', 'NOT_DISCARDED'],
    ['needs-review, open', { class: 'needs-review', verdict_rule: 'size_not_clearly_in_band' }, 'ok', 'ok', 'ok', 'NOT_DISCARDED'],
    ['not-target, open', { class: 'not-target', verdict_rule: 'stale_window' }, 'ok', 'noop', 'ok', 'NOT_DISCARDED'],
    ['blocked (company)', { class: 'not-target', verdict_rule: 'excl_blocked_company' }, 'BLOCKED_NOT_ELIGIBLE', 'noop', 'ok', 'NOT_DISCARDED'],
    ['blocked (suspect, machine needs-review)', { class: 'needs-review', verdict_rule: 'excl_blocked_suspect' }, 'BLOCKED_NOT_ELIGIBLE', 'noop', 'ok', 'NOT_DISCARDED'],
    ['blocked via sibling hint', { class: 'target', verdict_rule: 'dedup_blocked_sibling' }, 'BLOCKED_NOT_ELIGIBLE', 'noop', 'ok', 'NOT_DISCARDED'],
    ['manual target over needs-review', { class: 'needs-review', verdict_rule: 'x', decision: 'reclassified', decision_class: 'target' }, 'noop', 'WRONG_STATE', 'ok', 'NOT_DISCARDED'],
    ['manual not-target over target', { class: 'target', verdict_rule: 'x', decision: 'reclassified', decision_class: 'not-target' }, 'ok', 'noop', 'ok', 'NOT_DISCARDED'],
    ['discarded (was target)', { class: 'target', verdict_rule: 'x', decision: 'discarded' }, 'DISCARDED', 'DISCARDED', 'DISCARDED', 'ok'],
    ['discarded (was not-target)', { class: 'not-target', verdict_rule: 'x', decision: 'discarded' }, 'DISCARDED', 'DISCARDED', 'DISCARDED', 'ok'],
    ['discarded and blocked', { class: 'not-target', verdict_rule: 'excl_blocked_company', decision: 'discarded' }, 'DISCARDED', 'DISCARDED', 'DISCARDED', 'ok'],
    ['approved (PR5)', { class: 'target', verdict_rule: 'x', decision: 'approved', decision_class: 'target' }, 'DECISION_LOCKED', 'DECISION_LOCKED', 'DECISION_LOCKED', 'DECISION_LOCKED'],
  ];

  for (const [label, rowIn, a, b, c, d] of MATRIX) {
    test(`planAction: ${label}`, () => {
      const s = stateOf(/** @type {any} */ (rowIn));
      const norm = (/** @type {any} */ p) => (p.outcome === 'refuse' ? p.code : p.outcome);
      assert.equal(norm(planAction(s, { action: 'reclassify', to: 'target' })), a, 'reclassify to target');
      assert.equal(norm(planAction(s, { action: 'reclassify', to: 'not-target' })), b, 'reclassify to not-target');
      assert.equal(norm(planAction(s, { action: 'discard' })), c, 'discard');
      assert.equal(norm(planAction(s, { action: 'restore' })), d, 'restore');
      const al = allowedActions(s);
      assert.equal(al.reclassify.includes('target'), a === 'ok');
      assert.equal(al.reclassify.includes('not-target'), b === 'ok');
      assert.equal(al.discard, c === 'ok');
      assert.equal(al.restore, d === 'ok');
    });
  }

  test('anything outside the three actions, or a reclassify to a third class, is refused (never allowed by default)', () => {
    for (const eff of ['target', 'needs-review', 'not-target']) {
      const s = stateOf(/** @type {any} */ ({ class: eff, verdict_rule: 'x' }));
      assert.equal(planAction(s, /** @type {any} */ ({ action: 'send' })).outcome, 'refuse');
      assert.equal(planAction(s, /** @type {any} */ ({ action: 'reclassify', to: 'needs-review' })).outcome, 'refuse');
      assert.equal(planAction(s, /** @type {any} */ ({ action: 'reclassify' })).outcome, 'refuse');
    }
  });
});

describe('request validation is total and happens before any lookup', () => {
  test('closed reason lists, unknown keys, types and the note limit', () => {
    const v = { expected_decision_version: 0 };
    assert.deepEqual(parseRequest('reclassify', { ...v, to: 'target', reason_code: 'size_confirmed' }).req, { action: 'reclassify', to: 'target' });
    for (const bad of ['not_a_fit', 'stale', 'nonsense', '', 7, null]) {
      assert.throws(() => parseRequest('reclassify', { ...v, to: 'target', reason_code: bad }), /closed list|required/, `to target with ${String(bad)}`);
    }
    for (const bad of ['size_confirmed', 'trigger_confirmed', 'other_verified', 'x']) {
      assert.throws(() => parseRequest('reclassify', { ...v, to: 'not-target', reason_code: bad }), /closed list/, `to not-target with ${bad}`);
      assert.throws(() => parseRequest('discard', { ...v, reason_code: bad }), /closed list/, `discard with ${bad}`);
    }
    for (const ok of REASONS.discard) assert.ok(parseRequest('discard', { ...v, reason_code: ok }));
    assert.throws(() => parseRequest('reclassify', { ...v, to: 'needs-review', reason_code: 'stale' }), /to must be/);
    assert.throws(() => parseRequest('discard', { ...v, reason_code: 'stale', actor: 'someone' }), /unknown field/);
    assert.throws(() => parseRequest('restore', { ...v, reason_code: 'stale' }), /unknown field/);
    for (const bad of [undefined, -1, 1.5, '3', null, 2_000_000_001]) {
      assert.throws(() => parseRequest('restore', { expected_decision_version: bad }), /expected_decision_version/, String(bad));
    }
    assert.throws(() => parseRequest('discard', { ...v, reason_code: 'stale', note: 'x'.repeat(501) }), /500/);
    assert.equal(parseRequest('discard', { ...v, reason_code: 'stale', note: 'x'.repeat(500) }).note?.length, 500);
    assert.throws(() => parseRequest('discard', { ...v, reason_code: 'stale', note: 'bad\u0000note' }), /control/);
    assert.throws(() => parseRequest('discard', { ...v, reason_code: 'stale', note: 5 }), /note must be a string/);
    assert.equal(parseRequest('discard', { ...v, reason_code: 'stale', note: '   ' }).note, null);
    for (const body of [null, [], 'x', 5]) assert.throws(() => parseRequest('restore', body), /JSON object/);
  });
});

describe('reclassify, discard and restore against the database', () => {
  test('reclassify: sets the manual verdict, one audit row, version +1, actor damian, and clears new evidence', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'rc', cls: 'needs-review', newEvidenceAt: '2026-10-10T00:00:00Z' });
    const r = await applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'size_confirmed', note: ' looks right ', expected_decision_version: 0 });
    assert.deepEqual(r, { noop: false, id, decision_version: 1 });
    const t = await row(id);
    assert.deepEqual([t.class, t.decision, t.decision_class, t.decision_reason, t.decision_version, t.decided_by, t.new_evidence_at], ['needs-review', 'reclassified', 'target', 'size_confirmed', 1, 'damian', null]);
    assert.deepEqual(await audit(id), [{ action: 'reclassify', from_class: 'needs-review', to_class: 'target', reason_code: 'size_confirmed', note: 'looks right', decision_version: 1, actor: 'damian' }]);
  });

  test('a repeat reclassify to the same class is a no-op: no audit row, no version change', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'noop', cls: 'needs-review' });
    await applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'other_verified', expected_decision_version: 0 });
    const again = await applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'trigger_confirmed', expected_decision_version: 1 });
    assert.deepEqual(again, { noop: true, id, decision_version: 1 });
    assert.equal((await audit(id)).length, 1);
    assert.equal((await row(id)).decision_reason, 'other_verified', 'the no-op did not rewrite the reason');
  });

  test('a stale expected version is VERSION_CONFLICT (409) and writes nothing, even for an otherwise valid action', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'stale', cls: 'needs-review' });
    await applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'size_confirmed', expected_decision_version: 0 });
    const err = await refused(applyDecision(client, id, 'discard', { reason_code: 'stale', expected_decision_version: 0 }), 'VERSION_CONFLICT');
    assert.equal(err.status, 409);
    assert.equal(err.details.current_version, 1);
    assert.equal((await row(id)).decision, 'reclassified');
    assert.equal((await audit(id)).length, 1);
    await refused(applyDecision(client, id, 'discard', { reason_code: 'stale', expected_decision_version: 2 }), 'VERSION_CONFLICT');
  });

  test('two requests racing on the same version: exactly one wins, the other is a 409', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'race', cls: 'needs-review' });
    const a = applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'size_confirmed', expected_decision_version: 0 }).then(() => 'ok', (e) => e.code);
    const b = applyDecision(other, id, 'reclassify', { to: 'not-target', reason_code: 'not_a_fit', expected_decision_version: 0 }).then(() => 'ok', (e) => e.code);
    const out = (await Promise.all([a, b])).sort();
    assert.deepEqual(out, ['VERSION_CONFLICT', 'ok']);
    assert.equal((await audit(id)).length, 1);
    assert.equal((await row(id)).decision_version, 1);
  });

  test('unknown id is NOT_FOUND (after validation); a bad body never reaches the lookup', async () => {
    await refused(applyDecision(client, 2_000_000_000, 'restore', { expected_decision_version: 0 }), 'NOT_FOUND');
    await refused(applyDecision(client, 0, 'restore', { expected_decision_version: 0 }), 'INVALID_ID');
    await refused(applyDecision(client, 2_000_000_000, 'discard', { reason_code: 'bogus', expected_decision_version: 0 }), 'INVALID_REASON');
  });

  test('a blocked row cannot be promoted: refused, a blocked_refused audit row is kept, the version moves, the decision does not', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'blk', cls: 'not-target', rule: 'excl_blocked_company' });
    const err = await refused(applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'size_confirmed', note: 'try', expected_decision_version: 0 }), 'BLOCKED_NOT_ELIGIBLE');
    assert.equal(err.status, 409);
    const t = await row(id);
    assert.deepEqual([t.decision, t.decision_class, t.decision_version], [null, null, 1]);
    assert.deepEqual(await audit(id), [{ action: 'blocked_refused', from_class: 'not-target', to_class: 'target', reason_code: 'size_confirmed', note: 'try', decision_version: 1, actor: 'damian' }]);
    await refused(applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'size_confirmed', expected_decision_version: 0 }), 'VERSION_CONFLICT');
    const second = await refused(applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'size_confirmed', expected_decision_version: 1 }), 'BLOCKED_NOT_ELIGIBLE');
    assert.equal(second.details.current_version, 2);
    assert.equal((await audit(id)).length, 2, 'UNIQUE (target_id, decision_version) holds because every audit row bumps the version');
  });

  test('every plain refusal writes nothing (no audit, no version change)', async () => {
    const t = await seedTarget(client, { tag: TAG, n: 'wrong', cls: 'target', rule: 'target_all_checks_passed' });
    await refused(applyDecision(client, t, 'reclassify', { to: 'not-target', reason_code: 'not_a_fit', expected_decision_version: 0 }), 'WRONG_STATE');
    await refused(applyDecision(client, t, 'restore', { expected_decision_version: 0 }), 'NOT_DISCARDED');
    assert.equal((await audit(t)).length, 0);
    assert.equal((await row(t)).decision_version, 0);
    const ap = await seedTarget(client, { tag: TAG, n: 'appr', cls: 'target', decision: 'approved', decisionClass: 'target' });
    await refused(applyDecision(client, ap, 'discard', { reason_code: 'stale', expected_decision_version: 0 }), 'DECISION_LOCKED');
  });

  test('discard keeps decision_class; restore returns the row to its prior effective class (O3)', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'dr', cls: 'needs-review' });
    await applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'size_confirmed', expected_decision_version: 0 });
    await applyDecision(client, id, 'discard', { reason_code: 'already_known', expected_decision_version: 1 });
    let t = await row(id);
    assert.deepEqual([t.decision, t.decision_class, t.decision_reason, t.decision_version], ['discarded', 'target', 'already_known', 2]);
    await refused(applyDecision(client, id, 'reclassify', { to: 'not-target', reason_code: 'stale', expected_decision_version: 2 }), 'DISCARDED');
    const r = await applyDecision(client, id, 'restore', { expected_decision_version: 2 });
    assert.equal(r.decision_version, 3);
    t = await row(id);
    assert.deepEqual([t.decision, t.decision_class], ['reclassified', 'target']);
    const log = await audit(id);
    assert.deepEqual(log.map((a) => [a.action, a.from_class, a.to_class, a.decision_version]), [
      ['reclassify', 'needs-review', 'target', 1], ['discard', 'target', null, 2], ['restore', null, 'target', 3],
    ]);
  });

  test('restoring an untouched row clears the decision entirely; the machine verdict applies again', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'clear', cls: 'target', rule: 'target_all_checks_passed' });
    await applyDecision(client, id, 'discard', { reason_code: 'not_a_fit', expected_decision_version: 0 });
    await applyDecision(client, id, 'restore', { expected_decision_version: 1 });
    const t = await row(id);
    assert.deepEqual([t.decision, t.decision_class, t.decision_reason, t.decided_by], [null, null, null, null]);
    assert.equal((await client.query(`SELECT ${effectiveClassSql('t')} AS e FROM ic_targets t WHERE id = $1`, [id])).rows[0].e, 'target');
  });

  test('restore uses the class from the audit row, not the machine class of today', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'drift', cls: 'needs-review' });
    await applyDecision(client, id, 'discard', { reason_code: 'stale', expected_decision_version: 0 });
    await client.query(`UPDATE ic_targets SET class = 'target', verdict_rule = 'target_all_checks_passed' WHERE id = $1`, [id]);
    await applyDecision(client, id, 'restore', { expected_decision_version: 1 });
    const t = await row(id);
    assert.deepEqual([t.decision, t.decision_class], ['reclassified', 'needs-review'], 'the prior effective class was needs-review');
  });

  test('restore re-runs the blocked check: refused (and audited) when the prior class was active and the row is now blocked', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'rblk', cls: 'target', rule: 'target_all_checks_passed' });
    await applyDecision(client, id, 'discard', { reason_code: 'stale', expected_decision_version: 0 });
    await client.query(`UPDATE ic_targets SET class = 'not-target', verdict_rule = 'excl_blocked_company' WHERE id = $1`, [id]);
    await refused(applyDecision(client, id, 'restore', { expected_decision_version: 1 }), 'BLOCKED_NOT_ELIGIBLE');
    const t = await row(id);
    assert.deepEqual([t.decision, t.decision_version], ['discarded', 2]);
    assert.equal((await audit(id)).at(-1)?.action, 'blocked_refused');
  });

  test('restore of a discarded not-target row stays allowed even when blocked (it lands on not-target)', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'rblk2', cls: 'not-target', rule: 'excl_blocked_company' });
    await applyDecision(client, id, 'discard', { reason_code: 'blocked_relationship', expected_decision_version: 0 });
    await applyDecision(client, id, 'restore', { expected_decision_version: 1 });
    assert.equal((await row(id)).decision, null);
  });

  test('a missing discard audit row is an error and changes nothing (AUDIT_MISSING)', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'miss', cls: 'target', decision: 'discarded', version: 4 });
    await refused(applyDecision(client, id, 'restore', { expected_decision_version: 4 }), 'AUDIT_MISSING');
    assert.deepEqual([(await row(id)).decision, (await row(id)).decision_version], ['discarded', 4]);
  });
});

describe('audit table constraints (A5)', () => {
  test('action CHECK, UNIQUE (target_id, decision_version), and append-only', async () => {
    const id = await seedTarget(client, { tag: TAG, n: 'chk' });
    const ins = (/** @type {string} */ action, /** @type {number} */ v) => client.query(`INSERT INTO ic_target_decisions (target_id, action, decision_version) VALUES ($1, $2, $3)`, [id, action, v]);
    // PR5 (migration 027) adds 'approve' to the vocabulary; anything else is still refused.
    for (const [i, a] of ['reclassify', 'discard', 'restore', 'blocked_refused', 'approve'].entries()) await ins(a, i + 1);
    await assert.rejects(ins('send', 9), /check constraint/);
    await assert.rejects(ins('reclassify', 1), /unique|duplicate/);
    await assert.rejects(client.query(`INSERT INTO ic_target_decisions (target_id, action, decision_version, actor) VALUES ($1, 'discard', 20, 'someone')`, [id]), /check constraint/);
    await assert.rejects(client.query(`UPDATE ic_target_decisions SET note = 'edit' WHERE target_id = $1`, [id]), /append-only/);
  });
});

describe('blocked-first after the blocklist changes (A1)', () => {
  const COMPANY = `Zzblocklater ${process.pid} Co`;
  const ADSH = '0000000811-26-000811';
  const cleanLater = async () => {
    await client.query(`DELETE FROM ic_target_signals WHERE source = 'edgar_8k' AND signal->>'company' = $1`, [COMPANY]);
    await client.query(`DELETE FROM ic_targets WHERE company = $1`, [COMPANY]);
  };

  test('a manual target stays a manual target until the company becomes blocked; then it is not-target and cannot be promoted again', async () => {
    await cleanLater();
    try {
      const rules = loadTargetRules(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config'));
      const now = new Date('2026-10-15T12:00:00Z');
      await persistItems(client, [{
        source: 'edgar_8k', key: `${ADSH}|5.02`, outcome: /** @type {const} */ ('parsed'), reason: 'ok', excerpt: 'x', url: indexUrl('999', ADSH), contact: null,
        extracted: { accession: ADSH, file_date: '2026-10-08', parse_outcome: 'parsed' },
        signal: {
          trigger_kind: 'exec_departure', company: COMPANY, aliases: [], acquirer: null, investor: null, pe_firm: null, text: 'CTO resigned',
          evidence_url: indexUrl('999', ADSH), evidence_source: 'edgar_8k', event_date: '2026-10-08', filing_date: '2026-10-08', role: 'Chief Technology Officer',
          departure_ambiguous: false, doc_fetch: 'ok',
        },
      }]);
      const run = (/** @type {any} */ blocked) => classifyPhase({ client, rules, blocked, now, cutoff: '2026-06-01', gapSince: new Date('2026-01-01T00:00:00Z'), dryRun: false, dryItems: [] });
      await run({ entries: [...BUILT_IN_BLOCKED], status: 'ok', error: null });
      const id = Number((await client.query(`SELECT id FROM ic_targets WHERE company = $1`, [COMPANY])).rows[0].id);
      // Force it into needs-review (as a size-unclear row would be), then promote it by hand.
      await client.query(`UPDATE ic_targets SET class = 'needs-review' WHERE id = $1`, [id]);
      await applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'other_verified', expected_decision_version: 0 });
      const eff = async () => (await client.query(`SELECT ${effectiveClassSql('t')} AS e, ${blockedSql('t')} AS b, verdict_rule, decision_class, decision_version FROM ic_targets t WHERE id = $1`, [id])).rows[0];
      assert.equal((await eff()).e, 'target');

      // The blocklist now contains the company. The next run re-classifies the stored signal.
      await run({ entries: [...BUILT_IN_BLOCKED, COMPANY], status: 'ok', error: null });
      const after = await eff();
      assert.equal(after.verdict_rule, 'excl_blocked_company');
      assert.equal(after.b, true);
      assert.equal(after.e, 'not-target', 'blocked wins over the manual target');
      assert.equal(after.decision_class, 'target', 'the run did not touch the manual decision');
      assert.equal(after.decision_version, 1, 'nor the version');
      await refused(applyDecision(client, id, 'reclassify', { to: 'target', reason_code: 'other_verified', expected_decision_version: 1 }), 'BLOCKED_NOT_ELIGIBLE');
    } finally {
      await cleanLater();
    }
  });
});
