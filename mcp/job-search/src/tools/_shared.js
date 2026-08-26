// @ts-check
/**
 * Helpers shared by tool modules: uniform result envelope, error mapping,
 * and the DB accessor. Every tool handler returns a plain object; the server
 * serializes it as one text content block (compact JSON, no pretty print)
 * to keep the per-call token cost low.
 */
import { withClient } from '../core/db.js';
import { JobSearchError, errFields } from '../core/errors.js';
import { log } from '../core/logger.js';
import { untrusted, untrustedRows, ROWS_WRAP_OVERHEAD_CHARS } from '../core/compact.js';

export { untrusted, untrustedRows, ROWS_WRAP_OVERHEAD_CHARS };

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {Record<string, import('zod').ZodTypeAny>} schema zod raw shape
 * @property {(args: any, deps: ToolDeps, extra?: any) => Promise<object>} handler
 */

/**
 * @typedef {Object} ToolDeps
 * @property {<T>(fn: (client: import('pg').PoolClient) => Promise<T>) => Promise<T>} withClient
 * @property {import('../core/config.js').LoadedConfig|null} config
 * @property {import('../core/config.js').Env} env
 * @property {(() => Promise<import('../core/followups.js').CalendarDeps|null>)|null} calendar
 * @property {((listing: object) => Promise<{ description: string|null }|null>)|null} fetchDetail stage 3 wires this
 * @property {((args: object, deps: ToolDeps) => Promise<object>)|null} searchJobs stage 3 wires this
 * @property {typeof fetch} [fetch]
 */

/**
 * Map any thrown value to the error envelope.
 * @param {unknown} err
 */
export function errorEnvelope(err) {
  if (err instanceof JobSearchError) return err.toJSON();
  const f = errFields(err);
  return { ok: false, code: f.err_code === 'INTERNAL' ? 'INTERNAL' : f.err_code, message: f.err_message, hint: null, details: {} };
}

/**
 * Wrap a handler so it never throws through the SDK and always logs scalars.
 * @param {ToolDef} def
 * @param {ToolDeps} deps
 */
export function wrapHandler(def, deps) {
  return async (/** @type {any} */ args, /** @type {any} */ extra) => {
    const started = Date.now();
    let out;
    try {
      out = await def.handler(args ?? {}, deps, extra);
    } catch (err) {
      out = errorEnvelope(err);
      log.warn({ evt: 'tool_error', tool: def.name, err_code: String(out.code), err_message: String(out.message ?? '').slice(0, 300) });
    }
    const text = JSON.stringify(out);
    log.info({ evt: 'tool_call', tool: def.name, ms: Date.now() - started, ok: out && out.ok !== false, chars: text.length });
    return { content: [{ type: 'text', text }], isError: out && out.ok === false && out.code !== 'PREFLIGHT_FAILED' ? true : undefined };
  };
}

/** Default deps for the live server. */
export function defaultDeps(/** @type {Partial<ToolDeps>} */ overrides = {}) {
  return /** @type {ToolDeps} */ ({
    withClient,
    config: null,
    env: /** @type {any} */ ({}),
    calendar: null,
    fetchDetail: null,
    searchJobs: null,
    ...overrides,
  });
}
