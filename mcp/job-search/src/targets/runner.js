// @ts-check
/**
 * Target finder runner (plan 17). One code path for bin/targets.js and the scan stage.
 *
 *   runTargets(deps, opts) -> { status, run_id, skipped?, sources, counts, flags, attention }
 *
 * Flow: reap stale running rows -> advisory lock (loser writes a skipped_locked row) -> run row with a
 * heartbeat -> sources in order (Form D, 8-K, FTS per enabled query, alerts, gap last) -> classify from the
 * STORED signal rows, dedup, upsert ic_targets -> finalize the row. A dry run writes nothing at all.
 *
 * EDGAR sources are read one business day at a time (plan 17.2). Per day the persist and the cursor move
 * commit in ONE transaction, signals first; the cursor only moves over a day that is complete (see
 * coverage.js assessDay), is at least two business days old, and directly follows the previous cursor.
 * Nothing here sends anything anywhere; all network goes through the fetch guard.
 */
import { withTransaction } from '../core/db.js';
import { getEnv } from '../core/config.js';
import { normalizeCompany } from '../core/normalize.js';
import {
  loadTargetRules, classifySignal, dedupSignals, normalizeName, TRIGGER_KINDS, SIZE_CONFIDENCES,
} from '../core/target-classify.js';
import { loadBlockedAffiliates } from '../core/target-exclusion.js';
import { EDGAR_TOTAL_CAP } from './edgar-client.js';
import { createTargetNetwork } from './index.js';
import { runFormD } from './form-d.js';
import { run8k } from './edgar-8k.js';
import { runFts, loadFtsQueries } from './edgar-fts.js';
import { runGoogleAlerts, makeGmailTokenProvider, ALERT_WINDOW_DAYS } from './google-alerts.js';
import { runGapSource } from './gap-source.js';
import { persistItems, recordSourceState } from './store.js';
import {
  etDay, addDays, businessDayAnchors, sliceDays, backlogDays,
} from './dates.js';
import { assessDay, isCovered, closedReason, configHash } from './coverage.js';

export const TARGETS_LOCK_KEY = 730193031;
export const REAP_AFTER_MINUTES = 30;
export const HEARTBEAT_MS = 60_000;
export const DAY_MAX_PAGES = 5;
export const EMPTY_HOLD_RUNS = 2;
export const GAP_RECENT_DAYS = 5;
export const SOURCE_NAMES = Object.freeze(['form_d', '8k', 'fts', 'alerts', 'gap']);
export const LOOKBACK_DAYS = Object.freeze({ form_d: 14, '8k': 30, fts: 30 });
const DAY_MS = 86_400_000;
const STATUS_RANK = Object.freeze({ complete: 1, disabled: 0, skipped: 2, partial: 3, failed: 4 });

/**
 * @typedef {Object} SourceResult
 * @property {string} name form_d | 8k | fts | alerts | gap
 * @property {'complete'|'partial'|'skipped'|'failed'|'disabled'} status
 * @property {string|null} reason closed code
 * @property {number|null} backlog_days
 * @property {string[]} flags closed flags (config_reset, suspicious_empty_released, ...)
 * @property {Array<Record<string, any>>} days per-day summary (bounded)
 * @property {Array<import('./outcomes.js').TargetItem>} items every item persisted (or, in a dry run, fetched)
 * @property {{ raw: number, parsed: number, unparseable: number, out_of_scope: number, capped: number, read: number, reasons: Record<string, number>, warnings: string[], extra: Record<string, number> }} stats
 * @property {{ skipped: string|null, warnings: string[] }} feed shape departureFeedsRanClean reads
 */

/** @returns {SourceResult['stats']} */
function newAgg() {
  return { raw: 0, parsed: 0, unparseable: 0, out_of_scope: 0, capped: 0, read: 0, reasons: {}, warnings: [], extra: {} };
}

/** @param {SourceResult['stats']} agg @param {import('./outcomes.js').SourceStats} s */
function addStats(agg, s) {
  for (const k of /** @type {const} */ (['raw', 'parsed', 'unparseable', 'out_of_scope', 'capped', 'read'])) agg[k] += s[k] ?? 0;
  for (const [k, v] of Object.entries(s.reasons ?? {})) agg.reasons[k] = (agg.reasons[k] ?? 0) + v;
  for (const [k, v] of Object.entries(s.extra ?? {})) agg.extra[k] = (agg.extra[k] ?? 0) + v;
  for (const w of s.warnings ?? []) if (!agg.warnings.includes(w) && agg.warnings.length < 50) agg.warnings.push(w);
}

/**
 * @param {string} name
 * @returns {SourceResult}
 */
function newResult(name) {
  return { name, status: 'complete', reason: null, backlog_days: null, flags: [], days: [], items: [], stats: newAgg(), feed: { skipped: null, warnings: [] } };
}

/**
 * @param {Object} deps
 * @param {import('pg').ClientBase} deps.client dedicated connection (advisory lock lives on it); the caller closes it
 * @param {Date|(() => Date)} [deps.now]
 * @param {string} [deps.configDir]
 * @param {typeof fetch} [deps.fetch]
 * @param {number|null} [deps.deadlineAt] absolute epoch ms; EDGAR requests stop here
 * @param {AbortSignal|null} [deps.signal]
 * @param {ReturnType<typeof createTargetNetwork>} [deps.net] injected network (tests)
 * @param {object} [deps.timing] edgar client timing (tests)
 * @param {() => Promise<string|null>} [deps.getAccessToken] Gmail access token for alerts
 * @param {string|null} [deps.tokenFile]
 * @param {Array<any>} [deps.ftsQueries] injected FTS queries (tests)
 * @param {any} [deps.rules]
 * @param {import('../core/target-exclusion.js').BlockedList} [deps.blocked]
 * @param {number} [deps.heartbeatMs]
 * @param {number} [deps.reapAfterMinutes]
 * @param {(f: Record<string, unknown>) => void} [deps.log]
 * @param {{ afterPersist?: (info: { source: string, day: string }) => (void|Promise<void>) }} [deps.hooks] test seams
 * @param {{ source?: string|null, dryRun?: boolean, trigger?: string }} [opts]
 */
export async function runTargets(deps, opts = {}) {
  const client = deps.client;
  const log = deps.log ?? (() => {});
  const now = typeof deps.now === 'function' ? deps.now() : (deps.now ?? new Date());
  const dryRun = Boolean(opts.dryRun);
  const trigger = opts.trigger ?? 'cli';
  const only = opts.source ?? null;
  const configDir = deps.configDir ?? getEnv().JOBSEARCH_CONFIG_DIR;
  if (only !== null && !SOURCE_NAMES.includes(only)) return { status: 'failed', run_id: null, error: 'bad_source', sources: {}, counts: {}, flags: [], attention: true };
  const wants = (/** @type {string} */ n) => only === null || only === n;

  // Reaper: independent of the lock, heartbeat based, so a long manual CLI run (which keeps beating) survives.
  if (!dryRun) await reapStaleRuns(client, deps.reapAfterMinutes ?? REAP_AFTER_MINUTES, log);

  let locked = false;
  if (!dryRun) {
    const lock = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [TARGETS_LOCK_KEY]);
    if (!lock.rows[0]?.ok) {
      const row = await client.query(
        `INSERT INTO ic_target_runs (status, finished_at, trigger, details) VALUES ('skipped_locked', now(), $1, $2::jsonb) RETURNING id`,
        [trigger, JSON.stringify({ reason: 'already_running' })],
      );
      return { status: 'skipped', skipped: 'already_running', run_id: Number(row.rows[0].id), sources: {}, counts: {}, flags: [], attention: true };
    }
    locked = true;
  }

  /** @type {number|null} */
  let runId = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let hb = null;
  /** @type {Record<string, SourceResult>} */
  const results = {};
  /** @type {Record<string, any>} */
  let counts = {};
  try {
    const startedDb = (await client.query('SELECT now() AS t')).rows[0].t;
    if (!dryRun) {
      const ins = await client.query(`INSERT INTO ic_target_runs (status, trigger, heartbeat_at) VALUES ('running', $1, now()) RETURNING id`, [trigger]);
      runId = Number(ins.rows[0].id);
      const beat = () => { client.query(`UPDATE ic_target_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'`, [runId]).catch(() => {}); };
      hb = setInterval(beat, deps.heartbeatMs ?? HEARTBEAT_MS);
      hb.unref?.();
    }
    const beatNow = async () => {
      if (runId !== null) await client.query(`UPDATE ic_target_runs SET heartbeat_at = now() WHERE id = $1 AND status = 'running'`, [runId]).catch(() => {});
    };

    const rules = deps.rules ?? loadTargetRules(configDir);
    const blocked = deps.blocked ?? loadBlockedAffiliates(configDir);
    const today = etDay(now);
    const anchors = businessDayAnchors(today);
    const net = deps.net ?? createTargetNetwork({
      configDir,
      fetch: deps.fetch,
      timing: /** @type {any} */ (deps.timing),
      maxRequests: EDGAR_TOTAL_CAP + 100,
      control: { deadlineAt: deps.deadlineAt ?? null, signal: deps.signal ?? null },
    });

    // ---- helpers shared by the sources --------------------------------------------------------------
    /** @param {string} key */
    async function readState(key) {
      const r = await client.query(`SELECT cursor_date, cursor_detail, last_success_at FROM ic_target_source_state WHERE source = $1`, [key]);
      const row = r.rows[0];
      const cd = row?.cursor_date;
      return {
        cursor_date: cd instanceof Date ? cd.toISOString().slice(0, 10) : (typeof cd === 'string' ? cd.slice(0, 10) : null),
        detail: row && row.cursor_detail && typeof row.cursor_detail === 'object' ? { ...row.cursor_detail } : {},
        last_success_at: row?.last_success_at ?? null,
      };
    }
    /** @param {string} key @param {string|null} cursor @param {Record<string, any>} detail */
    async function writeCursor(key, cursor, detail) {
      await client.query(
        `INSERT INTO ic_target_source_state (source, cursor_date, cursor_detail, updated_at) VALUES ($1, $2::date, $3::jsonb, now())
         ON CONFLICT (source) DO UPDATE SET cursor_date = $2::date, cursor_detail = $3::jsonb, updated_at = now()`,
        [key, cursor, JSON.stringify(detail)],
      );
    }
    /** @param {string} source @param {string} day */
    async function coveredFor(source, day) {
      const r = await client.query(
        `SELECT extracted->>'accession' AS adsh, extracted->>'query_id' AS qid, parse_outcome, parse_reason, extracted->>'doc_fetch' AS doc_fetch
         FROM ic_target_signals WHERE source = $1 AND extracted->>'file_date' = $2`,
        [source, day],
      );
      /** @type {Set<string>} */
      const set = new Set();
      for (const row of r.rows) {
        if (row.adsh && isCovered({ outcome: row.parse_outcome, reason: row.parse_reason, doc_fetch: row.doc_fetch })) set.add(`${row.qid ?? ''}|${row.adsh}`);
      }
      return (/** @type {string} */ adsh, /** @type {string} */ qid = '') => set.has(`${qid}|${adsh}`);
    }

    /**
     * One EDGAR source, one cursor (plan 17.2).
     * @param {Object} o
     * @param {string} o.name result name
     * @param {string} o.stateKey ic_target_source_state.source
     * @param {string} o.adapterSource ic_target_signals.source of the rows
     * @param {number} o.lookbackDays
     * @param {string} o.hash config hash
     * @param {boolean} [o.emptyHold] Form D: a weekday with total 0 is suspicious_empty
     * @param {(day: string, covered: (adsh: string, qid?: string) => boolean) => Promise<{ items: any[], stats: any }>} o.call
     * @returns {Promise<SourceResult>}
     */
    async function edgarSource(o) {
      const res = newResult(o.name);
      if (!net.edgar) { res.status = 'skipped'; res.reason = 'sec_contact_missing'; res.feed.skipped = 'sec_contact_missing'; return res; }
      const edgar = net.edgar;
      const st = await readState(o.stateKey);
      let cursor = st.cursor_date;
      /** @type {Record<string, any>} */
      let detail = st.detail;
      if (detail.config_hash && detail.config_hash !== o.hash) {
        cursor = null;
        detail = {};
        res.flags.push('config_reset');
      }
      detail.config_hash = o.hash;
      const slices = sliceDays({ cursor, today, lookbackDays: o.lookbackDays });
      let contiguous = true;
      /** @type {string|null} */
      let stopped = null;
      let processed = 0;
      let skippedWhole = false;
      try {
        for (const day of slices) {
          if (edgar.blocked) { stopped = 'sec_blocked'; break; }
          if (edgar.msLeft() <= 0) { stopped = 'deadline'; break; }
          const covered = await coveredFor(o.adapterSource, day);
          const out = await o.call(day, covered);
          addStats(res.stats, out.stats);
          if (out.stats.skipped) {
            if (processed === 0) { skippedWhole = true; res.reason = closedReason(out.stats.skipped); res.feed.skipped = String(out.stats.skipped); } else stopped = closedReason(out.stats.skipped);
            break;
          }
          processed += 1;
          let a = assessDay(out);
          const eligible = day <= anchors.bd2;
          if (o.emptyHold && a.complete && a.total === 0 && eligible) {
            const prev = detail.empty_hold;
            const runs = prev && prev.day === day ? Number(prev.runs) || 0 : 0;
            if (runs >= EMPTY_HOLD_RUNS) {
              detail.empty_hold = null;
              if (!res.flags.includes('suspicious_empty_released')) res.flags.push('suspicious_empty_released');
            } else {
              a = { ...a, complete: false, reasons: [...a.reasons, 'suspicious_empty'] };
              detail.empty_hold = { day, runs: runs + 1 };
            }
          }
          const advance = eligible && contiguous && a.complete;
          if (!dryRun) {
            await withTransaction(client, async () => {
              await persistItems(client, out.items);
              if (deps.hooks?.afterPersist) await deps.hooks.afterPersist({ source: o.stateKey, day });
              if (advance) await writeCursor(o.stateKey, day, detail);
            });
          } else res.items.push(...out.items);
          if (advance) cursor = day;
          if (eligible && !a.complete) contiguous = false;
          if (res.days.length < 40) res.days.push({ day, complete: a.complete, reasons: a.reasons, total: a.total, distinct: a.distinct, eligible, advanced: advance });
          if (!a.complete) {
            res.flags.push(...a.reasons.filter((r) => r === 'day_overflow'));
            if (!res.reason) res.reason = closedReason(a.reasons[0]);
          }
          if (!dryRun) res.items.length = 0;
          await beatNow();
          if (a.reasons.includes('run_cap')) { stopped = 'run_cap'; break; }
          if (edgar.deadlineHit) { stopped = 'deadline'; break; }
        }
      } catch (err) {
        log({ evt: 'target_source_failed', source: o.stateKey, err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
        res.status = 'failed';
        res.reason = 'exception';
        res.feed.skipped = 'exception';
      }
      res.backlog_days = backlogDays({ cursor, today, lookbackDays: o.lookbackDays });
      detail.backlog_days = res.backlog_days;
      const firstHold = res.days.find((d) => !d.complete);
      detail.held = firstHold ? { day: firstHold.day, reasons: firstHold.reasons } : null;
      if (!dryRun && !skippedWhole && res.status !== 'failed') {
        await writeCursor(o.stateKey, cursor, detail);
      }
      if (res.status !== 'failed') {
        if (skippedWhole) res.status = 'skipped';
        else if (stopped || res.days.some((d) => !d.complete)) {
          res.status = 'partial';
          if (stopped) res.reason = closedReason(stopped);
        } else res.status = 'complete';
      }
      if (!dryRun && res.status !== 'failed') {
        await recordSourceState(client, o.stateKey, { ok: res.status === 'complete' || res.status === 'partial', status: res.status });
      } else if (!dryRun) {
        await recordSourceState(client, o.stateKey, { ok: false, status: 'failed' });
      }
      return res;
    }

    // ---- sources ----------------------------------------------------------------------------------------
    const edgarCommon = { edgar: net.edgar, now, blocked: blocked.entries };
    if (wants('form_d')) {
      results.form_d = await safe('form_d', () => edgarSource({
        name: 'form_d', stateKey: 'edgar_form_d', adapterSource: 'edgar_form_d', lookbackDays: LOOKBACK_DAYS.form_d,
        hash: configHash({ forms: 'D,D/A', lookback: LOOKBACK_DAYS.form_d, v: 1 }), emptyHold: true,
        call: (day, covered) => runFormD({ ...edgarCommon, rules, window: { start: day, end: day }, maxPages: DAY_MAX_PAGES, covered }),
      }));
      await beatNow();
    }
    if (wants('8k')) {
      results['8k'] = await safe('8k', () => edgarSource({
        name: '8k', stateKey: 'edgar_8k', adapterSource: 'edgar_8k', lookbackDays: LOOKBACK_DAYS['8k'],
        hash: configHash({ q: '"Item 5.02"', forms: '8-K,8-K/A', lookback: LOOKBACK_DAYS['8k'], v: 1 }), emptyHold: false,
        call: (day, covered) => run8k({ ...edgarCommon, window: { start: day, end: day }, maxPages: DAY_MAX_PAGES, covered }),
      }));
      await beatNow();
    }
    if (wants('fts')) {
      results.fts = await safe('fts', () => ftsSources());
      await beatNow();
    }
    if (wants('alerts')) {
      results.alerts = await safe('alerts', () => alertsSource());
      await beatNow();
    }
    if (wants('gap')) {
      results.gap = await safe('gap', () => gapSource());
      await beatNow();
    }

    async function ftsSources() {
      const loaded = deps.ftsQueries ? { ok: /** @type {const} */ (true), queries: deps.ftsQueries } : loadFtsQueries(configDir);
      if (!loaded.ok) { const r = newResult('fts'); r.status = 'skipped'; r.reason = 'config_invalid'; r.feed.skipped = 'config_invalid'; return r; }
      const enabled = loaded.queries.filter((/** @type {any} */ q) => q.enabled);
      if (enabled.length === 0) { const r = newResult('fts'); r.status = 'disabled'; return r; }
      const merged = newResult('fts');
      merged.status = 'complete';
      let backlog = 0;
      for (const q of enabled) {
        const r = await safe('fts', () => edgarSource({
          name: 'fts', stateKey: `edgar_fts:${q.id}`, adapterSource: 'edgar_fts', lookbackDays: Math.min(LOOKBACK_DAYS.fts, q.window_days),
          hash: configHash({ q: q.q, forms: q.forms, trigger_kind: q.trigger_kind, window_days: q.window_days, v: 1 }), emptyHold: false,
          call: (day, covered) => runFts({ ...edgarCommon, queries: [q], window: { start: day, end: day }, maxPages: DAY_MAX_PAGES, covered: (adsh, qid) => covered(adsh, qid) }),
        }));
        addStats(merged.stats, { ...r.stats, warnings: r.stats.warnings, capped: r.stats.capped });
        merged.items.push(...r.items);
        merged.flags.push(...r.flags.map((f) => `${q.id}:${f}`));
        merged.days.push(...r.days.slice(0, 10).map((d) => ({ query: q.id, ...d })));
        backlog = Math.max(backlog, r.backlog_days ?? 0);
        if (STATUS_RANK[r.status] > STATUS_RANK[merged.status]) { merged.status = r.status; merged.reason = r.reason; }
        if (r.feed.skipped) merged.feed.skipped = r.feed.skipped;
      }
      merged.backlog_days = backlog;
      return merged;
    }

    async function alertsSource() {
      const res = newResult('alerts');
      const st = await readState('google_alert');
      const sinceMs = st.last_success_at ? now.getTime() - new Date(st.last_success_at).getTime() : 0;
      const daysSince = Math.max(0, Math.ceil(sinceMs / DAY_MS));
      // F9: a gap in successful runs widens the Gmail window so alerts from the gap are not lost.
      const windowDays = Math.min(365, Math.max(ALERT_WINDOW_DAYS, daysSince));
      const getAccessToken = deps.getAccessToken ?? makeGmailTokenProvider(deps.tokenFile === undefined ? (getEnv().GOOGLE_TOKEN_FILE || null) : deps.tokenFile);
      const out = await runGoogleAlerts({ guard: net.guard, getAccessToken, now, blocked: blocked.entries, configDir, windowDays });
      addStats(res.stats, out.stats);
      res.stats.extra.window_days = windowDays;
      if (out.stats.skipped) {
        if (out.stats.skipped === 'no_enabled_patterns') res.status = 'disabled';
        else { res.status = 'skipped'; res.reason = closedReason(out.stats.skipped); res.feed.skipped = out.stats.skipped; }
      } else if ((out.stats.extra?.message_cap_hit ?? 0) > 0) {
        res.status = 'partial';
        res.reason = 'message_cap';
      }
      if (res.status !== 'skipped' && res.status !== 'disabled') {
        if (dryRun) res.items.push(...out.items);
        else await withTransaction(client, () => persistItems(client, out.items));
      }
      if (!dryRun && res.status !== 'disabled') await recordSourceState(client, 'google_alert', { ok: res.status === 'complete' || res.status === 'partial', status: res.status });
      return res;
    }

    async function gapSource() {
      const res = newResult('gap');
      const feeds = {
        fts: results.fts && results.fts.status !== 'disabled' ? /** @type {any} */ ({ skipped: results.fts.status === 'skipped' || results.fts.status === 'failed' ? (results.fts.feed.skipped ?? 'skipped') : null, warnings: results.fts.stats.warnings }) : null,
        k8: results['8k'] ? /** @type {any} */ ({ skipped: results['8k'].status === 'skipped' || results['8k'].status === 'failed' ? (results['8k'].feed.skipped ?? 'skipped') : null, warnings: results['8k'].stats.warnings }) : null,
      };
      const out = await runGapSource({ query: (sql, params) => client.query(sql, params), departureFeeds: feeds });
      addStats(res.stats, out.stats);
      if ((out.stats.extra?.row_cap_hit ?? 0) > 0) { res.status = 'partial'; res.reason = 'run_cap'; }
      if (dryRun) res.items.push(...out.items);
      else {
        await withTransaction(client, () => persistItems(client, out.items));
        await recordSourceState(client, 'listings', { ok: true, status: res.status });
      }
      return res;
    }

    /** @param {string} name @param {() => Promise<SourceResult>} fn @returns {Promise<SourceResult>} */
    async function safe(name, fn) {
      try {
        return await fn();
      } catch (err) {
        log({ evt: 'target_source_failed', source: name, err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
        const r = newResult(name);
        r.status = 'failed';
        r.reason = 'exception';
        r.feed.skipped = 'exception';
        return r;
      }
    }

    // ---- classify from stored rows, dedup, upsert ------------------------------------------------------
    const cutoff = addDays(today, -130);
    const gapRan = Boolean(results.gap) && results.gap.status !== 'failed';
    const gapSince = gapRan ? startedDb : new Date(new Date(startedDb).getTime() - GAP_RECENT_DAYS * DAY_MS);
    const dryItems = Object.values(results).flatMap((r) => r.items);
    counts = await classifyPhase({ client, rules, blocked, now, cutoff, gapSince, dryRun, dryItems });
    await beatNow();

    // ---- status and row -------------------------------------------------------------------------------
    const active = Object.values(results).filter((r) => r.status !== 'disabled');
    const statuses = active.map((r) => r.status);
    /** @type {'ok'|'partial'|'failed'} */
    let status;
    if (statuses.every((s) => s === 'complete')) status = 'ok';
    else if (statuses.length > 0 && statuses.every((s) => s === 'failed')) status = 'failed';
    else status = 'partial';
    const attention = active.some((r) => r.status === 'skipped' || r.status === 'failed' || (r.status === 'partial' && (r.backlog_days ?? 0) > 0));
    const flags = [...new Set(active.flatMap((r) => r.flags))];
    const summary = summarize(results);
    if (!dryRun && runId !== null) {
      const tot = Object.values(results).reduce((acc, r) => { acc.raw += r.stats.raw; acc.parsed += r.stats.parsed; acc.unparseable += r.stats.unparseable; acc.oos += r.stats.out_of_scope; return acc; }, { raw: 0, parsed: 0, unparseable: 0, oos: 0 });
      await client.query(
        `UPDATE ic_target_runs SET status = $2, finished_at = now(), heartbeat_at = now(), signals_seen = $3, targets = $4, needs_review = $5, not_target = $6,
           items_raw = $7, items_parsed = $8, items_unparseable = $9, items_out_of_scope = $10,
           source_stats = $11::jsonb, coverage = $12::jsonb, backlog = $13::jsonb, skip_reasons = $14::jsonb, details = $15::jsonb
         WHERE id = $1`,
        [runId, status, tot.parsed, counts.kept_target ?? 0, counts.kept_needs_review ?? 0, counts.kept_not_target ?? 0,
          tot.raw, tot.parsed, tot.unparseable, tot.oos,
          JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.stats]))),
          JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.days]))),
          JSON.stringify(Object.fromEntries(Object.entries(results).filter(([, r]) => r.backlog_days !== null).map(([k, r]) => [k, r.backlog_days]))),
          JSON.stringify(Object.fromEntries(Object.entries(results).filter(([, r]) => r.reason).map(([k, r]) => [k, r.reason]))),
          JSON.stringify({ counts, flags, dry_run: false })],
      );
    }
    return { status, run_id: runId, dry_run: dryRun, sources: summary, counts, flags, attention };
  } catch (err) {
    log({ evt: 'targets_run_failed', err: err instanceof Error ? err.message.slice(0, 160) : 'error' });
    if (!dryRun && runId !== null) {
      await client.query(`UPDATE ic_target_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'running'`, [runId, 'exception']).catch(() => {});
    }
    return { status: 'failed', run_id: runId, error: 'exception', sources: summarize(results), counts, flags: [], attention: true };
  } finally {
    if (hb) clearInterval(hb);
    if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [TARGETS_LOCK_KEY]).catch(() => {});
  }
}

/** @param {Record<string, SourceResult>} results */
function summarize(results) {
  return Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { status: r.status, reason: r.reason, backlog_days: r.backlog_days, flags: r.flags.slice(0, 10) }]));
}

/**
 * Mark running rows whose heartbeat (else started_at) is stale as failed. Best effort, never throws.
 * @param {import('pg').ClientBase} client
 * @param {number} minutes
 * @param {(f: Record<string, unknown>) => void} log
 */
export async function reapStaleRuns(client, minutes, log = () => {}) {
  try {
    const r = await client.query(
      `UPDATE ic_target_runs SET status = 'failed', finished_at = now(), error = 'reaped'
       WHERE status = 'running' AND coalesce(heartbeat_at, started_at) < now() - ($1::int * interval '1 minute') RETURNING id`,
      [minutes],
    );
    if (r.rowCount) log({ evt: 'target_runs_reaped', count: r.rowCount });
    return r.rowCount ?? 0;
  } catch (err) {
    log({ evt: 'target_reaper_failed', err: err instanceof Error ? err.message.slice(0, 120) : 'error' });
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Classification from stored rows (plan 17.1, F5)
// ---------------------------------------------------------------------------------------------------------

/** @param {unknown} v @returns {number|null} */
function intOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * @param {Object} o
 * @param {import('pg').ClientBase} o.client
 * @param {any} o.rules
 * @param {import('../core/target-exclusion.js').BlockedList} o.blocked
 * @param {Date} o.now
 * @param {string} o.cutoff oldest signal day still loaded
 * @param {Date|string} o.gapSince listings signals fetched before this are not part of the snapshot
 * @param {boolean} o.dryRun
 * @param {Array<import('./outcomes.js').TargetItem>} o.dryItems
 */
export async function classifyPhase({ client, rules, blocked, now, cutoff, gapSince, dryRun, dryItems }) {
  /** @type {Array<{ id: number|string, signal: any, contact: any, extracted: any }>} */
  let rows;
  if (dryRun) {
    rows = dryItems.filter((it) => it.outcome === 'parsed' && it.signal).map((it, i) => ({ id: `dry:${i}`, signal: it.signal, contact: it.contact, extracted: it.extracted }));
  } else {
    const r = await client.query(
      `SELECT id, signal, contact, extracted FROM ic_target_signals
       WHERE parse_outcome = 'parsed' AND signal IS NOT NULL AND NOT (extracted ? 'superseded_by')
         AND (source <> 'listings' OR fetched_at >= $1::timestamptz)
         AND (
           target_id IN (SELECT id FROM ic_targets WHERE class <> 'not-target')
           OR coalesce(nullif(signal->>'event_date', ''), signal->>'filing_date') IS NULL
           OR coalesce(nullif(signal->>'event_date', ''), signal->>'filing_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           OR coalesce(nullif(signal->>'event_date', ''), signal->>'filing_date') >= $2
         )
       ORDER BY id DESC LIMIT 20000`,
      [gapSince, cutoff],
    );
    rows = r.rows.map((x) => ({ id: Number(x.id), signal: x.signal, contact: x.contact, extracted: x.extracted }));
  }
  const byId = new Map(rows.map((x) => [x.id, x]));
  const classified = rows.map((x) => {
    const verdict = classifySignal(x.signal, { rules, now, blocked });
    const td = verdict.inputs && typeof verdict.inputs.trigger_date === 'string' ? verdict.inputs.trigger_date : null;
    return { id: x.id, company: String(x.signal?.company ?? ''), class: verdict.class, trigger_date: td, rule: verdict.rule, verdict };
  });
  const { kept } = dedupSignals(classified);
  const counts = {
    signals_classified: classified.length, groups: kept.length, kept_target: 0, kept_needs_review: 0, kept_not_target: 0,
    new_targets: 0, new_needs_review: 0, changed: 0, regressed: 0, ungroupable: 0, blocked_sibling_forced: 0, not_target_week: 0,
  };
  for (const k of kept) {
    if (k.class === 'target') counts.kept_target += 1;
    else if (k.class === 'needs-review') counts.kept_needs_review += 1;
    else counts.kept_not_target += 1;
    if (k.rule === 'dedup_blocked_sibling') counts.blocked_sibling_forced += 1;
  }
  if (dryRun) return counts;

  /** @type {Map<string, { id: number, class: string, verdict_rule: string }>} */
  const prior = new Map();
  const norms = kept.map((k) => normalizeCompany(normalizeName(k.company)).company_norm).filter((n) => n && !n.startsWith('confidential:'));
  if (norms.length) {
    const pr = await client.query(`SELECT id, company_norm, class, verdict_rule FROM ic_targets WHERE company_norm = ANY($1::text[])`, [norms]);
    for (const p of pr.rows) prior.set(p.company_norm, { id: Number(p.id), class: p.class, verdict_rule: p.verdict_rule });
  }
  await withTransaction(client, async () => {
    for (const k of kept) {
      const norm = normalizeCompany(normalizeName(k.company)).company_norm;
      if (!norm || norm.startsWith('confidential:')) { counts.ungroupable += 1; continue; }
      const src = byId.get(/** @type {number|string} */ (k.id));
      const sig = src?.signal ?? {};
      const v = /** @type {any} */ (k).verdict;
      const before = prior.get(norm);
      /** @type {Record<string, unknown>} */
      const inputs = { ...v.inputs, collapsed_signal_ids: k.collapsed_ids, blocked_hint: Boolean(/** @type {any} */ (k).blocked_hint) };
      if (/** @type {any} */ (k).original_class) inputs.dedup = { original_class: /** @type {any} */ (k).original_class, original_rule: /** @type {any} */ (k).original_rule };
      if (before && before.class !== k.class) {
        inputs.previous = { class: before.class, rule: before.verdict_rule };
        counts.changed += 1;
        if (before.class === 'target') counts.regressed += 1;
      }
      const size = sig.size && typeof sig.size === 'object' ? sig.size : {};
      const kind = TRIGGER_KINDS.includes(sig.trigger_kind) ? sig.trigger_kind : null;
      const conf = SIZE_CONFIDENCES.includes(size.confidence) ? size.confidence : null;
      const listingIds = Array.isArray(src?.extracted?.listing_ids) ? src.extracted.listing_ids.filter((/** @type {unknown} */ n) => Number.isInteger(n)) : [];
      const collapsed = k.collapsed_ids.filter((/** @type {unknown} */ n) => Number.isInteger(n));
      const contact = src?.contact && typeof src.contact === 'object' ? src.contact : {};
      const up = await client.query(
        `INSERT INTO ic_targets (company, company_norm, class, reason, verdict_rule, verdict_inputs, trigger_kind, trigger_date, evidence_url,
           contact_role, contact_name, pe_firm, size_low, size_high, size_basis, size_confidence, size_verified, listing_ids, collapsed_signal_ids)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::int[],$19::int[])
         ON CONFLICT (company_norm) DO UPDATE SET
           company = EXCLUDED.company, class = EXCLUDED.class, reason = EXCLUDED.reason, verdict_rule = EXCLUDED.verdict_rule,
           verdict_inputs = EXCLUDED.verdict_inputs, trigger_kind = EXCLUDED.trigger_kind, trigger_date = EXCLUDED.trigger_date,
           evidence_url = EXCLUDED.evidence_url, contact_role = EXCLUDED.contact_role, contact_name = EXCLUDED.contact_name,
           pe_firm = EXCLUDED.pe_firm, size_low = EXCLUDED.size_low, size_high = EXCLUDED.size_high, size_basis = EXCLUDED.size_basis,
           size_confidence = EXCLUDED.size_confidence, size_verified = EXCLUDED.size_verified, listing_ids = EXCLUDED.listing_ids,
           collapsed_signal_ids = EXCLUDED.collapsed_signal_ids, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          String(sig.company ?? k.company).slice(0, 400), norm, k.class, k.rule, k.rule, JSON.stringify(inputs), kind,
          typeof v.inputs?.trigger_date === 'string' ? v.inputs.trigger_date : null,
          typeof sig.evidence_url === 'string' ? sig.evidence_url.slice(0, 2048) : null,
          typeof contact.role === 'string' ? contact.role.slice(0, 200) : null,
          typeof contact.name === 'string' ? contact.name.slice(0, 200) : null,
          typeof sig.pe_firm === 'string' ? sig.pe_firm.slice(0, 200) : null,
          intOrNull(size.low), intOrNull(size.high),
          typeof size.basis === 'string' ? size.basis.slice(0, 80) : null, conf, Boolean(v.size_verified),
          listingIds, collapsed,
        ],
      );
      const targetId = Number(up.rows[0].id);
      if (up.rows[0].inserted) {
        if (k.class === 'target') counts.new_targets += 1;
        else if (k.class === 'needs-review') counts.new_needs_review += 1;
      }
      const linked = [k.id, ...k.collapsed_ids].filter((n) => Number.isInteger(n));
      if (linked.length) await client.query(`UPDATE ic_target_signals SET target_id = $1 WHERE id = ANY($2::int[])`, [targetId, linked]);
    }
    const wk = await client.query(`SELECT count(*)::int AS n FROM ic_targets WHERE class = 'not-target' AND created_at >= now() - interval '7 days'`);
    counts.not_target_week = wk.rows[0].n;
  });
  return counts;
}

