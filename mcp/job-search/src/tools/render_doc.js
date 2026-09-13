// @ts-check
/**
 * render_doc (spec 12a): preflight + DOCX rendering through the Python
 * converters. See core/render.js for the checks.
 *
 * Apply pipeline slice 3 (plan `let-s-brainstorm-a-bit-humble-umbrella.md` section "2. Listing to
 * documents"): an optional `listingId` links a successfully rendered DOCX to a listing and, for a
 * resume, flips the listing's application from drafting to docs_ready. Kept out of src/core/render.js
 * on purpose -- that module is pure filesystem/Python and has never touched the database; the linking
 * step lives at this tool-wrapper layer instead, alongside deps.withClient (which every DB-touching MCP
 * tool already receives, e.g. src/tools/get_job.js and src/tools/mark_jobs.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { renderDoc, KINDS } from '../core/render.js';
import { repoRoot } from '../core/config.js';
import { linkDocument, resolveOutputPath } from '../core/documents.js';
import { onDocumentLinked, onDocumentLinkedForApplication } from '../core/applications.js';
import { JobSearchError } from '../core/errors.js';

export const schema = {
  kind: z.enum(KINDS),
  source: z.string().min(1).max(300).describe('repo-relative .md (or .txt for cover letters) path'),
  outName: z.string().max(80).optional().describe('human file name without extension, e.g. "Jordan Reyes - CTO"; required for resumes and cover letters'),
  checkOnly: z.boolean().default(false),
  force: z.boolean().default(false).describe('overwrite an existing DOCX (never one that is open in Word)'),
  reuse_existing: z.boolean().default(false).describe('submit-on-resume: when render_doc returns EXISTS, link the ALREADY-ON-DISK DOCX to the listing/application instead of overwriting it. Mutually exclusive with force. Requires listingId. Refuses with EMPTY_DOCX (a 0-byte file) or EXISTS_OTHER_LISTING (the file is already linked to a different listing) rather than linking something that is not actually this listing\'s resume.'),
  allowMissing: z.array(z.string().max(60)).max(10).optional().describe('companies approved for omission from a resume'),
  listingId: z.number().int().positive().optional().describe('apply pipeline: link the rendered DOCX to this listing and, for a resume, flip its application to docs_ready'),
  applicationId: z.number().int().positive().optional().describe('one-click apply: link the rendered DOCX to THIS SPECIFIC application (never "whichever application is most recent for the listing"). Requires listingId; the application\'s own listing_id must equal it. Ignored unless listingId is also given.'),
};

/** render_doc `kind` -> documents.js DOCUMENT_KINDS value. cover_letter is the only rename (documents.js
 * calls it "coverletter"); the translation happens here, at the boundary, and neither side is renamed to
 * match the other (plan section 2). resume and cheatsheet already share the same spelling both sides. */
const DOC_KIND_FOR_RENDER_KIND = Object.freeze({ resume: 'resume', cover_letter: 'coverletter', cheatsheet: 'cheatsheet' });

/**
 * Link a just-rendered DOCX to a listing. Exported separately from the tool handler so it is testable
 * without invoking Python or the real preflight pipeline: tests call this directly against a real test
 * DB with a fabricated (but real, on-disk) render result.
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, kind: string, outputPath: string, root?: string, applicationId?: number }} input
 *   outputPath is renderDoc()'s own `output_path` (repo-relative, OS path separators, e.g.
 *   "output\\resumes\\X.docx" on Windows) or an already-absolute path. applicationId (one-click apply):
 *   when given, links THAT SPECIFIC application only (src/core/applications.js's
 *   onDocumentLinkedForApplication), never the listing's "most recent" application.
 * @returns {Promise<{ document: { id: number, kind: string, rel_path: string }, application_link: { ignored: true, reason: string } | { ignored: false, application: any } }>}
 */
export async function linkRenderedDocument(client, input) {
  const root = input.root ?? repoRoot();
  const outputRoot = path.join(root, 'output');
  const absTarget = path.isAbsolute(input.outputPath) ? input.outputPath : path.join(root, input.outputPath);
  // documents.resolveOutputPath (and every other consumer of a document relPath in this codebase) expects
  // forward-slash separators; renderDoc()'s own output_path is built with path.relative(), which is
  // backslash-separated on Windows. Converted once, here, at the only boundary between the two.
  const relPath = path.relative(outputRoot, absTarget).split(path.sep).join('/');
  const docKind = DOC_KIND_FOR_RENDER_KIND[input.kind] ?? 'other';
  const linked = await linkDocument(client, outputRoot, { listingId: input.listingId, relPath, kind: docKind, actor: 'mcp' });
  // linkDocument already records the 'document' event itself (src/core/documents.js) when the row is a
  // fresh insert -- no second recordEvent call here, which would double the audit trail on a re-link.
  const linkResult = input.applicationId !== undefined
    ? await onDocumentLinkedForApplication(client, input.applicationId, input.listingId, docKind, linked.id, { actor: 'mcp' })
    : await onDocumentLinked(client, input.listingId, docKind, linked.id, { actor: 'mcp' });
  return { document: { id: linked.id, kind: linked.kind, rel_path: linked.rel_path }, application_link: linkResult };
}

/**
 * submit-on-resume spec section 2 / amendment A4: link an ALREADY-ON-DISK DOCX (the one renderDoc's own
 * EXISTS branch just refused to overwrite) rather than regenerating it -- "the existing DOCX is the
 * truth; the newly drafted markdown is not applied to it." Never writes to the file itself, never calls
 * Python, never passes `force`.
 *
 * Two closed refusal branches ahead of linking, each its own distinct code (never silently linking
 * something that might not actually be this listing's resume):
 *   - EMPTY_DOCX: the on-disk file is 0 bytes (a previous render that crashed mid-write, or a placeholder
 *     someone created by hand) -- there is nothing real to reuse.
 *   - EXISTS_OTHER_LISTING: an ic_job_documents row already references this exact rel_path for a
 *     DIFFERENT listing_id than the one this call is trying to link (rel_path is unique per listing, not
 *     globally, so this is a real possible state, not a defensive-only branch) -- reusing it here would
 *     silently attach one listing's resume file to a second listing's application.
 * Only when neither branch fires (no ic_job_documents row references this rel_path at all, OR the only
 * row that does already belongs to THIS listing) does this proceed to linkRenderedDocument() exactly as
 * a fresh render would.
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, kind: string, outputPath: string, root?: string, applicationId?: number }} input
 * @returns {Promise<{ ok: true, document: { id: number, kind: string, rel_path: string }, application_link: any } | { ok: false, code: 'EMPTY_DOCX' | 'EXISTS_OTHER_LISTING', otherListingId?: number }>}
 */
export async function reuseExistingDocument(client, input) {
  const root = input.root ?? repoRoot();
  const outputRoot = path.join(root, 'output');
  const absTarget = path.isAbsolute(input.outputPath) ? input.outputPath : path.join(root, input.outputPath);
  const relPath = path.relative(outputRoot, absTarget).split(path.sep).join('/');
  const resolved = resolveOutputPath(outputRoot, relPath);
  const statTarget = resolved.ok ? resolved.absPath : absTarget;
  const stat = fs.statSync(statTarget);
  if (stat.size === 0) return { ok: false, code: 'EMPTY_DOCX' };

  const canonicalRelPath = resolved.ok ? resolved.relPath : relPath;
  const existing = await client.query('SELECT DISTINCT listing_id FROM ic_job_documents WHERE rel_path = $1', [canonicalRelPath]);
  const conflicting = existing.rows.find((r) => Number(r.listing_id) !== Number(input.listingId));
  if (conflicting) return { ok: false, code: 'EXISTS_OTHER_LISTING', otherListingId: Number(conflicting.listing_id) };

  const linked = await linkRenderedDocument(client, {
    listingId: input.listingId, kind: input.kind, outputPath: input.outputPath, root, applicationId: input.applicationId,
  });
  return { ok: true, ...linked };
}

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'render_doc',
  description: 'Preflight a resume, cover letter, or cheat sheet markdown (em-dash, en-dash, scare quotes, buzzwords, problem-comparison reframe, resume structure, role inclusion, PMP wording, Jenkon title, output naming) and render the DOCX with the repo converters. Fails closed on any check; returns LOCKED when the DOCX is open in Word. Never opens the file. An optional listingId links the render to that listing\'s application and, for a resume, moves it from drafting to docs_ready. An optional applicationId (requires listingId) scopes that link to one specific application rather than the listing\'s most recent one -- always pass both together in a one-click apply / headless run. reuse_existing links an EXISTS DOCX already on disk instead of overwriting it (refuses EMPTY_DOCX / EXISTS_OTHER_LISTING); mutually exclusive with force.',
  schema,
  async handler(a, deps) {
    if (a.reuse_existing && a.force) {
      throw new JobSearchError('VALIDATION', 'render_doc: reuse_existing and force are mutually exclusive');
    }
    // deps.renderDocFn is a test seam ONLY (never set by production wiring, matching
    // src/dashboard/routes/applications.js's deps.applyExclusionGate pattern): lets a test exercise this
    // handler's own EXISTS/reuse_existing branching without invoking the real filesystem/preflight/Python
    // pipeline. Defaults to the real renderDoc.
    const doRender = deps.renderDocFn ?? renderDoc;
    const result = await doRender({ kind: a.kind, source: a.source, outName: a.outName, checkOnly: a.checkOnly, force: a.force, allowMissing: a.allowMissing ?? [] });

    if (!result.ok && result.code === 'EXISTS' && a.reuse_existing && !a.checkOnly && a.listingId !== undefined) {
      const reuse = await deps.withClient((c) => reuseExistingDocument(c, {
        listingId: a.listingId, kind: a.kind, outputPath: /** @type {string} */ (result.output_path),
        applicationId: a.applicationId,
      }));
      if (!reuse.ok) {
        return { ...result, ok: false, code: reuse.code, hint: undefined, otherListingId: reuse.otherListingId };
      }
      const { ok, ...linkFields } = reuse;
      void ok;
      return { ...result, ...linkFields, ok: true, reused: true, code: undefined, hint: undefined };
    }

    if (!result.ok || a.checkOnly || a.listingId === undefined) return result;
    // Surfaced verbatim on the result (never swallowed) so a render against a listing whose application
    // already moved past drafting is visibly a no-op { ignored: true, reason } rather than a silent one.
    const linkOutcome = await deps.withClient((c) => linkRenderedDocument(c, {
      listingId: a.listingId, kind: a.kind, outputPath: /** @type {string} */ (result.output_path),
      applicationId: a.applicationId,
    }));
    return { ...result, ...linkOutcome };
  },
};
