// @ts-check
/**
 * Configuration loader.
 *
 * - Resolves the repo root (CLAUDE_PROJECT_DIR, else the directory four levels
 *   above this file, which is where mcp/job-search/src/core lives). The MCP
 *   launch does not run a shell, so this module loads mcp/job-search/.env
 *   itself before anything reads process.env.
 * - Validates config/*.json with zod. Config files fail closed: an invalid
 *   file refuses the run with CONFIG_INVALID.
 * - Computes sha256 over config/*.json for the config lock.
 *
 * All exports are synchronous so normalize.js can pull defaults at import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { JobSearchError } from './errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root: CLAUDE_PROJECT_DIR wins; otherwise derive from this file's location. */
export function repoRoot() {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.resolve(HERE, '..', '..', '..', '..');
}

/** mcp/job-search directory. */
export function packageRoot() {
  return path.join(repoRoot(), 'mcp', 'job-search');
}

/**
 * Minimal .env parser: KEY=VALUE lines, `#` comments, optional single or double quotes.
 * Existing process.env values win (an explicit environment beats the file).
 * @param {string} file
 * @returns {number} count of keys applied
 */
export function loadDotenv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  let applied = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    if (process.env[key] === undefined) {
      process.env[key] = val;
      applied++;
    }
  }
  return applied;
}

let dotenvLoaded = false;
/** Load mcp/job-search/.env once. Safe to call repeatedly. */
export function ensureDotenv() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  loadDotenv(path.join(packageRoot(), '.env'));
}

/**
 * @typedef {Object} Env
 * @property {string|null} PG_DSN full connection URL from .env, or null to use the local defaults
 * @property {string} SCAN_CDP_URL
 * @property {string} DAILY_CDP_URL the operator's normal daily-driver Chrome (remote debugging), used
 *   only by bin/remind.js --open-dashboard to reload/focus an already-open dashboard tab. Distinct from
 *   SCAN_CDP_URL (the dedicated scan browser profile on a different port): the two must never be
 *   conflated, so this has its own env var and its own default port rather than reusing SCAN_CDP_URL.
 * @property {string} SCAN_PROFILE_DIR
 * @property {string|null} CHROME_EXECUTABLE
 * @property {string} OLLAMA_URL
 * @property {string} OLLAMA_MODEL
 * @property {string} JOBSEARCH_LOG_DIR
 * @property {string} JOBSEARCH_CONFIG_DIR
 * @property {string} GOOGLE_TOKEN_FILE
 * @property {string} REMINDER_TO
 * @property {string} LOG_LEVEL
 * @property {string|undefined} DASHBOARD_PORT raw string from .env/process.env; bin/dashboard.js
 *   validates and falls back to its own default (7311) -- getEnv() does not itself validate or default
 *   this one, since resolvePort()'s fallback-with-warning behavior needs the raw, possibly-invalid value.
 */

/**
 * Resolve a path against the repo root when relative.
 * @param {string} p
 */
export function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot(), p);
}

/** @returns {Env} */
export function getEnv() {
  ensureDotenv();
  const e = process.env;
  return {
    PG_DSN: e.PG_DSN || null,
    SCAN_CDP_URL: e.SCAN_CDP_URL || 'http://127.0.0.1:9333',
    DAILY_CDP_URL: e.DAILY_CDP_URL || 'http://127.0.0.1:9222',
    SCAN_PROFILE_DIR: e.SCAN_PROFILE_DIR || path.join(os.homedir(), 'chrome-scan-profile'),
    CHROME_EXECUTABLE: e.CHROME_EXECUTABLE || null,
    OLLAMA_URL: (e.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
    OLLAMA_MODEL: e.OLLAMA_MODEL || 'mxbai-embed-large',
    JOBSEARCH_LOG_DIR: resolveFromRoot(e.JOBSEARCH_LOG_DIR || path.join('mcp', 'job-search', 'logs')),
    JOBSEARCH_CONFIG_DIR: resolveFromRoot(e.JOBSEARCH_CONFIG_DIR || path.join('mcp', 'job-search', 'config')),
    GOOGLE_TOKEN_FILE: e.GOOGLE_TOKEN_FILE || '',
    REMINDER_TO: e.REMINDER_TO || '',
    LOG_LEVEL: e.LOG_LEVEL || 'info',
    DASHBOARD_PORT: e.DASHBOARD_PORT || undefined,
  };
}

/**
 * Best-effort database name extraction from a connection string, for assertTestDbGuard() only -- an
 * unparseable string just fails that guard's "_test" check, which is the safe direction.
 * @param {string} connectionString
 * @returns {string|null}
 */
function dbNameFromConnectionString(connectionString) {
  try {
    return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

/**
 * Structural guard against running a test file directly (`node --test test/x.test.js`) instead of
 * through `npm test` / bin/run-tests.js: PG_DSN then resolves to whatever .env already points at -- the
 * real, configured database, not the isolated "_test" database bin/run-tests.js bootstraps and points
 * PG_DSN at for its spawned child. That exact mistake corrupted a real, shared singleton row
 * (ic_report_state) in this project's own database once; it was caught and repaired by hand, which is
 * not a defense, just luck. This guard makes the same mistake fail loudly and immediately, before any
 * connection is opened, instead of silently succeeding against production.
 *
 * Called from pgConnectionConfig() itself (not only from src/core/db.js's getPool()/connectDedicated()):
 * several test files construct `new pg.Client(pgConnectionConfig())` directly rather than going through
 * db.js, which is exactly the pathway the real incident went through -- a guard placed only in db.js
 * would not have caught it. pgConnectionConfig() is the one function every one of those paths actually
 * calls, so the check lives here; db.js additionally calls this same guard on its own two entry points
 * as a second, redundant layer.
 *
 * "Running under the test runner" is detected three ways -- any one trips the guard, this is a total
 * classification of the ways this project's tests get invoked, not a best-effort heuristic:
 *   - process.env.NODE_TEST_CONTEXT is set (Node's own `node --test` marker; present on every worker
 *     under this project's supported Node versions)
 *   - any process.argv entry contains "--test" (belt and braces for an invocation shape where Node
 *     surfaces the flag in argv instead of consuming it before argv is built)
 *   - process.env.JOBSEARCH_TEST_GUARD === '1' (bin/run-tests.js sets this explicitly on its spawned
 *     child alongside the test PG_DSN, so the guard still trips even on a future Node version that stops
 *     setting NODE_TEST_CONTEXT)
 *
 * When running under the test runner, the resolved database name MUST end in "_test" -- this mirrors
 * bin/bootstrap-test-db.js's own hard safety gate. bootstrap-test-db.js itself calls pgConnectionConfig()
 * from bin/run-tests.js's PARENT process (before the `node --test` child is even spawned), which is
 * never itself running under the test runner, so its legitimate need to resolve the REAL source
 * database's DSN (to pg_dump the schema FROM it) is unaffected by this guard.
 * @param {import('pg').ClientConfig} cfg
 */
export function assertTestDbGuard(cfg) {
  const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT)
    || process.argv.some((a) => typeof a === 'string' && a.includes('--test'))
    || process.env.JOBSEARCH_TEST_GUARD === '1';
  if (!underTestRunner) return;
  const dbName = 'connectionString' in cfg && typeof cfg.connectionString === 'string'
    ? dbNameFromConnectionString(cfg.connectionString)
    : /** @type {{ database?: string }} */ (cfg).database ?? null;
  if (typeof dbName === 'string' && dbName.endsWith('_test')) return;
  throw new Error(
    `refusing to connect to database "${dbName ?? '(unknown)'}" while running under the Node test runner: its name does not end in "_test". `
    + `Run tests through "npm test" (bin/run-tests.js), which bootstraps an isolated "_test" database and points PG_DSN at it for you. `
    + `Never run a test file directly with "node --test <file>" -- that connects to whatever PG_DSN/.env already points at, which is the real database most of the time.`,
  );
}

/**
 * pg connection options. With PG_DSN set, the URL is used verbatim; otherwise
 * the local trust-auth defaults (host localhost, port 5432, db ic_context,
 * user postgres, no password) are given as discrete fields. Kept as fields on
 * purpose: no connection URL literal lives in tracked source.
 * @param {string|null} [dsn] override (CLI --dsn)
 * @returns {import('pg').ClientConfig}
 */
export function pgConnectionConfig(dsn) {
  const env = getEnv();
  const url = dsn ?? env.PG_DSN;
  /** @type {import('pg').ClientConfig} */
  const cfg = url ? { connectionString: url } : { host: 'localhost', port: 5432, database: 'ic_context', user: 'postgres' };
  assertTestDbGuard(cfg);
  return cfg;
}

// ---------------------------------------------------------------------------
// zod schemas
// ---------------------------------------------------------------------------

const FORBIDDEN_SELECTOR = /(text=|:has-text|>>|xpath=)/i;
const selector = z.string().min(1).max(300).refine((s) => !FORBIDDEN_SELECTOR.test(s), {
  message: 'selector may not contain text=, :has-text, >>, or xpath=',
});

const domain = z.string().regex(/^[a-z0-9.-]+$/i, 'domain must be a bare hostname');
const pathPattern = z.string().min(1).max(300).refine((p) => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
}, { message: 'pathPattern must be a valid regex' });

const adapterSchema = z.object({
  transport: z.enum(['browser', 'fetch', 'html']),
  domains: z.array(domain),
  pathPatterns: z.array(pathPattern),
  delayMs: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).refine(([a, b]) => a <= b, 'delayMs min must be <= max'),
  dailyPages: z.number().int().positive(),
  dailyDetails: z.number().int().nonnegative(),
  maxPagesPerQuery: z.number().int().min(1).max(5),
  /** Per-source override of run.detailFetchMinPrescore (spec R4.1); falls back to the run-level default when absent. */
  detailFetchMinPrescore: z.number().int().min(0).max(100).optional(),
  /** Hard cap on pages fetched for this source across the WHOLE run, regardless of how many queries the profile plans (spec R5.1); undefined means no extra cap beyond the daily/per-query ones. */
  maxPagesPerRun: z.number().int().positive().optional(),
});

/**
 * Single source of truth for the "Houston / Texas" report section's prescore floor (spec item 5;
 * threading fix: report.js's buildScanReport() imports this directly instead of hardcoding its own copy
 * of the number 40, so there is exactly one place this default lives -- the zod schema below and every
 * caller's own fallback, when config is unavailable, both reference it).
 */
export const DEFAULT_REPORT_HOME_MIN_PRESCORE = 40;

export const adaptersSchema = z.object({
  dedup: z.object({
    repostGapDays: z.number().int().positive(),
    reviewAutoSeparateDays: z.number().int().positive(),
    titleSimilarity: z.number().min(0).max(1),
    companySimilarity: z.number().min(0).max(1),
    postedAtCorroborationDays: z.number().int().nonnegative(),
    expireAfterAbsentRuns: z.number().int().positive(),
  }),
  trackingParams: z.array(z.string().min(1)),
  /** Trailing source-UI fragments to strip from a title (spec R3.1 defense: LinkedIn's verified-badge
   * text, "<title> with verification"). Total classification in normalize.js's stripTrailingUiFragments:
   * a fragment not on this list is left in place, never guessed at. */
  titleTrailingFragments: z.array(z.string().min(1)).default(['with verification']),
  httpAllowedHosts: z.array(domain),
  adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), adapterSchema),
  run: z.object({
    maxPlannedPagesPerRun: z.number().int().positive(),
    runTimeoutMinutes: z.number().int().positive(),
    heartbeatStaleMinutes: z.number().int().positive(),
    detailFetchMinPrescore: z.number().int().min(0).max(100),
    backoff: z.object({ maxDelayMs: z.number().int().positive(), retries: z.number().int().nonnegative() }),
    throttleRatio: z.number().min(0).max(1),
    /** IANA zone for report day-bucketing (spec R1, decision 25). */
    timezone: z.string().min(1).default('America/Chicago'),
    /** Default row count for the report's "Look at these" section (spec R1.2b). */
    reportTopN: z.number().int().positive().default(10),
    /** Minimum prescore for the report's "Houston / Texas" section (independent review round 2 fix: an unfiltered "any prescore" list surfaced very low-relevance rows like an RN Clinical Director posting). */
    reportHomeMinPrescore: z.number().int().min(0).max(100).default(DEFAULT_REPORT_HOME_MIN_PRESCORE),
  }),
});

export const atsBoardsSchema = z.object({
  greenhouse: z.array(z.object({
    board: z.string().regex(/^[a-z0-9-]+$/),
    company: z.string().min(1),
    hosts: z.array(domain).default([]),
    enabled: z.boolean().default(true),
  })),
  lever: z.array(z.object({
    company: z.string().regex(/^[a-z0-9-]+$/),
    displayName: z.string().min(1),
    enabled: z.boolean().default(true),
  })),
  workday: z.array(z.object({
    tenant: z.string().regex(/^[a-z0-9_-]+$/),
    site: z.string().min(1),
    wd: z.string().regex(/^wd\d+$/),
    displayName: z.string().min(1),
    enabled: z.boolean().default(true),
  })),
  dayforce: z.array(z.object({
    host: domain,
    client: z.string().regex(/^[a-z0-9_-]+$/i),
    lang: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
    displayName: z.string().min(1),
    enabled: z.boolean().default(true),
  })),
});

const httpsUrl = z.string().url().refine((u) => /^https:\/\//i.test(u), { message: 'listUrl must be https' });

export const execBoardsSchema = z.object({
  boards: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    listUrl: httpsUrl,
    domains: z.array(domain).min(1),
    pathPatterns: z.array(pathPattern).min(1),
    mode: z.enum(['fetch', 'browser']),
    enabled: z.boolean().default(true),
    selectors: z.object({
      item: selector.optional(),
      title: selector.optional(),
      link: selector.optional(),
      location: selector.optional(),
    }).optional(),
  }).refine((b) => {
    try {
      const host = new URL(b.listUrl).hostname.toLowerCase();
      return b.domains.some((d) => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
    } catch {
      return false;
    }
  }, { message: 'listUrl host must be one of the board domains' })),
});

export const companyAliasesSchema = z.object({
  _comment: z.string().optional(),
  aliases: z.record(z.string().min(1), z.string().min(1)),
});

/**
 * Total classification of a listing's noise_class (spec R2.1, decisions 1-8): every row maps to exactly
 * one of these. 'ok' and 'ok_manual' are terminal outcomes of the source check, never a config rule's
 * `class`; 'unknown_source' is likewise terminal, never a config rule. The four remaining values are the
 * classes a config/noise-rules.json rule may declare.
 */
export const NOISE_CLASSES = Object.freeze(['ok', 'ok_manual', 'aggregator_repost', 'fractional_or_founder', 'staffing_generic', 'unknown_source', 'suspect']);
/** Classes a config/noise-rules.json rule is allowed to declare (excludes the terminal source-check outcomes). */
export const NOISE_RULE_CLASSES = Object.freeze(['aggregator_repost', 'fractional_or_founder', 'staffing_generic', 'suspect']);

const noiseRuleSchema = z.discriminatedUnion('class', [
  z.object({
    class: z.literal('aggregator_repost'),
    priority: z.number().int(),
    aggregatorHosts: z.array(domain).default([]),
    aggregatorGmailParsers: z.array(z.string().min(1)).default([]),
  }),
  z.object({ class: z.literal('fractional_or_founder'), priority: z.number().int() }),
  z.object({
    class: z.literal('staffing_generic'),
    priority: z.number().int(),
    staffingFirms: z.array(z.string().min(1)).default([]),
  }),
  z.object({ class: z.literal('suspect'), priority: z.number().int() }),
]);

/**
 * config/noise-rules.json (spec R2.1, decision 5/8): rules are evaluated in ascending `priority` order,
 * first match wins -- never file position (no positional/contiguity assumption on a human-edited file).
 * Two rules sharing a priority, or a rule missing one, fails validation outright (decision 5/8).
 */
export const noiseRulesSchema = z.object({
  rules: z.array(noiseRuleSchema).refine((rules) => {
    const seen = new Set();
    for (const r of rules) {
      if (seen.has(r.priority)) return false;
      seen.add(r.priority);
    }
    return true;
  }, { message: 'noise-rules.json: every rule must have a distinct priority' }),
  multipliers: z.record(z.enum(/** @type {[string, ...string[]]} */ (NOISE_CLASSES)), z.number().min(0).max(2)).refine(
    (m) => NOISE_CLASSES.every((c) => typeof m[c] === 'number'),
    { message: `noise-rules.json: multipliers must define every noise class: ${NOISE_CLASSES.join(', ')}` },
  ),
});

/** Closed enum: every alert-senders.json entry must map to a parser that exists (src/adapters/gmail-parsers.js). */
export const GMAIL_PARSER_NAMES = Object.freeze(['linkedin', 'indeed-alert', 'indeed-match', 'lensa', 'ladders']);

const emailAddress = z.string().min(3).max(200).regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/, 'address must be a lowercase email address');

export const alertSendersSchema = z.object({
  senders: z.array(z.object({
    address: emailAddress,
    parser: z.enum(/** @type {[string, ...string[]]} */ (GMAIL_PARSER_NAMES)),
    enabled: z.boolean().default(true),
    comment: z.string().optional(),
  })),
});

/**
 * Slice 3 auto-triage config (docs/slice3-auto-triage-spec.md section 3). `deterministic` and `model`
 * are independent toggles, both defaulting to `false`: model scoring ships off "until verified" (locked
 * decision); deterministic auto-skip/auto-new ships off by default too so a fresh clone or fork never
 * auto-marks rows until an operator deliberately opts in. `floor === ceiling` is a legal, accepted
 * degenerate case (the `.refine` only requires `<=`, not `<`): every row lands in skip_low or auto_new,
 * model_band is permanently empty, and the model step never has anything to batch.
 */
export const triageSchema = z.object({
  deterministic: z.object({
    enabled: z.boolean().default(false),
    floor: z.number().int().min(0).max(100).default(40),
    ceiling: z.number().int().min(0).max(100).default(70),
  }).refine((d) => d.floor <= d.ceiling, { message: 'triage.json: deterministic.floor must be <= ceiling' }).default({}),
  model: z.object({
    enabled: z.boolean().default(false), // off until verified, per the locked decision
    modelName: z.string().min(1).default('claude-sonnet-5'),
    batchSize: z.number().int().min(10).max(20).default(15),
    skipMaxFit: z.number().int().min(0).max(100).default(30),
    timeoutMs: z.number().int().positive().default(60000),
    maxListingsPerRun: z.number().int().positive().default(200),
    maxBatchesPerRun: z.number().int().positive().default(15),
    descriptionTruncateChars: z.number().int().positive().default(1200),
  }).default({}),
});

export const CONFIG_FILES = Object.freeze([
  'adapters.json', 'ats-boards.json', 'exec-boards.json', 'company-aliases.json', 'alert-senders.json', 'noise-rules.json',
  // Slice 3 auto-triage (spec section 3): all four hashed for "config drift must be deliberate", even
  // though triage.json is loaded tolerantly (readOptionalValidated, below) and triage-candidate.md is
  // never committed (personal data, gitignored) -- computeConfigHash() hashes a "<missing>" placeholder
  // for an absent file without throwing, so this list growing never blocks loadConfig() on its own; it
  // only changes the config-lock hash, which is why the real triage.json + a fresh config.lock.json must
  // ship in the same deploy as this code (spec section 3, "Production rollout").
  'triage.json', 'triage-candidate.md', 'triage-output-schema.json', 'triage-mcp-empty.json',
]);

/**
 * @typedef {Object} LoadedConfig
 * @property {z.infer<typeof adaptersSchema>} adapters
 * @property {z.infer<typeof atsBoardsSchema>} atsBoards
 * @property {z.infer<typeof execBoardsSchema>} execBoards
 * @property {Record<string, string>} companyAliases
 * @property {z.infer<typeof alertSendersSchema>['senders']} alertSenders
 * @property {z.infer<typeof noiseRulesSchema>} noiseRules
 * @property {z.infer<typeof triageSchema> & { present: boolean }} triage present=false means no
 *   config/triage.json was found at all (schema defaults applied silently); present=true with both
 *   steps disabled means an operator deliberately configured triage and turned it off (spec section 3/6).
 * @property {string} configDir
 * @property {string} hash sha256 over the raw config files
 */

/**
 * @param {string} dir
 * @param {string} name
 * @param {z.ZodTypeAny} schema
 */
function readValidated(dir, name, schema) {
  const file = path.join(dir, name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new JobSearchError('CONFIG_INVALID', `config file missing: ${name}`, { details: { file: name } });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new JobSearchError('CONFIG_INVALID', `config file is not valid JSON: ${name}`, { details: { file: name } });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? first.path.join('.') : '';
    throw new JobSearchError('CONFIG_INVALID', `config validation failed: ${name} at ${where}: ${first ? first.message : 'unknown'}`, {
      details: { file: name, path: where },
    });
  }
  return parsed.data;
}

/**
 * Tolerant loader for triage.json (spec section 3): every field of `schema` carries a zod default, so
 * `schema.parse({})` always succeeds, meaning a missing file yields `{ data: schema.parse({}), present:
 * false }` instead of throwing CONFIG_INVALID the way readValidated() does for every other config file.
 * A missing config/triage.json must never fail the scan (adding 'triage.json' to CONFIG_FILES and
 * wiring it through readValidated() the same way as the other six would mean the entire scan pipeline
 * fails closed the moment this code ships, until the real file exists on disk -- this is not
 * hypothetical: it would break the operator's own unattended `job-search scan` Task Scheduler job at the
 * next run after merge). A file that DOES exist but fails to parse or validate still throws
 * CONFIG_INVALID exactly like readValidated() does for every other file: a present, malformed file is a
 * real, deliberate config error, not tolerated.
 * @param {string} dir
 * @param {string} name
 * @param {z.ZodTypeAny} schema
 */
function readOptionalValidated(dir, name, schema) {
  const file = path.join(dir, name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { data: schema.parse({}), present: false };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new JobSearchError('CONFIG_INVALID', `config file is not valid JSON: ${name}`, { details: { file: name } });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? first.path.join('.') : '';
    throw new JobSearchError('CONFIG_INVALID', `config validation failed: ${name} at ${where}: ${first ? first.message : 'unknown'}`, {
      details: { file: name, path: where },
    });
  }
  return { data: parsed.data, present: true };
}

/**
 * Read config/triage-candidate.md (spec section 3): a plain-text candidate summary for the auto-triage
 * model prompt, never zod-validated, never touched by loadConfig() itself. Intended to be called once
 * per triage invocation (src/core/triage.js's runTriage()) and the same in-memory string reused verbatim
 * for every batch that run sends, never re-read mid-run (finding 17): a file edited partway through a
 * long, multi-batch run must not produce a self-inconsistent run.
 *
 * Missing, or blank after trimming, returns null -- the caller disables model scoring for that run with
 * reason 'candidate_summary_missing', never a silent default description. Not committed to the repo
 * (personal data): gitignored (mcp/job-search/.gitignore via the repo root .gitignore), present only on
 * an operator's own machine.
 * @param {string} dir configDir
 * @returns {string|null}
 */
export function loadTriageCandidateSummary(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'triage-candidate.md'), 'utf8');
  } catch {
    return null;
  }
  return text.trim() ? text : null;
}

/**
 * sha256 over the raw bytes of every config file, in CONFIG_FILES order, with
 * the filename mixed in so renames change the hash.
 * @param {string} [dir]
 */
export function computeConfigHash(dir = getEnv().JOBSEARCH_CONFIG_DIR) {
  const h = crypto.createHash('sha256');
  for (const name of CONFIG_FILES) {
    h.update(name + '\n');
    try {
      // Line endings are normalized so git autocrlf checkouts and LF worktrees agree on the hash.
      h.update(fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n'));
    } catch {
      h.update('<missing>');
    }
    h.update('\n');
  }
  return h.digest('hex');
}

/** @type {LoadedConfig | null} */
let cached = null;

/**
 * Load and validate all config files. Cached after first call unless `fresh`.
 * @param {{ fresh?: boolean, dir?: string }} [opts]
 * @returns {LoadedConfig}
 */
export function loadConfig(opts = {}) {
  if (cached && !opts.fresh && !opts.dir) return cached;
  const dir = opts.dir ?? getEnv().JOBSEARCH_CONFIG_DIR;
  const adapters = readValidated(dir, 'adapters.json', adaptersSchema);
  const atsBoards = readValidated(dir, 'ats-boards.json', atsBoardsSchema);
  const execBoards = readValidated(dir, 'exec-boards.json', execBoardsSchema);
  const aliasesFile = readValidated(dir, 'company-aliases.json', companyAliasesSchema);
  const alertSendersFile = readValidated(dir, 'alert-senders.json', alertSendersSchema);
  const noiseRules = readValidated(dir, 'noise-rules.json', noiseRulesSchema);
  const triageFile = readOptionalValidated(dir, 'triage.json', triageSchema);
  /** @type {LoadedConfig} */
  const cfg = {
    adapters,
    atsBoards,
    execBoards,
    companyAliases: aliasesFile.aliases,
    alertSenders: alertSendersFile.senders,
    noiseRules,
    triage: { ...triageFile.data, present: triageFile.present },
    configDir: dir,
    hash: computeConfigHash(dir),
  };
  if (!opts.dir) cached = cfg;
  return cfg;
}

/** Path of the committed lock file (JOBSEARCH_CONFIG_LOCK overrides it for tests that use a fixture config dir). */
export function configLockPath() {
  ensureDotenv();
  const override = process.env.JOBSEARCH_CONFIG_LOCK;
  if (override && override.trim()) return resolveFromRoot(override.trim());
  return path.join(packageRoot(), 'config.lock.json');
}

/**
 * Compare the live config hash with config.lock.json.
 * @returns {{ ok: boolean, expected: string|null, actual: string }}
 */
export function checkConfigLock() {
  const actual = computeConfigHash();
  let expected = null;
  try {
    const lock = JSON.parse(fs.readFileSync(configLockPath(), 'utf8'));
    expected = typeof lock.sha256 === 'string' ? lock.sha256 : null;
  } catch {
    expected = null;
  }
  return { ok: expected === actual, expected, actual };
}

/**
 * Write config.lock.json for the current config files.
 * @returns {string} the hash written
 */
export function writeConfigLock() {
  const hash = computeConfigHash();
  const body = { sha256: hash, files: [...CONFIG_FILES], updated_at: new Date().toISOString() };
  fs.writeFileSync(configLockPath(), JSON.stringify(body, null, 2) + '\n');
  return hash;
}
