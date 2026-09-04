// @ts-check
/**
 * Fetch wrapper and response classifier (pr3-spec-decisions.md section 4). One function, `classify()`,
 * is the total classification of a `{status, body}` pair into a named branch; `request()` is the only
 * code path that ever issues a fetch, so `Content-Type: application/json` on mutations is structural,
 * not something every call site has to remember (section 4's closing rule).
 *
 * There is no 401 branch anywhere in this classifier (confirmed: this API never produces one). An
 * unrecognized status/code falls into the same branch as INTERNAL, per the decision file.
 */

/** @typedef {{ kind: string, [key: string]: any }} ApiOutcome */

const JSON_CONTENT_TYPE = 'application/json';

/**
 * Classify a response's status/body into one named branch (section 4's table). Pure function: no fetch,
 * no DOM, fully unit-testable with canned inputs.
 * @param {number} status
 * @param {unknown} body body already JSON-parsed, or a sentinel object `{__unparsable: true, raw}` when
 *   the response text failed to parse as JSON
 * @returns {ApiOutcome}
 */
export function classify(status, body) {
  const b = /** @type {any} */ (body ?? {});
  if (b && b.__unparsable) return { kind: 'unparsable', raw: b.raw };
  if (status >= 200 && status < 300) return { kind: 'ok', status, body: b };
  const code = typeof b.code === 'string' ? b.code : null;
  if (status === 400 && code === 'VALIDATION') return { kind: 'validation', message: b.message, hint: b.hint ?? null, details: b.details ?? {} };
  if (status === 403 && (code === 'BAD_HOST' || code === 'BAD_ORIGIN')) return { kind: 'rejected_request', code, message: b.message };
  if (status === 404 && code === 'NOT_FOUND') return { kind: 'not_found', message: b.message };
  if (status === 405 && code === 'METHOD_NOT_ALLOWED') return { kind: 'client_bug', code, message: b.message };
  if (status === 409 && code === 'LOCKED') return { kind: 'locked', message: b.message };
  if (status === 409 && code === 'CONFIG_LOCK_MISMATCH') return { kind: 'config_lock_mismatch', message: b.message };
  if (status === 409 && code === 'DUPLICATE_CANDIDATE') return { kind: 'duplicate_candidate', candidates: b.candidates ?? [] };
  if (status === 409 && code === 'DUPLICATE_APPLICATION') return { kind: 'duplicate_application', message: b.message };
  // Apply exclusion gate: APPLY_EXCLUDED is a HARD branch (blocked_company/already_applied_listing/
  // already_applied_history) -- never overridable. APPLY_NEEDS_OVERRIDE is a NEEDS_HUMAN branch
  // (previously_withdrawn/applied_company_other_role/blocked_company_suspect/unknown_company) -- the
  // caller may retry the same request with `override: true` in the body to proceed anyway.
  if (status === 409 && code === 'APPLY_EXCLUDED') return { kind: 'apply_excluded', branch: b.branch, reason: b.reason, message: b.message };
  if (status === 409 && code === 'APPLY_NEEDS_OVERRIDE') return { kind: 'apply_needs_override', branch: b.branch, reason: b.reason, message: b.message };
  if (status === 413 && code === 'PAYLOAD_TOO_LARGE') return { kind: 'payload_too_large', message: b.message };
  if (status === 415 && code === 'UNSUPPORTED_MEDIA_TYPE') return { kind: 'client_bug', code, message: b.message };
  if (status === 503 && code === 'DB_UNAVAILABLE') return { kind: 'db_unavailable', message: b.message };
  if (status === 500 && code === 'INTERNAL') return { kind: 'internal', requestId: b.requestId ?? null };
  // Unknown/unrecognized status or code: same terminal branch as INTERNAL (section 4's closing rule).
  return { kind: 'internal', requestId: b.requestId ?? null, code: code ?? null, unknownStatus: status };
}

/**
 * Parse a fetch Response's body as JSON, returning the unparsable sentinel on failure instead of
 * throwing (so `classify()` can stay a pure function of already-resolved values).
 * @param {Response} res
 */
async function parseBody(res) {
  const raw = await res.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsable: true, raw };
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, query?: Record<string, string|number|boolean|undefined|null> }} [opts]
 * @returns {Promise<ApiOutcome>}
 */
export async function request(path, opts = {}) {
  const method = (opts.method ?? 'GET').toUpperCase();
  let url = path;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (path.includes('?') ? '&' : '?') + qs;
  }
  /** @type {RequestInit} */
  const init = { method };
  if (method !== 'GET' && method !== 'HEAD') {
    init.headers = { 'Content-Type': JSON_CONTENT_TYPE };
    init.body = JSON.stringify(opts.body ?? {});
  }
  /** @type {Response} */
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    return { kind: 'network_error' };
  }
  const body = await parseBody(res);
  return classify(res.status, body);
}

/** @param {string} path @param {Record<string,any>} [query] */
export function getJson(path, query) {
  return request(path, { method: 'GET', query });
}

/** @param {string} path @param {unknown} body */
export function postJson(path, body) {
  return request(path, { method: 'POST', body });
}

/** @param {string} path @param {unknown} body */
export function putJson(path, body) {
  return request(path, { method: 'PUT', body });
}

/** @param {string} path @param {unknown} [body] */
export function deleteJson(path, body) {
  return request(path, { method: 'DELETE', body });
}
