// @ts-check
/**
 * The scan run loop (spec sections 4, 5, 6). Shared by the search_jobs
 * tool (trigger 'mcp'), bin/scan.js (trigger 'cli' or, from the dashboard, 'dashboard').
 *
 * Order of operations:
 *   1. validate sources against config + adapter registry
 *   2. pg_try_advisory_lock on a DEDICATED client (released in finally);
 *      contention returns {ok:false, status:'locked'} in under a second
 *   3. reaper: running rows with a stale heartbeat become failed
 *   4. insert the ic_scan_runs row (wait=false returns {run_id} here)
 *   5. profile-change reset of absent_runs, then adoption of Python-inserted
 *      rows (spec 2.2 item 5), both skipped on dryRun
 *   6. fan-out plan and per-run cap (BUDGET_EXCEEDED refuses the run)
 *   7. per source: enabled check, scheduler drives the adapter; every
 *      listing is normalized, prescored, classified, optionally detail
 *      fetched (prescore gate + details budget), embedded, and persisted in
 *      its own transaction; every page reserves daily budget first
 *   8. expiry pass per completed source (spec 3.2 rules)
 *   9. finalize the run row, close pages, disconnect, unlock
 *   10. slice 3 auto-triage (docs/slice3-auto-triage-spec.md): AFTER the advisory lock releases and this
 *       run's own client closes, on a fresh dedicated connection -- deterministic skip/new routing, then
 *       a gated claude -p fit-scoring step for the plausible middle band. Never runs for a dry run; never
 *       changes this run's own status/exit code, only stats.triage.
 *
 * Network side effects are identical with dryRun; only database writes for
 * listings, queue, run items, expiry, and adoption are skipped (the run row
 * and the daily budget are still written, since the network activity is
 * real).
 */
import { loadConfig, getEnv } from './config.js';
import { connectDedicated as defaultConnectDedicated, withTransaction } from './db.js';
import { JobSearchError, errFields } from './errors.js';
import { log as defaultLog } from './logger.js';
import { normalizeListing } from './normalize.js';
import { classify, makePgLookups } from './dedup.js';
import { applyDecision, adoptUnclassifiedRows } from './upsert.js';
import { prescore } from './prescore.js';
import { classifyNoise, weightedPrescore, getDefaultNoiseRules } from './noise.js';
import { embedSafe, embeddingText } from './embed.js';
import { compactRows, capResponse, MAX_ROWS, MAX_RESPONSE_CHARS, untrustedRows, ROWS_WRAP_OVERHEAD_CHARS } from './compact.js';
import { buildRegistry, guardedFetch } from './urlguard.js';
import { planPages, assertPlanWithinCap, reserveBudget } from './budget.js';
import { makeRateLimiter } from './ratelimit.js';
import { runSearch } from './scheduler.js';
import { classifyPage, recordWall, recordClean, sourceEnabled } from '../browser/wall.js';
import { connectSession as defaultConnectSession, applyTargetMarkerPath } from '../browser/session.js';
import { makeCapability } from '../browser/capability.js';
import { ADAPTERS, getAdapter } from '../adapters/index.js';
import { runTriage } from './triage.js';
import { persistApplyTargetForListing, buildScanProbeRegistry } from './apply-target-persist.js';

/** Advisory lock key shared by MCP and CLI (spec section 5). */
export const LOCK_KEY = 730193001;
export const HEARTBEAT_MS = 20000;
export const USER_AGENT = 'job-search-mcp/0.1 (interview-coach; read-only scanner)';

/**
 * @typedef {Object} RunArgs
 * @property {string} profile
 * @property {string[]} [sources]
 * @property {number} [postedWithinDays]
 * @property {number} [maxPages]
 * @property {boolean} dryRun
 * @property {number} [limit]
 * @property {number} [minPrescore]
 * @property {boolean} [wait]
 */

/**
 * @typedef {Object} RunDeps
 * @property {import('./config.js').LoadedConfig|null} [config]
 * @property {import('./config.js').Env} [env]
 * @property {() => Promise<import('pg').Client>} [connectDedicated]
 * @property {(opts: { cdpUrl: string }) => Promise<import('../browser/session.js').Session>} [connectSession]
 * @property {typeof fetch} [fetch]
 * @property {import('./urlguard.js').Lookup} [lookup]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {() => number} [random]
 * @property {typeof reserveBudget} [reserveBudget] tests inject an in-memory reservation so fixture runs never consume the real daily budget
 * @property {Function} [execFile] slice 3 auto-triage's model step (src/core/triage.js's runModelTriage)
 *   seam for a fake `claude` CLI script in tests, mirroring render.js's `opts.execFile` pattern. The
 *   binary NAME is separately overridable via the JOBSEARCH_TRIAGE_CLAUDE_BIN env var (mirrors
 *   JOBSEARCH_FIXTURE_MAP), for a child-process-level test that cannot pass a JS function across the
 *   process boundary.
 */

/**
 * @typedef {Object} RunOpts
 * @property {'mcp'|'cli'|'dashboard'} trigger
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [progress]
 * @property {(fields: Record<string, string|number|boolean|null>) => void} [log]
 * @property {AbortSignal} [signal] external cancel (SIGINT)
 * @property {Date} [now]
 * @property {(runId: number) => void} [onRunStarted] fired synchronously right after the ic_scan_runs
 *   INSERT returns (dashboard PR 2's marker-file correlation: bin/scan.js's `--run-marker` writes the
 *   run id to a file from this callback, before any further work happens, so the dashboard never
 *   correlates a spawn by timing).
 * @property {Array<{ source: string|null, code: string, severity: 'warning', [k: string]: any }>} [preRunWarnings]
 *   Warnings the caller already knows about before this run even started (scan-never-skip fix): a
 *   config-lock mismatch, an unlocked rubric, or a self-healed/failed Chrome launch, all discovered in
 *   bin/scan.js before runScan() is called. Seeded into this run's own `errors` array at the very start of
 *   executeRun() so they land in the same finalize UPDATE as everything else and are visible on the run row
 *   -- but status computation ignores every entry whose `severity` is 'warning', so a run carrying ONLY
 *   these stays 'ok'.
 */

/**
 * @typedef {Object} RunStats
 * @property {number} fetched
 * @property {number} new
 * @property {number} updated
 * @property {number} cross_source_dup
 * @property {number} repost
 * @property {number} ambiguous
 * @property {number} errors
 * @property {number} unembedded
 * @property {number} stale_dropped
 * @property {number} detail_fetched
 * @property {number} detail_skipped_budget rows queued for a detail fetch (outcome new/ambiguous, prescore gate met) but skipped because the source's daily/per-run budget ran out mid-source (spec R4.2, decision 22)
 * @property {number} dedup_sticky_skip_merged rows that would otherwise have created a review-queue row
 *   but instead auto-merged into a STICKY-ELIGIBLE skip/passed/lost root (sticky-skip spec part B,
 *   src/core/upsert.js's findStickySkipRoot()); also counted under `cross_source_dup` above, since the
 *   persisted shape is the same (a new row, duplicate_of the root, no queue entry) -- this is the count
 *   of that subset specifically caused by sticky-skip rather than an ordinary corroborated cross-source
 *   match.
 * @property {number} adopted
 * @property {number} expired
 * @property {Record<string, number>} pages_by_source
 */

/** @param {unknown} err */
function errRecord(err, source = null) {
  const f = errFields(err);
  const details = err instanceof JobSearchError ? err.details : {};
  return { source, code: f.err_code, message: f.err_message, ...(details && typeof details === 'object' ? { details } : {}) };
}

/**
 * Load a profile row and apply per-run overrides.
 * @param {import('pg').ClientBase} client
 * @param {RunArgs} args
 */
async function loadProfile(client, args) {
  const r = await client.query('SELECT name, keywords, phrases, exclude_terms, locations, remote, posted_within_days, max_pages, sources, rev FROM ic_search_profiles WHERE name = $1', [args.profile]);
  if (r.rowCount === 0) throw new JobSearchError('NOT_FOUND', `profile ${args.profile} not found`, { hint: 'profiles({action:"list"}) or profiles({action:"upsert", profile:{...}})' });
  const p = r.rows[0];
  return {
    name: String(p.name),
    keywords: p.keywords ?? [],
    phrases: p.phrases ?? [],
    exclude_terms: p.exclude_terms ?? [],
    locations: p.locations ?? [],
    remote: String(p.remote ?? 'any'),
    posted_within_days: Number(args.postedWithinDays ?? p.posted_within_days ?? 7),
    max_pages: Number(args.maxPages ?? p.max_pages ?? 3),
    sources: p.sources ?? [],
    rev: String(p.rev),
  };
}

/**
 * Resolve and validate the sources for a run. Total: every name maps to a
 * known adapter with config, or the run is refused.
 * @param {string[]} names
 * @param {import('./config.js').LoadedConfig} config
 */
export function resolveSources(names, config) {
  const out = [];
  for (const raw of names) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    const adapter = getAdapter(name);
    const cfg = config.adapters.adapters[name];
    if (!cfg) throw new JobSearchError('CONFIG_INVALID', `source ${name} has no entry in adapters.json`);
    if (!out.some((s) => s.name === name)) out.push({ name, adapter, cfg });
  }
  if (out.length === 0) throw new JobSearchError('VALIDATION', 'no sources selected', { hint: `sources: one or more of ${Object.keys(ADAPTERS).join(', ')}` });
  return out;
}

/**
 * Run a scan. Never throws for per-source problems; run-level failures are
 * recorded on the run row and returned as {ok:false}.
 * @param {RunArgs} args
 * @param {RunDeps} deps
 * @param {RunOpts} opts
 * @returns {Promise<object>}
 */
export async function runScan(args, deps, opts) {
  const log = opts.log ?? ((f) => defaultLog.info(f));
  const progress = opts.progress ?? (() => {});
  const config = deps.config ?? loadConfig();
  const env = deps.env ?? getEnv();
  const connectDedicated = deps.connectDedicated ?? (() => defaultConnectDedicated());
  const connectSession = deps.connectSession ?? defaultConnectSession;
  const now = opts.now ?? new Date();
  const dryRun = Boolean(args.dryRun);

  // 1. explicit sources are validated before any connection (unknown names never touch the DB or the lock)
  if (args.sources && args.sources.length > 0) resolveSources(args.sources, config);

  // 2. dedicated lock client
  const client = await connectDedicated();
  let locked = false;
  let handedOff = false; // executeRun owns unlock + end once started
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [LOCK_KEY]);
    locked = Boolean(lockRes.rows[0].ok);
    if (!locked) {
      log({ evt: 'scan_locked', trigger: opts.trigger });
      return { ok: false, status: 'locked', hint: 'another scan holds the lock; scans({action:"status", last:1}) shows it, or retry later' };
    }
    const profile = await loadProfile(client, args);
    const sources = resolveSources(args.sources && args.sources.length > 0 ? args.sources : profile.sources, config);

    // 3. reaper
    const reaped = await client.query(
      `UPDATE ic_scan_runs SET status = 'failed', finished_at = now(), errors = errors || '[{"code":"STALE_HEARTBEAT"}]'::jsonb
       WHERE status = 'running' AND heartbeat_at < now() - ($1::int * interval '1 minute') RETURNING id`,
      [config.adapters.run.heartbeatStaleMinutes],
    );
    if (reaped.rowCount) log({ evt: 'runs_reaped', count: reaped.rowCount });

    // 4. run row
    const ins = await client.query(
      `INSERT INTO ic_scan_runs (profile, profile_rev, trigger, dry_run, config_hash, status) VALUES ($1, $2, $3, $4, $5, 'running') RETURNING id, started_at`,
      [profile.name, profile.rev, opts.trigger, dryRun, config.hash],
    );
    const runId = Number(ins.rows[0].id);
    if (opts.onRunStarted) {
      try {
        opts.onRunStarted(runId);
      } catch (err) {
        log({ evt: 'on_run_started_failed', run_id: runId, ...errFields(err) });
      }
    }
    log({ evt: 'run_started', run_id: runId, profile: profile.name, trigger: opts.trigger, dry_run: dryRun, sources: sources.map((s) => s.name).join(',') });

    const execute = () => executeRun({ client, runId, profile, sources, config, env, args, deps, opts, log, progress, now, connectSession });
    handedOff = true;
    if (args.wait === false) {
      // Detach: the lock and client are released by executeRun's finally.
      execute().catch((err) => log({ evt: 'run_detached_failed', run_id: runId, ...errFields(err) }));
      return { ok: true, run_id: runId, status: 'running', hint: `scans({action:"status", run_id:${runId}}) to poll; query_jobs({runId:${runId}}) for rows` };
    }
    return await execute();
  } finally {
    if (!handedOff) {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
        } catch {
          /* connection gone */
        }
      }
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {{ client: import('pg').Client, runId: number, profile: any, sources: Array<{ name: string, adapter: import('../adapters/base.js').Adapter, cfg: any }>, config: import('./config.js').LoadedConfig, env: import('./config.js').Env, args: RunArgs, deps: RunDeps, opts: RunOpts, log: (f: any) => void, progress: (f: any) => void, now: Date, connectSession: any }} p
 */
async function executeRun(p) {
  const { client, runId, profile, sources, config, env, args, deps, opts, log, progress, now } = p;
  const dryRun = Boolean(args.dryRun);
  const runCfg = config.adapters.run;
  const dedupCfg = config.adapters.dedup;
  const classifyOpts = {
    now,
    repostGapDays: dedupCfg.repostGapDays,
    titleSimilarity: dedupCfg.titleSimilarity,
    companySimilarity: dedupCfg.companySimilarity,
    postedAtCorroborationDays: dedupCfg.postedAtCorroborationDays,
  };
  const windowStart = new Date(now.getTime() - profile.posted_within_days * 86400000);
  const windowDate = windowStart.toISOString().slice(0, 10);
  // Resolved once per run (spec R2): the noise rule set and the known-adapter-name set for the terminal
  // source check, so every listing in this run is classified against the same snapshot.
  const noiseRules = config.noiseRules ?? getDefaultNoiseRules();
  const noiseKnownSources = new Set(Object.keys(config.adapters.adapters));

  /** @type {RunStats} */
  const stats = {
    fetched: 0, new: 0, updated: 0, cross_source_dup: 0, repost: 0, ambiguous: 0, errors: 0, unembedded: 0, stale_dropped: 0,
    detail_fetched: 0, detail_skipped_budget: 0, dedup_sticky_skip_merged: 0, adopted: 0, expired: 0, pages_by_source: {},
  };
  // Seeded with anything the caller already knew about before this run started (scan-never-skip fix): a
  // config-lock mismatch, an unlocked rubric, or a self-healed/failed Chrome launch. Each carries
  // severity:'warning' so the status computation at finalize below ignores it; a run-level failure this
  // file itself detects (SOURCE_DISABLED, BUDGET_EXCEEDED, a source's own thrown error, etc.) never sets
  // severity, so it counts toward 'partial'/'failed' exactly as before.
  /** @type {Array<{ source: string|null, code: string, message?: string, severity?: 'warning', [k: string]: any }>} */
  const errors = Array.isArray(opts.preRunWarnings) ? [...opts.preRunWarnings] : [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {any[]} */
  const rows = [];
  const seenKeys = new Set();
  let partial = false;
  let cancelled = false;

  const controller = new AbortController();
  const signal = controller.signal;
  const timeout = setTimeout(() => {
    controller.abort();
    errors.push({ source: null, code: 'RUN_TIMEOUT', message: `run exceeded ${runCfg.runTimeoutMinutes} minutes` });
  }, runCfg.runTimeoutMinutes * 60000);
  const onExternalAbort = () => {
    cancelled = true;
    controller.abort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onExternalAbort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Heartbeat + cancel check (scans({action:'cancel'}) flips the row to failed).
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const r = await client.query(`UPDATE ic_scan_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running' RETURNING id`, [runId]);
      if (r.rowCount === 0) {
        cancelled = true;
        controller.abort();
      }
    } catch {
      /* next tick retries */
    } finally {
      heartbeatBusy = false;
    }
  }, HEARTBEAT_MS);

  const registry = buildRegistry(config);
  // Auto-apply PR B (docs/auto-apply-spec.md): the OPPORTUNISTIC half of apply-target resolution -- a
  // SEPARATE, host-only-gate registry (never a relaxation of `registry` above; see probe-registry.js's own
  // doc comment) built once per run, plus a per-source, per-run counter enforcing
  // config/auto-apply.json's probeCapPerSource. Only ever consulted from finalizeListing/
  // maybeSaveApplyTarget below, and only when an adapter's fetchDetail returned an apply-target hint.
  const probeRegistry = buildScanProbeRegistry(config);
  /** @type {Map<string, number>} */
  const probeCountBySource = new Map();
  /**
   * @param {string} sourceName
   * @param {number} listingId
   * @param {import('./normalize.js').NormalizedListing} rec
   * @param {import('./apply-target-persist.js').ApplyDetail} applyDetail
   */
  async function maybeSaveApplyTarget(sourceName, listingId, rec, applyDetail) {
    const used = probeCountBySource.get(sourceName) ?? 0;
    if (used >= config.autoApply.probeCapPerSource) return;
    try {
      const cur = await client.query('SELECT apply_probed_at, probe_attempts FROM ic_job_listings WHERE id = $1', [listingId]);
      if (cur.rowCount === 0) return;
      const listingState = {
        id: listingId, url: null, url_normalized: rec.url_normalized,
        apply_probed_at: cur.rows[0].apply_probed_at, probe_attempts: Number(cur.rows[0].probe_attempts ?? 0),
      };
      const result = await persistApplyTargetForListing(client, listingState, applyDetail, {
        probeRegistry, reprobeAfterHours: config.autoApply.reprobeAfterHours, now, dryRun: false, fetch: deps.fetch, lookup: deps.lookup,
      });
      if (result.outcome === 'resolved' || result.outcome === 'unresolved') probeCountBySource.set(sourceName, used + 1);
    } catch (err) {
      log({ evt: 'apply_target_persist_failed', source: sourceName, listing_id: listingId, ...errFields(err) });
    }
  }
  /** @type {import('../browser/session.js').Session|null} */
  let session = null;
  let sessionFailed = false;
  /** @type {Map<string, import('../browser/capability.js').Capability>} */
  const caps = new Map();
  /** @type {Map<string, import('./ratelimit.js').RateLimiter>} */
  const capLimiters = new Map();

  async function getSession() {
    if (session) return session;
    if (sessionFailed) return null;
    try {
      session = await p.connectSession({ cdpUrl: env.SCAN_CDP_URL });
      // Apply pipeline slice 5 fix (orchestrator review): reconcile CDP targets a crashed apply run left
      // open in this SAME shared scan Chrome, using the SAME stable marker file src/apply/worker.js
      // writes to (applyTargetMarkerPath). This must run at the start of every scan session too, not only
      // every apply run -- otherwise a crashed apply page sits alongside whatever pages this scan run
      // opens indefinitely, until an operator notices. Deliberately a SEPARATE try/catch from the one
      // around this whole function: reconcileTargets() only ever closes target ids it reads back from
      // that one marker file (never an arbitrary open page), and any failure here is swallowed and logged
      // rather than marking the scan Chrome itself unavailable -- a target-reconcile hiccup is pure
      // housekeeping, not a reason to degrade this scan to 'partial'.
      try {
        await session.reconcileTargets(applyTargetMarkerPath(env.JOBSEARCH_LOG_DIR));
      } catch (err) {
        log({ evt: 'scan_target_reconcile_failed', ...errFields(err) });
      }
      await session.reconcile();
      return session;
    } catch (err) {
      sessionFailed = true;
      errors.push(errRecord(err));
      partial = true;
      log({ evt: 'browser_unavailable', ...errFields(err) });
      return null;
    }
  }

  /**
   * One rate limiter per browser source, built from that source's
   * configured delayMs (spec section 4 applies to browser navigation the
   * same as it does to fetchText; a source with no resolved config here is a
   * defect in the caller, so it throws rather than skip the delay silently).
   * exec boards call capFor with a per-board key (`exec:<slug>`, see
   * adapters/exec-generic.js) that never appears in the resolved `sources`
   * list itself (only the base `exec` entry does); the limiter is still
   * cached and keyed per exec:<slug> (each board is its own page and its own
   * wait chain, same granularity as capFor's own `caps` map), but its
   * delayMs config is read from the shared `exec` adapter entry, matching
   * the same source-vs-exec: fallback used elsewhere in this file
   * (expiryPass's `source LIKE 'exec:%'`, fetchDetailForRow's `startsWith`).
   * @param {string} source
   */
  function limiterFor(source) {
    const existing = capLimiters.get(source);
    if (existing) return existing;
    const cfgName = source.startsWith('exec:') ? 'exec' : source;
    const s = sources.find((x) => x.name === cfgName);
    if (!s) throw new JobSearchError('INTERNAL', `capFor: no resolved config for source ${source}`, { details: { source } });
    const limiter = makeRateLimiter({ delayMs: s.cfg.delayMs, backoff: runCfg.backoff, sleep: deps.sleep, random: deps.random });
    capLimiters.set(source, limiter);
    return limiter;
  }

  /** @param {string} source */
  async function capFor(source) {
    const existing = caps.get(source);
    if (existing) return existing;
    const s = await getSession();
    if (!s) return null;
    const page = await s.attachPage({ signal });
    const limiter = limiterFor(source);
    const cap = makeCapability(page, { registry, source, signal, lookup: deps.lookup, onPage: () => limiter.wait(source, signal) });
    caps.set(source, cap);
    return cap;
  }

  /**
   * @param {{ name: string, adapter: import('../adapters/base.js').Adapter, cfg: any }} s
   * @returns {import('../adapters/base.js').AdapterCtx}
   */
  function makeCtx(s) {
    const limiter = makeRateLimiter({ delayMs: s.cfg.delayMs, backoff: runCfg.backoff, sleep: deps.sleep, random: deps.random });
    const caps_ = { dailyPages: s.cfg.dailyPages, dailyDetails: s.cfg.dailyDetails };
    const reserve = deps.reserveBudget ?? reserveBudget;
    // Per-run page cap (spec R5.1: Indeed's list pages per run drop to a config cap, default 12,
    // regardless of how many queries the profile plans). Independent of and in addition to the daily
    // budget below; reuses the same BUDGET_EXHAUSTED code so the scheduler/adapter stop this source the
    // same way they already do for the daily cap.
    let pagesThisRun = 0;
    /** @type {import('../adapters/base.js').AdapterCtx['fetchText']} */
    const fetchText = async (url, o = {}) => {
      const method = o.method ?? 'GET';
      let host = '';
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        throw new JobSearchError('URL_REJECTED', 'url refused: invalid_url');
      }
      const res = await limiter.withRetry(host, async () => {
        const r = await guardedFetch(url, registry, {
          method,
          headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html;q=0.9', ...(o.headers ?? {}) },
          body: o.body,
          source: o.source ?? s.name,
          fetch: deps.fetch,
          lookup: deps.lookup,
          signal,
          timeoutMs: 30000,
        });
        log({ evt: 'fetch', source: s.name, host, method, status: r.status, hops: r.hops, bytes: r.text.length });
        return r;
      }, { signal, onRetry: (f) => log({ evt: 'fetch_retry', source: s.name, host, ...f }) });
      return { status: res.status, url: res.url, text: res.text, contentType: res.contentType };
    };
    return {
      signal,
      now,
      windowStart,
      maxPages: Math.max(1, Math.min(profile.max_pages, s.cfg.maxPagesPerQuery)),
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
        const perRunCap = s.cfg.maxPagesPerRun;
        if (typeof perRunCap === 'number' && pagesThisRun >= perRunCap) {
          throw new JobSearchError('BUDGET_EXHAUSTED', `per-run page cap (${perRunCap}) reached for ${s.name}`, { details: { source: s.name, cap: perRunCap, scope: 'run' } });
        }
        const r = await reserve(client, s.name, { pages: 1 }, caps_, now);
        if (!r.ok) throw new JobSearchError('BUDGET_EXHAUSTED', `daily page budget exhausted for ${s.name}`, { details: { source: s.name, remaining_pages: r.remainingPages } });
        pagesThisRun++;
      },
      async reserveDetail() {
        const r = await reserve(client, s.name, { details: 1 }, caps_, now);
        if (!r.ok) throw new JobSearchError('BUDGET_EXHAUSTED', `daily detail budget exhausted for ${s.name}`, { details: { source: s.name, remaining_details: r.remainingDetails } });
      },
      capFor,
      config,
      env: { GOOGLE_TOKEN_FILE: env.GOOGLE_TOKEN_FILE },
      log: (f) => log({ source: s.name, ...f }),
    };
  }

  const lookups = makePgLookups(client);

  /**
   * Persist one classified listing (insert/update, stats, response row, log). Shared by the immediate path
   * (a row not eligible for a detail fetch) and the sorted detail pass below (spec R4).
   * @param {{ name: string, adapter: import('../adapters/base.js').Adapter, cfg: any }} s
   * @param {import('../adapters/base.js').ListingEvent} ev
   * @param {import('./normalize.js').NormalizedListing} rec
   * @param {import('./dedup.js').Decision} decision
   * @param {number} ps
   * @param {number} psRaw
   * @param {string} noiseClass
   * @param {boolean} detailSkipped
   * @param {import('./apply-target-persist.js').ApplyDetail|null} [applyDetail] auto-apply PR B: set only
   *   when this row went through a detail fetch AND the adapter returned an apply-target hint
   */
  async function finalizeListing(s, ev, rec, decision, ps, psRaw, noiseClass, detailSkipped, applyDetail = null) {
    /** @type {{ id: number|null, outcome: string, queued: number|null, branch: string, status?: string|null, stickySkipMerged?: boolean }} */
    let applied;
    if (dryRun) {
      // A dry run never reaches applyDecision/findStickySkipRoot (no DB writes at all in dry-run mode),
      // so `status` here is decision.js's own pre-persistence approximation, same as before sticky-skip
      // existed -- it cannot reflect a sticky-skip merge a live run might have made instead.
      applied = {
        id: null, outcome: decision.outcome, queued: decision.queue ? -1 : null, branch: decision.branch,
        status: decision.outcome === 'ambiguous' ? 'review' : decision.inherit?.status ?? null,
      };
    } else {
      let embedding = null;
      if (decision.outcome !== 'update') {
        const e = await embedSafe([embeddingText({ title: rec.title, company: rec.company, notes: null })], { ollamaUrl: env.OLLAMA_URL, model: env.OLLAMA_MODEL, fetch: deps.fetch });
        embedding = e.literals[0];
        if (e.unembedded) {
          stats.unembedded += e.unembedded;
          if (e.warning && !warnings.includes(e.warning)) warnings.push(e.warning);
        }
      }
      applied = await withTransaction(client, (c) => applyDecision(c, rec, decision, {
        runId, pageIndex: ev.pageIndex, searchProfile: profile.name, profileRev: profile.rev,
        // stickyFloor (auto-skip-sticky spec): same config source triage.js reads (config/triage.json's
        // deterministic.floor, default 40), so findStickySkipRoot/findStickySkipRootForSameRow gate an
        // auto-actor STICKY-ELIGIBLE root on this row's own already-computed prescore (`ps` above)
        // against the SAME floor auto-triage itself would use to decide skip_low.
        prescore: ps, prescoreRaw: psRaw, noiseClass, detailSkipped, embedding, now, stickyFloor: config.triage.deterministic.floor,
      }));
    }
    if (!dryRun && applyDetail && applied.id) await maybeSaveApplyTarget(s.name, applied.id, rec, applyDetail);
    if (applied.outcome === 'update') stats.updated++;
    else if (applied.outcome === 'new') stats.new++;
    else if (applied.outcome === 'cross_source_dup') stats.cross_source_dup++;
    else if (applied.outcome === 'repost') stats.repost++;
    else if (applied.outcome === 'ambiguous') stats.ambiguous++;
    if (applied.stickySkipMerged) stats.dedup_sticky_skip_merged++;
    rows.push({
      id: applied.id,
      title: rec.title,
      company: rec.company,
      location: rec.location,
      remote_mode: rec.remote_mode,
      posted_at: rec.posted_at,
      salary_min: rec.salary_min,
      salary_max: rec.salary_max,
      prescore: ps,
      noise_class: noiseClass,
      status: applied.status ?? null,
      source: rec.source,
      outcome: applied.outcome,
    });
    log({ evt: 'listing', run_id: runId, source: rec.source, outcome: applied.outcome, branch: applied.branch, id: applied.id, prescore: ps, url_normalized: rec.url_normalized });
  }

  /**
   * Attempt one detail fetch and re-derive prescore/noise/classification from the fetched description
   * (spec R4). Returns the (possibly unchanged) rec/decision/ps/psRaw/noiseClass plus whether the fetch
   * was skipped for budget reasons.
   * @param {{ name: string, adapter: import('../adapters/base.js').Adapter, cfg: any }} s
   * @param {import('../adapters/base.js').AdapterCtx} ctx
   * @param {import('../adapters/base.js').ListingEvent} ev
   * @param {import('./normalize.js').NormalizedListing} rec
   */
  async function tryFetchDetail(s, ctx, ev, rec) {
    /** @type {any} */
    let d = null;
    try {
      d = await s.adapter.fetchDetail({ url: ev.listing.url, url_normalized: rec.url_normalized, external_id: rec.external_id, source: rec.source }, ctx);
    } catch (err) {
      if (err instanceof JobSearchError && err.code === 'CANCELLED') throw err;
      if (err instanceof JobSearchError && err.code === 'BUDGET_EXHAUSTED') {
        // Budget ran out mid-source (spec R4.2, decision 22): this row (and the rest of the sorted queue
        // behind it) is still persisted, just without a description, rather than aborting the source.
        return { skipped: true };
      }
      warnings.push(`detail fetch failed for ${rec.source} ${rec.external_id ?? ''}: ${errFields(err).err_code}`);
      return { skipped: false };
    }
    // Auto-apply PR B: capture whatever apply-target hint the adapter returned, REGARDLESS of whether the
    // description fetch itself succeeded -- an adapter whose own listing URL already IS the apply page
    // (greenhouse/workday/dayforce) still has something worth persisting opportunistically even when the
    // description fetch failed. `applyDetail` is null when the adapter returned none of the new optional
    // fields at all (the legacy `{ description }`-only shape), so a caller that never widened its adapter
    // sees no behavior change whatsoever.
    const applyDetail = d && (d.externalApplyUrl !== undefined || d.easyApplyOnly !== undefined || d.applyProbe !== undefined)
      ? { externalApplyUrl: d.externalApplyUrl ?? null, easyApplyOnly: Boolean(d.easyApplyOnly), applyProbe: d.applyProbe ?? null }
      : null;
    if (d && d.description) {
      const rec2 = normalizeListing({ ...ev.listing, description: d.description });
      const psRaw2 = prescore(rec2, profile);
      const noiseClass2 = classifyNoise(rec2, { rules: noiseRules, knownSources: noiseKnownSources });
      const ps2 = weightedPrescore(psRaw2, noiseClass2, { rules: noiseRules });
      const decision2 = await classify(rec2, lookups, classifyOpts);
      stats.detail_fetched++;
      return { rec: rec2, decision: decision2, ps: ps2, psRaw: psRaw2, noiseClass: noiseClass2, skipped: false, applyDetail };
    }
    return { skipped: false, applyDetail };
  }

  /**
   * @param {{ name: string, adapter: import('../adapters/base.js').Adapter, cfg: any }} s
   * @param {import('../adapters/base.js').AdapterCtx} ctx
   * @param {import('../adapters/base.js').ListingEvent} ev
   * @param {Array<{ ev: import('../adapters/base.js').ListingEvent, rec: import('./normalize.js').NormalizedListing, decision: import('./dedup.js').Decision, ps: number, psRaw: number, noiseClass: string, seq: number }>} detailQueue
   * @param {() => number} nextSeq
   */
  async function processListing(s, ctx, ev, detailQueue, nextSeq) {
    const rec = normalizeListing(ev.listing);
    const key = `${rec.source}|${rec.external_id ?? rec.url_normalized ?? rec.dedup_hash}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    stats.fetched++;
    const psRaw = prescore(rec, profile);
    const noiseClass = classifyNoise(rec, { rules: noiseRules, knownSources: noiseKnownSources });
    const ps = weightedPrescore(psRaw, noiseClass, { rules: noiseRules });
    const decision = await classify(rec, lookups, classifyOpts);
    // Detail fetch eligibility (spec R4.1, decision 20): prescore gate (per-source override), and ONLY
    // outcomes new/ambiguous ever queue -- a matched existing row (update/cross_source_dup/repost) is
    // finalized immediately, same as before. Eligible rows are queued here (spec R4.1: "collecting list
    // results for the source first") instead of fetched inline; the whole source's queue is sorted by
    // prescore descending once list collection for the source finishes (runDetailPass below) so budget is
    // spent on the highest-value rows first, not in page-arrival order.
    const detailGate = s.cfg.detailFetchMinPrescore ?? runCfg.detailFetchMinPrescore;
    const eligible = Boolean(s.adapter.fetchDetail) && !rec.description && (decision.outcome === 'new' || decision.outcome === 'ambiguous') && ps >= detailGate;
    if (eligible) {
      detailQueue.push({ ev, rec, decision, ps, psRaw, noiseClass, seq: nextSeq() });
      return;
    }
    await finalizeListing(s, ev, rec, decision, ps, psRaw, noiseClass, false);
  }

  /**
   * Phase 2 (spec R4): drain one source's detail queue in descending prescore order (tie-break: posted_at
   * desc nulls last, then arrival sequence asc -- decision 19's "id asc", read as arrival order since a
   * queued 'new' row has no id yet). Ordering is a FIXED snapshot taken once here (decision 21): a row's
   * prescore can change after its own detail fetch, but that never re-sorts the rest of the queue.
   * @param {{ name: string, adapter: import('../adapters/base.js').Adapter, cfg: any }} s
   * @param {import('../adapters/base.js').AdapterCtx} ctx
   * @param {Array<{ ev: import('../adapters/base.js').ListingEvent, rec: import('./normalize.js').NormalizedListing, decision: import('./dedup.js').Decision, ps: number, psRaw: number, noiseClass: string, seq: number }>} detailQueue
   */
  async function runDetailPass(s, ctx, detailQueue) {
    const dateNum = (/** @type {string|null} */ d) => (d ? Date.parse(d) || 0 : -Infinity);
    const sorted = [...detailQueue].sort((a, b) => (b.ps - a.ps) || (dateNum(b.rec.posted_at) - dateNum(a.rec.posted_at)) || (a.seq - b.seq));
    let queuedSkippedFromHere = false;
    for (const item of sorted) {
      if (signal.aborted) break;
      let { ev, rec, decision, ps, psRaw, noiseClass } = item;
      let detailSkipped = false;
      /** @type {import('./apply-target-persist.js').ApplyDetail|null} */
      let applyDetail = null;
      if (queuedSkippedFromHere) {
        // Budget already exhausted earlier in this SAME sorted pass: every remaining item skips the
        // network attempt outright (decision 22: queued minus fetched) rather than re-throwing per item.
        detailSkipped = true;
        stats.detail_skipped_budget = (stats.detail_skipped_budget ?? 0) + 1;
      } else {
        const r = await tryFetchDetail(s, ctx, ev, rec);
        if (r.skipped) {
          detailSkipped = true;
          queuedSkippedFromHere = true;
          stats.detail_skipped_budget = (stats.detail_skipped_budget ?? 0) + 1;
        } else if (r.rec) {
          rec = r.rec;
          decision = r.decision;
          ps = r.ps;
          psRaw = r.psRaw;
          noiseClass = r.noiseClass;
        }
        applyDetail = r.applyDetail ?? null;
      }
      await finalizeListing(s, ev, rec, decision, ps, psRaw, noiseClass, detailSkipped, applyDetail);
    }
  }

  /**
   * Expiry pass (spec 3.2) for one completed source.
   * @param {{ name: string }} s
   * @param {number} deepestPage
   */
  async function expiryPass(s, deepestPage) {
    const src = s.name;
    const where = `(source = $1 OR ($1 = 'exec' AND source LIKE 'exec:%')) AND coalesce(record_kind,'listing') = 'listing' AND duplicate_of IS NULL AND expired_at IS NULL
      AND search_profile = $2 AND profile_rev IS NOT DISTINCT FROM $3 AND posted_at IS NOT NULL AND posted_at >= $4::date
      AND NOT EXISTS (SELECT 1 FROM ic_scan_run_items i WHERE i.run_id = $5 AND i.listing_id = ic_job_listings.id)`;
    const params = [src, profile.name, profile.rev, windowDate, runId, deepestPage];
    const inc = await client.query(`UPDATE ic_job_listings SET absent_runs = absent_runs + 1 WHERE ${where} AND coalesce(last_page_index, 0) < $6 RETURNING id`, params);
    const st = await client.query(`UPDATE ic_job_listings SET stale = true WHERE ${where} AND coalesce(last_page_index, 0) >= $6 RETURNING id`, params);
    const exp = await client.query(
      `UPDATE ic_job_listings SET expired_at = now() WHERE (source = $1 OR ($1 = 'exec' AND source LIKE 'exec:%')) AND search_profile = $2 AND expired_at IS NULL AND absent_runs >= $3 RETURNING id`,
      [src, profile.name, dedupCfg.expireAfterAbsentRuns],
    );
    stats.expired += exp.rowCount ?? 0;
    log({ evt: 'expiry_pass', source: src, absent_incremented: inc.rowCount ?? 0, stale_marked: st.rowCount ?? 0, expired: exp.rowCount ?? 0, deepest_page: deepestPage });
  }

  try {
    // 5. profile-change reset + adoption
    if (!dryRun) {
      const last = await client.query(`SELECT profile_rev FROM ic_scan_runs WHERE profile = $1 AND id < $2 AND dry_run = false ORDER BY id DESC LIMIT 1`, [profile.name, runId]);
      if (last.rowCount && last.rows[0].profile_rev !== profile.rev) {
        const r = await client.query(`UPDATE ic_job_listings SET absent_runs = 0 WHERE search_profile = $1 AND profile_rev IS DISTINCT FROM $2 AND expired_at IS NULL`, [profile.name, profile.rev]);
        log({ evt: 'profile_changed_reset', profile: profile.name, rows: r.rowCount ?? 0 });
      }
      const adopted = await withTransaction(client, (c) => adoptUnclassifiedRows(c, { runId, classifyOpts }));
      stats.adopted = adopted.adopted;
      if (adopted.queued) warnings.push(`adoption queued ${adopted.queued} row(s) for review`);
      log({ evt: 'adoption', run_id: runId, adopted: adopted.adopted, queued: adopted.queued, failed: adopted.failed });
    }

    // 6. plan
    const ignoresQuery = new Set(sources.filter((s) => s.adapter.ignoresQuery).map((s) => s.name));
    const plan = planPages({ keywords: profile.keywords, phrases: profile.phrases, locations: profile.locations, maxPages: profile.max_pages, sources: sources.map((s) => s.name) }, config.adapters, ignoresQuery);
    assertPlanWithinCap(plan, runCfg.maxPlannedPagesPerRun);
    log({ evt: 'plan', run_id: runId, planned: plan.planned, sources: sources.length });

    // 7. sources
    for (const s of sources) {
      if (signal.aborted) break;
      const enabled = await sourceEnabled(client, s.name, now);
      if (!enabled.enabled) {
        errors.push({ source: s.name, code: 'SOURCE_DISABLED', message: `${s.name} disabled (${enabled.reason})${enabled.disabledUntil ? ' until ' + enabled.disabledUntil.toISOString() : ''}` });
        partial = true;
        continue;
      }
      const ctx = makeCtx(s);
      let walled = false;
      /** @type {import('./scheduler.js').ScheduleResult|null} */
      let result = null;
      /** @type {Array<{ ev: import('../adapters/base.js').ListingEvent, rec: import('./normalize.js').NormalizedListing, decision: import('./dedup.js').Decision, ps: number, psRaw: number, noiseClass: string, seq: number }>} */
      const detailQueue = [];
      let detailSeq = 0;
      try {
        result = await runSearch(s.adapter, profile, ctx, {
          onListing: (ev) => processListing(s, ctx, ev, detailQueue, () => detailSeq++),
          async onBatch(ev) {
            stats.pages_by_source[s.name] = (stats.pages_by_source[s.name] ?? 0) + 1;
            progress({ run_id: runId, source: s.name, query: ev.query.slice(0, 80), page_index: ev.pageIndex, parsed: ev.parsed, fetched: stats.fetched });
          },
          async onWarning(ev) {
            const msg = `${ev.code}: ${ev.message}`;
            if (!warnings.includes(msg)) warnings.push(msg);
            if (ev.code === 'BROWSER_UNAVAILABLE' || ev.code === 'UNRENDERABLE' || ev.code === 'AUTH_UNAVAILABLE') partial = true;
            if (ev.code === 'BOARD_NOT_FOUND' || ev.code === 'BAD_RESPONSE') {
              // A configured board that does not answer is a config defect: visible as partial, never silent.
              partial = true;
              errors.push({ source: s.name, code: ev.code, message: ev.message.slice(0, 300) });
            }
            log({ evt: 'adapter_warning', source: s.name, code: ev.code, message: ev.message.slice(0, 300) });
          },
          async onWall(ev) {
            const verdict = classifyPage(ev.signals);
            log({ evt: 'page_classified', source: s.name, kind: verdict.kind, reason: verdict.reason, status: ev.signals.status ?? null });
            if (!verdict.stopSource) return { stopSource: false };
            walled = true;
            partial = true;
            const w = await recordWall(client, s.name, now);
            errors.push({ source: s.name, code: verdict.code, message: `${verdict.reason}; source disabled ${w.manual ? 'until manual re-enable' : w.hours + ' h'}` });
            return { stopSource: true };
          },
        }, { maxPages: ctx.maxPages, windowStart, staleLimit: s.adapter.dateOrdered ? undefined : Number.POSITIVE_INFINITY });
        // Phase 2 (spec R4): sorted detail-fetch pass over everything list-collection queued for this
        // source, run BEFORE expiryPass below so every queued row is persisted (and so has an
        // ic_scan_run_items row) before absence accounting looks for it.
        if (detailQueue.length) await runDetailPass(s, ctx, detailQueue);
        stats.stale_dropped += result.stale;
        if (result.completed && !walled) {
          await recordClean(client, s.name);
          // Pagination boundary (spec 3.2): rows on the deepest page get `stale`, not an absence, but only when some
          // query was actually cut off by maxPages. A source that listed everything (Greenhouse board, Lever tail,
          // Workday total reached) has no boundary, so every unseen row counts as absent.
          const truncated = Object.values(result.queries).some((q) => q.stoppedBy === 'maxPages');
          const boundary = truncated ? result.deepestPage : 2147483647;
          if (!dryRun && result.listings >= 1) await expiryPass(s, boundary);
        }
        log({ evt: 'source_done', run_id: runId, source: s.name, pages: result.pages, listings: result.listings, stale: result.stale, completed: result.completed, stopped_by: result.stoppedBy });
      } catch (err) {
        if (err instanceof JobSearchError && err.code === 'CANCELLED') throw err;
        if (signal.aborted) throw new JobSearchError('CANCELLED', 'run aborted');
        errors.push(errRecord(err, s.name));
        partial = true;
        log({ evt: 'source_failed', run_id: runId, source: s.name, ...errFields(err) });
      }
    }
    if (signal.aborted) throw new JobSearchError('CANCELLED', 'run aborted');
  } catch (err) {
    if (err instanceof JobSearchError && err.code === 'CANCELLED') {
      cancelled = true;
      if (!errors.some((e) => e.code === 'CANCELLED' || e.code === 'RUN_TIMEOUT')) errors.push({ source: null, code: 'CANCELLED', message: 'run cancelled' });
    } else {
      errors.push(errRecord(err));
      cancelled = true;
      log({ evt: 'run_failed', run_id: runId, ...errFields(err) });
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    if (session) {
      try {
        await session.closeAll();
      } catch {
        /* ignore */
      }
    }
  }

  // Warnings (severity:'warning' -- config-lock mismatch, unlocked rubric, Chrome self-heal) never count
  // toward stats.errors or the status computation: a run carrying only warnings stays 'ok'. `partial` is
  // still set independently by real run-level conditions elsewhere in this file (SOURCE_DISABLED, a wall,
  // BROWSER_UNAVAILABLE, etc.), unaffected by this filter.
  const blockingErrors = errors.filter((e) => e.severity !== 'warning');
  stats.errors = blockingErrors.length;
  const status = cancelled ? 'failed' : partial || blockingErrors.length > 0 ? 'partial' : 'ok';
  try {
    await client.query(
      `UPDATE ic_scan_runs SET status = CASE WHEN status = 'running' THEN $2 ELSE status END, finished_at = now(), heartbeat_at = now(),
         stats = $3::jsonb, pages_by_source = $4::jsonb, errors = errors || $5::jsonb WHERE id = $1`,
      [runId, status, JSON.stringify(stats), JSON.stringify(stats.pages_by_source), JSON.stringify(errors)],
    );
  } catch (err) {
    log({ evt: 'run_finalize_failed', run_id: runId, ...errFields(err) });
  }
  try {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
  } catch {
    /* connection gone: the lock dies with it */
  }
  try {
    await client.end();
  } catch {
    /* ignore */
  }

  // Slice 3 auto-triage (docs/slice3-auto-triage-spec.md section 5): runs AFTER the advisory lock
  // releases and this run's own client closes, on a fresh dedicated connection, so a model step that can
  // run for minutes (up to maxBatchesPerRun * cfg.model.timeoutMs) never blocks a second scan trigger
  // that only needs the lock for the network fetch/dedupe/store loop above. Gated on !dryRun (always
  // true at this point, since a run row was just finalized -- a defensive restatement, not a new check,
  // per the spec). The whole call is wrapped in one try/catch so a total triage failure (e.g. the
  // dedicated connection itself throwing, or runDeterministicTriage's first query failing before any row
  // is processed) never changes this run's own status/exit code -- only stats.triage describes the
  // failure, and the scan's own rows/response are written normally either way.
  if (!dryRun) {
    /** @type {any} */
    let triageStats = { configured: Boolean(config.triage && config.triage.present) };
    try {
      const connectTriage = deps.connectDedicated ?? defaultConnectDedicated;
      const triageClient = await connectTriage();
      try {
        triageStats = await runTriage(triageClient, runId, config, profile, { execFile: deps.execFile, now });
        try {
          await triageClient.query('UPDATE ic_scan_runs SET stats = stats || $2::jsonb WHERE id = $1', [runId, JSON.stringify({ triage: triageStats })]);
        } catch (err) {
          log({ evt: 'triage_stats_write_failed', run_id: runId, ...errFields(err) });
        }
      } finally {
        try {
          await triageClient.end();
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      const f = errFields(err);
      log({ evt: 'triage_failed', run_id: runId, ...f });
      triageStats = { configured: Boolean(config.triage && config.triage.present), error: f.err_code };
    }
    // Merged into the same in-memory stats object `response` is built from below (spec section 5, item
    // 6), not only written to the database above, so result.stats.triage is available synchronously to
    // whichever caller is waiting (bin/scan.js's JSON summary, or search_jobs.js's tool result) without a
    // second DB round trip.
    stats.triage = triageStats;
  }

  log({ evt: 'run_finished', run_id: runId, status, fetched: stats.fetched, new: stats.new, updated: stats.updated, errors: errors.length });

  // Response
  const minPs = args.minPrescore ?? 0;
  const ordered = rows.filter((r) => (r.prescore ?? 0) >= minPs).sort((a, b) => (b.prescore ?? 0) - (a.prescore ?? 0) || String(b.posted_at ?? '').localeCompare(String(a.posted_at ?? '')));
  const compact = compactRows(ordered, { limit: args.limit ?? MAX_ROWS, dry: dryRun });
  const blind = [...new Set(sources.flatMap((s) => s.adapter.blindSpots))];
  const response = {
    ok: status !== 'failed',
    run_id: runId,
    status,
    stats,
    errors: errors.slice(0, 10),
    rows: compact.rows,
    truncated: compact.truncated,
    warnings: [...compact.warnings, ...warnings.slice(0, 10)],
    blind_spots: blind.slice(0, 6),
    hint: dryRun ? 'dry run: nothing persisted; rerun with dryRun:false to store rows' : `query_jobs({runId:${runId}, offset:${compact.rows.length}}) for the rest`,
  };
  const capped = capResponse(response, { hint: `query_jobs({runId:${runId}, offset:25}) for the rest`, maxChars: MAX_RESPONSE_CHARS - ROWS_WRAP_OVERHEAD_CHARS });
  capped.rows = untrustedRows(capped.rows);
  return capped;
}

/**
 * Detail fetch for get_job({fetchIfMissing:true}) on fetch-backed sources:
 * goes through the adapter's fetchDetail with a minimal ctx (URL guard, rate
 * limiter, details budget). Browser sources are refused by get_job itself.
 * @param {{ id: number, source: string|null, url: string|null, url_normalized: string|null, external_id: string|null }} row
 * @param {RunDeps & { withClient: <T>(fn: (c: import('pg').PoolClient) => Promise<T>) => Promise<T> }} deps
 * @returns {Promise<{ description: string|null }>}
 */
export async function fetchDetailForRow(row, deps) {
  const config = deps.config ?? loadConfig();
  const src = String(row.source ?? '');
  const name = src.startsWith('exec:') ? 'exec' : src;
  const adapter = ADAPTERS[name];
  const cfg = config.adapters.adapters[name];
  if (!adapter || !adapter.fetchDetail || !cfg) throw new JobSearchError('VALIDATION', `no detail fetch for source ${src || 'unknown'}`);
  if (adapter.needsBrowser) throw new JobSearchError('VALIDATION', `detail fetch refused for ${name}: logged-in source`);
  const registry = buildRegistry(config);
  const limiter = makeRateLimiter({ delayMs: cfg.delayMs, backoff: config.adapters.run.backoff, sleep: deps.sleep, random: deps.random });
  const controller = new AbortController();
  const signal = controller.signal;
  /** @type {import('../adapters/base.js').AdapterCtx['fetchText']} */
  const fetchText = async (url, o = {}) => {
    const host = new URL(url).hostname.toLowerCase();
    const r = await limiter.withRetry(host, () => guardedFetch(url, registry, {
      method: o.method ?? 'GET', headers: { 'user-agent': USER_AGENT, ...(o.headers ?? {}) }, body: o.body, source: o.source ?? name, fetch: deps.fetch, lookup: deps.lookup, signal, timeoutMs: 30000,
    }), { signal });
    return { status: r.status, url: r.url, text: r.text, contentType: r.contentType };
  };
  /** @type {import('../adapters/base.js').AdapterCtx} */
  const ctx = {
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
      throw new JobSearchError('VALIDATION', 'list pages are not fetched outside a scan');
    },
    async reserveDetail() {
      const r = await deps.withClient((c) => reserveBudget(c, name, { details: 1 }, { dailyPages: cfg.dailyPages, dailyDetails: cfg.dailyDetails }));
      if (!r.ok) throw new JobSearchError('BUDGET_EXHAUSTED', `daily detail budget exhausted for ${name}`);
    },
    capFor: async () => null,
    config,
    log: (f) => defaultLog.info({ source: name, ...f }),
  };
  return adapter.fetchDetail({ url: row.url, url_normalized: row.url_normalized, external_id: row.external_id, source: src }, ctx);
}
