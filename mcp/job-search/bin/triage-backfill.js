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
 *
 * **Leftover fit-scoring pass (auto_new band model scoring PR), added after the original build.** After
 * the replay loop above completes, a second pass fit-scores historical rows the deterministic step
 * already marked `status='new'` (via `actor='auto'`) but that never got a `fit_score` -- rows the
 * replay loop's own `RUN_IDS_QUERY` structurally cannot reach, since that query's `l.status IS NULL`
 * guard excludes any row already carrying a status. See `LEFTOVER_FIT_QUERY`'s own doc comment for the
 * exact predicate. This pass reuses `runModelTriage()` directly (zero new triage logic): passing the
 * same id list as both `ids` and `autoNewIds` sends every candidate through the fit-only apply path
 * (src/core/triage.js), identical to how a normal scan's own auto_new ids are handled. `--dry-run`
 * gates this pass exactly like the primary loop above: it prints the candidate count/ids and performs
 * zero writes, `runModelTriage()` is never called, so no `claude` process is ever spawned. Idempotent
 * for the same reason as the primary loop: once a row's `fit_score` is set, it no longer matches
 * `LEFTOVER_FIT_QUERY`.
 *
 * **Review-band leftover fit-scoring pass (jobs-unscored-visibility PR, Change 2), added after the
 * auto_new leftover pass above.** A THIRD, independent pass, run after both passes above complete:
 * fit-scores historical `status='review'` rows that are noise-ok and prescore-in-band but never got a
 * `fit_score` -- backlog rows neither the primary replay loop nor the auto_new leftover pass above can
 * ever reach, since a review row's status is never `IS NULL` (excluded by `RUN_IDS_QUERY`) and is never
 * `'new'` (excluded by `LEFTOVER_FIT_QUERY`). See `LEFTOVER_REVIEW_FIT_QUERY`'s own doc comment for the
 * exact predicate. Reuses `runModelTriage()` the SAME way the auto_new leftover pass does: the same id
 * list as both `ids` and `reviewBandIds` (never `autoNewIds` -- review-band ids use their own
 * `review_fit_*` counters, see src/core/triage.js), so every candidate takes the review-band fit-only
 * apply path, never a bespoke UPDATE (that call shape inherits the FOR-UPDATE guard that makes
 * concurrent scan+backfill safe). `--dry-run` gates this pass exactly like the one above: it prints the
 * candidate count/ids and performs zero writes, `runModelTriage()` is never called, so no `claude`
 * process is ever spawned. Idempotent for the same reason: once a row's `fit_score` is set, it no
 * longer matches `LEFTOVER_REVIEW_FIT_QUERY`.
 */
import { connectDedicated } from '../src/core/db.js';
import { loadConfig, loadTriageCandidateSummary } from '../src/core/config.js';
import { runTriage, loadTriageCandidates, runModelTriage } from '../src/core/triage.js';
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

/**
 * Historical `auto_new` rows the deterministic step already marked `status='new'` (via the `auto`
 * actor) but that never got a fit score -- either because they predate this PR's auto_new
 * fit-scoring, or because a prior run's/backfill's model step was disabled or failed for them. This is
 * a SEPARATE leftover pass from the RUN_IDS_QUERY replay loop above: those rows already carry a
 * non-NULL `status` (the deterministic step's own auto_new mark), so `RUN_IDS_QUERY`'s own
 * `l.status IS NULL` guard already excludes them, they would never be reprocessed by the replay loop
 * no matter how many times it runs.
 *
 * (SHOULD-FIX B8) `coalesce(record_kind,'listing') = 'listing'`, `duplicate_of IS NULL`, and
 * `expired_at IS NULL` mirror the same liveness guards `TRIAGE_CANDIDATE_QUERY`
 * (src/core/triage.js) applies, so this pass never fit-scores a note, a since-merged duplicate, or a
 * since-expired posting. The most-recent-`status`-event `actor='auto'` check (a correlated subquery,
 * the same shape src/dashboard/routes/listings.js already uses for `triagedBy=auto`) is what limits
 * this pass to rows an automated triage pass marked, never a row a human explicitly set to `new`
 * (`mark_jobs`/dashboard), which must never be silently fit-scored by an unattended backfill.
 *
 * Idempotent: once a row's `fit_score` is set (by this pass, a later scan's own auto_new fit-scoring,
 * or a human), `fit_score IS NULL` excludes it from the next run of this query, so re-running this
 * script is always safe.
 */
const LEFTOVER_FIT_QUERY = `
  SELECT l.id
  FROM ic_job_listings l
  WHERE l.status = 'new'
    AND l.fit_score IS NULL
    AND coalesce(l.record_kind,'listing') = 'listing'
    AND l.duplicate_of IS NULL
    AND l.expired_at IS NULL
    AND (
      SELECT e.actor FROM ic_job_events e WHERE e.listing_id = l.id AND e.kind = 'status' ORDER BY e.at DESC, e.id DESC LIMIT 1
    ) = 'auto'
  ORDER BY l.id
`;

/**
 * Historical `status='review'` rows that are noise-ok and prescore-in-band but never got a `fit_score`
 * (jobs-unscored-visibility PR, Change 2) -- a SEPARATE leftover pass from both `RUN_IDS_QUERY`'s replay
 * loop and `LEFTOVER_FIT_QUERY`'s auto_new pass above: a review row's status is never `IS NULL` (so the
 * replay loop's own `l.status IS NULL` guard excludes it) and never `'new'` (so `LEFTOVER_FIT_QUERY`'s
 * own `l.status = 'new'` guard excludes it too). Neither existing pass can ever reach it no matter how
 * many times either runs.
 *
 * The noise/prescore predicate mirrors `classifyForTriage()`'s own `review_band` branch
 * (src/core/triage.js) exactly: `noise_class` in the same `noiseOk` set that function checks
 * (`'ok'`/`'ok_manual'`), and `prescore` between the SAME `config.triage.deterministic.floor`/`ceiling`
 * values passed in as `$1`/`$2` -- never a hardcoded 40/70, so a future config edit changes this query's
 * behavior identically to a live scan's. The liveness guards (`coalesce(record_kind,'listing') =
 * 'listing'`, `duplicate_of IS NULL`, `expired_at IS NULL`) mirror `TRIAGE_CANDIDATE_QUERY`'s own guards
 * for the same reason SHOULD-FIX B8 gave `LEFTOVER_FIT_QUERY` its own copies: this pass never
 * fit-scores a note, a since-merged duplicate, or a since-expired posting.
 *
 * Idempotent: once a row's `fit_score` is set (by this pass, a later scan's own review-band fit-scoring,
 * or a human), `fit_score IS NULL` excludes it from the next run of this query, so re-running this
 * script is always safe.
 */
const LEFTOVER_REVIEW_FIT_QUERY = `
  SELECT l.id
  FROM ic_job_listings l
  WHERE l.status = 'review'
    AND l.fit_score IS NULL
    AND coalesce(l.record_kind,'listing') = 'listing'
    AND l.duplicate_of IS NULL
    AND l.expired_at IS NULL
    AND (l.noise_class = 'ok' OR l.noise_class = 'ok_manual')
    AND l.prescore >= $1
    AND l.prescore <= $2
  ORDER BY l.id
`;

/** Branches loadTriageCandidates() can return that are worth a named bucket in the dry-run report. */
const KNOWN_BRANCHES = ['skip_noise', 'skip_low', 'auto_new', 'model_band', 'has_open_review', 'review_band', 'review_other'];

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

    // Leftover fit-scoring pass (SHOULD-FIX B8/B10), AFTER the replay loop above: historical auto_new
    // rows the deterministic step already marked but that never got a fit score. --dry-run gates this
    // pass exactly like the primary loop: only the candidate count/ids are printed, runModelTriage() is
    // never called, so zero writes happen and no `claude` process is ever spawned.
    const leftoverResult = await client.query(LEFTOVER_FIT_QUERY);
    const leftoverIds = leftoverResult.rows.map((row) => Number(row.id));
    process.stdout.write(`triage-backfill: leftover fit-scoring pass: ${leftoverIds.length} candidate(s): ${JSON.stringify(leftoverIds)}\n`);
    if (args.dryRun) {
      process.stdout.write('triage-backfill: leftover fit-scoring pass: dry-run, no writes performed.\n');
    } else if (leftoverIds.length === 0) {
      process.stdout.write('triage-backfill: leftover fit-scoring pass: nothing to do.\n');
    } else {
      // Reuses runModelTriage() exactly as the replay loop above reuses runTriage(): zero new triage
      // logic. Passing `leftoverIds` as BOTH the `ids` array and the `autoNewIds` set makes every id in
      // this pass take the fit-only apply path (src/core/triage.js), the same path a normal scan's
      // auto_new ids take. `runId: null` is legal (`ic_job_events.run_id` is nullable): no single run_id
      // owns this cross-run pass.
      const candidateSummary = loadTriageCandidateSummary(config.configDir);
      const leftoverStats = await runModelTriage(client, null, leftoverIds, config.triage, config.configDir, candidateSummary, profile, {}, leftoverIds);
      process.stdout.write(`triage-backfill: leftover fit-scoring pass stats: ${JSON.stringify(leftoverStats)}\n`);
    }

    // Review-band leftover fit-scoring pass (jobs-unscored-visibility PR, Change 2), AFTER the auto_new
    // leftover pass above: historical status='review' rows that are noise-ok and prescore-in-band but
    // never got a fit score. --dry-run gates this pass exactly like the one above: only the candidate
    // count/ids are printed, runModelTriage() is never called, so zero writes happen and no `claude`
    // process is ever spawned.
    const { floor, ceiling } = config.triage.deterministic;
    const leftoverReviewResult = await client.query(LEFTOVER_REVIEW_FIT_QUERY, [floor, ceiling]);
    const leftoverReviewIds = leftoverReviewResult.rows.map((row) => Number(row.id));
    process.stdout.write(`triage-backfill: review-band leftover fit-scoring pass: ${leftoverReviewIds.length} candidate(s): ${JSON.stringify(leftoverReviewIds)}\n`);
    if (args.dryRun) {
      process.stdout.write('triage-backfill: review-band leftover fit-scoring pass: dry-run, no writes performed.\n');
    } else if (leftoverReviewIds.length === 0) {
      process.stdout.write('triage-backfill: review-band leftover fit-scoring pass: nothing to do.\n');
    } else {
      // Reuses runModelTriage() the SAME way the auto_new leftover pass above does: zero new triage
      // logic. Passing `leftoverReviewIds` as BOTH the `ids` array and the `reviewBandIds` set (NEVER
      // `autoNewIds`) makes every id in this pass take the review-band fit-only apply path
      // (src/core/triage.js), the same path a normal scan's own review-band ids take. `runId: null` is
      // legal (`ic_job_events.run_id` is nullable): no single run_id owns this cross-run pass.
      const candidateSummary = loadTriageCandidateSummary(config.configDir);
      const leftoverReviewStats = await runModelTriage(client, null, leftoverReviewIds, config.triage, config.configDir, candidateSummary, profile, {}, [], leftoverReviewIds);
      process.stdout.write(`triage-backfill: review-band leftover fit-scoring pass stats: ${JSON.stringify(leftoverReviewStats)}\n`);
    }
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
