// @ts-check
/**
 * GET /api/wall-snapshots/:file -- the sanitized page snapshot a wall left behind (LinkedIn, see
 * core/linkedin-snapshot.js), so the "view page" link on a disabled source opens what the scan saw.
 *
 * The file is untrusted markup from a third-party site, so the route is a total classification, each
 * refusal a NOT_FOUND with no detail about which rule fired: the name must be a plain basename of letters,
 * digits, dot, dash and underscore ending in .html (no separators, no `..`); the resolved real path must
 * sit inside the snapshot directory's real path; and the file itself must be a regular file, never a
 * symlink (lstat). It is served with a sandbox CSP and nosniff as text/plain: nothing in the page can run
 * under the dashboard origin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JobSearchError } from '../../core/errors.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

/**
 * @param {string} dir the snapshot directory
 * @param {unknown} name the requested file name
 * @returns {string|null} the absolute path to serve, or null when any rule refuses it
 */
export function resolveSnapshot(dir, name) {
  if (typeof name !== 'string' || name.length > 200 || !NAME_RE.test(name) || name.includes('..')) return null;
  try {
    const realDir = fs.realpathSync(dir);
    const candidate = path.join(realDir, name);
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const real = fs.realpathSync(candidate);
    const rel = path.relative(realDir, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel !== name) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/wall-snapshots/:file', async (ctx) => {
    const dir = deps.snapshotDir ?? (deps.env.JOBSEARCH_LOG_DIR ? path.join(deps.env.JOBSEARCH_LOG_DIR, 'linkedin-snapshots') : null);
    const file = dir ? resolveSnapshot(dir, ctx.params.file) : null;
    if (!file) throw new JobSearchError('NOT_FOUND', 'snapshot not found');
    const data = fs.readFileSync(file);
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.end(data);
  });
}
