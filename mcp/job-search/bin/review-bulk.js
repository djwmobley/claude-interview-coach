#!/usr/bin/env node
// @ts-check
/**
 * Review-queue bulk-resolve CLI (review-bulk spec S3c). Thin wrapper over bulkResolve()
 * (src/tools/review.js): re-queries open review-queue items at execution time and resolves the ones
 * the selected mode picks. 'rule' | 'reason' | 'stale' only ever separate; 'sticky-skip' (sticky-skip
 * spec part C) is the one mode that merges -- into a STICKY-ELIGIBLE root -- instead.
 *
 *   node bin/review-bulk.js --mode rule [--dry-run | --no-dry-run --confirm]
 *   node bin/review-bulk.js --mode reason --reason title_similar_same_company [--dry-run | --no-dry-run --confirm]
 *   node bin/review-bulk.js --mode stale [--dry-run | --no-dry-run --confirm]
 *   node bin/review-bulk.js --mode sticky-skip [--dry-run | --no-dry-run --confirm]
 *   node bin/review-bulk.js --mode scope [--dry-run | --no-dry-run --confirm]
 *
 * `--mode scope` (dedup scope-gate spec C) is the one-time backlog cleanup: merge/repost exact same-source
 * pairs, separate different-location and out-of-scope pairs, leave the rest with a recorded reason. A
 * live run takes the scan advisory lock (exit 1 with a LOCKED message and no changes when a scan holds
 * it), resolves as actor 'auto', then runs deterministic auto-triage over the rows it returned to
 * status null and prints those counts.
 *
 * `--mode reason --reason reopened_skip` is refused: those items now resolve via `--mode sticky-skip`,
 * which re-checks STICKY-ELIGIBLE per candidate instead of separating every reopened_skip row alike.
 *
 * --dry-run is the default (zero writes, prints a preview count table). A live run needs BOTH
 * --no-dry-run AND --confirm; --no-dry-run alone is refused by bulkResolve() itself (dryRun false
 * requires confirm true, enforced server-side, not just here) -- this CLI does not pre-check that itself
 * so there is exactly one place the rule can drift out of sync with the MCP tool and the dashboard route.
 *
 * Exit 0 on a normal run (including zero matching items). Exit 1 on a DB connection failure or a
 * bulkResolve VALIDATION error (bad --mode/--reason, or a live run missing --confirm).
 */
import { loadConfig } from '../src/core/config.js';
import { connectDedicated } from '../src/core/db.js';
import { errFields } from '../src/core/errors.js';
import { bulkResolve } from '../src/tools/review.js';

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ mode: string|null, reason: string|null, dryRun: boolean, confirm: boolean }} */
  const out = { mode: null, reason: null, dryRun: true, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i] ?? null;
    else if (a === '--reason') out.reason = argv[++i] ?? null;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-dry-run') out.dryRun = false;
    else if (a === '--confirm') out.confirm = true;
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bin/review-bulk.js --mode rule|reason|stale|sticky-skip|scope [--reason <reason>] [--dry-run | --no-dry-run --confirm]');
      process.exit(0);
    } else {
      console.error(`unrecognized argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

/** @param {any} out bulkResolve() result for mode 'scope' */
function printScopeTable(out) {
  console.log(`mode: ${out.mode}  dry_run: ${out.dryRun}`);
  console.log(`merged: ${out.counts.merged}`);
  console.log(`reposted: ${out.counts.reposted}`);
  console.log(`separated: ${out.counts.separated}`);
  for (const [rule, n] of Object.entries(out.counts.separated_by_rule)) console.log(`  ${rule}: ${n}`);
  const left = Object.entries(out.counts.leave_by_reason);
  console.log(`left: ${left.reduce((a, [, n]) => a + Number(n), 0)}`);
  for (const [reason, n] of left.sort((a, b) => Number(b[1]) - Number(a[1]))) console.log(`  ${reason}: ${n}`);
  const skipEntries = Object.entries(out.counts.skipped_by_reason);
  if (skipEntries.length) {
    console.log('skipped_by_reason:');
    for (const [reason, n] of skipEntries) console.log(`  ${reason}: ${n}`);
  }
  if (!out.dryRun) console.log(`triage: ${JSON.stringify(out.counts.triage)}`);
  console.log(`errors: ${out.counts.errors}`);
  for (const e of out.ids.errors) console.log(`  error #${e.id}: ${e.message}`);
}

/** @param {Awaited<ReturnType<typeof bulkResolve>>} out */
function printTable(out) {
  if (out.mode === 'scope') {
    printScopeTable(out);
    return;
  }
  console.log(`mode: ${out.mode}  dry_run: ${out.dryRun}`);
  if (out.mode === 'sticky-skip') console.log(`merged: ${out.counts.merged}`);
  else console.log(`separate: ${out.counts.separate}`);
  if (out.counts.left_for_sticky_skip) {
    console.log(`left_for_sticky_skip: ${out.counts.left_for_sticky_skip} (rerun --mode sticky-skip for these)`);
  }
  const leaveEntries = Object.entries(out.counts.leave_by_reason);
  if (leaveEntries.length) {
    console.log('leave_by_reason:');
    for (const [reason, n] of leaveEntries) console.log(`  ${reason}: ${n}`);
  }
  const skipEntries = Object.entries(out.counts.skipped_by_reason);
  if (skipEntries.length) {
    console.log('skipped_by_reason:');
    for (const [reason, n] of skipEntries) console.log(`  ${reason}: ${n}`);
  }
  console.log(`errors: ${out.counts.errors}`);
  if (out.ids.errors.length) {
    for (const e of out.ids.errors) console.log(`  error #${e.id}: ${e.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) {
    console.error('--mode rule|reason|stale|sticky-skip|scope is required');
    process.exit(1);
  }
  /** @type {import('../src/core/config.js').LoadedConfig|null} */
  let config = null;
  try {
    config = loadConfig();
  } catch {
    /* falls back to the same 30-day default bulkResolve() itself uses */
  }
  let client;
  try {
    client = await connectDedicated();
  } catch (err) {
    console.error(JSON.stringify({ ok: false, ...errFields(err) }));
    process.exit(1);
    return;
  }
  const withClient = (/** @type {(c: any) => Promise<any>} */ fn) => fn(client);
  try {
    const scope = args.mode === 'scope';
    const out = await bulkResolve({ withClient }, {
      mode: /** @type {any} */ (args.mode),
      reason: args.reason ?? undefined,
      dryRun: args.dryRun,
      confirm: args.confirm,
      // mode 'scope' resolves as the automated actor (dedup scope-gate spec, "Decisions").
      actor: scope ? 'auto' : 'cli',
      reviewAutoSeparateDays: config ? config.adapters.dedup.reviewAutoSeparateDays : 30,
      stickyFloor: config ? config.triage.deterministic.floor : undefined,
      prescoreFloor: config ? config.triage.deterministic.floor : undefined,
      repostGapDays: config ? config.adapters.dedup.repostGapDays : undefined,
      triageConfig: config && config.triage.present ? config.triage : null,
    });
    printTable(out);
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, ...errFields(err) }));
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
