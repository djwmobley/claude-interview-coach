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
import { checkResumeFile, isValidDocxFile } from '../core/resume-content-gate.js';

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
 * Stale or foreign resume guard, S1: reuse classification is TOTAL. An existing file at a target path is in
 * exactly one branch:
 *   - SAME_LISTING_CURRENT: a row in ic_job_documents links this exact rel_path to THIS listing, the file is
 *     non-empty, is a readable DOCX, and (kind resume) passes the content gate against the current project
 *     index. Safe to re-link (idempotent).
 *   - DEFAULT: everything else (no row, rows only for other listings, a row for this listing but the gate or
 *     the DOCX check fails, an empty or unreadable file, or any thrown error). Never linked; the caller
 *     renders a fresh, listing-unique sibling instead. `conflict` says why, for the result's conflict_code.
 * Never writes, modifies, or deletes the file.
 * @param {import('pg').ClientBase} client
 * @param {string} outputRoot
 * @param {string} absPath
 * @param {number} listingId
 * @param {string} kind render_doc kind (resume, cover_letter, cheatsheet)
 * @returns {Promise<{ branch: 'SAME_LISTING_CURRENT' } | { branch: 'DEFAULT', conflict: 'EMPTY_DOCX' | 'EXISTS_OTHER_LISTING' | 'EXISTS_UNVERIFIED', otherListingId?: number }>}
 */
export async function classifyExistingFile(client, outputRoot, absPath, listingId, kind) {
  try {
    const relPath = path.relative(outputRoot, absPath).split(path.sep).join('/');
    const resolved = resolveOutputPath(outputRoot, relPath);
    const statTarget = resolved.ok ? resolved.absPath : absPath;
    const stat = fs.statSync(statTarget);
    if (stat.size === 0) return { branch: 'DEFAULT', conflict: 'EMPTY_DOCX' };
    const canonicalRelPath = resolved.ok ? resolved.relPath : relPath;
    const rows = await client.query('SELECT DISTINCT listing_id FROM ic_job_documents WHERE rel_path = $1', [canonicalRelPath]);
    const ids = rows.rows.map((r) => Number(r.listing_id));
    if (!ids.includes(Number(listingId))) {
      const other = ids.find((id) => id !== Number(listingId));
      return other !== undefined ? { branch: 'DEFAULT', conflict: 'EXISTS_OTHER_LISTING', otherListingId: other } : { branch: 'DEFAULT', conflict: 'EXISTS_UNVERIFIED' };
    }
    if (!resolved.ok) return { branch: 'DEFAULT', conflict: 'EXISTS_UNVERIFIED' };
    if (kind === 'resume') {
      if (!checkResumeFile(resolved.absPath, path.join(path.dirname(outputRoot), 'data', 'project-index.md')).ok) return { branch: 'DEFAULT', conflict: 'EXISTS_UNVERIFIED' };
    } else if (!isValidDocxFile(resolved.absPath)) {
      return { branch: 'DEFAULT', conflict: 'EXISTS_UNVERIFIED' };
    }
    return { branch: 'SAME_LISTING_CURRENT' };
  } catch {
    return { branch: 'DEFAULT', conflict: 'EXISTS_UNVERIFIED' };
  }
}

/**
 * The listing-unique sibling filenames tried, in order, once the primary attempted output path is not
 * SAME_LISTING_CURRENT. First choice appends the listing's sanitized company name; the next appends the
 * listingId too (by construction it cannot collide with another listing's sibling); a few numbered
 * variants follow so a regenerated resume never needs to overwrite or reuse an unverified sibling. When the
 * company name has no usable text, the company-suffixed choice is skipped.
 * @param {string} stem the primary target's filename without its extension
 * @param {string|null} companySuffix sanitizeCompanyForFilename's output
 * @param {number} listingId
 * @returns {string[]} filenames without extension, in try order
 */
function siblingNameCandidates(stem, companySuffix, listingId) {
  const candidates = [];
  if (companySuffix) candidates.push(`${stem} - ${companySuffix}`);
  const withId = companySuffix ? `${stem} - ${companySuffix} ${listingId}` : `${stem} - ${listingId}`;
  candidates.push(withId);
  for (let n = 2; n <= 9; n++) candidates.push(`${withId} v${n}`);
  return candidates;
}

/**
 * Resolve a primary-target that is not SAME_LISTING_CURRENT by rendering a listing-unique sibling instead
 * (or re-linking a sibling that IS SAME_LISTING_CURRENT, S1: an existing sibling is reused only under
 * that branch). Picks the first candidate name that does not exist; never overwrites, never passes force,
 * never reuses an unverified sibling.
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, kind: string, root: string, outputRoot: string, applicationId?: number, source?: string, outName?: string, allowMissing?: string[], renderFn: typeof renderToPath }} input
 * @param {string} absTarget the primary target's absolute path (the one that is not reusable)
 * @param {'EMPTY_DOCX'|'EXISTS_OTHER_LISTING'|'EXISTS_UNVERIFIED'} conflictCode
 * @param {number} [otherListingId]
 * @returns {Promise<{ ok: true, document: any, application_link: any, reused: boolean, renamed_to: string, conflict_code: string } | { ok: false, code: string, conflict_code: string, otherListingId?: number }>}
 */
async function resolveSiblingForListing(client, input, absTarget, conflictCode, otherListingId) {
  if (!input.source) {
    // No markdown source to render from: nothing to do but refuse (the existing file stays untouched).
    return conflictCode === 'EXISTS_OTHER_LISTING' ? { ok: false, code: conflictCode, conflict_code: conflictCode, otherListingId } : { ok: false, code: conflictCode, conflict_code: conflictCode };
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
    const candidateState = await classifyExistingFile(client, input.outputRoot, candidateAbs, input.listingId, input.kind);
    if (candidateState.branch !== 'SAME_LISTING_CURRENT') continue; // unverified sibling: never reused, try the next name
    const linked = await linkRenderedDocument(client, {
      listingId: input.listingId, kind: input.kind, outputPath: candidateOutputPath, root: input.root, applicationId: input.applicationId,
    });
    return { ok: true, ...linked, reused: true, renamed_to: candidateOutputPath, conflict_code: conflictCode };
  }
  // Every candidate name is taken by something unverified: a real dead end. Refuse rather than overwrite.
  return { ok: false, code: conflictCode, conflict_code: conflictCode, otherListingId };
}

/**
 * submit-on-resume spec section 2 / amendment A4, tightened by the stale or foreign resume guard (S1, S2):
 * called when renderDoc's own EXISTS branch refused to overwrite the file at `outputPath`. The existing file
 * is linked ONLY when it is SAME_LISTING_CURRENT (see classifyExistingFile). In every other case the newly
 * supplied source is rendered to a fresh listing-unique sibling and that is linked (resolveSiblingForListing).
 * Never writes to, modifies, or deletes the existing file; never passes `force`. Without a `source` a
 * non-reusable file refuses outright with its conflict code (EMPTY_DOCX, EXISTS_OTHER_LISTING, or
 * EXISTS_UNVERIFIED). A resume whose content fails the gate at link time throws STALE_RESUME (linkDocument).
 * @param {import('pg').ClientBase} client
 * @param {{ listingId: number, kind: string, outputPath: string, root?: string, applicationId?: number, source?: string, outName?: string, allowMissing?: string[], renderFn?: typeof renderToPath }} input
 * @returns {Promise<{ ok: true, document: { id: number, kind: string, rel_path: string }, application_link: any, reused: boolean, renamed_to?: string, conflict_code?: string } | { ok: false, code: string, conflict_code?: string, otherListingId?: number }>}
 */
export async function reuseExistingDocument(client, input) {
  const root = input.root ?? repoRoot();
  const outputRoot = path.join(root, 'output');
  const absTarget = path.isAbsolute(input.outputPath) ? input.outputPath : path.join(root, input.outputPath);
  const state = await classifyExistingFile(client, outputRoot, absTarget, input.listingId, input.kind);

  if (state.branch === 'DEFAULT') {
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
  description: 'Preflight a resume, cover letter, or cheat sheet markdown (em-dash, en-dash, scare quotes, buzzwords, problem-comparison reframe, resume structure, role inclusion, PMP wording, Jenkon title, output naming) and render the DOCX with the repo converters. Fails closed on any check; returns LOCKED when the DOCX is open in Word. Never opens the file. An optional listingId links the render to that listing\'s application and, for a resume, moves it from drafting to docs_ready. An optional applicationId (requires listingId) scopes that link to one specific application rather than the listing\'s most recent one -- always pass both together in a one-click apply / headless run. reuse_existing re-links an EXISTS DOCX already on disk ONLY when it is already linked to this same listing and (for a resume) still matches the current project index; in every other case (never linked, linked to another listing, empty, unreadable, or stale) it renders the newly supplied source to a fresh listing-unique sibling and links that instead (renamed_to); mutually exclusive with force. A resume that does not match the current project index is refused with code STALE_RESUME (missing names the employers), on every link path including force.',
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
    try {
      return await finishRender(a, deps, result);
    } catch (err) {
      // S3: a resume that fails the content gate at link time is a refusal, not a crash. Headless callers
      // surface it as HEADLESS_ABORT: stale_resume.
      if (err instanceof JobSearchError && err.code === 'STALE_RESUME') {
        return { ...result, ok: false, code: 'STALE_RESUME', message: err.message, hint: err.hint ?? undefined, missing: String(err.details?.missing ?? '') };
      }
      throw err;
    }
  },
};

/**
 * The linking half of the handler, split out so the handler can map a STALE_RESUME throw to a refusal.
 * @param {any} a validated tool args
 * @param {any} deps
 * @param {any} result renderDoc's (or the test seam's) result
 */
async function finishRender(a, deps, result) {
  {
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
  }
}
