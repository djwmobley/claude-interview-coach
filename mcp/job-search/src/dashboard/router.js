// @ts-check
/**
 * Small path router (dashboard PR 2, plan "Server" section: "node:http plus a 60-line router"). Routes
 * are registered per exact method; dispatch is a total classification of (pathname, method): no route
 * shape matches -> null (caller sends 404); shape matches but not this method -> notAllowed with the
 * Allow set (caller sends 405); otherwise the matching route (or, for HEAD against a registered GET
 * route, that GET route flagged headOnly).
 */

/**
 * @typedef {Object} Route
 * @property {string} method
 * @property {string[]} segments path split on '/', ':name' segments are params
 * @property {(ctx: import('./server.js').RouteContext) => Promise<void>} handler
 * @property {boolean} allowEmptyBody true when this route's body may be empty/absent (parsed as {})
 */

/** @param {string} path */
function compile(path) {
  return path.split('/').filter(Boolean);
}

export function createRouter() {
  /** @type {Route[]} */
  const table = [];

  /**
   * @param {string} method
   * @param {string} path
   * @param {(ctx: import('./server.js').RouteContext) => Promise<void>} handler
   * @param {{ allowEmptyBody?: boolean }} [opts]
   */
  function register(method, path, handler, opts = {}) {
    table.push({ method: method.toUpperCase(), segments: compile(path), handler, allowEmptyBody: Boolean(opts.allowEmptyBody) });
  }

  /**
   * @param {string} pathname
   * @returns {Array<{ route: Route, params: Record<string, string> }>}
   */
  function matchAll(pathname) {
    const segs = compile(pathname);
    /** @type {Array<{ route: Route, params: Record<string, string> }>} */
    const out = [];
    for (const route of table) {
      if (route.segments.length !== segs.length) continue;
      /** @type {Record<string, string>} */
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const rs = route.segments[i];
        if (rs.startsWith(':')) {
          params[rs.slice(1)] = decodeURIComponent(segs[i]);
        } else if (rs !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ route, params });
    }
    return out;
  }

  /**
   * @param {string} pathname
   * @param {string} method
   * @returns {null | { notAllowed: true, allow: string[] } | { route: Route, params: Record<string, string>, headOnly: boolean }}
   */
  function dispatch(pathname, method) {
    const matches = matchAll(pathname);
    if (matches.length === 0) return null;
    const exact = matches.find((m) => m.route.method === method);
    if (exact) return { route: exact.route, params: exact.params, headOnly: false };
    if (method === 'HEAD') {
      const getMatch = matches.find((m) => m.route.method === 'GET');
      if (getMatch) return { route: getMatch.route, params: getMatch.params, headOnly: true };
    }
    const allow = [...new Set(matches.map((m) => m.route.method))];
    if (!allow.includes('HEAD') && allow.includes('GET')) allow.push('HEAD');
    return { notAllowed: true, allow };
  }

  return { register, dispatch };
}
