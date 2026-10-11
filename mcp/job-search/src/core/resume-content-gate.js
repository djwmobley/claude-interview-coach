// @ts-check
/**
 * Resume content gate (stale or foreign resume guard).
 *
 * A resume DOCX may only be linked to a listing, and only be uploaded by the unattended submit, when its
 * text still matches the CURRENT data/project-index.md: every indexed employer appears in the first field
 * of some company line, and every indexed current role (Period ends in "present") has a company line whose
 * last field says "Present". Otherwise it is stale or foreign (a hand-made file, a months-old render) and
 * the caller refuses with STALE_RESUME.
 *
 * evaluateResumeContent() is a pure function of (docx text, project-index text). Everything else here only
 * reads files and never writes or deletes any of them. The classification is total: every unreadable,
 * unparseable, or empty input is a FAIL, never "not applicable".
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { repoRoot } from './config.js';
import { parseProjectIndexCompanies } from './render.js';

/**
 * @typedef {Object} ContentVerdict
 * @property {boolean} ok
 * @property {string[]} missing employers (index spelling) that failed a rule
 * @property {string|null} reason null when ok, else a short human-readable cause
 */

// ---------------------------------------------------------------------------------------------------
// Minimal DOCX text extraction (zip central directory + inflateRaw; no dependency)
// ---------------------------------------------------------------------------------------------------

/**
 * Read one entry of a zip archive held in memory. Stored (0) and deflate (8) only; zip64 is not supported
 * (a resume is never that large) and fails closed by throwing.
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer}
 */
export function readZipEntry(buf, name) {
  const minEocd = 22;
  if (buf.length < minEocd) throw new Error('not a zip: too short');
  let eocd = -1;
  const lowest = Math.max(0, buf.length - minEocd - 0xffff);
  for (let i = buf.length - minEocd; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('corrupt zip local header');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (data.length !== compSize) throw new Error('truncated zip entry');
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`unsupported zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip has no entry ${name}`);
}

/** @param {string} s */
function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Plain text of a DOCX, one line per paragraph. Throws on anything that is not a readable DOCX.
 * @param {Buffer} buf
 * @returns {string}
 */
export function docxToText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  if (!/<w:document[\s>]/.test(xml)) throw new Error('word/document.xml is not a WordprocessingML document');
  const paragraphs = xml.split(/<\/w:p>/);
  const lines = [];
  for (const para of paragraphs) {
    let text = '';
    for (const m of para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
      if (m[0].startsWith('<w:tab')) text += ' ';
      else if (m[0].startsWith('<w:br')) text += '\n';
      else text += decodeXmlEntities(m[1] ?? '');
    }
    if (!text) continue; // blank paragraphs and the tail after the last paragraph carry no text
    for (const l of text.split('\n')) lines.push(l);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// The pure gate
// ---------------------------------------------------------------------------------------------------

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive containment. A "word" boundary is any non-letter, non-digit (unicode aware),
 * so "Ace" does not match "Acetech" and "Monat" matches "MONAT Global".
 * @param {string} hay
 * @param {string} needle
 */
export function containsWholeWord(hay, needle) {
  const n = needle.trim();
  if (!n) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'iu').test(hay);
}

/**
 * Index entries: one per `**Client:**` line, with the Period of its `## ` block (blocks are found by
 * heading, not by position, so reordering fields inside a block cannot detach a Period from its Client).
 * @param {string} indexText
 * @returns {Array<{ client: string, current: boolean }>}
 */
export function parseIndexEntries(indexText) {
  const blocks = indexText.split(/^##\s/m);
  const entries = [];
  const seen = new Set();
  for (const block of blocks) {
    const clients = parseProjectIndexCompanies(block);
    if (clients.length === 0) continue;
    const pm = block.match(/^\s*-\s*\*\*Period:\*\*\s*(.+?)\s*$/m);
    const period = pm ? pm[1] : '';
    const current = /present[\s*_.)]*$/i.test(period);
    for (const client of clients) {
      const key = client.toLowerCase();
      const existing = seen.has(key);
      if (existing) {
        const prior = entries.find((e) => e.client.toLowerCase() === key);
        if (prior && current) prior.current = true;
        continue;
      }
      seen.add(key);
      entries.push({ client, current });
    }
  }
  return entries;
}

/**
 * Company lines of a resume's text, found by pattern: at least two " | " separated fields (any run of
 * whitespace around the pipe, the converter pads it with two spaces), last field containing a 4-digit year.
 * @param {string} docxText
 * @returns {string[][]} fields per company line
 */
export function findCompanyLines(docxText) {
  const out = [];
  for (const raw of docxText.split(/\r?\n/)) {
    const fields = raw.split(/\s+\|\s+/).map((f) => f.trim());
    if (fields.length < 2) continue;
    if (!/(?<!\d)\d{4}(?!\d)/.test(fields[fields.length - 1])) continue;
    out.push(fields);
  }
  return out;
}

/**
 * @param {string} docxText
 * @param {string} indexText
 * @returns {ContentVerdict}
 */
export function evaluateResumeContent(docxText, indexText) {
  if (typeof docxText !== 'string' || !docxText.trim()) return { ok: false, missing: [], reason: 'the resume has no readable text' };
  if (typeof indexText !== 'string') return { ok: false, missing: [], reason: 'the project index is not readable' };
  const entries = parseIndexEntries(indexText);
  if (entries.length === 0) return { ok: false, missing: [], reason: 'the project index lists no employers' };
  const lines = findCompanyLines(docxText);
  if (lines.length === 0) return { ok: false, missing: entries.map((e) => e.client), reason: 'the resume has no company lines' };

  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const notCurrent = [];
  for (const e of entries) {
    const matching = lines.filter((f) => containsWholeWord(f[0], e.client));
    if (matching.length === 0) {
      missing.push(e.client);
      continue;
    }
    if (e.current && !matching.some((f) => /present/i.test(f[f.length - 1]))) notCurrent.push(e.client);
  }
  if (missing.length === 0 && notCurrent.length === 0) return { ok: true, missing: [], reason: null };
  const parts = [];
  if (missing.length) parts.push(`missing employers: ${missing.join(', ')}`);
  if (notCurrent.length) parts.push(`current role not marked Present: ${notCurrent.join(', ')}`);
  return { ok: false, missing: [...missing, ...notCurrent], reason: parts.join('; ') };
}

// ---------------------------------------------------------------------------------------------------
// File-level wrappers (read only)
// ---------------------------------------------------------------------------------------------------

/** @returns {string} */
export function defaultProjectIndexPath() {
  return path.join(repoRoot(), 'data', 'project-index.md');
}

/**
 * Gate one DOCX file against the CURRENT project index (read fresh on every call; nothing is cached).
 * Never throws and never writes.
 * @param {string} absPath
 * @param {string} [indexPath]
 * @returns {ContentVerdict}
 */
export function checkResumeFile(absPath, indexPath = defaultProjectIndexPath()) {
  try {
    const hooks = gateHooks.resumeGate;
    if (hooks) return hooks(absPath);
    const indexText = fs.readFileSync(indexPath, 'utf8');
    const text = docxToText(fs.readFileSync(absPath));
    return evaluateResumeContent(text, indexText);
  } catch (err) {
    return { ok: false, missing: [], reason: `the resume or project index could not be read (${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'})` };
  }
}

/**
 * Is `absPath` a readable, non-empty DOCX? (Used for the reuse decision of non-resume kinds.) Never throws.
 * @param {string} absPath
 * @returns {boolean}
 */
export function isValidDocxFile(absPath) {
  try {
    if (gateHooks.docxValid) return gateHooks.docxValid(absPath);
    docxToText(fs.readFileSync(absPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Test-only seam: lets a test file whose fixtures are fake bytes substitute the file-level gate. Production
 * never calls this. Pass null to restore the real gate.
 * @type {{ resumeGate: ((absPath: string) => ContentVerdict) | null, docxValid: ((absPath: string) => boolean) | null }}
 */
const gateHooks = { resumeGate: null, docxValid: null };

/** @param {{ resumeGate?: ((absPath: string) => ContentVerdict) | null, docxValid?: ((absPath: string) => boolean) | null } | null} h */
export function setGateHooksForTests(h) {
  gateHooks.resumeGate = h?.resumeGate ?? null;
  gateHooks.docxValid = h?.docxValid ?? null;
}
