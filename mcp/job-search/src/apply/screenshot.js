// @ts-check
/**
 * Screenshot write-side confinement (apply pipeline slice 5, amended spec "Screenshots"). The ONLY way
 * apply code ever writes a PNG to disk. Callers pass raw bytes and an application id; this module builds
 * the destination path ITSELF (`output/applications/<id>/<ts>.png`) and realpath-verifies the result stays
 * under `output/applications/` before writing -- callers never construct or pass a path (mirrors src/core/
 * documents.js's resolveOutputPath rationale, applied to the write side instead of the read side).
 */
import fs from 'node:fs';
import path from 'node:path';
import { JobSearchError } from '../core/errors.js';

/**
 * Write one screenshot for `applicationId`. `buffer` is the already-captured PNG bytes (the capability
 * layer calls page.screenshot() itself; this module never touches a page). Returns the file's relPath
 * (relative to outputRoot, forward-slash separated, matching src/core/documents.js's own relPath
 * convention) and absPath.
 * @param {string} outputRoot absolute path to output/
 * @param {number} applicationId
 * @param {Buffer} buffer
 * @returns {{ relPath: string, absPath: string }}
 */
export function writeApplicationScreenshot(outputRoot, applicationId, buffer) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) {
    throw new JobSearchError('VALIDATION', 'writeApplicationScreenshot: applicationId must be a positive integer');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new JobSearchError('VALIDATION', 'writeApplicationScreenshot: buffer is required');
  }
  const appsRoot = path.join(outputRoot, 'applications');
  const dir = path.join(appsRoot, String(applicationId));
  fs.mkdirSync(dir, { recursive: true });

  // realpath-verify the DIRECTORY (the file itself does not exist yet, so there is nothing else to
  // resolve) stays under output/applications/ before a single byte is written: this catches a symlink or
  // junction swapped into output/applications/<id> pointing somewhere else -- the same defense-in-depth
  // documents.js's resolveOutputPath applies on the read side.
  /** @type {string} */
  let realDir;
  /** @type {string} */
  let realAppsRoot;
  try {
    realDir = fs.realpathSync.native(dir);
    realAppsRoot = fs.realpathSync.native(appsRoot);
  } catch {
    throw new JobSearchError('INTERNAL', 'writeApplicationScreenshot: cannot resolve real path');
  }
  const rel = path.relative(realAppsRoot, realDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new JobSearchError('VALIDATION', 'writeApplicationScreenshot: resolved directory escapes output/applications/');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const absPath = path.join(realDir, `${ts}.png`);
  fs.writeFileSync(absPath, buffer);
  const relPath = path.relative(outputRoot, absPath).split(path.sep).join('/');
  return { relPath, absPath };
}

/**
 * Resolve the most recent screenshot for an application id (the dashboard's GET /api/applications/:id/
 * screenshot route). Same confinement discipline as the write side, mirrored for reads: the caller passes
 * only an application id, never a path, and the real, resolved path is verified to stay under
 * output/applications/ before it is ever returned. Returns null (never throws) when there is no
 * screenshot, the id is invalid, or the resolved path fails confinement -- "no screenshot" and "malicious
 * path" are both, deliberately, the same total "nothing to show" outcome to the route caller.
 * @param {string} outputRoot
 * @param {number} applicationId
 * @returns {string|null} absolute path, or null
 */
export function resolveLatestApplicationScreenshot(outputRoot, applicationId) {
  if (!Number.isInteger(applicationId) || applicationId <= 0) return null;
  const appsRoot = path.join(outputRoot, 'applications');
  const dir = path.join(appsRoot, String(applicationId));
  /** @type {fs.Dirent[]} */
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const pngs = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png')).map((e) => e.name).sort();
  if (pngs.length === 0) return null;
  const latestAbs = path.join(dir, pngs[pngs.length - 1]);
  /** @type {string} */
  let realAbs;
  /** @type {string} */
  let realRoot;
  try {
    realAbs = fs.realpathSync.native(latestAbs);
    realRoot = fs.realpathSync.native(appsRoot);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, realAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return realAbs;
}
