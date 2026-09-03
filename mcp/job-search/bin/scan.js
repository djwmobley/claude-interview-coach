#!/usr/bin/env node
// @ts-check
/**
 * Scan CLI (spec section 6), for Windows Task Scheduler and manual runs.
 *
 *   node mcp/job-search/bin/scan.js --profile exec-default [--sources a,b] [--days N] [--max-pages N]
 *        [--min-prescore N] [--dry-run] [--json out] [--launch-chrome]
 *
 * Exit 0 ok / 2 partial or locked / 1 failed. SIGINT/SIGTERM abort the run;
 * the run loop closes its pages and releases the advisory lock. Logs JSONL to
 * logs/scan-YYYY-MM-DD.log (14-day retention); --json defaults to a file inside logs/.
 *
 * Config lock (scan-never-skip fix): an unattended run NEVER exits on a config-lock mismatch (the
 * incident this fix exists for: a lost scan day when a config drift was left unreviewed overnight).
 * Instead it proceeds with the on-disk config and records a CONFIG_LOCK_MISMATCH warning on the run --
 * the daily report renders it loudly ([LOCK MISMATCH]) without ever blocking the scan itself. A
 * config/*.json file that fails zod validation (CONFIG_INVALID) still exits unconditionally: that is a
 * real, broken config, not a drift-review question. A present-but-unlocked rubric (config/triage-
 * candidate.md whose gitignored triage-candidate.lock sidecar is missing or stale) similarly warns
 * (RUBRIC_UNLOCKED) rather than blocking. `--accept-config-change` no longer exists: there is nothing left
 * for it to override.
 *
 * --launch-chrome starts the DEDICATED scan Chrome from CHROME_EXECUTABLE with --user-data-dir=
 * SCAN_PROFILE_DIR and the port from SCAN_CDP_URL. It refuses port 9222 (the daily-driver instance) and
 * any non-loopback host outright (hard failures, not retried). Readiness is proven by a real DevTools
 * protocol round trip over the CDP websocket (src/core/chrome-launch.js's probeDevToolsProtocol), never
 * by the HTTP GET /json/version probe alone -- a zombie chrome-scan-profile process can keep answering
 * that HTTP endpoint while its DevTools websocket is wedged. A failed probe kills the whole
 * chrome-scan-profile process tree (matched only by command line containing the scan profile directory,
 * never by process name, never touching any other Chrome) and relaunches, up to two retries. Exhausting
 * every attempt records a CHROME_LAUNCH_FAILED warning and proceeds into the run rather than losing the
 * day; a successful self-heal records CHROME_RELAUNCHED so the report shows the browser needed repair.
 *
 * JOBSEARCH_FIXTURE_MAP=<file.json> replaces the network with recorded
 * responses ({"<url prefix>": "<fixture path>"}); used by test/scan-cli.test.js.
 *
 * JOBSEARCH_FIXTURE_NOW=<ISO date> pins runScan's freshness clock (opts.now) to a fixed instant
 * instead of the real clock, so fixture postings with hardcoded dates never drift stale as real time
 * advances. Test-only seam, mirrors JOBSEARCH_FIXTURE_MAP; used by test/scan-cli.test.js and
 * test/scan-cli-triage.test.js via test/helpers/scan-fixtures.js's FIXTURE_NOW.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getEnv, loadConfig, checkConfigLock, checkTriageCandidateLock } from '../src/core/config.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { errFields } from '../src/core/errors.js';
import { runScan } from '../src/core/scan-run.js';
import { probeDevToolsProtocol, selfHealingLaunch } from '../src/core/chrome-launch.js';

/** Closed list of valid --trigger values; default 'cli'. Anything else is a visible error (see main()). */
export const SCAN_TRIGGERS = Object.freeze(['cli', 'dashboard']);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    profile: 'exec-default',
    /** @type {string[]|undefined} */ sources: undefined,
    /** @type {number|undefined} */ days: undefined,
    /** @type {number|undefined} */ maxPages: undefined,
    /** @type {number|undefined} */ minPrescore: undefined,
    dryRun: false,
    /** @type {string|null|undefined} */ json: undefined,
    launchChrome: false,
    /** @type {string} */ trigger: 'cli',
    /** @type {string|undefined} */ runMarker: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--profile') out.profile = String(next() ?? 'exec-default');
    else if (a === '--sources') out.sources = String(next() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--days') out.days = Number(next());
    else if (a === '--max-pages') out.maxPages = Number(next());
    else if (a === '--min-prescore') out.minPrescore = Number(next());
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        out.json = v;
        i++;
      } else out.json = null;
    } else if (a === '--launch-chrome') out.launchChrome = true;
    else if (a === '--trigger') out.trigger = String(next() ?? 'cli');
    else if (a === '--run-marker') out.runMarker = String(next() ?? '');
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const USAGE = 'usage: node bin/scan.js --profile exec-default [--sources a,b] [--days N] [--max-pages N] [--min-prescore N] [--dry-run] [--trigger cli|dashboard] [--run-marker path] [--json [out]] [--launch-chrome]';

/**
 * Write `{"run_id": N}` to `markerFile` (dashboard PR 2, pr2-spec-decisions.md "Scan runner"): the
 * dashboard correlates its spawned child to a run by this file's appearance, never by timing. Written
 * synchronously from runScan's onRunStarted hook, i.e. immediately after the ic_scan_runs INSERT
 * returns and before any network activity for this run begins.
 * @param {string} markerFile
 * @param {number} runId
 */
export function writeRunMarker(markerFile, runId) {
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ run_id: runId }));
}

/**
 * Fixture transport for offline CLI tests: exact-prefix map of URL -> file.
 * @param {string} mapFile
 */
export function fixtureTransport(mapFile) {
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const base = path.dirname(mapFile);
  /** @type {typeof fetch} */
  const fixtureFetch = async (input, init) => {
    const url = String(input);
    const key = Object.keys(map).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const entry = map[key];
    const file = typeof entry === 'string' ? entry : entry.file;
    const status = typeof entry === 'object' && entry.status ? Number(entry.status) : 200;
    const body = fs.readFileSync(path.resolve(base, file), 'utf8');
    const ct = file.endsWith('.json') ? 'application/json' : 'text/html';
    void init;
    return new Response(body, { status, headers: { 'content-type': ct } });
  };
  /** @type {import('../src/core/urlguard.js').Lookup} */
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  return { fetch: fixtureFetch, lookup };
}

/**
 * Whether a CDP endpoint answers. Exported (dashboard PR 1) so bin/dashboard.js's health check and
 * tests can probe the scan Chrome without duplicating this fetch.
 * @param {string} cdpUrl
 */
export async function cdpReachable(cdpUrl) {
  try {
    const res = await fetch(new URL('/json/version', cdpUrl).toString(), { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Launch the dedicated scan Chrome, self-healing (src/core/chrome-launch.js's selfHealingLaunch): never
 * the 9222 daily driver (hard refusal, never retried); readiness proven by a real DevTools protocol round
 * trip, never the HTTP probe alone; a zombie chrome-scan-profile process is killed (command-line matched
 * only) and relaunched, up to two retries. Returns `{ port, launched, healed, attempts, killedPids,
 * warning }` -- `warning` (CHROME_RELAUNCHED or CHROME_LAUNCH_FAILED, both severity 'warning') is null
 * when the first probe already found Chrome healthy. Never throws for a launch/readiness failure -- only
 * the two guard checks below (wrong port, non-loopback host) throw, since those are refusals to even
 * attempt a launch, not launch failures to retry through.
 * @param {import('../src/core/config.js').Env} env
 * @param {(f: Record<string, string|number|boolean|null>) => void} log
 * @param {{ probe?: typeof probeDevToolsProtocol, listProcesses?: Function, killTree?: Function, spawn?: typeof spawn, sleep?: (ms: number) => Promise<void> }} [deps]
 */
export async function launchChrome(env, log, deps = {}) {
  const u = new URL(env.SCAN_CDP_URL);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (port === 9222) throw new Error('refusing to launch on port 9222: that is the daily-driver Chrome; set SCAN_CDP_URL to the dedicated scan port');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('SCAN_CDP_URL must point at a loopback address to launch Chrome');

  const spawnImpl = deps.spawn ?? spawn;
  const spawnChromeOnce = async () => {
    if (!env.CHROME_EXECUTABLE) throw new Error('CHROME_EXECUTABLE is not set; cannot launch the scan Chrome');
    if (!fs.existsSync(env.CHROME_EXECUTABLE)) throw new Error('CHROME_EXECUTABLE does not exist');
    fs.mkdirSync(env.SCAN_PROFILE_DIR, { recursive: true });
    const args = [
      `--user-data-dir=${env.SCAN_PROFILE_DIR}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=http://127.0.0.1:' + port + ',http://localhost:' + port,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'about:blank',
    ];
    const child = spawnImpl(env.CHROME_EXECUTABLE, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref?.();
    log({ evt: 'chrome_launched', port, pid: child.pid ?? null });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await cdpReachable(env.SCAN_CDP_URL)) return;
    }
    throw new Error('scan Chrome did not expose its HTTP debug endpoint within 20 s');
  };

  const result = await selfHealingLaunch(
    { cdpUrl: env.SCAN_CDP_URL, profileDir: env.SCAN_PROFILE_DIR },
    { probe: deps.probe ?? probeDevToolsProtocol, spawnChrome: spawnChromeOnce, listProcesses: deps.listProcesses, killTree: deps.killTree, log, sleep: deps.sleep },
  );
  return { port, ...result };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!SCAN_TRIGGERS.includes(/** @type {any} */ (args.trigger))) {
    console.log(JSON.stringify({ ok: false, code: 'VALIDATION', message: `--trigger must be one of ${SCAN_TRIGGERS.join(', ')}, got "${args.trigger}"` }));
    process.exit(1);
  }
  const env = getEnv();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'scan', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'scan'), name: 'scan' });
  /** @param {Record<string, string|number|boolean|null>} f */
  const log = (f) => logger.info(f);

  // Config lock (scan-never-skip fix): NEVER exits on a mismatch. The run proceeds with the on-disk
  // config; a warning rides along in the run's own errors so the daily report renders it loudly without
  // ever blocking the scan (the incident this fix exists for: a lost scan day when the old hard-exit fired
  // unattended and produced a bare [NO SCAN] digest with no reason shown).
  /** @type {Array<{ source: null, code: string, severity: 'warning', [k: string]: any }>} */
  const preRunWarnings = [];
  const lock = checkConfigLock();
  if (!lock.ok) {
    log({ evt: 'config_lock_mismatch', expected: lock.expected, actual: lock.actual, missing: lock.missing.join(',') });
    preRunWarnings.push({
      source: null,
      code: 'CONFIG_LOCK_MISMATCH',
      severity: 'warning',
      expected: lock.expected,
      actual: lock.actual,
      missing: lock.missing,
      remedy: lock.detail,
    });
  }

  // config/*.json failing zod validation (a real, broken config) still exits unconditionally -- this is
  // never a drift-review question the way a lock-hash mismatch is.
  let config;
  try {
    config = loadConfig({ fresh: true });
  } catch (err) {
    const f = errFields(err);
    log({ evt: 'config_invalid', ...f });
    console.log(JSON.stringify({ ok: false, ...f }));
    process.exit(1);
  }

  // Rubric integrity (spec section 5): the rubric itself is never part of config.lock.json any more; its
  // own gitignored sidecar tracks it. Absent rubric is not a warning (triage already degrades with
  // candidate_summary_missing); present-but-unlocked is.
  const rubricLock = checkTriageCandidateLock(env.JOBSEARCH_CONFIG_DIR);
  if (rubricLock.present && !rubricLock.ok) {
    log({ evt: 'rubric_unlocked', expected: rubricLock.expected, actual: rubricLock.actual });
    preRunWarnings.push({ source: null, code: 'RUBRIC_UNLOCKED', severity: 'warning', remedy: 'run node bin/config-lock.js --write in the main checkout' });
  }

  if (args.launchChrome) {
    try {
      const chrome = await launchChrome(env, log);
      if (chrome.warning) preRunWarnings.push({ source: null, ...chrome.warning });
    } catch (err) {
      // Only the launchChrome guard refusals (wrong port, non-loopback host) throw -- a real launch/
      // readiness failure never does (it self-heals or warns and proceeds via chrome.warning above).
      const f = errFields(err);
      log({ evt: 'chrome_launch_failed', ...f });
      console.log(JSON.stringify({ ok: false, code: 'BROWSER_UNAVAILABLE', message: f.err_message }));
      process.exit(1);
    }
  }

  /** @type {import('../src/core/scan-run.js').RunDeps} */
  const deps = { config, env };
  if (process.env.JOBSEARCH_FIXTURE_MAP) {
    const t = fixtureTransport(process.env.JOBSEARCH_FIXTURE_MAP);
    deps.fetch = t.fetch;
    deps.lookup = t.lookup;
    deps.sleep = async () => {};
    log({ evt: 'fixture_transport_active', map: path.basename(process.env.JOBSEARCH_FIXTURE_MAP) });
  }

  /** @type {Date|undefined} */
  let fixedNow;
  if (process.env.JOBSEARCH_FIXTURE_NOW) {
    fixedNow = new Date(process.env.JOBSEARCH_FIXTURE_NOW);
    log({ evt: 'fixture_now_active', now: fixedNow.toISOString() });
  }

  const controller = new AbortController();
  const onSignal = (/** @type {string} */ sig) => {
    log({ evt: 'signal', signal: sig });
    controller.abort();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let code = 1;
  /** @type {any} */
  let result;
  try {
    result = await runScan(
      { profile: args.profile, sources: args.sources, postedWithinDays: args.days, maxPages: args.maxPages, minPrescore: args.minPrescore, dryRun: args.dryRun, wait: true },
      deps,
      {
        trigger: /** @type {'cli'|'dashboard'} */ (args.trigger),
        signal: controller.signal,
        log,
        progress: (f) => log({ evt: 'progress', ...f }),
        ...(fixedNow ? { now: fixedNow } : {}),
        ...(args.runMarker ? { onRunStarted: (runId) => writeRunMarker(/** @type {string} */ (args.runMarker), runId) } : {}),
        ...(preRunWarnings.length ? { preRunWarnings } : {}),
      },
    );
    if (result.status === 'ok') code = 0;
    else if (result.status === 'partial' || result.status === 'locked') code = 2;
    else code = 1;
  } catch (err) {
    const f = errFields(err);
    log({ evt: 'scan_failed', ...f });
    result = { ok: false, ...f };
    code = 1;
  }
  if (args.json !== undefined) {
    const file = args.json ?? path.join(env.JOBSEARCH_LOG_DIR, `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
    log({ evt: 'json_written', file: path.basename(file) });
  }
  const summary = { ok: result.ok, run_id: result.run_id ?? null, status: result.status ?? null, stats: result.stats ?? null, errors: (result.errors ?? []).slice(0, 5) };
  if (result.code || result.err_code) Object.assign(summary, { code: result.code ?? result.err_code, message: String(result.message ?? result.err_message ?? '').slice(0, 300), hint: result.hint ?? null });
  console.log(JSON.stringify(summary));
  process.exit(code);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
