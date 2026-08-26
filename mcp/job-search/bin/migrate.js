#!/usr/bin/env node
// @ts-check
/**
 * Migration CLI (spec 2.2).
 *
 *   node bin/migrate.js --check            no writes; report columns, collisions, notes, conflicts, invariant
 *   node bin/migrate.js [--notes 53,54,..] apply sql/001-006, mark notes, backfill, queue conflicts,
 *                                          create unique indexes only when the queue has no open legacy conflicts
 *
 * Exit codes: 0 ok, 1 failure, 2 unresolved legacy conflicts (unique indexes NOT created).
 * Output goes to stdout (this is a CLI, not the MCP server).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDedicated, withTransaction } from '../src/core/db.js';
import { normalizeLegacyRow } from '../src/core/normalize.js';
import { errFields } from '../src/core/errors.js';
import { computeProfileRev } from '../src/core/upsert.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');
const MIGRATIONS = ['001_extend_ic_job_listings.sql', '002_search_profiles.sql', '003_scan_runs.sql', '004_review_queue.sql', '005_budget.sql', '006_followups.sql', '007_mark_meta.sql'];
const DEFAULT_NOTE_IDS = [53, 54, 55, 56, 57, 58];

const EXPECTED_COLUMNS = [
  'record_kind', 'source', 'external_id', 'url_normalized', 'dedup_hash', 'company_norm', 'title_norm', 'location',
  'location_norm', 'remote_mode', 'remote_declared', 'salary_min', 'salary_max', 'salary_raw', 'posted_at', 'first_seen',
  'last_seen', 'times_seen', 'absent_runs', 'last_page_index', 'profile_rev', 'description', 'description_hash',
  'search_profile', 'prescore', 'duplicate_of', 'repost_of', 'expired_at', 'stale', 'tsv', 'marked_at',
];
const EXPECTED_TABLES = ['ic_search_profiles', 'ic_scan_runs', 'ic_scan_run_items', 'ic_job_review_queue', 'ic_scan_budget', 'ic_source_state', 'ic_followups'];
const EXPECTED_INDEXES = [
  'ic_job_listings_tsv_idx', 'ic_job_listings_dedup_hash_idx', 'ic_job_listings_title_norm_trgm_idx',
  'ic_job_listings_company_norm_trgm_idx', 'ic_job_listings_status_last_seen_idx',
];
const UNIQUE_INDEXES = ['ic_job_listings_source_ext_uniq', 'ic_job_listings_url_norm_uniq'];
const LEGACY_REASONS = ['legacy_url_conflict', 'legacy_ext_conflict'];

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { check: false, notes: DEFAULT_NOTE_IDS, dsn: /** @type {string|null} */ (null), json: false, seedProfile: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-seed-profile') out.seedProfile = false;
    else if (a === '--notes') {
      const v = argv[++i] ?? '';
      out.notes = v.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    } else if (a === '--dsn') out.dsn = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bin/migrate.js [--check] [--notes 53,54,...] [--dsn <dsn>] [--json] [--no-seed-profile]');
      process.exit(0);
    }
  }
  return out;
}

/** @param {string} line */
function say(line) {
  process.stdout.write(line + '\n');
}

/**
 * @template T
 * @param {T[]} rows
 * @param {(r: T) => string|null} keyFn
 * @returns {Map<string, T[]>}
 */
function groupBy(rows, keyFn) {
  /** @type {Map<string, T[]>} */
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined || k === '') continue;
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

/** @param {import('pg').ClientBase} client */
async function currentColumns(client) {
  const r = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ic_job_listings'`);
  return new Set(r.rows.map((x) => x.column_name));
}
/** @param {import('pg').ClientBase} client */
async function currentTables(client) {
  const r = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  return new Set(r.rows.map((x) => x.table_name));
}
/** @param {import('pg').ClientBase} client */
async function currentIndexes(client) {
  const r = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='ic_job_listings'`);
  return new Set(r.rows.map((x) => x.indexname));
}

/**
 * Load every listing-ish row with only the legacy columns (works pre-migration).
 * @param {import('pg').ClientBase} client
 * @param {Set<string>} cols
 */
async function loadRows(client, cols) {
  const extra = ['record_kind', 'source', 'external_id', 'url_normalized', 'dedup_hash', 'duplicate_of', 'location_norm', 'company_norm', 'title_norm']
    .filter((c) => cols.has(c))
    .map((c) => `, ${c}`)
    .join('');
  const r = await client.query(`SELECT id, title, company, status, url, ad_date, created_at${extra} FROM ic_job_listings ORDER BY id`);
  return r.rows;
}

/**
 * Analyze rows with the real JS normalizers. Pure; used by --check and by apply.
 * @param {any[]} rows
 * @param {number[]} noteIds
 */
function analyze(rows, noteIds) {
  const listings = rows.filter((r) => (r.record_kind ?? 'listing') === 'listing' && !noteIds.includes(r.id));
  const norm = listings.map((r) => ({ row: r, n: normalizeLegacyRow({ id: r.id, title: r.title, company: r.company, url: r.url, source: r.source ?? null }) }));
  const emptyUrl = rows.filter((r) => !r.url || !String(r.url).trim());
  const noteCandidates = rows.filter((r) => (!r.url || !String(r.url).trim()) && r.status === 'active');
  const byKind = groupBy(norm, (x) => x.n.url_kind);
  const bySource = groupBy(norm, (x) => x.n.source);
  const linkedinExt = norm.filter((x) => x.n.external_id && x.n.external_id.startsWith('linkedin:'));
  const urlGroups = [...groupBy(norm, (x) => x.n.url_normalized).entries()].filter(([, v]) => v.length > 1);
  const extGroups = [...groupBy(norm, (x) => (x.n.external_id ? `${x.n.source}|${x.n.external_id}` : null)).entries()].filter(([, v]) => v.length > 1);
  const hashGroups = [...groupBy(norm, (x) => x.n.dedup_hash).entries()].filter(([, v]) => v.length > 1);
  const legacyGroups = [...groupBy(norm, (x) => `${String(x.row.title).toLowerCase().trim()}|${String(x.row.company).toLowerCase().trim()}`).entries()].filter(([, v]) => v.length > 1);
  return { listings, norm, emptyUrl, noteCandidates, byKind, bySource, linkedinExt, urlGroups, extGroups, hashGroups, legacyGroups };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {Set<string>} tables
 */
async function queueInvariant(client, tables) {
  if (!tables.has('ic_job_review_queue')) return { checked: false, violations: [] };
  const r = await client.query(`
    SELECT l.id, count(q.id) FILTER (WHERE q.resolved_at IS NULL) AS open_count
    FROM ic_job_listings l
    LEFT JOIN ic_job_review_queue q ON q.candidate_id = l.id
    WHERE l.status = 'review'
    GROUP BY l.id
    HAVING count(q.id) FILTER (WHERE q.resolved_at IS NULL) <> 1
    ORDER BY l.id`);
  return { checked: true, violations: r.rows.map((x) => ({ id: x.id, open_count: Number(x.open_count) })) };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runCheck(client, args) {
  const cols = await currentColumns(client);
  const tables = await currentTables(client);
  const idx = await currentIndexes(client);
  const missingCols = EXPECTED_COLUMNS.filter((c) => !cols.has(c));
  const missingTables = EXPECTED_TABLES.filter((t) => !tables.has(t));
  const missingIdx = EXPECTED_INDEXES.filter((i) => !idx.has(i));
  const missingUnique = UNIQUE_INDEXES.filter((i) => !idx.has(i));
  const ext = await client.query(`SELECT count(*)::int AS n FROM pg_extension WHERE extname='pg_trgm'`);

  const rows = await loadRows(client, cols);
  const a = analyze(rows, args.notes);

  say(`== migrate --check (no writes) ==`);
  say(`rows: ${rows.length} total, ${a.listings.length} listings analyzed, notes arg: [${args.notes.join(',')}]`);
  say(`pg_trgm enabled: ${ext.rows[0].n > 0}`);
  say(`missing columns (${missingCols.length}): ${missingCols.join(', ') || 'none'}`);
  say(`missing tables (${missingTables.length}): ${missingTables.join(', ') || 'none'}`);
  say(`missing indexes (${missingIdx.length}): ${missingIdx.join(', ') || 'none'}`);
  say(`unique partial indexes present: ${UNIQUE_INDEXES.filter((i) => idx.has(i)).join(', ') || 'none'}; missing: ${missingUnique.join(', ') || 'none'}`);
  say('');
  say(`note candidates (url empty AND status='active'): ${a.noteCandidates.length}`);
  for (const r of a.noteCandidates) say(`  #${r.id} ${r.title} | ${r.company}`);
  say(`empty/whitespace URL rows (normalize to NULL): ${a.emptyUrl.length} -> ids ${a.emptyUrl.map((r) => r.id).join(',')}`);
  say(`url kinds: ${[...a.byKind.entries()].map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
  say(`sources by host: ${[...a.bySource.entries()].map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
  say(`LinkedIn external_ids extracted: ${a.linkedinExt.length}`);
  const invalidNonEmpty = a.norm.filter((x) => x.n.url_kind === 'invalid' && x.row.url && String(x.row.url).trim());
  for (const x of invalidNonEmpty) say(`  invalid non-empty URL #${x.row.id}: ${String(x.row.url).slice(0, 80)}`);
  say('');
  say(`url_normalized conflict groups: ${a.urlGroups.length}`);
  for (const [k, v] of a.urlGroups) say(`  ${k} -> ids ${v.map((x) => x.row.id).join(',')}`);
  say(`(source, external_id) conflict groups: ${a.extGroups.length}`);
  for (const [k, v] of a.extGroups) say(`  ${k} -> ids ${v.map((x) => x.row.id).join(',')}`);
  say(`dedup_hash collision groups (company_norm|title_norm|legacy-unknown): ${a.hashGroups.length}`);
  for (const [, v] of a.hashGroups) say(`  ${v[0].n.company_norm} | ${v[0].n.title_norm} -> ids ${v.map((x) => x.row.id).join(',')}`);
  say(`legacy lower(title)+lower(company) match groups: ${a.legacyGroups.length}`);
  for (const [k, v] of a.legacyGroups) say(`  ${k} -> ids ${v.map((x) => x.row.id).join(',')}`);
  say('');
  const inv = await queueInvariant(client, tables);
  if (!inv.checked) say(`review-queue invariant: not checked (table missing)`);
  else if (inv.violations.length === 0) say(`review-queue invariant: ok (every status='review' row has exactly one open queue row)`);
  else {
    say(`review-queue invariant VIOLATIONS: ${inv.violations.length}`);
    for (const v of inv.violations) say(`  #${v.id} open queue rows=${v.open_count}`);
  }
  if (tables.has('ic_job_review_queue')) {
    const open = await client.query(`SELECT reason, count(*)::int AS n FROM ic_job_review_queue WHERE resolved_at IS NULL GROUP BY reason ORDER BY reason`);
    say(`open queue rows by reason: ${open.rows.map((r) => `${r.reason}=${r.n}`).join(', ') || 'none'}`);
  }
  if (args.json) {
    say(JSON.stringify({
      missingCols, missingTables, missingIdx, missingUnique,
      noteCandidates: a.noteCandidates.map((r) => r.id),
      emptyUrl: a.emptyUrl.map((r) => r.id),
      linkedinExt: a.linkedinExt.length,
      urlGroups: a.urlGroups.map(([k, v]) => [k, v.map((x) => x.row.id)]),
      extGroups: a.extGroups.map(([k, v]) => [k, v.map((x) => x.row.id)]),
      hashGroups: a.hashGroups.map(([, v]) => v.map((x) => x.row.id)),
      invariant: inv,
    }));
  }
  return 0;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runApply(client, args) {
  say(`== migrate apply ==`);
  for (const f of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(SQL_DIR, f), 'utf8');
    await client.query(sql);
    say(`applied ${f}`);
  }

  // Notes: operator-confirmed id list.
  if (args.notes.length) {
    const r = await client.query(`UPDATE ic_job_listings SET record_kind='note' WHERE id = ANY($1::int[]) AND coalesce(record_kind,'listing') <> 'note' RETURNING id, title`, [args.notes]);
    say(`record_kind='note' set on ${r.rowCount} rows: ${r.rows.map((x) => `#${x.id} ${String(x.title).slice(0, 40)}`).join('; ') || '(already set)'}`);
  }

  // Backfill: only rows never backfilled (dedup_hash IS NULL). Idempotent.
  const cols = await currentColumns(client);
  const rows = await loadRows(client, cols);
  const pending = rows.filter((r) => r.dedup_hash === null || r.dedup_hash === undefined);
  const noteRows = pending.filter((r) => r.record_kind === 'note');
  const listingRows = pending.filter((r) => r.record_kind !== 'note');

  await withTransaction(client, async (c) => {
    for (const r of noteRows) {
      await c.query(
        `UPDATE ic_job_listings SET source='manual', url_normalized=NULL, external_id=NULL, location_norm='legacy-unknown',
           posted_at=coalesce(posted_at, ad_date), first_seen=coalesce(created_at, first_seen), last_seen=coalesce(created_at, last_seen)
         WHERE id=$1`,
        [r.id],
      );
    }
    for (const r of listingRows) {
      const n = normalizeLegacyRow({ id: r.id, title: r.title, company: r.company, url: r.url, source: null });
      await c.query(
        `UPDATE ic_job_listings SET
           source=$2, external_id=$3, url_normalized=$4, company_norm=$5, title_norm=$6, location_norm=$7, dedup_hash=$8,
           location=coalesce(location, $9),
           posted_at=coalesce(posted_at, ad_date),
           first_seen=coalesce(created_at, first_seen), last_seen=coalesce(created_at, last_seen)
         WHERE id=$1`,
        [r.id, n.source, n.external_id, n.url_normalized, n.company_norm, n.title_norm, n.location_norm, n.dedup_hash, n.location],
      );
    }
  });
  say(`backfilled ${listingRows.length} listing rows and ${noteRows.length} note rows (rows already backfilled: ${rows.length - pending.length})`);

  // Conflict groups from the stored columns (covers rows backfilled in earlier runs too).
  const urlConf = await client.query(`
    SELECT url_normalized AS key, array_agg(id ORDER BY id) AS ids FROM ic_job_listings
    WHERE url_normalized IS NOT NULL AND duplicate_of IS NULL AND coalesce(record_kind,'listing')='listing'
    GROUP BY url_normalized HAVING count(*) > 1`);
  const extConf = await client.query(`
    SELECT source || '|' || external_id AS key, array_agg(id ORDER BY id) AS ids FROM ic_job_listings
    WHERE external_id IS NOT NULL AND duplicate_of IS NULL AND coalesce(record_kind,'listing')='listing'
    GROUP BY source, external_id HAVING count(*) > 1`);
  let queued = 0;
  for (const [reason, res] of [['legacy_url_conflict', urlConf], ['legacy_ext_conflict', extConf]]) {
    for (const g of /** @type {any} */ (res).rows) {
      const ids = g.ids.map(Number);
      const candidateId = ids[0];
      const matches = ids.slice(1);
      const exists = await client.query(
        `SELECT id FROM ic_job_review_queue WHERE resolved_at IS NULL AND reason=$1 AND candidate_id=$2 AND matches=$3::int[]`,
        [reason, candidateId, matches],
      );
      if (exists.rowCount) continue;
      const status = await client.query(`SELECT status FROM ic_job_listings WHERE id=$1`, [candidateId]);
      await client.query(
        `INSERT INTO ic_job_review_queue (candidate, candidate_id, matches, reason, status_at_create)
         VALUES ($1::jsonb, $2, $3::int[], $4, $5)`,
        [JSON.stringify({ key: g.key, ids }), candidateId, matches, reason, status.rows[0]?.status ?? null],
      );
      queued++;
    }
  }
  say(`conflict groups: url=${urlConf.rowCount} ext=${extConf.rowCount}; newly queued=${queued}`);

  if (args.seedProfile) {
    const seeded = await seedDefaultProfile(client);
    say(`exec-default profile: ${seeded ? 'seeded' : 'already present'}`);
  }

  const open = await client.query(`SELECT id, reason, candidate_id, matches FROM ic_job_review_queue WHERE resolved_at IS NULL AND reason = ANY($1::text[]) ORDER BY id`, [LEGACY_REASONS]);
  if (open.rowCount) {
    say(`UNRESOLVED legacy conflicts: ${open.rowCount}. Unique indexes NOT created. Resolve via review tool, then rerun migrate.`);
    for (const r of open.rows) say(`  queue #${r.id} ${r.reason} candidate #${r.candidate_id} matches [${r.matches.join(',')}]`);
    return 2;
  }
  const uniqueSql = fs.readFileSync(path.join(SQL_DIR, 'unique_indexes.sql'), 'utf8');
  await client.query(uniqueSql);
  say(`unique partial indexes created (zero open legacy conflicts): ${UNIQUE_INDEXES.join(', ')}`);
  return 0;
}

/**
 * Seed exec-default if absent. Values reflect the operator's target roles;
 * the profiles tool can upsert them later.
 * @param {import('pg').ClientBase} client
 */
async function seedDefaultProfile(client) {
  const profile = {
    name: 'exec-default',
    keywords: ['CTO', 'CIO', 'Chief Technology Officer', 'Chief Information Officer', 'Chief Digital Officer', 'Chief AI Officer', 'COO'],
    phrases: ['SVP Digital Transformation', 'VP E-Commerce', 'VP Payments Strategy', 'VP Technology', 'Head of Technology'],
    exclude_terms: ['intern', 'junior', 'analyst', 'coordinator', 'sales representative'],
    locations: ['Houston, TX', 'Dallas, TX', 'Austin, TX', 'United States'],
    remote: 'any',
    posted_within_days: 7,
    max_pages: 3,
    sources: ['greenhouse', 'lever', 'workday', 'indeed', 'linkedin'],
  };
  const rev = computeProfileRev(profile);
  const r = await client.query(
    `INSERT INTO ic_search_profiles (name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (name) DO NOTHING`,
    [profile.name, profile.keywords, profile.phrases, profile.exclude_terms, profile.locations, profile.remote, profile.posted_within_days, profile.max_pages, profile.sources, rev],
  );
  return r.rowCount === 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connectDedicated({ dsn: args.dsn });
  let code = 1;
  try {
    code = args.check ? await runCheck(client, args) : await runApply(client, args);
  } catch (err) {
    const f = errFields(err);
    say(`migrate failed: ${f.err_code}: ${f.err_message}`);
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

main();
