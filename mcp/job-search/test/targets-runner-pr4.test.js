// @ts-check
/**
 * Runner behavior added by PR4 (plan 18.6): the upsert never touches a human decision, new evidence on a decided
 * target is a badge and nothing more (A3, O4), a gap target whose listings vanish from a complete snapshot gets a
 * stale-evidence badge without being demoted (O6), the weekly not-target count follows the effective class, and
 * the run row carries per-source status for the Home tile. Isolated "_test" database, synthetic EDGAR, no network.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { loadTargetRules, normalizeName } from '../src/core/target-classify.js';
import { normalizeCompany } from '../src/core/normalize.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { classifyPhase, runTargets } from '../src/targets/runner.js';
import { persistItems } from '../src/targets/store.js';
import { indexUrl } from '../src/targets/edgar-client.js';
import { fastTiming } from './helpers/targets-replay.js';
import { makeWorld } from './helpers/targets-world.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = loadTargetRules(path.join(HERE, '..', 'config'));
const NOW = new Date('2026-10-15T12:00:00Z');
const PID = process.pid;
const OK_LIST = { entries: [...BUILT_IN_BLOCKED], status: /** @type {const} */ ('ok'), error: null };
const CO = (/** @type {string} */ s) => `Zzpr4run${PID} ${s} Co`;
/** @type {pg.Client} */
let client;
/** @type {string} */
let cfgDir;

async function wipe() {
  await client.query(`DELETE FROM ic_target_signals WHERE signal->>'company' LIKE $1 OR url_hash LIKE $2`, [`Zzpr4run${PID}%`, `zzpr4-${PID}-%`]);
  await client.query(`DELETE FROM ic_targets WHERE company LIKE $1`, [`Zzpr4run${PID}%`]);
  await client.query(`DELETE FROM ic_target_runs WHERE trigger = $1`, [`zzpr4-${PID}`]);
}
before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'targets-pr4-'));
  fs.writeFileSync(path.join(cfgDir, 'target-sec-contact.json'), JSON.stringify({ contact: 'Test Person test.person@corp.test' }));
  await wipe();
});
beforeEach(wipe);
after(async () => {
  await wipe();
  await client.end();
  fs.rmSync(cfgDir, { recursive: true, force: true });
});

/** @param {string} company @param {string} adsh @param {string} [eventDate] */
function stored(company, adsh, eventDate = '2026-10-08') {
  return {
    source: 'edgar_8k', key: `${adsh}|5.02`, outcome: /** @type {const} */ ('parsed'), reason: 'ok', excerpt: 'x', url: indexUrl('999', adsh), contact: null,
    extracted: { accession: adsh, file_date: eventDate, parse_outcome: 'parsed' },
    signal: {
      trigger_kind: 'exec_departure', company, aliases: [], acquirer: null, investor: null, pe_firm: null, text: 'CTO resigned',
      evidence_url: indexUrl('999', adsh), evidence_source: 'edgar_8k', event_date: eventDate, filing_date: eventDate, role: 'Chief Technology Officer',
      departure_ambiguous: false, doc_fetch: 'ok',
    },
  };
}
/** @param {Record<string, any>} [over] */
const phase = (over = {}) => classifyPhase({ client, rules: RULES, blocked: OK_LIST, now: NOW, cutoff: '2026-06-01', gapSince: new Date('2026-01-01T00:00:00Z'), dryRun: false, dryItems: [], ...over });
/** @param {string} company */
async function target(company) {
  return (await client.query(`SELECT * FROM ic_targets WHERE company = $1`, [company])).rows[0];
}

describe('the upsert never touches a human decision (A3)', () => {
  test('class and verdict refresh; every decision column and the version stay exactly as the operator left them', async () => {
    const company = CO('Sticky');
    await persistItems(client, [stored(company, '0000000701-26-000701')]);
    await phase();
    const first = await target(company);
    assert.equal(first.class, 'target');
    assert.equal(first.decision_version, 0);
    await client.query(
      `UPDATE ic_targets SET decision = 'reclassified', decision_class = 'not-target', decision_reason = 'not_a_fit', decided_by = 'damian', decided_at = '2026-10-14T10:00:00Z', decision_version = 5, class = 'needs-review', verdict_rule = 'size_not_clearly_in_band' WHERE id = $1`,
      [first.id],
    );
    await phase();
    const t = await target(company);
    assert.equal(t.class, 'target', 'the machine verdict was refreshed');
    assert.equal(t.verdict_rule, 'target_all_checks_passed');
    assert.deepEqual(
      [t.decision, t.decision_class, t.decision_reason, t.decided_by, t.decided_at.toISOString(), t.decision_version],
      ['reclassified', 'not-target', 'not_a_fit', 'damian', '2026-10-14T10:00:00.000Z', 5],
    );
    assert.equal(t.new_evidence_at, null, 'no new signal, so no badge');
  });
});

describe('new evidence is a badge and nothing more (A3, O4)', () => {
  test('a decided target with a NEW linked signal gets new_evidence_at; the decision and class are untouched', async () => {
    const company = CO('Badge');
    await persistItems(client, [stored(company, '0000000702-26-000702', '2026-10-01')]);
    await phase();
    const id = (await target(company)).id;
    await client.query(`UPDATE ic_targets SET decision = 'reclassified', decision_class = 'not-target', decision_version = 2 WHERE id = $1`, [id]);
    await persistItems(client, [stored(company, '0000000703-26-000703', '2026-10-09')]);
    const counts = await phase();
    const t = await target(company);
    assert.ok(t.new_evidence_at instanceof Date);
    assert.equal(counts.new_evidence, 1);
    assert.deepEqual([t.decision, t.decision_class, t.decision_version], ['reclassified', 'not-target', 2]);
    const eff = await client.query(`SELECT coalesce(decision_class, class) AS e FROM ic_targets WHERE id = $1`, [id]);
    assert.equal(eff.rows[0].e, 'not-target', 'the row is not resurfaced');
  });

  test('a discarded row with new evidence stays discarded', async () => {
    const company = CO('Gone');
    await persistItems(client, [stored(company, '0000000704-26-000704', '2026-10-01')]);
    await phase();
    const id = (await target(company)).id;
    await client.query(`UPDATE ic_targets SET decision = 'discarded', decision_version = 1 WHERE id = $1`, [id]);
    await persistItems(client, [stored(company, '0000000705-26-000705', '2026-10-09')]);
    await phase();
    const t = await target(company);
    assert.equal(t.decision, 'discarded');
    assert.ok(t.new_evidence_at instanceof Date);
  });

  test('an undecided target never gets the badge, and a decided one with no new signal does not either', async () => {
    const plain = CO('Plain');
    await persistItems(client, [stored(plain, '0000000706-26-000706', '2026-10-01')]);
    await phase();
    await persistItems(client, [stored(plain, '0000000707-26-000707', '2026-10-09')]);
    await phase();
    assert.equal((await target(plain)).new_evidence_at, null);

    const decided = CO('Quiet');
    await persistItems(client, [stored(decided, '0000000708-26-000708', '2026-10-01')]);
    await phase();
    await client.query(`UPDATE ic_targets SET decision = 'reclassified', decision_class = 'target', decision_version = 1 WHERE company = $1`, [decided]);
    await phase();
    await phase();
    assert.equal((await target(decided)).new_evidence_at, null);
  });
});

describe('stale evidence on gap targets (O6)', () => {
  /** @param {string} company @param {string} fetchedAt */
  async function gapTarget(company, fetchedAt) {
    const t = await client.query(
      `INSERT INTO ic_targets (company, company_norm, class, verdict_rule, trigger_kind) VALUES ($1, $2, 'target', 'target_all_checks_passed', 'leadership_gap') RETURNING id`,
      [company, normalizeCompany(normalizeName(company)).company_norm],
    );
    const id = Number(t.rows[0].id);
    await client.query(
      `INSERT INTO ic_target_signals (url_hash, source, target_id, parse_outcome, fetched_at, signal) VALUES ($1, 'listings', $2, 'parsed', $3::timestamptz, $4::jsonb)`,
      [`zzpr4-${PID}-${id}`, id, fetchedAt, JSON.stringify({ company })],
    );
    return id;
  }
  const SINCE = new Date('2026-10-15T08:00:00Z');

  test('listing signals not refreshed by a COMPLETE gap snapshot mark the target stale; the class and decision are untouched', async () => {
    const id = await gapTarget(CO('Vanished'), '2026-10-10T08:00:00Z');
    await client.query(`UPDATE ic_targets SET decision = 'reclassified', decision_class = 'target', decision_version = 4 WHERE id = $1`, [id]);
    const counts = await phase({ gapSince: SINCE, gapComplete: true });
    const t = (await client.query(`SELECT class, decision, decision_class, decision_version, stale_evidence_at FROM ic_targets WHERE id = $1`, [id])).rows[0];
    assert.ok(t.stale_evidence_at instanceof Date);
    assert.deepEqual([t.class, t.decision, t.decision_class, t.decision_version], ['target', 'reclassified', 'target', 4], 'not demoted');
    assert.ok(counts.stale_marked >= 1);
  });

  test('an incomplete gap run proves nothing: no badge', async () => {
    const id = await gapTarget(CO('Maybe'), '2026-10-10T08:00:00Z');
    await phase({ gapSince: SINCE, gapComplete: false });
    assert.equal((await client.query(`SELECT stale_evidence_at FROM ic_targets WHERE id = $1`, [id])).rows[0].stale_evidence_at, null);
  });

  test('a listing that is refreshed this run is not stale, and a returning one clears the badge', async () => {
    const fresh = await gapTarget(CO('Fresh'), '2026-10-15T09:00:00Z');
    const back = await gapTarget(CO('Back'), '2026-10-10T08:00:00Z');
    await phase({ gapSince: SINCE, gapComplete: true });
    assert.equal((await client.query(`SELECT stale_evidence_at FROM ic_targets WHERE id = $1`, [fresh])).rows[0].stale_evidence_at, null);
    assert.ok((await client.query(`SELECT stale_evidence_at FROM ic_targets WHERE id = $1`, [back])).rows[0].stale_evidence_at);
    await client.query(`UPDATE ic_target_signals SET fetched_at = '2026-10-15T09:30:00Z' WHERE target_id = $1`, [back]);
    await phase({ gapSince: SINCE, gapComplete: true });
    assert.equal((await client.query(`SELECT stale_evidence_at FROM ic_targets WHERE id = $1`, [back])).rows[0].stale_evidence_at, null);
  });

  test('a target that is not a gap target is never marked stale', async () => {
    const company = CO('NotGap');
    await persistItems(client, [stored(company, '0000000709-26-000709')]);
    await phase({ gapSince: SINCE, gapComplete: true });
    assert.equal((await target(company)).stale_evidence_at, null);
  });
});

describe('the weekly not-target count follows the effective class', () => {
  test('blocked rows count, discarded rows and manual targets do not', async () => {
    const base = (await phase()).not_target_week;
    /** @param {string} n @param {Record<string, string|null>} o */
    const add = (n, o) => client.query(
      `INSERT INTO ic_targets (company, company_norm, class, verdict_rule, decision, decision_class) VALUES ($1, $2, $3, $4, $5, $6)`,
      [CO(n), CO(n).toLowerCase(), o.cls, o.rule ?? 'x', o.decision ?? null, o.dc ?? null],
    );
    await add('A', { cls: 'not-target' });
    await add('B', { cls: 'target', rule: 'excl_blocked_company' });
    await add('C', { cls: 'not-target', decision: 'discarded' });
    await add('D', { cls: 'not-target', decision: 'reclassified', dc: 'target' });
    await add('E', { cls: 'target' });
    const counts = await phase();
    assert.equal(counts.not_target_week - base, 2, 'A (machine) and B (blocked) only');
  });
});

describe('the run row carries per-source status for the Home tile', () => {
  test('details.sources holds status, reason and backlog days; the gap source of a clean run is complete', async () => {
    const world = makeWorld();
    const r = await runTargets({ client, now: NOW, configDir: cfgDir, fetch: world.fetch, rules: RULES, blocked: OK_LIST, timing: fastTiming().timing, heartbeatMs: 60_000 }, { source: 'gap', trigger: `zzpr4-${PID}` });
    assert.equal(r.sources.gap.status, 'complete');
    const row = (await client.query(`SELECT details FROM ic_target_runs WHERE id = $1`, [r.run_id])).rows[0];
    assert.equal(row.details.sources.gap.status, 'complete');
    assert.ok('backlog_days' in row.details.sources.gap && 'reason' in row.details.sources.gap);
    assert.ok('new_evidence' in row.details.counts && 'stale_marked' in row.details.counts);
    // The throwaway database may hold gap targets built from its listings; the other target tests wipe these tables too.
    await client.query('DELETE FROM ic_target_signals');
    await client.query('DELETE FROM ic_targets');
  });
});
