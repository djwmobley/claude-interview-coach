#!/usr/bin/env node
// @ts-check
/**
 * Repair stored descriptions that are really verification, challenge, login or error pages (detail-block
 * fix; listings 12921 and 16451 stored "Additional Verification Required Your Ray ID ..." as a description).
 *
 *   node bin/repair-blocked-descriptions.js                  DRY RUN (default): per-status counts and ids, no writes
 *   node bin/repair-blocked-descriptions.js --apply          write the repair
 *   node bin/repair-blocked-descriptions.js --limit N        stop after N repairable rows
 *   node bin/repair-blocked-descriptions.js --include-applied  also repair rows that have an application or a linked resume
 *   node bin/repair-blocked-descriptions.js --include-unverified  also repair 'unverified' rows (300 to 1199 chars, no job-shape marker);
 *                                                     without it they are reported and left alone, since legitimate short postings land there
 *
 * Every stored description is classified with classifyDetail. For each non-ok row (and, unless
 * --include-applied, only when the row has no application and no linked resume document):
 *   1. before anything is changed, the old text and the columns about to change are written to a backup
 *      JSON file under mcp/job-search/logs/ (apply mode only)
 *   2. description and description_hash are set NULL, detail_outcome is set to the new class (this also
 *      migrates the old 'empty' rows whose text was a block page), and fit_score / fit_basis are set NULL
 *      (any fit was scored against junk)
 *   3. an audit row (first 500 chars of the old text) goes to ic_job_events
 * It does not force an immediate refetch: the normal detail budget refetches newest first, because a row
 * with no description and a non-fetched outcome is eligible again.
 *
 * Exit 0 on completion, exit 1 on a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDedicated, withTransaction } from '../src/core/db.js';
import { errFields } from '../src/core/errors.js';
import { classifyDetail } from '../src/browser/detail-classify.js';
import { clearRejectedDescription } from '../src/core/store-description.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BATCH = 500;

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { apply: false, limit: Infinity, includeApplied: false, includeUnverified: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--include-applied') out.includeApplied = true;
    else if (a === '--include-unverified') out.includeUnverified = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice(8));
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!(out.limit > 0)) throw new Error('--limit must be a positive number');
  return out;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ apply: boolean, limit: number, includeApplied: boolean, includeUnverified?: boolean }} args
 * @param {{ logDir: string, now?: Date, write?: (s: string) => void }} deps
 */
export async function runRepair(client, args, deps) {
  const write = deps.write ?? ((s) => process.stdout.write(s));
  const now = deps.now ?? new Date();
  /** @type {Record<string, number[]>} */
  const repaired = {};
  /** @type {Record<string, number[]>} */
  const skippedApplied = {};
  /** @type {Record<string, number[]>} */
  const reportedOnly = {};
  /** @type {Array<{ id: number, source: string|null, cls: string, description: string, detail_outcome: string|null, fit_score: any, fit_basis: any, description_hash: string|null }>} */
  const plan = [];
  let scanned = 0;
  let lastId = 0;
  let done = false;
  while (!done) {
    const r = await client.query(
      `SELECT l.id, l.source, l.description, l.description_hash, l.detail_outcome, l.fit_score, l.fit_basis,
              (EXISTS (SELECT 1 FROM ic_job_applications a WHERE a.listing_id = l.id)
               OR EXISTS (SELECT 1 FROM ic_job_documents d WHERE d.listing_id = l.id AND d.kind = 'resume')) AS has_application
         FROM ic_job_listings l
        WHERE l.description IS NOT NULL AND l.id > $1
        ORDER BY l.id ASC LIMIT ${BATCH}`,
      [lastId],
    );
    if (r.rowCount === 0) break;
    for (const row of r.rows) {
      lastId = Number(row.id);
      scanned++;
      const cls = classifyDetail({ text: String(row.description), source: row.source });
      if (cls === 'ok') continue;
      // 'unverified' means "300 to 1199 chars with no job-shape marker": it is a soft class that also fits
      // plain, legitimate short postings, so it is reported but not wiped unless asked for.
      if (cls === 'unverified' && !args.includeUnverified) {
        (reportedOnly[cls] ??= []).push(Number(row.id));
        continue;
      }
      if (row.has_application && !args.includeApplied) {
        (skippedApplied[cls] ??= []).push(Number(row.id));
        continue;
      }
      if (plan.length >= args.limit) {
        done = true;
        break;
      }
      (repaired[cls] ??= []).push(Number(row.id));
      plan.push({ id: Number(row.id), source: row.source, cls, description: String(row.description), detail_outcome: row.detail_outcome, fit_score: row.fit_score, fit_basis: row.fit_basis, description_hash: row.description_hash });
    }
  }

  let backupFile = null;
  if (args.apply && plan.length) {
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    fs.mkdirSync(deps.logDir, { recursive: true });
    backupFile = path.join(deps.logDir, `repair-blocked-descriptions-${stamp}.json`);
    // Written and flushed BEFORE the first row changes.
    fs.writeFileSync(backupFile, JSON.stringify({ created_at: now.toISOString(), rows: plan }, null, 2) + '\n');
    for (const p of plan) {
      await withTransaction(/** @type {any} */ (client), (c) => clearRejectedDescription(c, p.id, p.cls, p.description, { now }));
    }
  }

  const mode = args.apply ? 'APPLY' : 'DRY RUN';
  write(`repair-blocked-descriptions: ${mode}: scanned ${scanned} stored description(s)\n`);
  for (const [cls, ids] of Object.entries(repaired)) {
    write(`  ${cls}: ${args.apply ? 'repaired' : 'would repair'} ${ids.length}: ids ${ids.join(', ')}\n`);
  }
  for (const [cls, ids] of Object.entries(skippedApplied)) {
    write(`  ${cls}: skipped ${ids.length} with an application or linked resume (use --include-applied): ids ${ids.join(', ')}\n`);
  }
  for (const [cls, ids] of Object.entries(reportedOnly)) {
    write(`  ${cls}: reported only, ${ids.length} left unchanged (use --include-unverified to repair): ids ${ids.join(', ')}\n`);
  }
  if (!plan.length && !Object.keys(skippedApplied).length && !Object.keys(reportedOnly).length) write('  no stored description classifies non-ok\n');
  if (backupFile) write(`repair-blocked-descriptions: backup written to ${backupFile}\n`);
  if (!args.apply) write('repair-blocked-descriptions: dry run, no writes performed. Re-run with --apply to change rows.\n');
  return { scanned, repaired, skippedApplied, reportedOnly, backupFile, changed: args.apply ? plan.length : 0 };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(`repair-blocked-descriptions: ${errFields(err).err_message}\n`);
    process.exit(1);
    return;
  }
  if (args.help) {
    process.stdout.write('usage: node bin/repair-blocked-descriptions.js [--apply] [--limit N] [--include-applied] [--include-unverified]\n');
    process.exit(0);
    return;
  }
  const client = await connectDedicated();
  let code = 0;
  try {
    await runRepair(client, args, { logDir: path.join(HERE, '..', 'logs') });
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`repair-blocked-descriptions: failed: ${f.err_code}: ${f.err_message}\n`);
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
