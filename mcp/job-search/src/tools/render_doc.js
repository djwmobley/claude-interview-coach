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
import { renderDoc, renderToPath, KINDS } from '../core/render.js';
import { repoRoot } from '../core/config.js';
import { linkDocument, resolveOutputPath } from '../core/documents.js';
import { onDocumentLinked, onDocumentLinkedForApplication } from '../core/applications.js';
import { JobSearchError } from '../core/errors.js';

/** Cap on the sanitized company suffix appended to a sibling filename (spec: "max 40 chars"). */
const COMPANY_SUFFIX_MAX = 40;

/**
 * Sanitize a listing's company name for use as one filename component appended after " - " to an outward
 * DOCX stem. Total classification, not an allow-list: every input character is either kept (a letter in
 * any script, a digit, a space, or a hyphen) or folded to a space (anything else -- slashes, colons,
 * quotes, ampersands, and all other punctuation/symbols), so an unanticipated character never survives
 * into a Windows path unescaped instead of silently corrupting it. Runs of whitespace collapse to one
 * space; the result is trimmed, has any leading/trailing hyphens stripped (a run of nothing but hyphens or
 * punctuation must not become a bare "-" suffix), and is capped at 40 characters. Returns null when there
 * is no usable company text (missing, blank, or sanitizes to nothing) so the caller falls back to a
 * listingId-only sibling name instead of an empty or junk company suffix.
 * @param {unknown} company
 * @returns {string|null}
 */
export function sanitizeCompanyForFilename(company) {
  const raw = typeof company === 'string' ? company : '';
  if (!raw.trim()) return null;
  let cleaned = raw.replace(/[^\p{L}\p{N} -]/gu, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/^-+|-+$/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > COMPANY_SUFFIX_MAX) cleaned = cleaned.slice(0, COMPANY_SUFFIX_MAX).trim();
  return cleaned || null;
}

export const schema = {
  kind: z.enum(KINDS),
  source: z.string().min(1).max(300).describe('repo-relative .md (or .txt for cover letters) path'),
  outName: z.string().max(80).optional().describe('human file name without extension, e.g. "Jordan Reyes - CTO"; required for resumes and cover letters'),
  checkOnly: z.boolean().default(false),
  force: z.boolean().default(false).describe('overwrite an existing DOCX (never one that is open in Word)'),
  reuse_existing: z.boolean().default(false).describe('submit-on-resume: when render_doc returns EXISTS, link the ALREADY-ON-DISK DOCX to the listing/application instead of overwriting it. Mutually exclusive with force. Requires listingId. If the on-disk file is EMPTY_DOCX (0 bytes) or EXISTS_OTHER_LISTING (already linked to a different listing), this renders a listing-unique sibling file instead (a company-suffixed name, e.g. "<name> - Acme.docx") and links that one, returned as renamed_to; it never links something that is not actually this listing\'s resume, and never overwrites another listing\'s file.'),
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
 * Is the file at `absPath` unusable for THIS listing: 0 bytes, or already linked (in ic_job_documents) to
 * a different listing_id? Total for the two states this module ever needs to distinguish; a file that is
 * neither (non-empty, and unlinked or linked to this same listing) is usable as-is.
 * @param {import('pg').ClientBase} client
 * @param {string} outputRoot
 * @param {string} absPath
 * @param {number} listingId
 * @returns {Promise<{ conflict: null } | { conflict: 'EMPTY_DOCX' } | { conflict: 'EXISTS_OTHER_LISTING', otherListingId: number }>}
 */
async function classifyExistingFile(client, outputRoot, absPath, listingId) {
  const relPath = path.relative(outputRoot, absPath).split(path.sep).join('/');
  const resolved = resolveOutputPath(outputRoot, relPath);
  const statTarget = resolved.ok ? resolved.absPath : absPath;
  const stat = fs.statSync(statTarget);
  if (stat.size === 0) return { conflict: 'EMPTY_DOCX' };
  const canonicalRelPath = resolved.ok ? resolved.relPath : relPath;
  const existing = await client.query('SELECT DISTINCT listing_id FROM ic_job_documents WHERE rel_path = $1', [canonicalRelPath]);
  const conflicting = existing.rows.find((r) => Number(r.listing_id) !== Number(listingId));
  if (conflicting) return { conflict: 'EXISTS_OTHER_LISTING', otherListingId: Number(conflicting.listing_id) };
  return { conflict: null };
}

/**
 * The listing-unique sibling filenames tried, in order, once the primary attempted output path turns out
 * to belong to (or look like) a different listing's resume. First choice appends the listing's sanitized
 * company name; the second, more specific fallback also appends the listingId itself, which by
 * construction cannot collide with any other listing's sibling name. When the company name has no usable
 * text (missing, blank, or sanitizes to nothing -- sanitizeCompanyForFilename returns null), the
 * company-suffixed choice is skipped entirely and only the listingId-only name is tried.
 * @param {string} stem the primary target's filename without its extension
 * @param {string|null} companySuffix sanitizeCompanyForFilename's output
 * @param {number} listingId
 * @returns {string[]} filenames without extension, in try order
 */
function siblingNameCandidates(stem, companySuffix, listingId) {
  const candidates = [];
  if (companySuffix) candidates.push(`${stem} - ${companySuffix}`);
  candidates.push(companySuffix ? `${stem} - ${companySuffix} ${listingId}` : `${stem} - ${listingId}`);
  return candidates;
}

/**
 * Resolve a primary-target conflict (EMPTY_DOCX or EXISTS_OTHER_LISTING) by rendering (or, if a usable
 * file already sits there, linking) a listing-unique sibling instead of refusing outright. Operator rule:
 * "anything that gets a resume made must be sent," and outward DOCX filenames stay human-readable, so the
 * sibling name is `<stem> - <Company>.docx`, falling back to `<stem> - <Company> <listingId>.docx` (or, with
 * no usable company text, `<stem> - <listingId>.docx`) only if the company-suffixed name is itself taken by
 * something unusable. Never overwrites an existing non-empty file belonging to another listing; never
 * passes force.
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, kind: string, root: string, outputRoot: string, applicationId?: number, source?: string, outName?: string, allowMissing?: string[], renderFn: typeof renderToPath }} input
 * @param {string} absTarget the primary target's absolute path (the one that conflicted)
 * @param {'EMPTY_DOCX'|'EXISTS_OTHER_LISTING'} conflictCode
 * @param {number} [otherListingId]
 * @returns {Promise<{ ok: true, document: any, application_link: any, reused: boolean, renamed_to: string, conflict_code: string } | { ok: false, code: string, conflict_code: string, otherListingId?: number }>}
 */
async function resolveSiblingForListing(client, input, absTarget, conflictCode, otherListingId) {
  if (!input.source) {
    // No markdown source to render from: there is nothing this function can do without one, so it refuses
    // in exactly the pristine pre-fallback shape (no conflict_code/renamed_to noise) rather than a
    // half-resolved result. A caller with a source always reaches the fallback below instead; this is the
    // documented blind spot (see PR body) for a caller that omits it.
    return conflictCode === 'EXISTS_OTHER_LISTING' ? { ok: false, code: conflictCode, otherListingId } : { ok: false, code: conflictCode };
  }
  const dir = path.dirname(absTarget);
  const ext = path.extname(absTarget) || '.docx';
  const stem = path.basename(absTarget, ext);
  const companyRow = await client.query('SELECT company FROM ic_job_listings WHERE id = $1', [input.listingId]);
  const companySuffix = sanitizeCompanyForFilename(companyRow.rows[0]?.company ?? null);
  const req = { kind: input.kind, source: input.source, outName: input.outName, allowMissing: input.allowMissing ?? [] };

  for (const name of siblingNameCandidates(stem, companySuffix, input.listingId)) {
    const candidateAbs = path.join(dir, `${name}${ext}`);
    const candidateOutputPath = path.relative(input.root, candidateAbs);
    if (!fs.existsSync(candidateAbs)) {
      const rendered = await input.renderFn(req, candidateAbs, { root: input.root });
      if (!rendered.ok) return { ok: false, code: /** @type {string} */ (rendered.code), conflict_code: conflictCode, otherListingId };
      const linked = await linkRenderedDocument(client, {
        listingId: input.listingId, kind: input.kind, outputPath: /** @type {string} */ (rendered.output_path), root: input.root, applicationId: input.applicationId,
      });
      return { ok: true, ...linked, reused: false, renamed_to: /** @type {string} */ (rendered.output_path), conflict_code: conflictCode };
    }
    const candidateState = await classifyExistingFile(client, input.outputRoot, candidateAbs, input.listingId);
    if (candidateState.conflict) continue; // this sibling name is itself unusable; try the next, more specific one
    const linked = await linkRenderedDocument(client, {
      listingId: input.listingId, kind: input.kind, outputPath: candidateOutputPath, root: input.root, applicationId: input.applicationId,
    });
    return { ok: true, ...linked, reused: true, renamed_to: candidateOutputPath, conflict_code: conflictCode };
  }
  // Every candidate, including the listingId-qualified one (which by construction cannot collide with any
  // OTHER listing's sibling), is itself unusable. Exceedingly rare -- it requires a hand-placed or
  // corrupted file sitting exactly at that fully-qualified path -- but a real dead end: refuse rather than
  // overwrite or guess further.
  return { ok: false, code: conflictCode, conflict_code: conflictCode, otherListingId };
}

/**
 * submit-on-resume spec section 2 / amendment A4: link an ALREADY-ON-DISK DOCX (the one renderDoc's own
 * EXISTS branch just refused to overwrite) rather than regenerating it -- "the existing DOCX is the
 * truth; the newly drafted markdown is not applied to it." Never writes to the file itself, never calls
 * Python, never passes `force`.
 *
 * Two conflict states are checked ahead of linking, each its own distinct code (never silently linking
 * something that might not actually be this listing's resume):
 *   - EMPTY_DOCX: the on-disk file is 0 bytes (a previous render that crashed mid-write, or a placeholder
 *     someone created by hand) -- there is nothing real to reuse.
 *   - EXISTS_OTHER_LISTING: an ic_job_documents row already references this exact rel_path for a
 *     DIFFERENT listing_id than the one this call is trying to link (rel_path is unique per listing, not
 *     globally, so this is a real possible state, not a defensive-only branch) -- reusing it here would
 *     silently attach one listing's resume file to a second listing's application.
 * Neither is a dead end by itself (render_doc PR "resolve cross-listing DOCX filename collisions"): when
 * `input.source` and `input.renderFn` are supplied, a conflict is resolved by rendering (or linking an
 * already-usable) listing-unique sibling file instead -- see resolveSiblingForListing. Without a source
 * (the pre-fallback callers), a conflict still refuses outright, exactly as before.
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, kind: string, outputPath: string, root?: string, applicationId?: number, source?: string, outName?: string, allowMissing?: string[], renderFn?: typeof renderToPath }} input
 * @returns {Promise<{ ok: true, document: { id: number, kind: string, rel_path: string }, application_link: any, reused: boolean, renamed_to?: string, conflict_code?: string } | { ok: false, code: string, conflict_code?: string, otherListingId?: number }>}
 */
export async function reuseExistingDocument(client, input) {
  const root = input.root ?? repoRoot();
  const outputRoot = path.join(root, 'output');
  const absTarget = path.isAbsolute(input.outputPath) ? input.outputPath : path.join(root, input.outputPath);
  const state = await classifyExistingFile(client, outputRoot, absTarget, input.listingId);

  if (state.conflict) {
    const renderFn = input.renderFn ?? renderToPath;
    return resolveSiblingForListing(client, { ...input, root, outputRoot, renderFn }, absTarget, state.conflict, /** @type {any} */ (state).otherListingId);
  }

  const linked = await linkRenderedDocument(client, {
    listingId: input.listingId, kind: input.kind, outputPath: input.outputPath, root, applicationId: input.applicationId,
  });
  return { ok: true, ...linked, reused: true };
}

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'render_doc',
  description: 'Preflight a resume, cover letter, or cheat sheet markdown (em-dash, en-dash, scare quotes, buzzwords, problem-comparison reframe, resume structure, role inclusion, PMP wording, Jenkon title, output naming) and render the DOCX with the repo converters. Fails closed on any check; returns LOCKED when the DOCX is open in Word. Never opens the file. An optional listingId links the render to that listing\'s application and, for a resume, moves it from drafting to docs_ready. An optional applicationId (requires listingId) scopes that link to one specific application rather than the listing\'s most recent one -- always pass both together in a one-click apply / headless run. reuse_existing links an EXISTS DOCX already on disk instead of overwriting it; if that file is EMPTY_DOCX or EXISTS_OTHER_LISTING, it renders a company-suffixed sibling and links that instead (renamed_to); mutually exclusive with force.',
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
      // deps.renderToPathFn is a test seam ONLY, matching deps.renderDocFn above: lets a test drive the
      // EMPTY_DOCX/EXISTS_OTHER_LISTING sibling-render fallback without invoking Python. Defaults to the
      // real renderToPath (src/core/render.js).
      const renderSibling = deps.renderToPathFn ?? renderToPath;
      const reuse = await deps.withClient((c) => reuseExistingDocument(c, {
        listingId: a.listingId, kind: a.kind, outputPath: /** @type {string} */ (result.output_path),
        applicationId: a.applicationId, source: a.source, outName: a.outName, allowMissing: a.allowMissing ?? [],
        renderFn: renderSibling,
      }));
      if (!reuse.ok) {
        return { ...result, ok: false, code: reuse.code, hint: undefined, otherListingId: reuse.otherListingId, conflict_code: reuse.conflict_code };
      }
      const { ok, ...linkFields } = reuse;
      void ok;
      return { ...result, ...linkFields, ok: true, code: undefined, hint: undefined };
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
