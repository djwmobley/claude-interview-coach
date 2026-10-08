// @ts-check
/**
 * Sanitized LinkedIn page snapshots for diagnosing a wall / unrecognized / end-of-results page after the
 * fact. Written to <logDir>/linkedin-snapshots/<run>-<query-hash>-p<page>.html, at most 10 per run.
 *
 * Sanitizing is deliberately aggressive: LinkedIn pages embed the signed-in member's name (nav/header),
 * voyager data blobs (<code> elements), CSRF tokens (meta, hidden inputs, ajax:<digits> values) and
 * tracking query strings. All of that is removed; the structural markup (class names, roles, element
 * order) that makes the snapshot diagnosable stays. Anything the patterns miss is a blind spot, so the
 * directory is under the gitignored logs/ tree and never published.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_SNAPSHOTS_PER_RUN = 10;
const MAX_BYTES = 400000;

/**
 * @param {unknown} html
 * @returns {string}
 */
export function sanitizeSnapshotHtml(html) {
  let s = typeof html === 'string' ? html : '';
  // Whole elements that carry code, member data, or the signed-in member's identity.
  for (const tag of ['script', 'style', 'noscript', 'code', 'header', 'nav', 'template']) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), `<!-- ${tag} removed -->`);
  }
  // Meta tags (csrf-token, member ids) and every input value.
  s = s.replace(/<meta\b[^>]*>/gi, '<!-- meta removed -->');
  s = s.replace(/(<input\b[^>]*?)\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
  // Query strings and fragments on any URL attribute.
  s = s.replace(/\b(href|src|action|data-[a-z-]*url)\s*=\s*("([^"?#]*)[^"]*"|'([^'?#]*)[^']*')/gi, (_m, attr, _q, dq, sq) => `${attr}="${dq ?? sq ?? ''}"`);
  // Token-shaped values and obvious identifiers anywhere that remains.
  s = s.replace(/ajax:\d+/gi, 'ajax:REDACTED');
  s = s.replace(/\b(li_at|JSESSIONID|bcookie|bscookie|lidc|csrf-?token|liap)\b\s*[=:]\s*"?[^\s"'<;,]+/gi, '$1=REDACTED');
  s = s.replace(/urn:li:[A-Za-z_]+:[A-Za-z0-9_-]+/g, 'urn:li:REDACTED');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'EMAIL_REDACTED');
  return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) : s;
}

/**
 * One saver per run. Returns the written path, or null when the per-run cap is reached.
 * @param {{ dir: string, runId: number|string }} o
 * @returns {(html: string, meta: { query: string, pageIndex: number, classification?: string }) => Promise<string|null>}
 */
export function createSnapshotSaver(o) {
  let written = 0;
  return async (html, meta) => {
    if (written >= MAX_SNAPSHOTS_PER_RUN) return null;
    written++;
    const hash = crypto.createHash('sha1').update(String(meta.query)).digest('hex').slice(0, 10);
    const file = path.join(o.dir, `${o.runId}-${hash}-p${Number(meta.pageIndex) || 0}.html`);
    await fs.promises.mkdir(o.dir, { recursive: true });
    await fs.promises.writeFile(file, sanitizeSnapshotHtml(html), 'utf8');
    return file;
  };
}
