#!/usr/bin/env node
// @ts-check
/**
 * Optional, read-mostly backfill for migration 016 (sql/016_listing_salary_period.sql,
 * hourly-disqualifier ruling): fills `ic_job_listings.salary_period` from the row's own `salary_raw` for
 * every row where `salary_period IS NULL` and `salary_raw IS NOT NULL` -- rows scanned/adopted before
 * this migration existed. Reuses `parseSalaryPeriod()` (src/core/normalize.js) exactly, zero new
 * classification logic of its own, so a backfilled row's period always agrees with what a live scan would
 * have written for the same `salary_raw` text.
 *
 * Idempotent: once a row's `salary_period` is set (by this script, a later scan, or a human), the
 * `salary_period IS NULL` predicate excludes it from the next run, so re-running this script after a
 * partial pass, or after new scans have since populated some of the same rows, is always safe.
 *
 * `--dry-run` prints the count and a per-period breakdown of what WOULD be written, without touching the
 * database. `--limit N` caps how many rows are processed in this invocation (oldest id first), for a
 * staged rollout; defaults to unbounded.
 *
 *   node bin/backfill-salary-period.js [--dry-run] [--limit N]
 *
 * Exit 0 on completion (including zero rows to process). Exit 1 on a DB failure.
 *
 * NEVER run this against the real/production database from an automated context -- like every other
 * backfill script in this package (bin/triage-backfill.js, bin/backfill-embeddings.js), it is meant to be
 * invoked deliberately, by hand, against whichever database the caller's connection config points at.
 */
import { connectDedicated } from '../src/core/db.js';
import { parseSalaryPeriod } from '../src/core/normalize.js';
import { errFields } from '../src/core/errors.js';

/** Rows this backfill can ever touch: a live listing/note row is fine either way (record_kind is not
 * filtered here -- salary_period is meaningful for any row carrying salary_raw text, and an unfiltered
 * scan mirrors how normalizeListing() itself never checks record_kind before computing the period). */
const CANDIDATE_QUERY = `
  SELECT id, salary_raw FROM ic_job_listings
  WHERE salary_period IS NULL AND salary_raw IS NOT NULL
  ORDER BY id
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--limit') out.limit = parseInt(argv[++i] ?? '0', 10) || Infinity;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = await connectDedicated();
  let code = 0;
  try {
    const result = await client.query(Number.isFinite(args.limit) ? `${CANDIDATE_QUERY} LIMIT $1` : CANDIDATE_QUERY, Number.isFinite(args.limit) ? [args.limit] : []);
    const rows = result.rows.map((r) => ({ id: Number(r.id), salaryRaw: String(r.salary_raw), period: parseSalaryPeriod(r.salary_raw) }));

    /** @type {Record<string, number>} */
    const counts = { hour: 0, day: 0, week: 0, month: 0, year: 0, unknown: 0 };
    for (const row of rows) counts[row.period]++;

    process.stdout.write(`backfill-salary-period: mode=${args.dryRun ? 'dry-run' : 'live'} candidates=${rows.length} counts=${JSON.stringify(counts)}\n`);

    if (args.dryRun) {
      process.stdout.write('backfill-salary-period: dry-run, no writes performed.\n');
    } else if (rows.length === 0) {
      process.stdout.write('backfill-salary-period: nothing to do.\n');
    } else {
      let updated = 0;
      for (const row of rows) {
        const r = await client.query(
          'UPDATE ic_job_listings SET salary_period = $2 WHERE id = $1 AND salary_period IS NULL',
          [row.id, row.period],
        );
        updated += r.rowCount ?? 0;
      }
      process.stdout.write(`backfill-salary-period: updated ${updated} row(s).\n`);
    }
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`backfill-salary-period: failed: ${f.err_code}: ${f.err_message}\n`);
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

main();
