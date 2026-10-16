// @ts-check
/**
 * The note as Damian copies it (plan 19.3 and 19.6): salutation and sign-off supplied by code around the four
 * model fields. Pure.
 *
 * The addressee is the contact name when it is a plain name, else the contact role when that is a plain title,
 * else nobody ("Hello,"). The text hash binds the approve call to exactly the text that Preflight returned.
 */
import crypto from 'node:crypto';
import { FIELDS } from './draft-gates.js';

const PLAIN_NAME = /^\p{L}[\p{L}'.\- ]{0,58}$/u;

/**
 * @param {{ contact_name?: unknown, contact_role?: unknown }} t
 * @returns {string|null}
 */
export function addresseeOf(t) {
  for (const v of [t.contact_name, t.contact_role]) {
    if (typeof v !== 'string') continue;
    const s = v.replace(/\s+/g, ' ').trim();
    if (PLAIN_NAME.test(s) && !/\d/.test(s)) return s;
  }
  return null;
}

/**
 * @param {{ hook: string, bridge: string, claim: string, ask: string }} fields
 * @param {string|null} addressee
 * @param {string} signoff
 * @returns {string}
 */
export function composeNote(fields, addressee, signoff) {
  const salutation = addressee ? `Hello ${addressee},` : 'Hello,';
  const bodyText = FIELDS.map((k) => String(/** @type {any} */ (fields)[k]).trim()).join(' ');
  const tail = String(signoff ?? '').trim();
  return [salutation, '', bodyText, ...(tail ? ['', tail] : [])].join('\n');
}

/**
 * @param {{ hook: string, bridge: string, claim: string, ask: string }} fields
 * @param {string|null} addressee
 * @param {string} signoff
 * @returns {string} sha256 hex of the exact note text
 */
export function noteHash(fields, addressee, signoff) {
  return crypto.createHash('sha256').update(composeNote(fields, addressee, signoff), 'utf8').digest('hex');
}

/** @param {unknown} v @param {number} max @returns {string} control characters stripped, whitespace collapsed, cut to max */
export function cleanLabel(v, max) {
  return String(v ?? '').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
