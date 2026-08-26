// @ts-check
/**
 * pino logger that never writes to stdout. stdout belongs to JSON-RPC frames
 * (server.js) or to CLI JSON output; everything diagnostic goes to stderr or
 * to a JSONL file under the log dir.
 *
 * Logging rule (spec section 1): enumerated scalars only. Callers pass
 * objects whose values are strings, numbers, booleans, or null. `scalars()`
 * enforces that at the boundary by dropping anything else, so an accidental
 * `log.info({ err })` or `log.info({ raw })` cannot leak an object.
 */
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const MAX_STRING = 300;

/**
 * Keep only scalar fields; truncate strings to 300 chars. Objects, arrays,
 * functions, and Error instances are replaced with a marker string.
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, string | number | boolean | null>}
 */
export function scalars(fields) {
  /** @type {Record<string, string | number | boolean | null>} */
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === 'string') out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'bigint') out[k] = v.toString();
    else out[k] = `[dropped:${Array.isArray(v) ? 'array' : typeof v}]`;
  }
  return out;
}

/**
 * @typedef {Object} LoggerOptions
 * @property {string} [level] pino level, default from LOG_LEVEL or 'info'
 * @property {string} [file] absolute path of a JSONL file; when absent, stderr
 * @property {string} [name]
 */

/**
 * @param {LoggerOptions} [opts]
 * @returns {import('pino').Logger}
 */
export function createLogger(opts = {}) {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  /** @type {import('pino').DestinationStream} */
  let dest;
  if (opts.file) {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    dest = pino.destination({ dest: opts.file, sync: true, mkdir: true });
  } else {
    dest = pino.destination({ dest: 2, sync: true });
  }
  const base = pino(
    {
      level,
      name: opts.name ?? 'job-search',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      // Belt and braces: even if a caller bypasses scalars(), these keys never serialize.
      redact: { paths: ['raw', 'html', 'headers', 'cookies', 'token', 'access_token', 'refresh_token', 'password', 'err'], remove: true },
      hooks: {
        logMethod(args, method) {
          if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
            args[0] = scalars(/** @type {Record<string, unknown>} */ (args[0]));
          } else if (args[0] instanceof Error) {
            args[0] = { err_code: /** @type {any} */ (args[0]).code ?? 'INTERNAL', err_message: String(args[0].message).slice(0, MAX_STRING) };
          }
          method.apply(this, args);
        },
      },
    },
    dest,
  );
  return base;
}

/** Default process logger: stderr, level from LOG_LEVEL. */
export const log = createLogger();

/**
 * Daily JSONL log file path for a CLI (`scan-YYYY-MM-DD.log`).
 * @param {string} logDir
 * @param {string} prefix
 * @param {Date} [now]
 */
export function dailyLogPath(logDir, prefix, now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  return path.join(logDir, `${prefix}-${d}.log`);
}

/**
 * Delete `<prefix>-YYYY-MM-DD.log` files older than `days` in logDir.
 * Returns the count removed. Never throws on a missing directory.
 * @param {string} logDir
 * @param {string} prefix
 * @param {number} days
 */
export function pruneLogs(logDir, prefix, days = 14) {
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - days * 86400000;
  const re = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
  for (const n of names) {
    const m = re.exec(n);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && t < cutoff) {
      try {
        fs.unlinkSync(path.join(logDir, n));
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}
