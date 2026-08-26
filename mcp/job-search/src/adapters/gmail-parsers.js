// @ts-check
/**
 * Per-sender Gmail job-alert parsers (spec: gmail-adapter-brief.md). Pure
 * functions (body, now) -> RawListing[]; no network, no ctx. gmail.js
 * dispatches on the exact From address via config/alert-senders.json and
 * wraps every call so a throw here becomes PARSE_ERROR for that message,
 * never a crash of the whole source (R4).
 *
 * Input shape per parser (PARSER_INPUT): 'text' parsers receive the
 * decoded text/plain body (or text/html run through normalize.htmlToText
 * when no text/plain part exists); 'html' parsers receive the decoded
 * text/html body directly and use cheerio, chosen per sender because the
 * captured real emails showed a more stable structure there than the
 * regex-hostile plaintext (Lensa's plaintext is a markdown-style dump with
 * multi-line tracking links; Ladders ships no text/plain part at all).
 */
import * as cheerio from 'cheerio';
import { rawListing, relativeDate, isoDate } from './base.js';
import { sha1, normalizeTitle, normalizeCompany, normalizeLocation, stripZeroWidth } from '../core/normalize.js';

/**
 * Identity hash for senders whose link carries no stable id (R5): sha1 of
 * the NORMALIZED title/company/location, so a re-sent alert with the same
 * normalized fields collapses to the same externalId. Callers prefix the
 * result with `${parserName}:`; normalizeListing prefixes that again with
 * `gmail:` because raw.source is always 'gmail'.
 * @param {string} title
 * @param {string} company
 * @param {string|null} location
 */
export function identityHash(title, company, location) {
  const t = normalizeTitle(title).title_norm;
  const c = normalizeCompany(company).company_norm;
  const l = normalizeLocation(location ?? null).location_norm;
  return sha1(`${t}|${c}|${l}`);
}

/** Which body the sender's parser wants: the decoded text/plain (or its html-to-text fallback) or the raw text/html. */
export const PARSER_INPUT = Object.freeze({
  linkedin: 'text',
  'indeed-alert': 'text',
  'indeed-match': 'text',
  lensa: 'html',
  ladders: 'html',
});

// ---------------------------------------------------------------------------
// LinkedIn (jobalerts-noreply@linkedin.com, jobs-noreply@linkedin.com)
// ---------------------------------------------------------------------------

/** Per-card lines that are not part of title/company/location; skip while walking backward from "View job:". */
const LINKEDIN_BADGE_RE = /^(top applicant|apply with resume\s*&\s*profile|this company is actively hiring|\d+\+?\s*connections?)$/i;
const LINKEDIN_ID_RE = /\/jobs\/view\/(\d{6,})(?:[/?]|$)/;

/**
 * @param {string} text decoded text/plain body
 * @param {Date} now message internal date, used as postedAt (LinkedIn digests give no per-job date)
 * @returns {import('../core/normalize.js').RawListing[]}
 */
export function parseLinkedin(text, now) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  /** @type {import('../core/normalize.js').RawListing[]} */
  const listings = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^View job:\s*(https?:\/\/\S+)/i.exec(lines[i]);
    if (!m) continue;
    const idm = LINKEDIN_ID_RE.exec(m[1]);
    if (!idm) continue;
    // Walk backward collecting the last 3 non-blank, non-badge lines directly above "View job:": location, company, title.
    /** @type {string[]} */
    const collected = [];
    for (let j = i - 1; j >= 0 && collected.length < 3; j--) {
      const l = lines[j];
      if (!l || LINKEDIN_BADGE_RE.test(l)) continue;
      collected.push(l);
    }
    if (collected.length < 3) continue;
    const [location, company, title] = collected;
    listings.push(rawListing({
      source: 'gmail',
      externalId: null,
      url: `https://www.linkedin.com/jobs/view/${idm[1]}`,
      title,
      company,
      location,
      postedAt: isoDate(now),
    }));
  }
  return listings;
}

// ---------------------------------------------------------------------------
// Indeed job alert digest (donotreply@jobalert.indeed.com)
// ---------------------------------------------------------------------------

const INDEED_SALARY_RE = /\$[\d,]+(?:\.\d+)?\s*-\s*\$[\d,]+(?:\.\d+)?\s*(?:a year|an hour|\/\s*(?:year|hour|hr|yr))?/i;
const INDEED_RELATIVE_DATE_RE = /^(today|just posted|yesterday|\d+\+?\s*(day|hour|minute|week|month)s?\s*ago)$/i;
/** Real captured links are /rc/clk/dl?jk=... or /pagead/clk?jk=...; jk is read from the query string regardless of exact path shape. */
const INDEED_CLICK_URL_RE = /^https?:\/\/(?:www\.)?indeed\.com\/(?:rc|pagead)\/clk/i;

/**
 * @param {string} text decoded text/plain body
 * @param {Date} now
 * @returns {import('../core/normalize.js').RawListing[]}
 */
export function parseIndeedAlert(text, now) {
  const lines = stripZeroWidth(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  /** @type {import('../core/normalize.js').RawListing[]} */
  const listings = [];
  for (let i = 0; i < lines.length; i++) {
    if (!INDEED_CLICK_URL_RE.test(lines[i])) continue;
    /** @type {string|null} */
    let jk = null;
    try {
      jk = new URL(lines[i]).searchParams.get('jk');
    } catch {
      jk = null;
    }
    if (!jk || !/^[0-9a-f]{8,}$/i.test(jk)) continue;
    // Walk backward to the previous blank line or previous click-link line, collecting the block in order.
    /** @type {string[]} */
    const block = [];
    for (let j = i - 1; j >= 0; j--) {
      if (!lines[j] || INDEED_CLICK_URL_RE.test(lines[j])) break;
      block.unshift(lines[j]);
    }
    if (block.length < 2) continue;
    const title = block[0];
    const companyLoc = block[1];
    const sep = companyLoc.indexOf(' - ');
    const company = sep === -1 ? companyLoc : companyLoc.slice(0, sep).trim();
    const location = sep === -1 ? null : companyLoc.slice(sep + 3).trim();
    if (!title || !company) continue;
    /** @type {string|null} */
    let salaryRaw = null;
    /** @type {string|null} */
    let postedRaw = null;
    for (const l of block.slice(2)) {
      if (!salaryRaw && INDEED_SALARY_RE.test(l)) salaryRaw = l;
      else if (!postedRaw && INDEED_RELATIVE_DATE_RE.test(l)) postedRaw = l;
    }
    const postedAt = postedRaw ? relativeDate(postedRaw, now) ?? isoDate(now) : isoDate(now);
    listings.push(rawListing({
      source: 'gmail',
      externalId: null,
      url: `https://www.indeed.com/viewjob?jk=${jk.toLowerCase()}`,
      title,
      company,
      location,
      salaryRaw,
      postedAt,
    }));
  }
  return listings;
}

// ---------------------------------------------------------------------------
// Indeed personalized match email (donotreply@match.indeed.com)
// ---------------------------------------------------------------------------

/**
 * @param {string} text decoded text/plain body
 * @param {Date} now
 * @returns {import('../core/normalize.js').RawListing[]}
 */
export function parseIndeedMatch(text, now) {
  const lines = stripZeroWidth(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const anchorIdx = lines.findIndex((l) => /^Benefits:$/i.test(l) || /^View job:/i.test(l));
  if (anchorIdx === -1) return [];
  /** @type {string[]} */
  const collected = [];
  for (let j = anchorIdx - 1; j >= 0 && collected.length < 3; j--) {
    if (!lines[j]) continue;
    collected.push(lines[j]);
  }
  if (collected.length < 3) return [];
  const [location, company, title] = collected;
  if (!title || !company) return [];
  const salLineIdx = lines.findIndex((l) => /^Minimum base pay:/i.test(l));
  /** @type {string|null} */
  let salaryRaw = null;
  if (salLineIdx !== -1) {
    const raw = lines[salLineIdx].replace(/^Minimum base pay:\s*/i, '');
    const stripped = raw.split(/\s*-\s*https?:\/\//i)[0].trim();
    if (stripped) salaryRaw = stripped;
  }
  const viewJobLine = lines.find((l) => /^View job:\s*https?:\/\//i.test(l));
  const url = viewJobLine ? viewJobLine.replace(/^View job:\s*/i, '').trim() : null;
  return [
    rawListing({
      source: 'gmail',
      externalId: `indeed-mail:${identityHash(title, company, location)}`,
      url,
      title,
      company,
      location,
      salaryRaw,
      postedAt: isoDate(now),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Lensa (jobalert@lensa.com, aggregated@lensa.com, lensa24@lensa.com)
// ---------------------------------------------------------------------------

const LENSA_SALARY_RE = /\$[\d,]+K?\s*-\s*\$[\d,]+K?\s*\/\s*yr\.?/i;

/**
 * Every job card is one `<a href="…lensa.com/ls/click…">` wrapping a table
 * whose direct `<tr>` rows are, in order: company+title (a nested 2-row
 * table), salary (a `<div>`), an OPTIONAL location/posted-date row (a
 * nested table with one or two cells), and a flags row (`<span>` elements
 * joined by literal "•" separators, e.g. "New", "Full-Time", "Remote").
 * The location row is skipped entirely on some cards (remote-only postings
 * with no city), so classification is by row STRUCTURE (does this row
 * contain a `<span>`? a nested `<table>`?), never by counting text items in
 * a flattened list -- a flattened list cannot tell "no location, flags
 * start immediately" apart from "location is the single word 'Full-Time'".
 * @param {string} html decoded text/html body
 * @param {Date} now
 * @returns {import('../core/normalize.js').RawListing[]}
 */
export function parseLensa(html, now) {
  const $ = cheerio.load(String(html ?? ''));
  /** @type {import('../core/normalize.js').RawListing[]} */
  const listings = [];
  $('a[href]').each((_i, el) => {
    const $a = $(el);
    const href = String($a.attr('href') ?? '');
    /** @type {URL} */
    let u;
    try {
      u = new URL(href);
    } catch {
      return;
    }
    if (!u.hostname.toLowerCase().endsWith('lensa.com') || !u.pathname.startsWith('/ls/click')) return;
    const outerTable = $a.find('table').first();
    if (outerTable.length === 0) return;
    let rows = outerTable.children('tbody').children('tr');
    if (rows.length === 0) rows = outerTable.children('tr');
    if (rows.length < 2) return; // not a job card (nav / unsubscribe / "edit settings" links)

    const cardTable = rows.eq(0).find('table').first();
    let cardRows = cardTable.children('tbody').children('tr');
    if (cardRows.length === 0) cardRows = cardTable.children('tr');
    if (cardRows.length < 2) return;
    const company = cardRows.eq(0).find('td').last().text().replace(/\s+/g, ' ').trim();
    const title = cardRows.eq(1).find('td').first().text().replace(/\s+/g, ' ').trim();
    if (!company || !title) return;

    /** @type {string|null} */
    let salaryRaw = null;
    /** @type {string|null} */
    let location = null;
    /** @type {string|null} */
    let postedRaw = null;
    let flagsText = '';
    for (let i = 1; i < rows.length; i++) {
      const row = rows.eq(i);
      if (row.find('span').length > 0) {
        flagsText = row.text().replace(/\s+/g, ' ').trim();
        continue;
      }
      if (row.find('table').length > 0) {
        const cellTexts = row.find('table td').map((_j, c) => $(c).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
        let ti = 0;
        if (cellTexts[ti] && !/^posted\b/i.test(cellTexts[ti])) {
          location = cellTexts[ti].replace(/\s*[•|]\s*$/, '').trim();
          ti++;
        }
        if (cellTexts[ti] && /^posted\b/i.test(cellTexts[ti])) postedRaw = cellTexts[ti];
        continue;
      }
      const rowText = row.text().replace(/\s+/g, ' ').trim();
      if (rowText && LENSA_SALARY_RE.test(rowText)) salaryRaw = rowText;
    }
    const remote = /\bremote\b/i.test(flagsText) || /\bremote\b/i.test(location ?? '');
    const postedAt = postedRaw ? relativeDate(postedRaw.replace(/^posted\s*/i, ''), now) ?? isoDate(now) : isoDate(now);
    listings.push(rawListing({
      source: 'gmail',
      externalId: `lensa:${identityHash(title, company, location)}`,
      url: href,
      title,
      company,
      location,
      remoteMode: remote ? 'remote' : null,
      remoteDeclared: remote,
      salaryRaw,
      postedAt,
    }));
  });
  return listings;
}

// ---------------------------------------------------------------------------
// Ladders (jobs@my.theladders.com)
// ---------------------------------------------------------------------------

/**
 * @param {string} html decoded text/html body (Ladders ships no text/plain part)
 * @param {Date} now
 * @returns {import('../core/normalize.js').RawListing[]}
 */
export function parseLadders(html, now) {
  const $ = cheerio.load(String(html ?? ''));
  /** @type {import('../core/normalize.js').RawListing[]} */
  const listings = [];
  // The company/location/salary line is rendered as `<span id="jobs-company-container">Company&nbsp;&nbsp;|&nbsp;&nbsp;City, ST&nbsp;&nbsp;|&nbsp;&nbsp;$Min - $Max*</span>`.
  // The id repeats once per job card (real captured markup, not unique per the HTML spec); cheerio's
  // attribute selector matches every occurrence, not just the first (unlike DOM getElementById).
  $('[id="jobs-company-container"]').each((_i, el) => {
    const $span = $(el);
    const text = $span.text().replace(/\s+/g, ' ').trim();
    const parts = text.split('|').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return;
    const company = parts[0];
    const location = parts.length >= 3 ? parts[1] : null;
    const salaryPart = parts[parts.length - 1];
    // Title sits in the previous row's link (no per-job "view" link separate from the title itself).
    const prevTr = $span.closest('tr').prev('tr');
    const title = prevTr.find('a').first().text().replace(/\s+/g, ' ').trim();
    if (!title || !company) return;
    const salaryRaw = /\$/.test(salaryPart) ? salaryPart.replace(/\*+$/, '').trim() : null;
    listings.push(rawListing({
      source: 'gmail',
      externalId: `ladders:${identityHash(title, company, location)}`,
      url: null,
      title,
      company,
      location,
      salaryRaw,
      postedAt: isoDate(now),
    }));
  });
  return listings;
}

/** @type {Readonly<Record<string, (body: string, now: Date) => import('../core/normalize.js').RawListing[]>>} */
export const PARSERS = Object.freeze({
  linkedin: parseLinkedin,
  'indeed-alert': parseIndeedAlert,
  'indeed-match': parseIndeedMatch,
  lensa: parseLensa,
  ladders: parseLadders,
});
