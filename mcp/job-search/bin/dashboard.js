#!/usr/bin/env node
// @ts-check
/**
 * Dashboard entry point (dashboard PR 2, plan line 74 and pr2-spec-decisions.md "Single instance and
 * startup"). Binds 127.0.0.1 only; a caller connecting via `http://localhost:PORT/` may resolve to `::1`
 * on some resolvers, but the URL this process prints always uses the literal 127.0.0.1 address it bound.
 *
 *   node bin/dashboard.js [--port N] [--open] [--help]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { getEnv, loadConfig, repoRoot } from '../src/core/config.js';
import { withClient, closePool } from '../src/core/db.js';
import { createLogger, dailyLogPath, pruneLogs } from '../src/core/logger.js';
import { errFields } from '../src/core/errors.js';
import { makeCalendarProvider } from '../src/core/calendar-provider.js';
import { createCredentials } from '../src/core/credentials.js';
import { startupDb } from '../src/core/startup.js';
import { defaultDeps } from '../src/tools/_shared.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { createScanRunner } from '../src/dashboard/scan-runner.js';
import { createApplyRunner } from '../src/dashboard/apply-runner.js';
import { createCalendarCache } from '../src/dashboard/calendar-cache.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(HERE, '..');

export const DEFAULT_PORT = 7311;
export const VERSION = '0.1.0';
export const SERVICE_NAME = 'job-search-dashboard';

const USAGE = 'usage: node bin/dashboard.js [--port N] [--open] [--help]';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ port: number|undefined, open: boolean, help: boolean }} */
  const out = { port: undefined, open: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--open') out.open = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * DASHBOARD_PORT (or --port): must be an integer 1024-65535; otherwise fall back to DEFAULT_PORT with a
 * logged warning and a health-banner entry (decision 2). Checked before listen.
 * @param {number|undefined} cliPort
 * @param {string|undefined} envValue
 * @param {(fields: Record<string, string|number|boolean|null>) => void} log
 * @returns {{ port: number, warning: string|null }}
 */
export function resolvePort(cliPort, envValue, log) {
  const raw = cliPort !== undefined && !Number.isNaN(cliPort) ? cliPort : envValue !== undefined && envValue.trim() ? Number(envValue) : undefined;
  if (raw === undefined) return { port: DEFAULT_PORT, warning: null };
  if (!Number.isInteger(raw) || raw < 1024 || raw > 65535) {
    log({ evt: 'dashboard_port_invalid', raw_value: String(raw), fallback_port: DEFAULT_PORT });
    return { port: DEFAULT_PORT, warning: `configured port "${raw}" is not an integer 1024-65535; using ${DEFAULT_PORT}` };
  }
  return { port: raw, warning: null };
}

/**
 * EADDRINUSE probe (decision 1): 2 s timeout; exit 0 (single-instance, not an error) only if the body
 * parses as JSON with `service === 'job-search-dashboard'`. Any other outcome (non-2xx, timeout,
 * non-JSON, a different service) means the port is held by something else -> exit 1.
 * @param {number} port
 */
export async function probeExistingHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { same: false, reason: `non-2xx status ${res.status}` };
    /** @type {any} */
    let body;
    try {
      body = await res.json();
    } catch {
      return { same: false, reason: 'response body is not JSON' };
    }
    if (body && typeof body === 'object' && body.service === SERVICE_NAME) return { same: true, reason: null };
    return { same: false, reason: 'a different service answered on this port' };
  } catch (err) {
    return { same: false, reason: err instanceof Error && err.name === 'TimeoutError' ? 'health probe timed out' : 'health probe failed' };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const env = getEnv();
  pruneLogs(env.JOBSEARCH_LOG_DIR, 'dashboard', 14);
  const logger = createLogger({ file: dailyLogPath(env.JOBSEARCH_LOG_DIR, 'dashboard'), name: 'dashboard' });
  /** @param {Record<string, string|number|boolean|null>} f */
  const log = (f) => logger.info(f);

  /** @type {string[]} */
  const healthBanner = [];
  /** @type {import('../src/core/config.js').LoadedConfig|null} */
  let config = null;
  try {
    config = loadConfig();
  } catch (err) {
    const f = errFields(err);
    log({ evt: 'dashboard_config_invalid', ...f });
    healthBanner.push(`config invalid: ${f.err_message}`);
  }

  const { port, warning: portWarning } = resolvePort(args.port, env.DASHBOARD_PORT, log);
  if (portWarning) healthBanner.push(portWarning);

  await startupDb();

  const scanRunner = createScanRunner({
    env,
    logDir: env.JOBSEARCH_LOG_DIR,
    scanScript: path.join(PACKAGE_ROOT, 'bin', 'scan.js'),
    spawn: nodeSpawn,
    log,
  });
  const applyRunner = createApplyRunner({
    env,
    logDir: env.JOBSEARCH_LOG_DIR,
    applyScript: path.join(PACKAGE_ROOT, 'bin', 'apply.js'),
    spawn: nodeSpawn,
    log,
  });

  const deps = {
    ...defaultDeps({ withClient, config, env, calendar: makeCalendarProvider(env) }),
    scanRunner,
    applyRunner,
    calendarCache: createCalendarCache(),
    credentials: createCredentials(),
    outputRoot: path.join(repoRoot(), 'output'),
    version: VERSION,
    startedAt: new Date().toISOString(),
    log,
    healthBanner,
  };

  const app = createDashboardServer(/** @type {any} */ (deps));

  try {
    await app.listen(port, '127.0.0.1');
  } catch (/** @type {any} */ err) {
    if (err && err.code === 'EADDRINUSE') {
      const probe = await probeExistingHealth(port);
      if (probe.same) {
        log({ evt: 'dashboard_already_running', port });
        process.exit(0);
      }
      log({ evt: 'dashboard_port_in_use', port, reason: probe.reason });
      process.exit(1);
    }
    log({ evt: 'dashboard_listen_failed', ...errFields(err) });
    process.exit(1);
    return;
  }

  log({ evt: 'dashboard_started', port, pid: process.pid });
  console.log(`job-search dashboard listening on http://127.0.0.1:${port}/`);

  if (args.open) {
    // execFile (no shell) even though `port` is our own validated integer: never build a shell string
    // from data that flows toward a shell, even trusted-looking data.
    const url = `http://127.0.0.1:${port}/`;
    if (process.platform === 'win32') execFile('cmd.exe', ['/c', 'start', '""', url], () => {});
    else if (process.platform === 'darwin') execFile('open', [url], () => {});
    else execFile('xdg-open', [url], () => {});
  }

  let shuttingDown = false;
  /** @param {string} signal */
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ evt: 'dashboard_shutdown', signal });
    // 5 s grace, then force-exit; the detached scan child (if any) is never touched here.
    const forceTimer = setTimeout(() => process.exit(0), 5000);
    forceTimer.unref?.();
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    await closePool();
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
