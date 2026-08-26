// @ts-check
/**
 * job-search MCP server (spec section 5). stdout carries JSON-RPC frames
 * only; everything else goes to stderr through pino (see stdout-hygiene.js,
 * which must stay the first import).
 */
import './core/stdout-hygiene.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { getEnv, loadConfig } from './core/config.js';
import { withClient, closePool } from './core/db.js';
import { log } from './core/logger.js';
import { errFields } from './core/errors.js';
import { ensureAuxSchema } from './core/schema.js';
import { seedExecDefault } from './core/profile-seed.js';
import { googleHttp, calendarInsertEvent, calendarDeleteEvent } from './core/google.js';
import { wrapHandler, defaultDeps } from './tools/_shared.js';
import { fetchDetailForRow } from './core/scan-run.js';
import { tool as searchJobs } from './tools/search_jobs.js';
import { tool as queryJobs } from './tools/query_jobs.js';
import { tool as getJob } from './tools/get_job.js';
import { tool as markJobs } from './tools/mark_jobs.js';
import { tool as profiles } from './tools/profiles.js';
import { tool as scans } from './tools/scans.js';
import { tool as review } from './tools/review.js';
import { tool as renderDoc } from './tools/render_doc.js';
import { tool as followups } from './tools/followups.js';
import { tool as scanReport } from './tools/scan_report.js';

export const SERVER_INFO = Object.freeze({ name: 'job-search', version: '0.1.0' });

/** Registration order is the tools/list order. */
export const TOOLS = Object.freeze([searchJobs, queryJobs, getJob, markJobs, profiles, scans, review, renderDoc, followups, scanReport]);

/**
 * Lazy calendar deps: token loaded on first use, access token cached until
 * shortly before expiry. Returns null (with a logged warning) when the token
 * file is missing or lacks the calendar scope, so followups still work.
 * @param {import('./core/config.js').Env} env
 */
export function makeCalendarProvider(env) {
  /** @type {{ deps: import('./core/google.js').HttpDeps, until: number }|null} */
  let cached = null;
  return async () => {
    const now = Date.now();
    if (cached && cached.until > now) return wrap(cached.deps);
    if (!env.GOOGLE_TOKEN_FILE) {
      log.warn({ evt: 'google_token_unavailable', err_code: 'VALIDATION', err_message: 'GOOGLE_TOKEN_FILE is not set; add it to mcp/job-search/.env' });
      return null;
    }
    try {
      const g = await googleHttp({ tokenFile: env.GOOGLE_TOKEN_FILE, need: { calendar: true } });
      const exp = g.expiry ? Date.parse(g.expiry) : now + 30 * 60000;
      cached = { deps: g.deps, until: Math.min(exp - 60000, now + 50 * 60000) };
      log.info({ evt: 'google_token_ok', calendar_ok: g.info.calendar_ok, expiry: g.expiry });
      return wrap(g.deps);
    } catch (err) {
      log.warn({ evt: 'google_token_unavailable', ...errFields(err) });
      return null;
    }
  };
  /** @param {import('./core/google.js').HttpDeps} deps */
  function wrap(deps) {
    return {
      insertEvent: (/** @type {any} */ ev) => calendarInsertEvent(deps, ev),
      deleteEvent: (/** @type {string} */ id) => calendarDeleteEvent(deps, id),
    };
  }
}

/**
 * Build the McpServer with all nine tools registered.
 * @param {Partial<import('./tools/_shared.js').ToolDeps>} [overrides]
 */
export function buildServer(overrides = {}) {
  const env = getEnv();
  /** @type {import('./core/config.js').LoadedConfig|null} */
  let config = null;
  try {
    config = loadConfig();
  } catch (err) {
    log.warn({ evt: 'config_invalid', ...errFields(err) });
  }
  const deps = defaultDeps({ withClient, config, env, calendar: makeCalendarProvider(env), ...overrides });
  if (!deps.fetchDetail) deps.fetchDetail = (row) => fetchDetailForRow(/** @type {any} */ (row), { withClient: deps.withClient, config: deps.config, env: deps.env, fetch: deps.fetch });
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {}, logging: {} } });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, wrapHandler(t, deps));
  }
  return { server, deps };
}

/** Best-effort startup DB work: aux schema, profile seed. DB down is logged, not fatal. */
export async function startupDb() {
  try {
    await withClient(async (c) => {
      const applied = await ensureAuxSchema(c);
      const seed = await seedExecDefault(c);
      log.info({ evt: 'startup_db', aux_applied: applied.length, profile_seeded: seed.seeded, profile_from: seed.from });
    });
  } catch (err) {
    log.warn({ evt: 'startup_db_failed', ...errFields(err) });
  }
}

export async function main() {
  const { server } = buildServer();
  await startupDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info({ evt: 'server_started', tools: TOOLS.length, pid: process.pid });
  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    log.error({ evt: 'server_failed', ...errFields(err) });
    process.exit(1);
  });
}
