// @ts-check
/**
 * Body decoding for the personal mail intake (sql/029). Pure: no network, no DB.
 *
 * decodeMessageBody walks a Gmail payload recursively (any depth of multipart), prefers the first text/plain
 * leaf, falls back to the first text/html leaf stripped to text, and returns at most 4 KB of text. Each leaf
 * is decoded in the order the wire format applies: Gmail's base64url transport, the part's own
 * Content-Transfer-Encoding when it is still visible in the data (quoted-printable, base64), then the part's
 * charset. The Gmail API normally hands back parts with the transfer encoding already removed, so a second
 * decode is applied ONLY when the text still looks like that encoding; plain text containing a literal "=41"
 * is rare enough that this is the right trade.
 *
 * Total: every input maps to a result. A decode error or an empty result is `unreadable: true` with an empty
 * `text`; the caller falls back to subject plus snippet and flags body_unreadable (never silently unsorted).
 */
import { htmlToText } from './normalize.js';

/** Hard cap on decoded body text, applied after decoding. */
export const BODY_MAX_CHARS = 4096;

/**
 * @param {any} part
 * @param {string} name
 * @returns {string|null}
 */
function partHeader(part, name) {
  const headers = part && Array.isArray(part.headers) ? part.headers : [];
  const h = headers.find((/** @type {any} */ x) => String(x && x.name).toLowerCase() === name.toLowerCase());
  return h && typeof h.value === 'string' ? h.value : null;
}

/**
 * Charset parameter of a Content-Type value, lowercased, or null.
 * @param {string|null} contentType
 */
export function charsetOf(contentType) {
  if (!contentType) return null;
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Quoted-printable bytes -> Buffer (soft line breaks removed, =XX decoded).
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function decodeQuotedPrintable(buf) {
  const s = buf.toString('latin1').replace(/=\r?\n/g, '');
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

/**
 * Bytes -> string in `charset`; an unknown or unsupported charset falls back to utf-8 (never throws on that).
 * @param {Buffer} buf
 * @param {string|null} charset
 */
export function decodeCharset(buf, charset) {
  const name = (charset || 'utf-8').replace(/^"|"$/g, '');
  try {
    return new TextDecoder(name).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** @param {string} s */
function looksQuotedPrintable(s) {
  return /=\r?\n/.test(s) || /=[0-9A-F]{2}/.test(s);
}

/** @param {string} s */
function looksBase64(s) {
  const t = s.replace(/\s+/g, '');
  return t.length >= 16 && t.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t);
}

/**
 * Decode one leaf's body.data to text. Throws on malformed input (the caller turns that into unreadable).
 * @param {any} part
 * @returns {string}
 */
function decodeLeaf(part) {
  const data = part && part.body && part.body.data;
  if (typeof data !== 'string' || data === '') return '';
  if (!/^[A-Za-z0-9_\-+/=\s]+$/.test(data)) throw new Error('body data is not base64url');
  let bytes = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const cte = (partHeader(part, 'Content-Transfer-Encoding') || '').trim().toLowerCase();
  if (cte === 'quoted-printable' && looksQuotedPrintable(bytes.toString('latin1'))) {
    bytes = decodeQuotedPrintable(bytes);
  } else if (cte === 'base64' && looksBase64(bytes.toString('latin1'))) {
    bytes = Buffer.from(bytes.toString('latin1').replace(/\s+/g, ''), 'base64');
  }
  return decodeCharset(bytes, charsetOf(partHeader(part, 'Content-Type')));
}

/**
 * Walk the payload tree, collecting the first text/plain leaf, the first text/html leaf, and whether any
 * text/calendar part exists. Decode errors on a leaf are recorded, not thrown.
 * @param {any} part
 * @param {{ text: string|null, html: string|null, calendar: boolean, errors: number }} out
 * @param {number} [depth]
 */
function walk(part, out, depth = 0) {
  if (!part || typeof part !== 'object' || depth > 20) return;
  const mime = String(part.mimeType || '').toLowerCase();
  if (mime === 'text/calendar') out.calendar = true;
  if ((mime === 'text/plain' && out.text === null) || (mime === 'text/html' && out.html === null)) {
    try {
      const t = decodeLeaf(part);
      if (mime === 'text/plain') out.text = t;
      else out.html = t;
    } catch {
      out.errors++;
    }
  }
  if (Array.isArray(part.parts)) for (const p of part.parts) walk(p, out, depth + 1);
}

/**
 * @param {any} payload Gmail message payload (format=full)
 * @returns {{ text: string, source: 'plain'|'html'|'none', unreadable: boolean, calendar: boolean }}
 */
export function decodeMessageBody(payload) {
  /** @type {{ text: string|null, html: string|null, calendar: boolean, errors: number }} */
  const out = { text: null, html: null, calendar: false, errors: 0 };
  try {
    walk(payload, out);
    // A single-part message carries its body on the payload itself (no parts array).
    if (out.text === null && out.html === null && payload && !Array.isArray(payload.parts) && payload.body && payload.body.data) {
      const mime = String(payload.mimeType || 'text/plain').toLowerCase();
      const t = decodeLeaf(payload);
      if (mime === 'text/html') out.html = t;
      else out.text = t;
    }
  } catch {
    out.errors++;
  }
  let text = '';
  /** @type {'plain'|'html'|'none'} */
  let source = 'none';
  if (out.text !== null && out.text.trim() !== '') {
    text = out.text;
    source = 'plain';
  } else if (out.html !== null && out.html.trim() !== '') {
    text = htmlToText(out.html);
    source = 'html';
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t\f\v]+/g, ' ').replace(/\n[ ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > BODY_MAX_CHARS) text = text.slice(0, BODY_MAX_CHARS);
  const unreadable = text === '';
  return { text, source: unreadable ? 'none' : source, unreadable, calendar: out.calendar };
}
