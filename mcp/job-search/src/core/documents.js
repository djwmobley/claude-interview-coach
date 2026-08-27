// @ts-check
/**
 * Linked documents (dashboard PR 1, plan line 58-59, pr1-spec-decisions.md "resolveOutputPath" and
 * "suggestDocuments"). Everything here treats `output/` (the repo-root output directory: resumes,
 * coverletters, cheatsheets, markdown, research, reports) as read-only from this module's point of
 * view -- no PR 1 code path writes a file there from a caller-supplied path. `resolveOutputPath` exists
 * to answer "is this an existing, real file under output/, and what is its canonical relative path" as a
 * total, ordered classification; `suggestDocuments` only ever suggests, never links.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JobSearchError } from './errors.js';
import { recordEvent } from './events.js';

/** The six directories under output/ this module knows about, exact and case-sensitive. */
export const DOCUMENT_DIRS = Object.freeze(['resumes', 'coverletters', 'cheatsheets', 'markdown', 'research', 'reports']);

/** Allowed file extensions, lowercase, matched on path.extname's last-dot semantics. */
export const DOCUMENT_EXTS = Object.freeze(['.docx', '.pdf', '.md', '.html', '.txt']);

/** ic_job_documents.kind CHECK values (sql/009_pipeline_events_documents.sql). */
export const DOCUMENT_KINDS = Object.freeze(['resume', 'coverletter', 'cheatsheet', 'markdown', 'research', 'report', 'other']);

/** DOCUMENT_DIRS entry -> the DOCUMENT_KINDS value listOutputFiles assigns it. */
const KIND_FOR_DIR = Object.freeze({
  resumes: 'resume', coverletters: 'coverletter', cheatsheets: 'cheatsheet', markdown: 'markdown', research: 'research', reports: 'report',
});

/** Total order tiebreak for suggestDocuments (pr1-spec-decisions.md rule 7). */
export const DOC_KIND_PRIORITY = Object.freeze(['resume', 'coverletter', 'cheatsheet', 'markdown', 'research', 'report', 'other']);

// ---------------------------------------------------------------------------------------------------
// resolveOutputPath (pr1-spec-decisions.md): ordered classification, first failing rule wins.
// ---------------------------------------------------------------------------------------------------

/** Backslash, colon, percent, NUL, or any other C0 control code point. */
const BAD_CHAR_RE = /[\\:%\x00-\x1f]/;

/**
 * @typedef {'not_string'|'empty'|'bad_char'|'bad_segment'|'bad_depth'|'bad_dir'|'bad_ext'|'not_found'|'not_file'|'outside_root'} ResolveOutputPathReason
 */

/**
 * Resolve a caller-supplied `<dir>/<file>` path against an existing file under `outputRoot`. For
 * existing files only -- never creates, writes, or renames anything. Ordered classification: the first
 * rule that fails is the reason returned; success rebuilds relPath from the file's actual on-disk
 * casing (via realpathSync.native) so the UNIQUE(listing_id, rel_path) constraint holds on a
 * case-insensitive filesystem.
 * @param {string} outputRoot absolute path to the output/ directory
 * @param {unknown} relPath caller-supplied, untrusted
 * @returns {{ ok: true, relPath: string, absPath: string } | { ok: false, reason: ResolveOutputPathReason }}
 */
export function resolveOutputPath(outputRoot, relPath) {
  if (typeof relPath !== 'string') return { ok: false, reason: 'not_string' };
  const trimmed = relPath.trim();
  if (!trimmed || trimmed !== relPath) return { ok: false, reason: 'empty' };
  if (BAD_CHAR_RE.test(relPath)) return { ok: false, reason: 'bad_char' };
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.endsWith('.') || seg.endsWith(' ')) return { ok: false, reason: 'bad_segment' };
  }
  if (segments.length !== 2) return { ok: false, reason: 'bad_depth' };
  const [dir, file] = segments;
  if (!DOCUMENT_DIRS.includes(dir)) return { ok: false, reason: 'bad_dir' };
  const ext = path.extname(file).toLowerCase();
  if (!DOCUMENT_EXTS.includes(ext)) return { ok: false, reason: 'bad_ext' };
  const absPath = path.join(outputRoot, dir, file);
  /** @type {fs.Stats} */
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not_file' };
  /** @type {string} */
  let realAbs;
  /** @type {string} */
  let realRoot;
  try {
    realAbs = fs.realpathSync.native(absPath);
    realRoot = fs.realpathSync.native(outputRoot);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  const rel = path.relative(realRoot, realAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'outside_root' };
  // Rebuilt from the REAL path's own last two segments (its actual on-disk casing), not from the
  // caller's segments and not from `rel` (which is relative to root and could, in principle, carry more
  // than two segments if outputRoot itself sits behind a junction) -- this is deliberately the real
  // path's own tail, per the decision: "the last two segments of the real path."
  const realSegments = realAbs.split(path.sep).filter(Boolean);
  const canonicalRel = realSegments.slice(-2).join('/');
  return { ok: true, relPath: canonicalRel, absPath: realAbs };
}

// ---------------------------------------------------------------------------------------------------
// listOutputFiles: depth-1 directory scan
// ---------------------------------------------------------------------------------------------------

const DATE_COMPACT_RE = /^(\d{4})(\d{2})(\d{2})-(.+)$/;
const DATE_DASHED_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

/**
 * @param {string} baseName filename without its extension
 * @returns {{ date: string|null, slug: string, humanName: boolean }}
 */
function parseDocumentBaseName(baseName) {
  let m = DATE_DASHED_RE.exec(baseName);
  if (m) return { date: m[1], slug: m[2], humanName: false };
  m = DATE_COMPACT_RE.exec(baseName);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, slug: m[4], humanName: false };
  return { date: null, slug: baseName, humanName: true };
}

/**
 * @typedef {Object} OutputFile
 * @property {string} dir one of DOCUMENT_DIRS
 * @property {string} name filename with extension
 * @property {string} relPath `${dir}/${name}`
 * @property {string} ext lowercase, with leading dot
 * @property {string} kind DOCUMENT_KINDS value for this file's directory
 * @property {string|null} date YYYY-MM-DD parsed from the filename, or null
 * @property {string} slug the filename's non-date portion (or the whole base name for a human-named file)
 * @property {boolean} humanName true when no date prefix was found
 */

/**
 * One depth-1 scan of every DOCUMENT_DIRS subdirectory under outputRoot. Skips Office lock files
 * (`~$...`) and anything whose extension is not in DOCUMENT_EXTS. A missing subdirectory is simply
 * empty, never an error (a fresh checkout may not have every output/ subfolder yet).
 * @param {string} outputRoot
 * @returns {OutputFile[]}
 */
export function listOutputFiles(outputRoot) {
  /** @type {OutputFile[]} */
  const files = [];
  for (const dir of DOCUMENT_DIRS) {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(path.join(outputRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('~$')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!DOCUMENT_EXTS.includes(ext)) continue;
      const baseName = entry.name.slice(0, entry.name.length - ext.length);
      const parsed = parseDocumentBaseName(baseName);
      files.push({ dir, name: entry.name, relPath: `${dir}/${entry.name}`, ext, kind: KIND_FOR_DIR[dir], ...parsed });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------
// suggestDocuments (pr1-spec-decisions.md): never links, only scores and orders.
// ---------------------------------------------------------------------------------------------------

/** Closed, exported, distinct from normalize.js's TITLE_STOPWORDS. */
export const DOC_STOPWORDS = Object.freeze([
  'chief', 'officer', 'director', 'vp', 'vice', 'president', 'executive', 'head', 'senior', 'lead', 'manager',
  'inc', 'llc', 'group', 'corp', 'corporation', 'company', 'worldwide', 'holdings', 'partners',
  'the', 'of', 'and', 'a', 'an', 'for', 'in', 'to', 'at', 'or', 'with', 'on', 'by',
]);
const DOC_STOPWORDS_SET = new Set(DOC_STOPWORDS);

/** @param {unknown} s */
export function tokenize(s) {
  return String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Split a company string on '/', '&', or ' and ' before tokenizing each piece. @param {unknown} s */
function companySegments(s) {
  return String(s ?? '').split(/\/|&| and /gi).map((seg) => seg.trim()).filter(Boolean);
}

/**
 * Company tokens = tokenize(company_norm), segmented on '/'/'&'/' and ' first, union tokens of every
 * alias mapped to that same company_norm, minus DOC_STOPWORDS. No length floor ('e57' counts).
 * @param {string} companyNorm
 * @param {Record<string,string>} aliases alias-key -> canonical company_norm (config/company-aliases.json shape)
 * @returns {Set<string>}
 */
export function companyTokensFor(companyNorm, aliases = {}) {
  /** @type {Set<string>} */
  const set = new Set();
  const addFrom = (/** @type {string} */ str) => {
    for (const seg of companySegments(str)) {
      for (const t of tokenize(seg)) if (!DOC_STOPWORDS_SET.has(t)) set.add(t);
    }
  };
  addFrom(companyNorm);
  for (const [aliasKey, norm] of Object.entries(aliases ?? {})) {
    if (norm === companyNorm) addFrom(aliasKey);
  }
  return set;
}

/** Title tokens = tokenize(title) minus DOC_STOPWORDS, minus tokens shorter than 3 chars. @param {string} title */
export function titleTokensFor(title) {
  return new Set(tokenize(title).filter((t) => !DOC_STOPWORDS_SET.has(t) && t.length >= 3));
}

/** File tokens = tokenize(dir + '/' + name without extension). No stopword removal. @param {OutputFile} file */
function fileTokensFor(file) {
  const baseName = file.name.slice(0, file.name.length - file.ext.length);
  return new Set(tokenize(`${file.dir}/${baseName}`));
}

/**
 * @typedef {Object} DocumentSuggestion
 * @property {string} file relPath of the suggested file
 * @property {number} score companyHits + titleHits
 * @property {number} companyHits
 * @property {number} titleHits
 */

/**
 * Score and order candidate files for one listing. Never links. Candidate iff companyHits >= 1 AND
 * companyHits + titleHits >= 2 (company-only overlap of 1 is never enough; title-only overlap is never
 * enough either). Total order: score desc, titleHits desc, file-date distance to first_seen_at asc
 * (undated files sort last), kind priority, relPath asc.
 *
 * Known, accepted blind spot (pr1-spec-decisions.md): a human-named file ("Damian Mobley - CTO.docx")
 * carries no company tokens and is never suggested. The operator links those by hand from the documents
 * browser; not solved in PR 1.
 * @param {{ title: string, company_norm?: string|null, company?: string|null, first_seen_at?: string|Date|null }} listing
 * @param {OutputFile[]} files
 * @param {{ aliases?: Record<string,string> }} [opts]
 * @returns {DocumentSuggestion[]}
 */
export function suggestDocuments(listing, files, opts = {}) {
  const aliases = opts.aliases ?? {};
  const companyTokens = companyTokensFor(listing.company_norm ?? listing.company ?? '', aliases);
  const titleTokens = titleTokensFor(listing.title ?? '');
  const firstSeen = listing.first_seen_at ? new Date(listing.first_seen_at) : null;
  const firstSeenMs = firstSeen && !Number.isNaN(firstSeen.getTime()) ? firstSeen.getTime() : null;

  const scored = [];
  for (const file of files) {
    const fTokens = fileTokensFor(file);
    let companyHits = 0;
    let titleHits = 0;
    for (const t of fTokens) {
      if (companyTokens.has(t)) companyHits++;
      if (titleTokens.has(t)) titleHits++;
    }
    if (companyHits < 1 || companyHits + titleHits < 2) continue;
    const fileDateMs = file.date ? Date.parse(file.date) : NaN;
    const dateDistance = firstSeenMs !== null && !Number.isNaN(fileDateMs) ? Math.abs(fileDateMs - firstSeenMs) : Number.POSITIVE_INFINITY;
    const kindRank = DOC_KIND_PRIORITY.includes(file.kind) ? DOC_KIND_PRIORITY.indexOf(file.kind) : DOC_KIND_PRIORITY.length;
    scored.push({ file: file.relPath, score: companyHits + titleHits, companyHits, titleHits, dateDistance, kindRank });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.titleHits !== a.titleHits) return b.titleHits - a.titleHits;
    if (a.dateDistance !== b.dateDistance) return a.dateDistance - b.dateDistance;
    if (a.kindRank !== b.kindRank) return a.kindRank - b.kindRank;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  return scored.map(({ file, score, companyHits, titleHits }) => ({ file, score, companyHits, titleHits }));
}

// ---------------------------------------------------------------------------------------------------
// Linked documents (ic_job_documents)
// ---------------------------------------------------------------------------------------------------

const DOC_COLS = 'id, listing_id, kind, rel_path, label, created_at, actor';

/**
 * Link an existing output/ file to a listing. Always re-resolves relPath against the filesystem (via
 * resolveOutputPath) rather than trusting a caller-supplied canonical string, so a stale or hand-edited
 * rel_path can never be stored: the only relPath that ever reaches the INSERT is the one
 * resolveOutputPath itself just produced from a real, existing file.
 * @param {import('pg').ClientBase} client
 * @param {string} outputRoot
 * @param {{ listingId: number, relPath: string, kind: string, label?: string|null, actor?: 'dashboard'|'mcp'|'cli'|'migration'|'seed' }} input
 */
export async function linkDocument(client, outputRoot, input) {
  const resolved = resolveOutputPath(outputRoot, input.relPath);
  if (!resolved.ok) throw new JobSearchError('VALIDATION', `cannot link document: ${resolved.reason}`, { details: { reason: resolved.reason } });
  if (!DOCUMENT_KINDS.includes(input.kind)) throw new JobSearchError('VALIDATION', `document kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
  const actor = input.actor ?? 'mcp';
  // `xmax = 0` is the standard upsert idiom for "this RETURNING row came from the INSERT branch, not the
  // ON CONFLICT DO UPDATE branch" (a freshly inserted row has no prior deleting transaction id). Only the
  // insert branch records a document event, so re-linking the same (listing, rel_path) pair -- e.g. a
  // repeated seed run -- never accumulates duplicate audit events for a call that changed nothing new.
  const r = await client.query(
    `INSERT INTO ic_job_documents (listing_id, kind, rel_path, label, actor) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (listing_id, rel_path) DO UPDATE SET kind = EXCLUDED.kind, label = EXCLUDED.label
     RETURNING ${DOC_COLS}, (xmax = 0) AS inserted`,
    [input.listingId, input.kind, resolved.relPath, input.label ?? null, actor],
  );
  const { inserted, ...row } = r.rows[0];
  if (inserted) {
    await recordEvent(client, { listingId: input.listingId, kind: 'document', note: `linked ${resolved.relPath}`, actor });
  }
  return row;
}

/**
 * @param {import('pg').ClientBase} client
 * @param {{ id: number, actor?: 'dashboard'|'mcp'|'cli'|'migration'|'seed' }} input
 */
export async function unlinkDocument(client, input) {
  const r = await client.query(`DELETE FROM ic_job_documents WHERE id = $1 RETURNING listing_id, rel_path`, [input.id]);
  if (r.rowCount === 0) throw new JobSearchError('NOT_FOUND', `document ${input.id} not found`);
  const row = r.rows[0];
  const actor = input.actor ?? 'mcp';
  await recordEvent(client, { listingId: row.listing_id, kind: 'document', note: `unlinked ${row.rel_path}`, actor });
  return { id: input.id, listing_id: Number(row.listing_id) };
}

/**
 * @param {import('pg').ClientBase} client
 * @param {number} listingId
 */
export async function listDocuments(client, listingId) {
  const r = await client.query(`SELECT ${DOC_COLS} FROM ic_job_documents WHERE listing_id = $1 ORDER BY created_at ASC, id ASC`, [listingId]);
  return r.rows;
}
