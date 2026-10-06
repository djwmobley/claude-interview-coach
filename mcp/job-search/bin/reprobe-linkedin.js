#!/usr/bin/env node
// @ts-check
/**
 * LinkedIn re-probe backfill (spec v1 F1.5, v2 addendum B11). Every LinkedIn listing probed before the
 * page-state classifier shipped was mis-probed (apply_easy_only never persisted; many rows burned all three
 * lifetime attempts on the listing URL). This resets their probe bookkeeping so the NORMAL prepare phase
 * (bin/auto-apply.js runPrepare) re-probes them, highest fit first, under its own cap, budget, and pacing.
 *
 *   node bin/reprobe-linkedin.js [--dry-run] [--limit N]
 *
 * Selection -- the same guards as runPrepare's own candidate query (record_kind listing, not a duplicate,
 * not expired, status untriaged/new/maybe/shortlisted -- so applied/passed/lost/skip/dead/review rows are
 * never touched -- and fit_score >= config/auto-apply.json's probeFitFloor), plus:
 *   source = 'linkedin' AND apply_ats IS NULL
 *   apply_easy_only IS DISTINCT FROM true          -- already Easy Apply: nothing to re-learn
 *   no non-withdrawn application for the listing    -- never disturb an active application
 *   (probe_attempts > 0 OR apply_probed_at IS NOT NULL)  -- only rows a reset actually changes
 * Ordered fit_score DESC, id ASC; --limit N takes the first N.
 *
 * Write: probe_attempts = 0 and apply_probed_at = NULL, and NOTHING else. This script never sets
 * apply_easy_only (true or false) and never loads a page; the classifier decides on the next real probe.
 * The UPDATE re-asserts the selection WHERE, inside one transaction, so a row that changed between the
 * SELECT and the UPDATE is skipped rather than reset.
 *
 * Lock: takes src/core/scan-run.js's LOCK_KEY advisory lock (the one the morning auto-apply prepare phase
 * and every scan hold) with pg_try_advisory_lock, and REFUSES (exit 2, outcome 'locked') while another
 * process holds it. --dry-run takes the lock too, so its listing reflects a quiet moment.
 *
 * Exit codes: 0 ok (reset or dry_run), 1 failure, 2 locked.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { connectDedicated } from '../src/core/db.js';
import { errFields } from '../src/core/errors.js';
import { LOCK_KEY } from '../src/core/scan-run.js';

const USAGE = 'usage: node bin/reprobe-linkedin.js [--dry-run] [--limit N]';

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, limit: number|null, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { dryRun: false, limit: /** @type {number|null} */ (null), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit requires a positive integer (${USAGE})`);
      out.limit = n;
      i++;
    } else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument ${a} (${USAGE})`);
  }
  return out;
}

/** The selection predicate, shared by the SELECT and the re-asserting UPDATE. $1 = probeFitFloor. */
const WHERE = `coalesce(l.record_kind, 'listing') = 'listing' AND l.duplicate_of IS NULL AND l.expired_at IS NULL
  AND (l.status IS NULL OR l.status IN ('new', 'maybe', 'shortlisted'))
  AND l.fit_score >= $1
  AND l.source = 'linkedin' AND l.apply_ats IS NULL
  AND l.apply_easy_only IS DISTINCT FROM true
  AND (l.probe_attempts > 0 OR l.apply_probed_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM ic_job_applications a WHERE a.listing_id = l.id AND a.state <> 'withdrawn')`;

/**
 * @param {import('pg').ClientBase} client
 * @param {{ dryRun: boolean, limit: number|null, probeFitFloor: number, log: (f: Record<string, unknown>) => void, onlyIds?: number[] }} opts
 *   onlyIds: test seam only (restricts the selection to these ids so a shared test DB's other rows are never
 *   touched); the CLI never sets it.
 * @returns {Promise<{ outcome: 'locked'|'dry_run'|'reset', ids: number[], rows: Array<Record<string, unknown>> }>}
 */
export async function runReprobe(client, opts) {
  const got = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
  if (!got.rows[0].ok) {
    opts.log({ evt: 'reprobe_linkedin_locked' });
    return { outcome: 'locked', ids: [], rows: [] };
  }
  try {
    const params = /** @type {unknown[]} */ ([opts.probeFitFloor]);
    let extra = '';
    if (Array.isArray(opts.onlyIds)) {
      params.push(opts.onlyIds);
      extra += ` AND l.id = ANY($${params.length}::int[])`;
    }
    let limitSql = '';
    if (opts.limit !== null) {
      params.push(opts.limit);
      limitSql = ` LIMIT $${params.length}`;
    }
    const sel = await client.query(
      `SELECT l.id, l.fit_score, l.probe_attempts, l.apply_probed_at FROM ic_job_listings l
        WHERE ${WHERE}${extra} ORDER BY l.fit_score DESC NULLS LAST, l.id ASC${limitSql}`,
      params,
    );
    const rows = sel.rows.map((r) => ({ id: Number(r.id), fit_score: r.fit_score, probe_attempts: r.probe_attempts, apply_probed_at: r.apply_probed_at }));
    const ids = rows.map((r) => r.id);
    if (opts.dryRun || ids.length === 0) {
      opts.log({ evt: 'reprobe_linkedin_selected', dry_run: opts.dryRun, count: ids.length });
      return { outcome: opts.dryRun ? 'dry_run' : 'reset', ids, rows };
    }
    await client.query('BEGIN');
    try {
      const upd = await client.query(
        `UPDATE ic_job_listings l SET probe_attempts = 0, apply_probed_at = NULL
          WHERE l.id = ANY($2::int[]) AND ${WHERE} RETURNING l.id`,
        [opts.probeFitFloor, ids],
      );
      await client.query('COMMIT');
      const resetIds = upd.rows.map((r) => Number(r.id)).sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
      opts.log({ evt: 'reprobe_linkedin_reset', count: resetIds.length, selected: ids.length });
      return { outcome: 'reset', ids: resetIds, rows: rows.filter((r) => resetIds.includes(r.id)) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]).catch(() => {});
  }
}

async function main() {
  /** @type {ReturnType<typeof parseArgs>} */
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
    return;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  let config;
  try {
    config = loadConfig({ fresh: true });
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`reprobe-linkedin: config failed to load: ${f.err_code}: ${f.err_message}\n`);
    process.exit(1);
    return;
  }
  const log = (/** @type {Record<string, unknown>} */ f) => process.stderr.write(JSON.stringify(f) + '\n');
  const client = await connectDedicated();
  let code = 0;
  try {
    const r = await runReprobe(client, { dryRun: args.dryRun, limit: args.limit, probeFitFloor: config.autoApply.probeFitFloor ?? 0, log });
    process.stdout.write(JSON.stringify({ outcome: r.outcome, count: r.ids.length, rows: r.rows }, null, 2) + '\n');
    code = r.outcome === 'locked' ? 2 : 0;
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`reprobe-linkedin: failed: ${f.err_code}: ${f.err_message}\n`);
    code = 1;
  } finally {
    await client.end().catch(() => {});
  }
  process.exit(code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
