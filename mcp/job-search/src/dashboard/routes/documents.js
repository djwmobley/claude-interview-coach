// @ts-check
/**
 * Document routes (dashboard PR 2 API table, "Documents"). Every path a caller supplies goes through
 * resolveOutputPath (src/core/documents.js) before it ever touches the filesystem, matching the same
 * total-classification rules the MCP tools rely on. Stored report/research HTML is served with the
 * sandbox CSP (pr2-spec-decisions.md rule 5); docx/pdf download as attachments; md/txt as plain text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { JobSearchError } from '../../core/errors.js';
import { resolveOutputPath, listOutputFiles, linkDocument, unlinkDocument, DOCUMENT_KINDS } from '../../core/documents.js';
import { sendJson, applySandboxHtmlHeaders } from '../http.js';

const MIME_BY_EXT = Object.freeze({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * @param {ReturnType<typeof import('../router.js').createRouter>} router
 * @param {import('../server.js').DashboardDeps} deps
 */
export function register(router, deps) {
  router.register('GET', '/api/documents', async (ctx) => {
    const q = ctx.query;
    let files = listOutputFiles(deps.outputRoot);
    if (q.dir) files = files.filter((f) => f.dir === q.dir);
    if (q.q) {
      const needle = String(q.q).toLowerCase();
      files = files.filter((f) => f.relPath.toLowerCase().includes(needle));
    }
    sendJson(ctx.res, 200, { ok: true, files });
  });

  router.register('GET', '/api/documents/file', async (ctx) => {
    const resolved = resolveOutputPath(deps.outputRoot, ctx.query.path ?? '');
    if (!resolved.ok) throw new JobSearchError('VALIDATION', `cannot serve document: ${resolved.reason}`, { details: { reason: resolved.reason } });
    const ext = path.extname(resolved.absPath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    if (ext === '.html') applySandboxHtmlHeaders(ctx.res);
    ctx.res.setHeader('Content-Type', mime);
    if (ext === '.docx' || ext === '.pdf') {
      ctx.res.setHeader('Content-Disposition', `attachment; filename="${path.basename(resolved.absPath).replace(/"/g, '')}"`);
    }
    const data = fs.readFileSync(resolved.absPath);
    ctx.res.statusCode = 200;
    ctx.res.end(data);
  });

  router.register('POST', '/api/documents/open', async (ctx) => {
    const b = /** @type {any} */ (ctx.body);
    const resolved = resolveOutputPath(deps.outputRoot, b.path ?? '');
    if (!resolved.ok) throw new JobSearchError('VALIDATION', `cannot open document: ${resolved.reason}`, { details: { reason: resolved.reason } });
    if (process.platform !== 'win32') throw new JobSearchError('VALIDATION', 'open/reveal is only supported on Windows');
    await new Promise((resolve, reject) => {
      if (b.reveal) {
        execFile('explorer', ['/select,', resolved.absPath], (err) => {
          // explorer.exe frequently exits non-zero on a normal /select, success; treat any exit as ok.
          void err;
          resolve(undefined);
        });
      } else {
        execFile('rundll32', ['url.dll,FileProtocolHandler', resolved.absPath], (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      }
    }).catch((err) => {
      throw new JobSearchError('VALIDATION', `failed to open document: ${err instanceof Error ? err.message : String(err)}`);
    });
    sendJson(ctx.res, 200, { ok: true });
  }, { allowEmptyBody: true });

  router.register('POST', '/api/listings/:id/documents', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const b = /** @type {any} */ (ctx.body);
    if (!DOCUMENT_KINDS.includes(b.kind)) throw new JobSearchError('VALIDATION', `kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
    if (typeof b.relPath !== 'string') throw new JobSearchError('VALIDATION', 'relPath is required');
    const row = await deps.withClient((c) => linkDocument(c, deps.outputRoot, { listingId: id, relPath: b.relPath, kind: b.kind, label: b.label ?? null, actor: 'dashboard' }));
    sendJson(ctx.res, 201, { ok: true, row });
  });

  router.register('DELETE', '/api/documents/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new JobSearchError('VALIDATION', 'id must be a positive integer');
    const result = await deps.withClient((c) => unlinkDocument(c, { id, actor: 'dashboard' }));
    sendJson(ctx.res, 200, { ok: true, ...result });
  }, { allowEmptyBody: true });
}
