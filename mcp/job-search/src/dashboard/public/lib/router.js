// @ts-check
/**
 * Hash router parser (pr3-spec-decisions.md section 3): a pure function of a hash string to a named
 * route/params tuple, no DOM access, so the whole classification is unit-testable with a table of inputs.
 * Every input maps to a branch; there is no third, silently-blank error state (rule 6).
 */

/** Fixed route table: segment shape (static strings + ':param' placeholders). */
const ROUTES = Object.freeze([
  { name: 'home', shape: [] },
  { name: 'jobs', shape: ['jobs'] },
  { name: 'job-detail', shape: ['jobs', ':id'] },
  { name: 'pipeline', shape: ['pipeline'] },
  { name: 'followups', shape: ['followups'] },
  { name: 'review', shape: ['review'] },
  { name: 'runs', shape: ['runs'] },
  { name: 'run-detail', shape: ['runs', ':id'] },
  { name: 'reports', shape: ['reports'] },
  { name: 'report-view', shape: ['reports', ':day'] },
  { name: 'calendar', shape: ['calendar'] },
  { name: 'analytics', shape: ['analytics'] },
  { name: 'companies', shape: ['companies'] },
  { name: 'company-detail', shape: ['companies', ':norm'] },
]);

const ID_RE = /^\d+$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{ kind: 'ok', route: string, params: Record<string, string|number> } | { kind: 'not_found' } | { kind: 'invalid' }} RouteResult
 */

/**
 * @param {string} hash the full `location.hash`, e.g. "#/jobs/12" or "" or "#"
 * @returns {RouteResult}
 */
export function parseHash(hash) {
  const stripped = String(hash ?? '').replace(/^#/, '');
  const segments = stripped.split('/').filter((s) => s.length > 0);

  const candidates = ROUTES.filter((r) => r.shape.length === segments.length);
  if (candidates.length === 0) return { kind: 'not_found' };

  for (const route of candidates) {
    /** @type {Record<string, string|number>} */
    const params = {};
    let ok = true;
    for (let i = 0; i < route.shape.length; i++) {
      const shapeSeg = route.shape[i];
      const actual = segments[i];
      if (!shapeSeg.startsWith(':')) {
        if (shapeSeg !== actual) { ok = false; break; }
        continue;
      }
      const paramName = shapeSeg.slice(1);
      if (paramName === 'id') {
        if (!ID_RE.test(actual)) return { kind: 'invalid' };
        const n = Number(actual);
        if (!Number.isInteger(n) || n <= 0) return { kind: 'invalid' };
        params.id = n;
      } else if (paramName === 'day') {
        if (!DAY_RE.test(actual)) return { kind: 'invalid' };
        params.day = actual;
      } else if (paramName === 'norm') {
        /** @type {string} */
        let decoded;
        try {
          decoded = decodeURIComponent(actual);
        } catch {
          return { kind: 'invalid' };
        }
        if (!decoded || decoded.includes('/')) return { kind: 'invalid' };
        params.norm = decoded;
      }
    }
    if (ok) return { kind: 'ok', route: route.name, params };
  }
  return { kind: 'not_found' };
}

/** Build a hash string for a route + params (the inverse of parseHash, used by nav links). */
export function buildHash(route, params = {}) {
  const table = { home: '#/', jobs: '#/jobs', 'job-detail': (p) => `#/jobs/${p.id}`, pipeline: '#/pipeline',
    followups: '#/followups', review: '#/review', runs: '#/runs', 'run-detail': (p) => `#/runs/${p.id}`,
    reports: '#/reports', 'report-view': (p) => `#/reports/${p.day}`, calendar: '#/calendar',
    analytics: '#/analytics', companies: '#/companies', 'company-detail': (p) => `#/companies/${encodeURIComponent(p.norm)}` };
  const entry = table[route];
  if (!entry) return '#/';
  return typeof entry === 'function' ? entry(params) : entry;
}
