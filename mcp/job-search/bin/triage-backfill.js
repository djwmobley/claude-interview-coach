#!/usr/bin/env node
// @ts-check
/**
 * One-time backfill: run slice 3 auto-triage (src/core/triage.js) over the pre-existing untriaged
 * backlog. Nightly scans only triage the rows a given run touched, via ic_scan_run_items -- rows that
 * were fetched by runs that predate auto-triage (or by a run where triage itself failed) are never
 * revisited by a later scan, because a later scan's ic_scan_run_items rows belong to a different run_id.
 * This script closes that gap by replaying runTriage() for every historical run_id that still has at
 * least one untriaged, live, non-duplicate listing attached to it.
 *
 * Zero new query paths: this script adds no triage logic of its own. It reuses runTriage(),
 * loadTriageCandidates(), and (through loadTriageCandidates) classifyForTriage() from
 * src/core/triage.js exactly as scan-run.js's executeRun() does, on a fresh dedicated connection, one
 * run at a time.
 *
 * Idempotent / safe to re-run: classifyForTriage() classifies every row from the row's own current
 * state, not from history, so a row a prior backfill pass (or a human, or a nightly scan) already
 * marked reclassifies as already_marked / not_listing / duplicate / expired / has_open_review and is
 * left untouched. Re-running this script after a partial or interrupted pass, or after new scans have
 * since triaged some of the same run_ids, is always safe: it only ever writes to rows still in the
 * untriaged, no-open-review state.
 *
 *   node bin/triage-backfill.js [--profile exec-default] [--dry-run] [--limit-runs N]
 *
 * --profile selects the search profile (keywords/phrases/exclude_terms/locations/remote) passed to the
 * model step's prompt; it does not filter which runs are picked up. --dry-run classifies every
 * candidate row per run and prints counts by branch, without writing to the database or invoking
 * `claude`. --limit-runs caps how many historical run_ids are processed in this invocation, oldest
 * first, for a staged rollout.
 *
 * Exit 0 on completion (including a completion with zero runs to process). Exit 1 on a config load
 * failure, a DB failure, or an unknown --profile. Exit 2 (refusal, no DB writes attempted) when
 * config/triage.json is not present, or config.triage.deterministic.enabled is false -- there is
 * nothing this script can safely do without the deterministic step, since the model step's own
 * candidate list is drawn from the deterministic step's leftover model_band rows. A disabled model step
 * (config.triage.model.enabled false) is not a refusal: a warning prints and the deterministic step
 * still runs, matching how a nightly scan behaves.
 *
 * Run it when no nightly scan is in flight: the model step has no per-row lock of its own.
 */
import { connectDedicated } from '../src/core/db.js';
import { loadConfig } from '../src/core/config.js';
import { runTriage, loadTriageCandidates } from '../src/core/triage.js';
import { errFields, JobSearchError } from '../src/core/errors.js';

/** Every historical run that still has at least one live, non-duplicate, untriaged listing attached. */
const RUN_IDS_QUERY = `
  SELECT DISTINCT i.run_id
  FROM ic_job_listings l
  JOIN ic_scan_run_items i ON i.listing_id = l.id
  WHERE coalesce(l.record_kind,'listing') = 'listing'
    AND l.status IS NULL
    AND l.duplicate_of IS NULL
    AND l.expired_at IS NULL
  ORDER BY i.run_id
`;

/** Branches loadTriageCandidates() can return that are worth a named bucket in the dry-run report. */
const KNOWN_BRANCHES = ['skip_noise', 'skip_low', 'auto_new', 'model_band', 'has_open_review'];

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { profile: 'exec-default', dryRun: false, limitRuns: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') out.profile = String(argv[++i] ?? 'exec-default');
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--limit-runs') out.limitRuns = parseInt(argv[++i] ?? '0', 10) || Infinity;
  }
  return out;
}

/**
 * Minimal profile row for runTriage's model-prompt profile argument (mirrors scan-run.js's
 * loadProfile(), trimmed to the fields runTriage actually reads).
 * @param {import('pg').ClientBase} client
 * @param {string} name
 */
async function loadProfile(client, name) {
  const r = await client.query(
    'SELECT name, keywords, phrases, exclude_terms, locations, remote FROM ic_search_profiles WHERE name = $1',
    [name],
  );
  if (r.rowCount === 0) return null;
  const p = r.rows[0];
  return {
    name: String(p.name),
    keywords: p.keywords ?? [],
    phrases: p.phrases ?? [],
    exclude_terms: p.exclude_terms ?? [],
    locations: p.locations ?? [],
    remote: String(p.remote ?? 'any'),
  };
}

/** @returns {Record<string, number>} */
function emptyDryCounts() {
  return { skip_noise: 0, skip_low: 0, auto_new: 0, model_band: 0, has_open_review: 0, other: 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = loadConfig({ fresh: true });
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`triage-backfill: config failed to load: ${f.err_code}: ${f.err_message}\n`);
    process.exit(1);
    return;
  }

  if (!config.triage.present) {
    process.stdout.write('triage-backfill: refusing to run: config/triage.json is not present.\n');
    process.exit(2);
    return;
  }
  if (!config.triage.deterministic.enabled) {
    process.stdout.write('triage-backfill: refusing to run: config.triage.deterministic.enabled is false.\n');
    process.exit(2);
    return;
  }
  if (!config.triage.model.enabled) {
    process.stderr.write('triage-backfill: warning: config.triage.model.enabled is false; only the deterministic skip/new step will run, model-band rows are left untriaged.\n');
  }

  const client = await connectDedicated();
  let code = 0;
  let processedRuns = 0;
  const dryTotals = emptyDryCounts();
  const liveTotals = { auto_skipped: 0, auto_new: 0, sent_to_model: 0, scored: 0, batches_failed: 0, last_failure_reason: /** @type {string|null} */ (null) };
  try {
    const profile = await loadProfile(client, args.profile);
    if (!profile) {
      throw new JobSearchError('NOT_FOUND', `profile ${args.profile} not found`, {
        hint: 'profiles({action:"list"}) or profiles({action:"upsert", profile:{...}})',
      });
    }

    const runsResult = await client.query(RUN_IDS_QUERY);
    let runIds = runsResult.rows.map((row) => Number(row.run_id));
    if (Number.isFinite(args.limitRuns)) runIds = runIds.slice(0, args.limitRuns);

    process.stdout.write(`triage-backfill: profile=${profile.name} mode=${args.dryRun ? 'dry-run' : 'live'} runs=${runIds.length}\n`);

    for (const runId of runIds) {
      processedRuns++;

      if (args.dryRun) {
        const candidates = await loadTriageCandidates(client, runId, config.triage);
        const counts = emptyDryCounts();
        for (const { result } of candidates) {
          if (KNOWN_BRANCHES.includes(result.branch)) counts[result.branch]++;
          else counts.other++;
        }
        for (const key of Object.keys(counts)) dryTotals[key] += counts[key];
        process.stdout.write(JSON.stringify({ run_id: runId, dry_run: true, counts }) + '\n');
        continue;
      }

      const stats = await runTriage(client, runId, config, profile, {});
      try {
        await client.query('UPDATE ic_scan_runs SET stats = stats || $2::jsonb WHERE id = $1', [runId, JSON.stringify({ triage_backfill: stats })]);
      } catch (err) {
        const f = errFields(err);
        process.stdout.write(`triage-backfill: run ${runId}: stats write failed (triage marks were still applied): ${f.err_code}: ${f.err_message}\n`);
      }
      process.stdout.write(JSON.stringify({ run_id: runId, stats }) + '\n');

      liveTotals.auto_skipped += stats.deterministic.skip_noise + stats.deterministic.skip_low;
      liveTotals.auto_new += stats.deterministic.auto_new;
      liveTotals.sent_to_model += stats.model.batches_sent;
      liveTotals.scored += stats.model.scored;
      liveTotals.batches_failed += stats.model.batches_failed;
      if (stats.model.last_failure_reason) liveTotals.last_failure_reason = stats.model.last_failure_reason;
    }

    if (args.dryRun) {
      process.stdout.write(`triage-backfill: dry-run totals: ${JSON.stringify(dryTotals)}\n`);
    } else {
      process.stdout.write(`triage-backfill: totals: ${JSON.stringify(liveTotals)}\n`);
    }
    process.stdout.write(`triage-backfill: complete: ${processedRuns} run(s) processed.\n`);
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`triage-backfill: failed after ${processedRuns} run(s): ${f.err_code}: ${f.err_message}\n`);
    code = 1;
  } finally {
    await client.end();
  }
  process.exit(code);
}

main();
