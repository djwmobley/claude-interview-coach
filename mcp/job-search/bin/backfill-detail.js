#!/usr/bin/env node
// @ts-check
/**
 * Detail backfill: run a detail fetch (adapter.fetchDetail) over EXISTING ic_job_listings rows that were
 * never fetched, or that failed/emptied on an earlier attempt, without re-running a scan. This closes the
 * gap the LinkedIn gate-lowering PR opened: dropping linkedin's own detailFetchMinPrescore override (now
 * inherits config/adapters.json's run-level 40 instead of 55) makes many already-scanned rows newly
 * eligible for a detail fetch, but a scan only ever detail-fetches rows it sees FRESH on a list page in
 * that run -- a row already sitting in the database at a prescore between 40 and 54 will never be
 * revisited by a future scan just because the gate moved. This script closes that gap directly against
 * the backlog, on demand, without waiting for every affected row to resurface on a list page.
 *
 *   node bin/backfill-detail.js [--dry-run] [--limit N] [--ids=1,2,3] [--source=linkedin]
 *
 * Selection (src/core/dedup.js/src/core/scan-run.js's own liveness/eligibility guards, restated here since
 * this script reads rows the scan pipeline already wrote rather than a fresh list page):
 *   - status IN ('maybe','review','apply') OR the fit-sweep predicate (fix/detail-fit-sweep spec S4:
 *     src/core/detail-fit-sweep.js's fitSweepPredicateSql -- fit_score >= config/auto-apply.json's
 *     fitFloor, an empty description, not a terminal status, not expired/stale/absent, no active
 *     application) -- skipped with --ids (see below), UNIONed rather than replacing the original status
 *     set so a status='new' row that already looks like a good fit is no longer permanently invisible to
 *     this script just because it never crossed detailFetchMinPrescore on a live scan
 *   - expired_at IS NULL AND duplicate_of IS NULL                -- never a stale or merged-away row
 *   - detail_outcome IS DISTINCT FROM 'fetched'                  -- never re-fetch an already-successful row
 *   - detail_attempts < the row's OWN source's effective detailMaxAttempts (per-source override, falling
 *     back to config/adapters.json's run-level default) -- same retry cap src/core/scan-run.js's own
 *     processListing() enforces for a re-queued 'update' row; applied AFTER this query, in JS (see
 *     `candidates` below), uniformly over every returned row regardless of which half of the union it
 *     matched, so a fit-sweep-matched row gets the identical attempts-cap treatment a status-matched row
 *     already did
 *   - the row's source resolves to an adapter that exports fetchDetail at all (lever and gmail do not)
 * Ordered prescore DESC NULLS LAST, id (highest-value rows first, ties broken by insertion order) --
 * UNCHANGED by the fit-sweep union: a fit-sweep-only match is simply interleaved into this same ordering
 * by its own prescore, never given separate priority.
 *
 * --ids=<comma list> targets specific listing ids directly: this bypasses the `status IN (...)` filter
 * (a human can point this script at a specific row regardless of its current status) but NEVER the
 * fetched/attempts/adapter-capability guards above -- an id that already carries detail_outcome='fetched',
 * or that has exhausted its attempts, or whose source has no fetchDetail, is silently excluded from the
 * candidate list exactly as it would be for the ordinary status-driven selection. --source=<name> adds an
 * extra restriction to one source (or, for 'exec', every exec:<slug> board) on top of whichever selection
 * mode is active. --limit N caps how many of the ordered candidates this invocation processes.
 *
 * --dry-run prints every candidate row (id, source, prescore, detail_outcome, detail_attempts, and a
 * `reason` describing why it is still eligible: 'never_fetched' or 'retry_after_<outcome>_<n>_of_<max>')
 * and exits 0 WITHOUT fetching anything or writing to the database.
 *
 * DEDUP BYPASS (mandatory per spec): a live scan's own detail pass re-runs classify() (src/core/dedup.js)
 * against the freshly fetched description, because a description that didn't exist yet at list-collection
 * time can retroactively reveal this listing is a repost or cross-source duplicate of something already in
 * the database (dedup.js's description_hash-keyed matching, see classify()'s branches 0/1b/3/6). This
 * script deliberately NEVER calls classify() at all: fetchDetailNoDedup() below is a lifted equivalent of
 * scan-run.js's own (unexported) tryFetchDetail() that stops after recomputing prescore/noise from the new
 * description, and the write path calls upsert.js's updateListing() DIRECTLY with a synthetic
 * `{ branch: 'backfill-detail' }` decision instead of going through applyDecision() -- updateListing()
 * itself only ever takes the repost/status-inheritance branch when `decision.branch` is literally
 * '1a-repost-same-id' or '1b-repost-same-url' (see its own `repost` local), which this synthetic decision
 * never is, and applyDecision()'s sticky-skip auto-merge (findStickySkipRoot/findStickySkipRootForSameRow)
 * is never reached because applyDecision() itself is never called. A backfilled row can therefore never be
 * merged into another listing, never change status, and never becomes a repost_of/duplicate_of target as a
 * side effect of this script -- exactly the "never call the repost/duplicate merge path" requirement.
 * (This does still update the row's own description_hash, so a LATER real scan's own classify() call can
 * use it for matching, same as it always could once a description existed.)
 *
 * SCAN-CONCURRENCY GUARD: before EACH row's fetch (not only once at startup), this script checks
 * ic_scan_runs for a row with status='running' and a heartbeat within the last 10 minutes. If one is
 * found, the script stops immediately (exit code 2) WITHOUT attempting that row or any row after it --
 * every row already processed earlier in this same invocation was already committed and stays that way.
 *
 * BUDGET_EXHAUSTED (thrown by an adapter's own ctx.reserveDetail() call, same daily detail pool a live
 * scan draws from) is handled per-source, not globally: once a source's daily detail budget is exhausted,
 * every remaining candidate for THAT source in this invocation is finalized as 'skipped_budget' without a
 * further network attempt (mirroring scan-run.js's runDetailPass "queuedSkippedFromHere" behavior), while
 * candidates for OTHER sources continue normally. The script itself always exits 0 for this case (a
 * summary of what was and was not fetched is printed and written to the log file); it is not a failure.
 *
 * Chrome (browser-backed sources, e.g. linkedin): the shared scan Chrome is launched self-healingly
 * (src/core/chrome-launch.js via bin/scan.js's own launchChrome(), the exact function bin/scan.js's CLI
 * itself calls) lazily, the first time this run actually needs a browser session -- never at startup, and
 * never at all for an invocation whose candidates are all fetch-backed sources.
 *
 * Per-row stdout line: `#<id> <source> <outcome> <chars> <reason>` (chars = length of the newly fetched
 * description, 0 when none). Final summary line by outcome, plus logs/backfill-detail-YYYY-MM-DD-HHMM.json
 * carrying the same data as this run's returned summary object.
 *
 * Exit 0: dry-run, or a live run that completed (including one where every candidate outcome was
 * skipped_budget). Exit 1: config/DB failure before any row was attempted. Exit 2: the scan-concurrency
 * guard stopped a live run mid-batch (rows already processed remain committed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getEnv } from '../src/core/config.js';
import { connectDedicated as defaultConnectDedicated } from '../src/core/db.js';
import { JobSearchError, errFields } from '../src/core/errors.js';
import { normalizeListing, DETAIL_MIN_CHARS } from '../src/core/normalize.js';
import { prescore } from '../src/core/prescore.js';
import { classifyNoise, weightedPrescore, getDefaultNoiseRules } from '../src/core/noise.js';
import { updateListing } from '../src/core/upsert.js';
import { buildRegistry, guardedFetch } from '../src/core/urlguard.js';
import { reserveBudget as defaultReserveBudget } from '../src/core/budget.js';
import { makeRateLimiter } from '../src/core/ratelimit.js';
import { connectSession as defaultConnectSession } from '../src/browser/session.js';
import { makeCapability } from '../src/browser/capability.js';
import { resolveSources, USER_AGENT } from '../src/core/scan-run.js';
import { fitSweepPredicateSql } from '../src/core/detail-fit-sweep.js';
import { launchChrome as defaultLaunchChrome } from './scan.js';

const USAGE = 'usage: node bin/backfill-detail.js [--dry-run] [--limit N] [--ids=1,2,3] [--source=name] [--json [out]]';

/** Sources whose adapter has no fetchDetail at all (total classification lives in resolveSources/ADAPTERS; this is just the human-readable exclusion list for the header comment/log). */

/** @param {string} source raw ic_job_listings.source value, e.g. 'linkedin' or 'exec:techco' */
function cfgNameFor(source) {
  return String(source).startsWith('exec:') ? 'exec' : String(source);
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ dryRun: boolean, limit: number, ids: number[]|null, source: string|null, json: string|null|undefined, help: boolean }} */
  const out = { dryRun: false, limit: Infinity, ids: null, source: null, json: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Math.max(0, parseInt(argv[++i] ?? '0', 10) || 0);
    else if (a.startsWith('--limit=')) out.limit = Math.max(0, parseInt(a.slice('--limit='.length), 10) || 0);
    else if (a.startsWith('--ids=')) out.ids = a.slice('--ids='.length).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    else if (a === '--ids') out.ids = String(argv[++i] ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    else if (a.startsWith('--source=')) out.source = a.slice('--source='.length).trim().toLowerCase() || null;
    else if (a === '--source') out.source = String(argv[++i] ?? '').trim().toLowerCase() || null;
    else if (a === '--json') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        out.json = v;
        i++;
      } else out.json = null;
    } else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * Effective detailMaxAttempts for one row's source: per-source override, falling back to the run-level
 * default (mirrors src/core/scan-run.js's own `s.cfg.detailMaxAttempts ?? runCfg.detailMaxAttempts`).
 * @param {string} source
 * @param {import('../src/core/config.js').LoadedConfig} config
 */
function effectiveMaxAttempts(source, config) {
  const cfg = config.adapters.adapters[cfgNameFor(source)];
  return (cfg && cfg.detailMaxAttempts) ?? config.adapters.run.detailMaxAttempts;
}

/**
 * Build the candidate query. `ids` bypasses the status/fit-sweep filter entirely (never the
 * fetched/attempts/capability guards); `source` adds an extra restriction on top of whichever selection
 * mode is active. `fitFloor` (config/auto-apply.json's autoApply.fitFloor) is required whenever `ids` is
 * not given -- it feeds the fit-sweep half of the union (fix/detail-fit-sweep spec S4).
 * @param {{ ids: number[]|null, source: string|null, detailSources: string[], fitFloor: number }} o
 */
function buildCandidateQuery(o) {
  const clauses = [
    `coalesce(record_kind,'listing') = 'listing'`,
    `expired_at IS NULL`,
    `duplicate_of IS NULL`,
    `detail_outcome IS DISTINCT FROM 'fetched'`,
  ];
  /** @type {any[]} */
  const params = [];
  params.push(o.detailSources);
  clauses.push(`(source = ANY($${params.length}::text[]) OR source LIKE 'exec:%')`);
  if (o.ids && o.ids.length) {
    params.push(o.ids);
    clauses.push(`id = ANY($${params.length}::int[])`);
  } else {
    // fix/detail-fit-sweep spec S4: UNION the original status set with the shared fit-sweep predicate,
    // never replace it -- a row matching either half is a candidate, and the fit-sweep half's own status
    // clause (status IS NULL OR status IN ('new','maybe','shortlisted')) already excludes every terminal
    // status on its own, so no terminal status is ever reopened by this union.
    const pred = fitSweepPredicateSql({ paramOffset: params.length, fitFloor: o.fitFloor });
    params.push(...pred.params);
    clauses.push(`(status IN ('maybe','review','apply') OR ${pred.sql})`);
  }
  if (o.source) {
    params.push(o.source);
    clauses.push(`(source = $${params.length} OR ($${params.length} = 'exec' AND source LIKE 'exec:%'))`);
  }
  const sql = `SELECT id, source, external_id, url, url_normalized, title, company, location, remote_mode, remote_declared,
      salary_min, salary_max, salary_raw, posted_at, search_profile, profile_rev, prescore, detail_outcome, detail_attempts, status
    FROM ic_job_listings
    WHERE ${clauses.join(' AND ')}
    ORDER BY prescore DESC NULLS LAST, id`;
  return { sql, params };
}

/**
 * Minimal profile row for prescore()'s keyword/phrase matching (mirrors bin/triage-backfill.js's own
 * loadProfile, trimmed further: prescoreParts only ever reads keywords/phrases).
 * @param {import('pg').ClientBase} client
 * @param {string|null} name
 */
async function loadMiniProfile(client, name) {
  if (!name) return { name: null, keywords: [], phrases: [] };
  const r = await client.query('SELECT name, keywords, phrases FROM ic_search_profiles WHERE name = $1', [name]);
  if (r.rowCount === 0) return { name, keywords: [], phrases: [] };
  const p = r.rows[0];
  return { name: String(p.name), keywords: p.keywords ?? [], phrases: p.phrases ?? [] };
}

/** A synthetic decision that always takes updateListing()'s NON-repost branch (see the header comment's DEDUP BYPASS section): never '1a-repost-same-id'/'1b-repost-same-url', so `repost` inside updateListing() is always false and status/expired_at/absent_runs/stale are never touched. */
function noDedupDecision(id) {
  return { outcome: 'update', branch: 'backfill-detail', target: { id }, inherit: null };
}

/**
 * Lifted equivalent of src/core/scan-run.js's own (unexported) tryFetchDetail -- same outcome
 * classification ('fetched'/'empty'/'error'/'skipped_budget'), but deliberately stops short of
 * classify() (src/core/dedup.js): only prescore/noise are re-derived from the fetched description, never
 * a dedup decision.
 * @param {{ name: string, adapter: import('../src/adapters/base.js').Adapter, cfg: any }} s
 * @param {import('../src/adapters/base.js').AdapterCtx} ctx
 * @param {any} row
 * @param {{ keywords: string[], phrases: string[] }} profile
 * @param {any} noiseRules
 * @param {Set<string>} noiseKnownSources
 */
async function fetchDetailNoDedup(s, ctx, row, profile, noiseRules, noiseKnownSources) {
  /** @type {any} */
  let d = null;
  try {
    d = await s.adapter.fetchDetail({ url: row.url, url_normalized: row.url_normalized, external_id: row.external_id, source: row.source }, ctx);
  } catch (err) {
    if (err instanceof JobSearchError && err.code === 'BUDGET_EXHAUSTED') return { outcome: 'skipped_budget', warning: null };
    return { outcome: 'error', warning: `detail fetch failed for ${row.source} #${row.id}: ${errFields(err).err_code}` };
  }
  if (d && d.reason === 'not_found') return { outcome: 'error', warning: null };
  if (d && d.description) {
    const rec2 = normalizeListing({
      title: row.title, company: row.company, url: row.url, location: row.location,
      remoteMode: row.remote_mode, remoteDeclared: row.remote_declared,
      salaryMin: row.salary_min, salaryMax: row.salary_max, salaryRaw: row.salary_raw,
      postedAt: row.posted_at, source: row.source, description: d.description,
    });
    const psRaw2 = prescore(rec2, profile);
    const noiseClass2 = classifyNoise(rec2, { rules: noiseRules, knownSources: noiseKnownSources });
    const ps2 = weightedPrescore(psRaw2, noiseClass2, { rules: noiseRules });
    const outcome = rec2.description && rec2.description.length >= DETAIL_MIN_CHARS ? 'fetched' : 'empty';
    return { outcome, rec: rec2, ps: ps2, psRaw: psRaw2, noiseClass: noiseClass2, warning: null };
  }
  return { outcome: 'empty', warning: null };
}

/**
 * Run the backfill. Exported so tests can call it directly against a real (test) DB client with injected
 * deps, the same pattern test/scan-run.test.js uses for runScan -- no child-process spawning needed for
 * the DB-backed cases.
 * @param {{ dryRun: boolean, limit: number, ids: number[]|null, source: string|null }} args
 * @param {{ config: any, env: any, fetch?: typeof fetch, lookup?: any, sleep?: (ms:number)=>Promise<void>, random?: () => number, reserveBudget?: typeof defaultReserveBudget, connectSession?: typeof defaultConnectSession, launchChrome?: (env:any, log:any) => Promise<any>, log?: (f:any) => void }} deps
 * @param {import('pg').ClientBase} client
 */
export async function runBackfill(args, deps, client) {
  const config = deps.config;
  const env = deps.env;
  const log = deps.log ?? (() => {});
  const reserve = deps.reserveBudget ?? defaultReserveBudget;
  const connectSession = deps.connectSession ?? defaultConnectSession;
  const launchChromeFn = deps.launchChrome ?? ((e, l) => defaultLaunchChrome(e, l));
  const noiseRules = config.noiseRules ?? getDefaultNoiseRules();
  const noiseKnownSources = new Set(Object.keys(config.adapters.adapters));
  const registry = buildRegistry(config);
  const controller = new AbortController();
  const signal = controller.signal;

  // Sources whose adapter exports fetchDetail at all (spec guard "the source adapter exports fetchDetail").
  const detailSources = Object.entries(config.adapters.adapters)
    .map(([name]) => name)
    .filter((name) => {
      try {
        return Boolean(resolveSources([name], config)[0].adapter.fetchDetail);
      } catch {
        return false;
      }
    });

  const { sql, params } = buildCandidateQuery({ ids: args.ids, source: args.source, detailSources, fitFloor: config.autoApply.fitFloor });
  const rows = (await client.query(sql, params)).rows;

  const maxAttemptsByRow = new Map();
  const candidates = rows.filter((row) => {
    const max = effectiveMaxAttempts(row.source, config);
    maxAttemptsByRow.set(row.id, max);
    return Number(row.detail_attempts ?? 0) < max;
  }).slice(0, Number.isFinite(args.limit) ? args.limit : undefined);

  const rowReason = (row) => {
    if (!row.detail_outcome) return 'never_fetched';
    return `retry_after_${row.detail_outcome}_${row.detail_attempts}_of_${maxAttemptsByRow.get(row.id)}`;
  };

  if (args.dryRun) {
    const printed = candidates.map((row) => ({ id: row.id, source: row.source, prescore: row.prescore, detail_outcome: row.detail_outcome, detail_attempts: row.detail_attempts, reason: rowReason(row) }));
    for (const p of printed) process.stdout.write(`#${p.id} ${p.source} dry-run detail_outcome=${p.detail_outcome ?? 'null'} detail_attempts=${p.detail_attempts} reason=${p.reason}\n`);
    process.stdout.write(`backfill-detail: dry-run: ${printed.length} candidate(s), no writes performed.\n`);
    return { ok: true, code: 0, mode: 'dry-run', candidates: printed.length, processed: 0, by_outcome: {}, rows: printed };
  }

  /** @type {import('../src/browser/session.js').Session|null} */
  let session = null;
  let sessionFailed = false;
  async function getSession() {
    if (session) return session;
    if (sessionFailed) return null;
    try {
      await launchChromeFn(env, log);
    } catch (err) {
      log({ evt: 'chrome_launch_failed', ...errFields(err) });
    }
    try {
      session = await connectSession({ cdpUrl: env.SCAN_CDP_URL });
      await session.reconcile();
      return session;
    } catch (err) {
      sessionFailed = true;
      log({ evt: 'browser_unavailable', ...errFields(err) });
      return null;
    }
  }

  /** @type {Map<string, { name: string, adapter: any, cfg: any, limiter: any, cap: any }>} */
  const bySourceCfg = new Map();
  function limiterAndAdapter(cfgName) {
    let entry = bySourceCfg.get(cfgName);
    if (entry) return entry;
    const [s] = resolveSources([cfgName], config);
    const limiter = makeRateLimiter({ delayMs: s.cfg.delayMs, detailDelayMs: s.cfg.detailDelayMs, backoff: config.adapters.run.backoff, sleep: deps.sleep, random: deps.random });
    entry = { name: s.name, adapter: s.adapter, cfg: s.cfg, limiter, cap: null };
    bySourceCfg.set(cfgName, entry);
    return entry;
  }

  /** @param {string} cfgName */
  function makeCtx(cfgName) {
    const entry = limiterAndAdapter(cfgName);
    const caps_ = { dailyPages: entry.cfg.dailyPages, dailyDetails: entry.cfg.dailyDetails };
    const fetchText = async (url, o = {}) => {
      const method = o.method ?? 'GET';
      const host = new URL(url).hostname.toLowerCase();
      const r = await entry.limiter.withRetry(host, () => guardedFetch(url, registry, {
        method, headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html;q=0.9', ...(o.headers ?? {}) }, body: o.body, source: o.source ?? cfgName, fetch: deps.fetch, lookup: deps.lookup, signal, timeoutMs: 30000,
      }), { signal, onRetry: () => {} });
      return { status: r.status, url: r.url, text: r.text, contentType: r.contentType };
    };
    return {
      signal,
      now: new Date(),
      windowStart: null,
      maxPages: 1,
      fetchText,
      async fetchJson(url, o = {}) {
        const r = await fetchText(url, { ...o, headers: { accept: 'application/json', ...(o.headers ?? {}) } });
        let json = null;
        try {
          json = JSON.parse(r.text);
        } catch {
          json = null;
        }
        return { status: r.status, url: r.url, json };
      },
      async reservePage() {
        throw new JobSearchError('VALIDATION', 'list pages are not fetched by backfill-detail');
      },
      async reserveDetail() {
        const r = await reserve(client, cfgName, { details: 1 }, caps_, new Date());
        if (!r.ok) throw new JobSearchError('BUDGET_EXHAUSTED', `daily detail budget exhausted for ${cfgName}`, { details: { source: cfgName, remaining_details: r.remainingDetails } });
      },
      async capFor(source) {
        if (entry.cap) return entry.cap;
        const s = await getSession();
        if (!s) throw new JobSearchError('BROWSER_UNAVAILABLE', `no browser session available for ${source}`);
        const page = await s.attachPage({ signal });
        // This script never fetches a list page (reservePage() above throws unconditionally), so every
        // navigation through this capability is a detail fetch: onPage always paces on the limiter's
        // detail-scoped wait (detailDelayMs, falling back to delayMs when unset), unlike scan-run.js's
        // capFor() which must switch between the two depending on which pass is currently running.
        entry.cap = makeCapability(page, { registry, source, signal, lookup: deps.lookup, onPage: () => entry.limiter.waitDetail(source, signal) });
        return entry.cap;
      },
      config,
      env: { GOOGLE_TOKEN_FILE: env.GOOGLE_TOKEN_FILE },
      log: (f) => log({ source: cfgName, ...f }),
    };
  }

  const profileCache = new Map();
  async function profileFor(name) {
    if (!profileCache.has(name)) profileCache.set(name, await loadMiniProfile(client, name));
    return profileCache.get(name);
  }

  const byOutcome = { fetched: 0, empty: 0, error: 0, skipped_budget: 0 };
  /** @type {Set<string>} */
  const budgetExhaustedSources = new Set();
  const printedRows = [];
  let processed = 0;
  let stoppedForScanRunning = false;

  for (const row of candidates) {
    // Scan-concurrency guard: checked before EVERY row, not only once at startup.
    const running = await client.query(`SELECT id FROM ic_scan_runs WHERE status = 'running' AND heartbeat_at >= now() - interval '10 minutes' LIMIT 1`);
    if (running.rowCount > 0) {
      stoppedForScanRunning = true;
      break;
    }

    const cfgName = cfgNameFor(row.source);
    const ctx = makeCtx(cfgName);
    /** @type {any} */
    let result;
    if (budgetExhaustedSources.has(cfgName)) {
      result = { outcome: 'skipped_budget', warning: null };
    } else {
      const profile = await profileFor(row.search_profile);
      result = await fetchDetailNoDedup({ name: cfgName, adapter: bySourceCfg.get(cfgName).adapter, cfg: bySourceCfg.get(cfgName).cfg }, ctx, row, profile, noiseRules, noiseKnownSources);
      if (result.outcome === 'skipped_budget') budgetExhaustedSources.add(cfgName);
      if (result.warning) log({ evt: 'backfill_detail_warning', message: result.warning });
    }

    const detailRec = result.rec ?? { salary_min: null, salary_max: null, salary_raw: null, description: null, description_hash: null, posted_at: null, salary_period: null };
    const decision = noDedupDecision(row.id);
    const writeCtx = {
      now: new Date(),
      pageIndex: null,
      profileRev: null,
      prescore: result.ps ?? null,
      prescoreRaw: result.psRaw ?? null,
      noiseClass: result.noiseClass ?? null,
      detailSkipped: result.outcome === 'skipped_budget',
      detailOutcome: result.outcome,
    };
    await updateListing(client, detailRec, decision, writeCtx, { bumpTimesSeen: false });

    byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1;
    processed++;
    const chars = result.rec && result.rec.description ? result.rec.description.length : 0;
    const reason = result.warning ?? (result.outcome === 'fetched' ? 'ok' : result.outcome === 'skipped_budget' ? 'daily_detail_budget_exhausted' : result.outcome === 'empty' ? 'no_usable_description' : 'fetch_error');
    process.stdout.write(`#${row.id} ${row.source} ${result.outcome} ${chars} ${reason}\n`);
    printedRows.push({ id: row.id, source: row.source, outcome: result.outcome, chars, reason });
  }

  process.stdout.write(`backfill-detail: complete: ${processed} of ${candidates.length} candidate(s) processed: ${JSON.stringify(byOutcome)}\n`);
  if (stoppedForScanRunning) process.stdout.write(`backfill-detail: stopped: a scan run is currently in progress (rows already processed above remain committed).\n`);

  return {
    ok: true,
    code: stoppedForScanRunning ? 2 : 0,
    mode: 'live',
    candidates: candidates.length,
    processed,
    by_outcome: byOutcome,
    stopped_for_scan_running: stoppedForScanRunning,
    rows: printedRows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  let config;
  try {
    config = loadConfig({ fresh: true });
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`backfill-detail: config failed to load: ${f.err_code}: ${f.err_message}\n`);
    process.exit(1);
    return;
  }
  const env = getEnv();
  const log = (f) => process.stderr.write(JSON.stringify(f) + '\n');

  const client = await defaultConnectDedicated();
  let result;
  let code = 0;
  try {
    result = await runBackfill(args, { config, env, log }, client);
    code = result.code;
  } catch (err) {
    const f = errFields(err);
    process.stdout.write(`backfill-detail: failed: ${f.err_code}: ${f.err_message}\n`);
    result = { ok: false, ...f };
    code = 1;
  } finally {
    await client.end();
  }

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const logDir = env.JOBSEARCH_LOG_DIR;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `backfill-detail-${stamp}.json`), JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`backfill-detail: failed to write log file: ${errFields(err).err_message}\n`);
  }

  if (args.json !== undefined) {
    const file = args.json ?? path.join(logDir, `backfill-detail-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  }

  process.exit(code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
