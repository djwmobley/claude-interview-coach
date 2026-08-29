// @ts-check
/**
 * Minimal ZIP reader for DOCX inspection in tests (docx-output.test.js).
 * A .docx is a ZIP archive; this parses the End Of Central Directory record,
 * walks the central directory for each entry's local-header offset (the
 * central directory's extra-field length can differ from the local header's,
 * so the data start must be computed from the local header, not the central
 * directory record), and inflates the entry with node:zlib. Supports STORED
 * (0) and DEFLATE (8), the only methods python-docx or Word ever produce.
 * No new npm dependency.
 */
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** @param {Buffer} buf @returns {number} */
function findEOCD(buf) {
  const maxCommentLen = 65535;
  const minPos = Math.max(0, buf.length - 22 - maxCommentLen);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file (End Of Central Directory record not found)');
}

/**
 * @typedef {{ offset: number, compressedSize: number, uncompressedSize: number, method: number }} ZipEntry
 */

/**
 * @param {Buffer} buf a whole .docx (or any .zip) file's bytes
 * @returns {Map<string, ZipEntry>}
 */
export function listZipEntries(buf) {
  const eocdOffset = findEOCD(buf);
  const cdEntryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  /** @type {Map<string, ZipEntry>} */
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < cdEntryCount; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error(`central directory entry ${i} has a bad signature`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { offset: localHeaderOffset, compressedSize, uncompressedSize, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * @param {Buffer} buf
 * @param {string} entryName e.g. 'word/document.xml'
 * @returns {Buffer}
 */
export function readZipEntry(buf, entryName) {
  const entries = listZipEntries(buf);
  const entry = entries.get(entryName);
  if (!entry) throw new Error(`zip entry not found: ${entryName}`);
  if (buf.readUInt32LE(entry.offset) !== LFH_SIG) throw new Error(`local file header for ${entryName} has a bad signature`);
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const dataStart = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entryName}`);
}

/**
 * @param {Buffer} buf
 * @param {string} entryName
 * @returns {string} utf8 text
 */
export function readZipEntryText(buf, entryName) {
  return readZipEntry(buf, entryName).toString('utf8');
}
