#!/usr/bin/env node
// @ts-check
/**
 * One-time backfill for the title gate (src/core/title-gate.js): apply the same status change scan ingest
 * makes (src/core/title-gate-apply.js applyTitleGate -> status 'skip', actor 'auto', one status event
 * whose note names the reason) to listings already in the database.
 *
 *   node bin/title-gate-backfill.js            DRY RUN (default): counts by reason, up to 20 sample titles each
 *   node bin/title-gate-backfill.js --apply    perform the change
 *
 * Scope: live listing rows (not a note, not a duplicate, not expired) whose status is null, new, maybe or
 * shortlisted. applyTitleGate then refuses any row with an application row, a latest status event by
 * anyone but 'auto', a status with no event trail, or an open review item (see titleGateBlock); those are
 * counted as "left alone" per reason, never changed. Idempotent: a skipped row is no longer selected.
 * The dry run performs no writes and takes no row locks.
 *
 * Exit 0 on completion, exit 1 on a DB failure.
 */
import { connectDedicated, withTransaction } from '../src/core/db.js';
import { classifyTitle } from '../src/core/title-gate.js';
import { applyTitleGate } from '../src/core/title-gate-apply.js';
import { errFields } from '../src/core/errors.js';

const SAMPLE_LIMIT = 20;

const CANDIDATE_SQL = `
  SELECT l.id, l.title
  FROM ic_job_listings l
  WHERE coalesce(l.record_kind, 'listing') = 'listing'
    AND l.duplicate_of IS NULL
    AND l.expired_at IS NULL
    AND (l.status IS NULL OR l.status IN ('new', 'maybe', 'shortlisted'))
  ORDER BY l.id`;

async function main() {
  const apply = process.argv.includes('--apply');
  const client = await connectDedicated();
  let code = 0;
  try {
    const rows = (await client.query(CANDIDATE_SQL)).rows;
    /** @type {Record<string, { would: number, left: Record<string, number>, samples: string[] }>} */
    const byReason = {};
    let considered = 0;
    let changed = 0;
    for (const { id, title } of rows) {
      considered++;
      const gate = classifyTitle(title);
      if (gate.verdict !== 'drop' || !gate.reason) continue;
      const bucket = (byReason[gate.reason] ??= { would: 0, left: {}, samples: [] });
      const r = apply
        ? await withTransaction(client, (c) => applyTitleGate(c, Number(id), { now: new Date() }))
        : await applyTitleGate(client, Number(id), { dryRun: true });
      if (r.blocked) {
        bucket.left[r.blocked] = (bucket.left[r.blocked] ?? 0) + 1;
        continue;
      }
      bucket.would++;
      if (apply && r.applied) changed++;
      if (bucket.samples.length < SAMPLE_LIMIT) bucket.samples.push(String(title));
    }
    process.stdout.write(`title-gate-backfill: ${apply ? 'APPLY' : 'DRY RUN'}: considered ${considered} live row(s)\n`);
    for (const [reason, b] of Object.entries(byReason)) {
      process.stdout.write(`  ${reason}: ${apply ? 'skipped' : 'would skip'} ${b.would}; left alone ${JSON.stringify(b.left)}\n`);
      for (const t of b.samples) process.stdout.write(`    - ${t}\n`);
    }
    if (Object.keys(byReason).length === 0) process.stdout.write('  no row has a dropping title\n');
    if (apply) process.stdout.write(`title-gate-backfill: ${changed} row(s) changed\n`);
    else process.stdout.write('title-gate-backfill: dry run, no writes performed. Re-run with --apply to change rows.\n');
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`title-gate-backfill: failed: ${f.err_code}: ${f.err_message}\n`);
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

main();
