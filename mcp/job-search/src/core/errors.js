// @ts-check
/**
 * Typed errors for the job-search server. Every error carries a stable
 * `code` from ERROR_CODES so tools and CLIs can return it to the caller
 * without leaking stack traces or payloads.
 */

/** @type {Readonly<Record<string, string>>} */
export const ERROR_CODES = Object.freeze({
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_LOCK_MISMATCH: 'CONFIG_LOCK_MISMATCH',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  EMBED_UNAVAILABLE: 'EMBED_UNAVAILABLE',
  EMBED_INVALID: 'EMBED_INVALID',
  MIGRATION_CONFLICTS: 'MIGRATION_CONFLICTS',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  LOCKED: 'LOCKED',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  LOGIN_WALL: 'LOGIN_WALL',
  UNRENDERABLE: 'UNRENDERABLE',
  UNRECOGNIZED_PAGE: 'UNRECOGNIZED_PAGE',
  SUSPECTED_THROTTLE: 'SUSPECTED_THROTTLE',
  URL_REJECTED: 'URL_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  ADAPTER_ABORTED: 'ADAPTER_ABORTED',
  CANCELLED: 'CANCELLED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
});

/**
 * @typedef {Object} ErrorDetails
 * @property {string} [hint]
 * @property {Record<string, string | number | boolean | null>} [details] enumerated scalars only
 */

export class JobSearchError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message
   * @param {ErrorDetails} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'JobSearchError';
    this.code = ERROR_CODES[code] ? code : ERROR_CODES.INTERNAL;
    this.hint = opts.hint ?? null;
    this.details = opts.details ?? {};
  }

  /** Plain object safe to return through MCP or print from a CLI. */
  toJSON() {
    return { ok: false, code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

/**
 * Reduce any thrown value to the scalar fields the logging rules allow:
 * a code and a 300-char message. Never returns the error object itself.
 * @param {unknown} err
 * @returns {{ err_code: string, err_message: string }}
 */
export function errFields(err) {
  if (err instanceof JobSearchError) {
    return { err_code: err.code, err_message: String(err.message).slice(0, 300) };
  }
  if (err && typeof err === 'object') {
    const anyErr = /** @type {{ code?: unknown, message?: unknown }} */ (err);
    const code = typeof anyErr.code === 'string' ? anyErr.code : ERROR_CODES.INTERNAL;
    const message = typeof anyErr.message === 'string' ? anyErr.message : String(err);
    return { err_code: code, err_message: message.slice(0, 300) };
  }
  return { err_code: ERROR_CODES.INTERNAL, err_message: String(err).slice(0, 300) };
}

/**
 * Wrap a pg error into a JobSearchError while keeping the SQLSTATE in details.
 * @param {unknown} err
 * @param {string} context short scalar label
 * @returns {JobSearchError}
 */
export function wrapDbError(err, context) {
  const f = errFields(err);
  const sqlstate = /** @type {{ code?: string }} */ (err ?? {}).code ?? null;
  const isConn = ['ECONNREFUSED', 'ENOTFOUND', '57P01', '57P02', '57P03', '08001', '08006'].includes(String(sqlstate));
  return new JobSearchError(isConn ? 'DB_UNAVAILABLE' : 'INTERNAL', `${context}: ${f.err_message}`, {
    details: { sqlstate, context },
  });
}
