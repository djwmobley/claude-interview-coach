// @ts-check
/**
 * src/targets/gap-source.js and src/targets/store.js (target finder PR2). Runs against the isolated "_test"
 * database. Listing rows carry company `ZZGAP-<pid> ...`; signal rows carry source `zz-test-gap-<pid>`;
 * everything is deleted afterwards. No network.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { dedupHash } from '../src/core/normalize.js';
import {
  runGapSource, GAP_SQL, GAP_ROW_CAP, GAP_LISTING_CAP, GAP_REASONS, GAP_SOURCE, departureFeedsRanClean,
} from '../src/targets/gap-source.js';
import { persistItems, recordSourceState } from '../src/targets/store.js';
import { createCollector, urlHash, newStats } from '../src/targets/outcomes.js';
import { COMMON_REASONS, OUTCOMES } from '../src/targets/outcomes.js';
import { classifySignal, loadTargetRules } from '../src/core/target-classify.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = loadTargetRules(path.join(HERE, '..', 'config'));
const NOW = '2026-10-15';
const PID = process.pid;
const PFX = `ZZGAP-${PID}`;
const SRC = `zz-test-gap-${PID}`;
/** @type {import('../src/core/target-exclusion.js').BlockedList} */
const OK_LIST = { entries: [...BUILT_IN_BLOCKED], status: 'ok', error: null };
/** @type {pg.Client} */
let client;
let seq = 0;

/**
 * @param {string} name company display name (prefixed)
 * @param {string} title
 * @param {{ daysAgo?: number, absent_runs?: number, duplicate_of?: number|null, url?: string|null, posted?: string|null, description?: string|null, norm?: string, company?: string }} [o]
 */
async function listing(name, title, o = {}) {
  seq += 1;
  const company = o.company ?? `${PFX} ${name}`;
  const norm = o.norm ?? company.toLowerCase();
  const url = o.url === undefined ? `https://boards.example.test/${PID}/${seq}` : o.url;
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, url, url_normalized, source, external_id, record_kind, company_norm, title_norm, location, location_norm, remote_declared, dedup_hash, posted_at, first_seen, last_seen, absent_runs, duplicate_of, description)
     VALUES ($1,$2,$3,$4,$5,$6,'listing',$7,$8,NULL,'legacy-unknown',false,$9,$10, now() - ($11::int * interval '1 day'), now() - ($11::int * interval '1 day'), $12, $13, $14) RETURNING id`,
    [title, company, url ?? `https://nourl.example.test/${PID}/${seq}`, url, SRC, `${SRC}:${seq}`, norm, title.toLowerCase(), dedupHash(norm, `${title.toLowerCase()}-${seq}`, 'legacy-unknown'),
      o.posted ?? null, o.daysAgo ?? 1, o.absent_runs ?? 0, o.duplicate_of ?? null, o.description ?? null],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  await client.query(`UPDATE ic_job_listings SET url_normalized = NULL, external_id = NULL, duplicate_of = NULL, repost_of = NULL WHERE source = $1`, [SRC]);
  await client.query(`DELETE FROM ic_job_listings WHERE source = $1`, [SRC]);
  await client.query(`DELETE FROM ic_target_signals WHERE source LIKE $1`, [`zz-test-gap-${PID}%`]);
  await client.query(`DELETE FROM ic_targets WHERE company_norm LIKE $1`, [`zz-test-gap-${PID}%`]);
  await client.query(`DELETE FROM ic_target_source_state WHERE source LIKE $1`, [`zz-test-gap-${PID}%`]);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
});

const q = (/** @type {string} */ sql, /** @type {unknown[]} */ params) => client.query(sql, params);
/** @param {any} item */
const classify = (item) => classifySignal(item.signal, { rules: RULES, now: NOW, blocked: OK_LIST });

describe('gap source against the database', () => {
  /** @type {Awaited<ReturnType<typeof runGapSource>>} */
  let out;
  /** @param {string} name */
  const mine = (name) => out.items.find((i) => i.signal?.company === `${PFX} ${name}` || i.extracted.company === `${PFX} ${name}`);

  before(async () => {
    // Alpha: a CTO-level listing AND a VP listing (candidate, but the classifier must refuse it).
    await listing('Alpha', 'Vice President of Engineering', { posted: '2026-10-02', description: 'Reports to the CEO.' });
    await listing('Alpha', 'Chief Technology Officer');
    // Beta: VP only (a clean candidate), with two spellings of the company name.
    await listing('Beta', 'VP of Engineering', { posted: '2026-10-05', description: 'x'.repeat(3000) });
    await listing('Beta', 'Senior Software Engineer', { company: `${PFX} Beta Inc`, norm: `${PFX} Beta`.toLowerCase() });
    await listing('Beta', 'Platform Engineer');
    // Delta: duplicate_of set (excluded), Echo: absent_runs 1 (excluded), Foxtrot: last seen 90 days ago (excluded).
    const orig = await listing('Delta', 'VP of Engineering');
    await listing('Delta', 'VP of Engineering', { duplicate_of: orig, url: null });
    await listing('Echo', 'VP of Engineering', { absent_runs: 1 });
    await listing('Foxtrot', 'VP of Engineering', { daysAgo: 90 });
    // Golf: no hiring-leadership listing.
    await listing('Golf', 'Software Engineer');
    // Hotel: confidential company (unresolved).
    await listing('Hotel', 'VP of Engineering', { norm: `confidential:${PFX.toLowerCase()}`, company: 'Confidential' });
    // India: 24 other listings, a CTO-level one, and a VP one: truncated, CTO first.
    await listing('India', 'VP Engineering', { posted: '2026-10-09' });
    await listing('India', 'Chief Information Officer');
    for (let i = 0; i < GAP_LISTING_CAP + 4; i += 1) await listing('India', `Software Engineer ${i}`);
    // Juliet: a hiring VP but no URL on the chosen listing.
    await listing('Juliet', 'Director of Engineering', { url: null });
    // Kilo: VP with a prior departure signal; Lima: VP with none.
    await listing('Kilo', 'VP of Technology Platform');
    await listing('Lima', 'Head of Engineering');
    await client.query(
      `INSERT INTO ic_target_signals (url_hash, source, extracted) VALUES ($1, $2, $3::jsonb)`,
      [`${SRC}-dep`, SRC, JSON.stringify({ trigger_kind: 'exec_departure', parse_outcome: 'parsed', company_norm: `${PFX} Kilo`.toLowerCase(), alias_norms: [] })],
    );
    out = await runGapSource({ query: q, departureFeeds: { fts: { ...newStats() }, k8: { ...newStats() } } });
  });

  test('the query has an explicit ORDER BY and a row cap, and filters live, non-duplicate, recent rows', () => {
    assert.match(GAP_SQL, /ORDER BY company_norm ASC, last_seen DESC, id DESC/);
    assert.match(GAP_SQL, /LIMIT \$1/);
    assert.match(GAP_SQL, /duplicate_of IS NULL/);
    assert.match(GAP_SQL, /absent_runs/);
    assert.match(GAP_SQL, /interval '60 days'/);
    assert.equal(GAP_ROW_CAP, 5000);
  });

  test('excluded rows never appear: duplicate_of, absent_runs, stale last_seen', () => {
    for (const n of ['Echo', 'Foxtrot']) assert.equal(mine(n), undefined, n);
    assert.equal(mine('Delta')?.extracted.listing_count, 1, 'only the original counts; the duplicate_of row is excluded');
  });

  test('Alpha (CTO-level plus VP): a candidate with the CTO-level listing FIRST; the classifier refuses it', () => {
    const it = mine('Alpha');
    assert.ok(it && it.signal);
    assert.equal(it.signal.listings[0].title, 'Chief Technology Officer');
    assert.equal(it.signal.listings.length, 2);
    assert.equal(classify(it).rule, 'gap_cto_level_listing_present');
    assert.equal(it.signal.event_date, '2026-10-02');
  });

  test('Beta (VP only): mapping, description cap, evidence URL, size and employees null, a flagged-unverified target', () => {
    const it = mine('Beta');
    assert.ok(it && it.signal);
    const s = it.signal;
    assert.equal(s.trigger_kind, 'leadership_gap');
    assert.equal(s.company, `${PFX} Beta`, 'the most frequent company string');
    assert.deepEqual(s.aliases, [`${PFX} Beta Inc`]);
    assert.equal(s.size, null);
    assert.equal(s.employees, null);
    assert.equal(s.evidence_source, 'listings');
    assert.match(s.evidence_url, /^https:\/\/boards\.example\.test\//);
    assert.equal(s.event_date, '2026-10-05');
    assert.equal(s.filing_date, null);
    assert.equal(s.listings.find((/** @type {any} */ l) => l.title === 'VP of Engineering').description.length, 2000);
    assert.equal(s.listings_truncated, false);
    assert.equal(s.text, `VP of Engineering ${PFX} Beta`);
    assert.deepEqual(it.listing_ids?.length, 3);
    const v = classify(it);
    assert.deepEqual([v.class, v.rule, v.size_verified], ['target', 'target_all_checks_passed', false]);
  });

  test('Golf (no hiring leadership) and Hotel (confidential) are counted in aggregate, not persisted per group', () => {
    assert.equal(mine('Golf'), undefined);
    assert.equal(mine('Hotel'), undefined);
    assert.ok((out.stats.reasons['out_of_scope:no_hiring_leadership_listing'] ?? 0) >= 1);
    assert.ok((out.stats.reasons['out_of_scope:company_unresolved'] ?? 0) >= 1);
  });

  test('India (more live listings than the cap): truncated, the CTO-level listing is still first, and it is needs-review', () => {
    const it = mine('India');
    assert.ok(it && it.signal);
    assert.equal(it.signal.listings.length, GAP_LISTING_CAP);
    assert.equal(it.signal.listings[0].title, 'Chief Information Officer');
    assert.equal(it.signal.listings_truncated, true);
    assert.equal(it.extracted.truncated, true);
    assert.equal(classify(it).rule, 'gap_cto_level_listing_present');
    assert.ok((out.stats.extra.truncated_groups ?? 0) >= 1);
  });

  test('Juliet: the chosen listing has no URL -> unparseable listing_url_missing', () => {
    const it = out.items.find((i) => i.extracted.company === `${PFX} Juliet`);
    assert.ok(it);
    assert.deepEqual([it.outcome, it.reason, it.signal], ['unparseable', 'listing_url_missing', null]);
  });

  test('departure_signal is informational: true for a known departure, false when both feeds ran clean and none is known, null otherwise', async () => {
    assert.equal(mine('Kilo')?.signal?.departure_signal, true);
    assert.equal(mine('Lima')?.signal?.departure_signal, false);
    assert.equal(classify(mine('Kilo')).class, 'target', 'a known departure does not block the gap target');
    const noFeeds = await runGapSource({ query: q });
    assert.equal(noFeeds.items.find((i) => i.extracted.company === `${PFX} Lima`)?.signal?.departure_signal, null);
    const skipped = await runGapSource({ query: q, departureFeeds: { fts: { ...newStats(), skipped: 'sec_contact_missing' }, k8: { ...newStats() } } });
    assert.equal(skipped.items.find((i) => i.extracted.company === `${PFX} Lima`)?.signal?.departure_signal, null);
    const blocked = await runGapSource({ query: q, departureFeeds: { fts: { ...newStats(), warnings: ['sec_blocked'] }, k8: { ...newStats() } } });
    assert.equal(blocked.items.find((i) => i.extracted.company === `${PFX} Lima`)?.signal?.departure_signal, null);
    assert.equal(departureFeedsRanClean({ fts: newStats(), k8: newStats() }), true);
    assert.equal(departureFeedsRanClean({ fts: newStats(), k8: null }), false);
  });

  test('outcomes are from the closed set and the stats add up', () => {
    const allowed = new Set([...GAP_REASONS, ...COMMON_REASONS, 'ok']);
    for (const it of out.items) {
      assert.ok(OUTCOMES.includes(it.outcome));
      assert.ok(allowed.has(it.reason));
      assert.equal(it.source, GAP_SOURCE);
    }
    assert.equal(out.stats.parsed + out.stats.unparseable + out.stats.out_of_scope, out.stats.raw);
  });
});

describe('gap source row cap (stubbed query)', () => {
  test('rows beyond the cap are dropped, the cap is recorded, and the last group is marked truncated', async () => {
    const rows = Array.from({ length: GAP_ROW_CAP + 1 }, (_, i) => ({
      id: i + 1, title: i === GAP_ROW_CAP - 1 ? 'VP of Engineering' : 'Software Engineer', company: 'Zed Corp', company_norm: i < GAP_ROW_CAP - 1 ? 'acme' : 'zed corp',
      url_normalized: `https://boards.example.test/${i}`, posted_at: null, first_seen: new Date('2026-10-10T00:00:00Z'), last_seen: new Date('2026-10-14T00:00:00Z'), description: null,
    }));
    const calls = /** @type {unknown[][]} */ ([]);
    const out = await runGapSource({ query: async (_sql, params) => { calls.push(params); return { rows }; } });
    assert.deepEqual(calls[0], [GAP_ROW_CAP + 1]);
    assert.equal(out.stats.read, GAP_ROW_CAP);
    assert.equal(out.stats.extra.row_cap_hit, 1);
    assert.ok(out.stats.warnings.includes(`row_cap_hit:${GAP_ROW_CAP}`));
    const zed = out.items.find((i) => i.extracted.company_norm === 'zed corp');
    assert.ok(zed && zed.signal);
    assert.equal(zed.signal.listings_truncated, true);
    assert.equal(classify(zed).rule, 'gap_listings_truncated');
    assert.equal(out.stats.discovery_total, null);
  });
});

describe('store: signal upsert', () => {
  /** @param {Partial<import('../src/targets/outcomes.js').TargetItem> & { key: string }} o @returns {import('../src/targets/outcomes.js').TargetItem} */
  function item(o) {
    const c = createCollector(SRC, ['unknown_shape'], o.extracted?.parser_version ? String(o.extracted.parser_version) : 'v1');
    return c.add(o.outcome ?? 'parsed', o.reason ?? 'ok', { signal: { company: 'Store Co' }, excerpt: 'first excerpt', url: 'https://example.test/a', ...o });
  }
  const rowOf = async (/** @type {string} */ key) => (await client.query(`SELECT * FROM ic_target_signals WHERE url_hash = $1`, [urlHash(SRC, key)])).rows[0];

  test('url_hash is sha256 of "<source>|<key>"; outcome, reason, signal and contact are stored in their columns', async () => {
    const it = item({ key: 'k1', contact: { role: 'CEO', name: 'Jane Roe' } });
    const r = await persistItems(client, [it]);
    assert.deepEqual(r, { inserted: 1, rewritten: 0, touched: 0, superseded: 0 });
    const row = await rowOf('k1');
    assert.equal(row.url_hash, crypto.createHash('sha256').update(`${SRC}|k1`).digest('hex'));
    assert.deepEqual([row.parse_outcome, row.parse_reason, row.source], ['parsed', 'ok', SRC]);
    assert.deepEqual(row.signal, { company: 'Store Co' });
    assert.deepEqual(row.contact, { role: 'CEO', name: 'Jane Roe' });
    assert.equal(row.extracted.parse_outcome, 'parsed');
    assert.equal(row.extracted.parser_version, 'v1');
  });

  test('a re-seen unchanged item only refreshes fetched_at; id and target_id never change', async () => {
    const it = item({ key: 'k2' });
    await persistItems(client, [it]);
    const t = await client.query(`INSERT INTO ic_targets (company, company_norm, class, verdict_rule) VALUES ('S', $1, 'target', 'target_all_checks_passed') RETURNING id`, [`${SRC}-t2`]);
    await client.query(`UPDATE ic_target_signals SET target_id = $1, fetched_at = now() - interval '2 days' WHERE url_hash = $2`, [t.rows[0].id, urlHash(SRC, 'k2')]);
    const before = await rowOf('k2');
    const r = await persistItems(client, [item({ key: 'k2' })]);
    assert.deepEqual(r, { inserted: 0, rewritten: 0, touched: 1, superseded: 0 });
    const after = await rowOf('k2');
    assert.equal(after.id, before.id);
    assert.equal(after.target_id, t.rows[0].id);
    assert.ok(after.fetched_at > before.fetched_at);
    assert.equal(after.content_hash, before.content_hash);
  });

  test('changed content or a new parser_version rewrites extracted and excerpt, still keeping id and target_id', async () => {
    await persistItems(client, [item({ key: 'k3' })]);
    const t = await client.query(`INSERT INTO ic_targets (company, company_norm, class, verdict_rule) VALUES ('S', $1, 'target', 'target_all_checks_passed') RETURNING id`, [`${SRC}-t3`]);
    await client.query(`UPDATE ic_target_signals SET target_id = $1 WHERE url_hash = $2`, [t.rows[0].id, urlHash(SRC, 'k3')]);
    const before = await rowOf('k3');
    const changed = await persistItems(client, [item({ key: 'k3', excerpt: 'second excerpt' })]);
    assert.equal(changed.rewritten, 1);
    const mid = await rowOf('k3');
    assert.equal(mid.excerpt, 'second excerpt');
    assert.equal(mid.id, before.id);
    assert.equal(mid.target_id, t.rows[0].id);
    const bumped = await persistItems(client, [item({ key: 'k3', excerpt: 'second excerpt', extracted: { parser_version: 'v2' } })]);
    assert.equal(bumped.rewritten, 1);
    assert.equal((await rowOf('k3')).extracted.parser_version, 'v2');
  });

  test('an amendment supersedes the original row, and the marker survives a later rewrite of the original', async () => {
    await persistItems(client, [item({ key: 'orig' })]);
    const amend = item({ key: 'amend', supersedes: { source: SRC, key: 'orig' } });
    const r = await persistItems(client, [amend]);
    assert.equal(r.superseded, 1);
    assert.equal((await rowOf('orig')).extracted.superseded_by, 'amend');
    await persistItems(client, [item({ key: 'orig', excerpt: 'changed original' })]);
    const row = await rowOf('orig');
    assert.equal(row.excerpt, 'changed original');
    assert.equal(row.extracted.superseded_by, 'amend');
    const none = await persistItems(client, [item({ key: 'amend2', supersedes: { source: SRC, key: 'does-not-exist' } })]);
    assert.equal(none.superseded, 0);
  });

  test('unparseable and out_of_scope items are persisted too (nothing is silent), with their reason', async () => {
    const c = createCollector(SRC, ['no_pattern_matched', 'html_missing'], 'v1');
    c.add('out_of_scope', 'no_pattern_matched', { key: 'oos', excerpt: 'Local bakery wins award' });
    c.add('unparseable', 'html_missing', { key: 'unp' });
    c.add('unparseable', 'a_reason_nobody_declared', { key: 'coerced' });
    await persistItems(client, c.items);
    assert.deepEqual([(await rowOf('oos')).parse_outcome, (await rowOf('oos')).parse_reason], ['out_of_scope', 'no_pattern_matched']);
    assert.equal((await rowOf('oos')).excerpt, 'Local bakery wins award');
    assert.deepEqual([(await rowOf('unp')).parse_outcome, (await rowOf('unp')).parse_reason], ['unparseable', 'html_missing']);
    assert.equal((await rowOf('coerced')).parse_reason, 'unknown_shape', 'an undeclared reason is coerced to unknown_shape, never stored as-is');
    assert.ok(c.stats.warnings.some((w) => w.startsWith('reason_coerced')));
  });

  test('the stored extracted jsonb is bounded and carries no Cf / bidi characters', async () => {
    const it = item({ key: 'big', extracted: { blob: 'x'.repeat(100_000), evil: 'a\u202Eb\u200Bc', nested: { a: { b: { c: { d: { e: 1 } } } } }, list: Array.from({ length: 100 }, (_, i) => i) } });
    await persistItems(client, [it]);
    const row = await rowOf('big');
    assert.ok(Buffer.byteLength(JSON.stringify(row.extracted)) <= 8192);
    assert.equal(row.extracted.evil, 'abc');
    assert.ok(row.extracted.list.length <= 25);
    assert.ok(row.extracted.blob.length <= 500);
  });
});

describe('store: source state watermark', () => {
  test('a success sets the watermark and last_success_at; a later failure keeps both', async () => {
    const src = `${SRC}-state`;
    await recordSourceState(client, src, { ok: true, status: 'ok', watermark: '2026-10-14' });
    const a = (await client.query(`SELECT * FROM ic_target_source_state WHERE source = $1`, [src])).rows[0];
    assert.equal(a.watermark, '2026-10-14');
    assert.ok(a.last_success_at);
    await recordSourceState(client, src, { ok: false, status: 'sec_blocked' });
    const b = (await client.query(`SELECT * FROM ic_target_source_state WHERE source = $1`, [src])).rows[0];
    assert.equal(b.last_status, 'sec_blocked');
    assert.equal(b.watermark, '2026-10-14');
    assert.deepEqual(b.last_success_at, a.last_success_at);
    await recordSourceState(client, src, { ok: true, status: 'ok', watermark: '2026-10-15' });
    assert.equal((await client.query(`SELECT watermark FROM ic_target_source_state WHERE source = $1`, [src])).rows[0].watermark, '2026-10-15');
  });
});
