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
import path from 'node:path';
import { z } from 'zod';
import { renderDoc, KINDS } from '../core/render.js';
import { repoRoot } from '../core/config.js';
import { linkDocument } from '../core/documents.js';
import { onDocumentLinked, onDocumentLinkedForApplication } from '../core/applications.js';

export const schema = {
  kind: z.enum(KINDS),
  source: z.string().min(1).max(300).describe('repo-relative .md (or .txt for cover letters) path'),
  outName: z.string().max(80).optional().describe('human file name without extension, e.g. "Jordan Reyes - CTO"; required for resumes and cover letters'),
  checkOnly: z.boolean().default(false),
  force: z.boolean().default(false).describe('overwrite an existing DOCX (never one that is open in Word)'),
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

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'render_doc',
  description: 'Preflight a resume, cover letter, or cheat sheet markdown (em-dash, en-dash, scare quotes, buzzwords, problem-comparison reframe, resume structure, role inclusion, PMP wording, Jenkon title, output naming) and render the DOCX with the repo converters. Fails closed on any check; returns LOCKED when the DOCX is open in Word. Never opens the file. An optional listingId links the render to that listing\'s application and, for a resume, moves it from drafting to docs_ready. An optional applicationId (requires listingId) scopes that link to one specific application rather than the listing\'s most recent one -- always pass both together in a one-click apply / headless run.',
  schema,
  async handler(a, deps) {
    const result = await renderDoc({ kind: a.kind, source: a.source, outName: a.outName, checkOnly: a.checkOnly, force: a.force, allowMissing: a.allowMissing ?? [] });
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
