// @ts-check
/**
 * Local-HTTP request guards (dashboard PR 2, pr2-spec-decisions.md "Request guards"). Every rule here is
 * a total classification: every input maps to a named branch, never a startsWith/includes/endsWith
 * shortcut on the Host or Origin value.
 *
 * This module never imports src/server.js or src/core/stdout-hygiene.js (plan constraint): it only
 * depends on core/errors.js and core/logger.js, both of which are already dashboard-safe.
 */
import crypto from 'node:crypto';
import { JobSearchError, errFields } from '../core/errors.js';
import { log } from '../core/logger.js';

/** Exact-match loopback set (decision 1): never a prefix/suffix check. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);

export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Dashboard-local HTTP error: carries its own status, distinct from JobSearchError (whose codes/status
 * mapping are shared server-wide). Used only for guard failures that have no JobSearchError equivalent
 * (BAD_HOST, BAD_ORIGIN, UNSUPPORTED_MEDIA_TYPE, PAYLOAD_TOO_LARGE, METHOD_NOT_ALLOWED, STREAM_CAPACITY).
 */
export class DashboardError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {{ hint?: string|null, details?: Record<string, string|number|boolean|null> }} [opts]
   */
  constructor(status, code, message, opts = {}) {
    super(message);
    this.name = 'DashboardError';
    this.status = status;
    this.code = code;
    this.hint = opts.hint ?? null;
    this.details = opts.details ?? {};
  }

  toJSON() {
    return { ok: false, code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

/**
 * Strip a trailing `:<digits>` port, bracketed-IPv6 aware. `[::1]:7311` -> `[::1]`; `[::1]` -> `[::1]`;
 * `localhost:7311` -> `localhost`; `localhost` -> `localhost`. Never partial-matches inside the value.
 * @param {string} hostHeader
 */
export function stripHostPort(hostHeader) {
  if (hostHeader.startsWith('[')) {
    const closeIdx = hostHeader.indexOf(']');
    return closeIdx === -1 ? hostHeader : hostHeader.slice(0, closeIdx + 1);
  }
  const idx = hostHeader.lastIndexOf(':');
  if (idx === -1) return hostHeader;
  const maybePort = hostHeader.slice(idx + 1);
  return /^\d+$/.test(maybePort) ? hostHeader.slice(0, idx) : hostHeader;
}

/**
 * Decision 1: missing Host -> 400; more than one Host header line -> 400; otherwise strip the port,
 * lowercase, exact set membership -> 200-continue, else 403.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, status: number, code: 'BAD_HOST', message: string }}
 */
export function checkHost(req) {
  const raw = req.rawHeaders ?? [];
  let count = 0;
  /** @type {string|null} */
  let value = null;
  for (let i = 0; i < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === 'host') {
      count++;
      value = raw[i + 1];
    }
  }
  if (count === 0 || value == null) return { ok: false, status: 400, code: 'BAD_HOST', message: 'Host header is required' };
  if (count > 1) return { ok: false, status: 400, code: 'BAD_HOST', message: 'multiple Host headers are not allowed' };
  const bare = stripHostPort(value).toLowerCase();
  if (!LOOPBACK_HOSTS.includes(bare)) return { ok: false, status: 403, code: 'BAD_HOST', message: 'Host must be a loopback address' };
  return { ok: true };
}

/**
 * Decision 2 (Content-Type): missing -> 415; type/subtype not exactly application/json -> 415.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: string }}
 */
export function checkContentType(req) {
  const raw = req.headers['content-type'];
  if (!raw || typeof raw !== 'string') return { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type: application/json is required' };
  const mediaType = raw.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return { ok: false, status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' };
  return { ok: true };
}

/**
 * Decision 2 (Origin): absent -> allowed. Present -> must parse as http: with a loopback hostname; parse
 * failure (including the literal string "null") or mismatch -> 403. Never treat parse failure as absence.
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, status: 403, code: 'BAD_ORIGIN', message: string }}
 */
export function checkOrigin(req) {
  const raw = req.headers.origin;
  if (raw === undefined) return { ok: true };
  const value = Array.isArray(raw) ? raw[0] : raw;
  /** @type {URL} */
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return { ok: false, status: 403, code: 'BAD_ORIGIN', message: 'Origin could not be parsed' };
  }
  if (u.protocol !== 'http:') return { ok: false, status: 403, code: 'BAD_ORIGIN', message: 'Origin must be http' };
  const bare = stripHostPort(u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname).toLowerCase();
  if (!LOOPBACK_HOSTS.includes(bare)) return { ok: false, status: 403, code: 'BAD_ORIGIN', message: 'Origin must be a loopback address' };
  return { ok: true };
}

/**
 * Read the raw request body with an incremental byte cap (rule: exceeding it aborts with 413 BEFORE
 * buffering completes, so the socket is destroyed on the first over-cap chunk rather than after the
 * full body arrives).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<string>}
 */
export function readRawBody(req, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let total = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    let settled = false;
    const fail = (/** @type {Error} */ err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) {
        // Already rejected (over cap): keep draining without storing anything further, so the socket
        // does not back-pressure or hang while the caller sends the 413 response. The connection is
        // closed by the caller after that response is written (see server.js), not here -- destroying
        // the request stream mid-read can race the response write on the same socket.
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        fail(new DashboardError(413, 'PAYLOAD_TOO_LARGE', `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => fail(err));
    req.on('aborted', () => fail(new DashboardError(400, 'VALIDATION', 'request aborted')));
  });
}

/**
 * Read and parse a JSON object body. Empty body -> VALIDATION 400 unless `allowEmpty` (returns `{}`).
 * JSON.parse failure -> VALIDATION 400. A parsed value that is not a plain object (array, null, scalar)
 * -> VALIDATION 400, unless `allowArray` (some future route could accept a top-level array; none does
 * today, kept as an explicit escape hatch rather than a silent global relaxation).
 * @param {import('node:http').IncomingMessage} req
 * @param {{ maxBytes?: number, allowEmpty?: boolean, allowArray?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown> | unknown[]>}
 */
export async function readJsonBody(req, opts = {}) {
  const raw = await readRawBody(req, opts);
  const trimmed = raw.trim();
  if (!trimmed) {
    if (opts.allowEmpty) return {};
    throw new JobSearchError('VALIDATION', 'request body is required');
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new JobSearchError('VALIDATION', 'request body is not valid JSON');
  }
  if (Array.isArray(parsed)) {
    if (opts.allowArray) return parsed;
    throw new JobSearchError('VALIDATION', 'request body must be a JSON object');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new JobSearchError('VALIDATION', 'request body must be a JSON object');
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/** Status a JobSearchError code maps to (total classification of the enumerated codes this server ever throws). */
const JOB_SEARCH_ERROR_STATUS = Object.freeze({
  VALIDATION: 400,
  NOT_FOUND: 404,
  LOCKED: 409,
  CONFIG_LOCK_MISMATCH: 409,
  DB_UNAVAILABLE: 503,
});

/**
 * Base security headers applied to every response (rule 4). Cache-Control: no-store is added only under
 * /api/*. Callers serving stored report/research HTML overwrite Content-Security-Policy afterwards with
 * the stricter sandbox policy (rule 5).
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
export function applyBaseHeaders(res, pathname) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
}

/**
 * CSP for stored report/research HTML served through /api/documents/file (rule 5): `sandbox` with no
 * allow-* tokens, `default-src 'none'`. The page is rendered only inside a sandboxed iframe by the front
 * end; standing constraint (recorded in README): allow-scripts and allow-same-origin are never added
 * together to that iframe.
 * @param {import('node:http').ServerResponse} res
 */
export function applySandboxHtmlHeaders(res) {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
}

/**
 * Write a JSON response. Never called with a body containing anything but scalars/plain-data (route
 * handlers are responsible for that; this function does not itself sanitize).
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(text);
}

/**
 * Total classification of a thrown value (decision 6): DashboardError -> its own status/toJSON();
 * JobSearchError -> the fixed status map above and its own toJSON(); anything else -> log full server-side
 * with a request id, respond 500 INTERNAL with only the request id (never the error's own fields).
 * @param {unknown} err
 * @param {string} requestId
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function mapError(err, requestId) {
  if (err instanceof DashboardError) {
    return { status: err.status, body: err.toJSON() };
  }
  if (err instanceof JobSearchError) {
    return { status: JOB_SEARCH_ERROR_STATUS[err.code] ?? 500, body: err.toJSON() };
  }
  log.error({ evt: 'dashboard_internal_error', request_id: requestId, ...errFields(err) });
  return { status: 500, body: { ok: false, code: 'INTERNAL', message: 'internal error', requestId } };
}

/** @returns {string} */
export function newRequestId() {
  return crypto.randomUUID();
}
