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
import zlib from 'node:zlib';
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

/**
 * @typedef {Object} ParseResult one message's parse (unblock-auto-apply Gmail addendum, common contract)
 * @property {import('../core/normalize.js').RawListing[]} listings deduped within the message
 * @property {number} markers job-link occurrences by the sender's own job-link predicate, counted
 *   independently of (and more loosely than) the card grammar: "did this mail contain jobs at all"
 * @property {number} incomplete cards whose job link matched but whose fields could not be extracted
 * @property {Record<string, number>} dropped named, counted drops (never silent): card_misaligned,
 *   company_incomplete, cta_anchor, ...
 */

/**
 * @typedef {Object} ParseCtx
 * @property {string|null} [html] the message's text/html part, for parsers that cross-check text cards
 *   against the HTML anchors (LinkedIn, B5)
 * @property {{ company?: string }|null} [sender] the alert-senders.json entry (jobs2web reads `company`)
 */

/** Visible anchor texts that are calls to action, never job cards (addendum B3). */
export const CTA_TEXT_RE = /^(apply( now)?|easy apply|apply with ai|unsubscribe|manage (job )?alerts?|edit settings|view all( jobs)?|see all jobs)\b/i;

/**
 * A title with a trailing work-mode suffix removed ("(Remote)", "[Hybrid]", " - Remote"), for identity only
 * (addendum B9).
 * @param {string} title
 */
export function stripModeSuffix(title) {
  return String(title ?? '')
    .replace(/\s*[([]\s*(?:remote|hybrid|on-?site)[^)\]]*[)\]]\s*$/i, '')
    .replace(/\s*[-|]\s*(?:remote|hybrid|on-?site)\s*$/i, '')
    .trim();
}

/**
 * Identity from an order-independent job token found in the card's own link plus the mode-stripped
 * normalized title (addendum B9). Callers fall back to identityHash when the card carries no token.
 * @param {string} token
 * @param {string} title
 */
export function tokenIdentity(token, title) {
  return sha1(`${token}|${normalizeTitle(stripModeSuffix(title)).title_norm}`);
}

/** @returns {ParseResult} */
function emptyResult() {
  return { listings: [], markers: 0, incomplete: 0, dropped: {} };
}

/** @param {ParseResult} r @param {string} reason */
function drop(r, reason) {
  r.dropped[reason] = (r.dropped[reason] ?? 0) + 1;
}

/** @param {string} s */
function squashSpace(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// LinkedIn (jobalerts-noreply@linkedin.com, jobs-noreply@linkedin.com), version 2
// ---------------------------------------------------------------------------

const LINKEDIN_ID_RE = /\/jobs\/view\/(\d{6,})(?:[/?]|$)/;
/** Card boundaries: a dashed rule, the "N new jobs match" / "A new job matches" line, or a bare URL line. */
const LINKEDIN_BOUNDARY_RE = /^(?:-{10,}|(?:\d+\+?|a)\s+new jobs? match.*|https?:\/\/\S+)$/i;

/**
 * Job id -> visible texts of the HTML anchors linking to that job, for the B5 alignment check.
 * @param {string|null|undefined} html
 * @returns {Map<string, string[]>}
 */
function linkedinAnchorTexts(html) {
  /** @type {Map<string, string[]>} */
  const out = new Map();
  if (!html) return out;
  const $ = cheerio.load(String(html));
  $('a[href*="/jobs/view/"]').each((_i, el) => {
    const m = LINKEDIN_ID_RE.exec(String($(el).attr('href') ?? ''));
    const text = squashSpace($(el).text());
    if (!m || !text) return;
    const list = out.get(m[1]) ?? [];
    list.push(text.toLowerCase());
    out.set(m[1], list);
  });
  return out;
}

/**
 * Positional block rule (addendum G1, no badge allow-list): a card is the non-blank lines between the
 * previous boundary (a dashed rule, the "N new jobs match" line, or the previous "View job:" line) and its
 * "View job:" line; title, company, location are its first three lines and anything after (badges of any
 * wording) is ignored. A block with fewer than three lines is incomplete. B5: when the HTML part is
 * available, the parsed title must equal (or begin) one of the HTML anchor texts for the same job id;
 * a mismatch is dropped and counted card_misaligned, never kept with shifted fields.
 * @param {string} text decoded text/plain body
 * @param {Date} now message internal date, used as postedAt (LinkedIn digests give no per-job date)
 * @param {ParseCtx} [ctx]
 * @returns {ParseResult}
 */
export function analyzeLinkedin(text, now, ctx = {}) {
  const r = emptyResult();
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').map((l) => stripZeroWidth(l).trim());
  const anchors = linkedinAnchorTexts(ctx.html);
  const seen = new Set();
  let boundary = -1;
  for (let i = 0; i < lines.length; i++) {
    if (LINKEDIN_BOUNDARY_RE.test(lines[i])) {
      boundary = i;
      continue;
    }
    const m = /^View job:\s*(https?:\/\/\S+)/i.exec(lines[i]);
    if (!m) continue;
    const idm = LINKEDIN_ID_RE.exec(m[1]);
    const start = boundary;
    boundary = i;
    if (!idm) continue;
    r.markers++;
    if (seen.has(idm[1])) continue;
    seen.add(idm[1]);
    // No boundary line before the first card: the card is the last blank-separated group above it, so a
    // preamble paragraph is never read as the title. Badge lines after the location stay ignored either way.
    let from = start;
    if (from === -1) {
      for (let j = i - 1; j >= 0; j--) {
        if (!lines[j]) {
          from = j;
          break;
        }
      }
    }
    const block = lines.slice(from + 1, i).filter(Boolean);
    if (block.length < 3) {
      r.incomplete++;
      continue;
    }
    const [title, company, location] = block;
    const texts = anchors.get(idm[1]) ?? [];
    const t = title.toLowerCase();
    if (texts.length && !texts.some((a) => a === t || a.startsWith(`${t} `))) {
      drop(r, 'card_misaligned');
      continue;
    }
    r.listings.push(rawListing({
      source: 'gmail', externalId: null, url: `https://www.linkedin.com/jobs/view/${idm[1]}`, title, company, location, postedAt: isoDate(now),
    }));
  }
  return r;
}

/**
 * @param {string} text
 * @param {Date} now
 * @param {ParseCtx} [ctx]
 */
export function parseLinkedin(text, now, ctx) {
  return analyzeLinkedin(text, now, ctx).listings;
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
  return analyzeLensa(html, now).listings;
}

/** Host is lensa.com or a subdomain of it (exact or dot-suffix; never `evillensa.com`). @param {string} host */
export function isLensaHost(host) {
  const h = String(host ?? '').toLowerCase();
  return h === 'lensa.com' || h.endsWith('.lensa.com');
}

/** Lensa job-link path shapes: SendGrid /ls/click, Mailgun /c/<token>, Customer.io /f/a/, direct /cgw/ (B4). */
const LENSA_JOB_PATH_RE = /^\/(?:ls\/click|c\/|f\/a\/|cgw\/)/;

/**
 * Offline unwrap of a Mailgun click token (`/c/<base64url>`): base64url, zlib inflate, form string, param
 * `l`. Null on any failure (a decode failure is not an error: the caller keeps the href).
 * @param {string} href
 * @returns {string|null}
 */
export function decodeMailgunHref(href) {
  try {
    const u = new URL(href);
    const m = /^\/c\/([A-Za-z0-9_-]+={0,2})$/.exec(u.pathname);
    if (!m) return null;
    const buf = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const form = zlib.inflateSync(buf).toString('utf8');
    const l = new URLSearchParams(form).get('l');
    return l && /^https?:\/\//i.test(l) ? l : null;
  } catch {
    return null;
  }
}

/**
 * Lensa version 2 (addendum G1, B4, B9): any lensa.com host (three ESPs today), a job-link path shape, and
 * the card structure (an anchor wrapping a table of >= 2 rows whose first row holds company and title).
 * markers: lensa job-link anchors that wrap any table at all (looser than the card grammar). A Mailgun
 * token decoding to lensa.com/cgw/<id> stores `https://lensa.com/cgw/<id>` and identifies the card by that
 * id plus the mode-stripped title; every other card keeps the title/company/location hash.
 * @param {string} html
 * @param {Date} now
 * @returns {ParseResult}
 */
export function analyzeLensa(html, now) {
  const r = emptyResult();
  const $ = cheerio.load(String(html ?? ''));
  const seen = new Set();
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
    if (!isLensaHost(u.hostname) || !LENSA_JOB_PATH_RE.test(u.pathname)) return;
    const outerTable = $a.find('table').first();
    if (outerTable.length === 0) return;
    if (CTA_TEXT_RE.test(squashSpace($a.text()))) {
      drop(r, 'cta_anchor');
      return;
    }
    r.markers++;
    let rows = outerTable.children('tbody').children('tr');
    if (rows.length === 0) rows = outerTable.children('tr');
    if (rows.length < 2) {
      r.incomplete++;
      return;
    }

    const cardTable = rows.eq(0).find('table').first();
    let cardRows = cardTable.children('tbody').children('tr');
    if (cardRows.length === 0) cardRows = cardTable.children('tr');
    const company = cardRows.length >= 2 ? cardRows.eq(0).find('td').last().text().replace(/\s+/g, ' ').trim() : '';
    const title = cardRows.length >= 2 ? cardRows.eq(1).find('td').first().text().replace(/\s+/g, ' ').trim() : '';
    if (!company || !title) {
      r.incomplete++;
      return;
    }
    const decoded = decodeMailgunHref(href);
    const cgw = decoded ? /^https?:\/\/(?:www\.)?lensa\.com\/cgw\/([A-Za-z0-9]+)/i.exec(decoded) : null;
    const storedUrl = cgw ? `https://lensa.com/cgw/${cgw[1]}` : href;

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
    const externalId = `lensa:${cgw ? tokenIdentity(`cgw:${cgw[1]}`, title) : identityHash(title, company, location)}`;
    if (seen.has(externalId)) return;
    seen.add(externalId);
    r.listings.push(rawListing({
      source: 'gmail',
      externalId,
      url: storedUrl,
      title,
      company,
      location,
      remoteMode: remote ? 'remote' : null,
      remoteDeclared: remote,
      salaryRaw,
      postedAt,
    }));
  });
  return r;
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
  return analyzeLadders(html, now).listings;
}

/** Ladders title anchors must point at its own click tracker (B6). @param {string} href */
function isLaddersTracker(href) {
  try {
    const u = new URL(href);
    return u.hostname.toLowerCase() === 't.ladders.co' && u.pathname.startsWith('/f/a/');
  } catch {
    return false;
  }
}

/**
 * Ladders version 2 (addendum G1, B6): three templates in one pass, each card keyed by its title anchor so
 * none is counted twice.
 *   A  `[id="jobs-company-container"]` "Company | City, ST | $salary" with the title in the previous row's
 *      link (unchanged; url stays null).
 *   B  `a.jobTitle` with `span.jobCompanyAndLocation` "| Company | Location" and `span.jobSalary`.
 *   C  `a.mobileLink` followed by sibling text "| Company | $salary" (no location).
 * B and C need the title anchor's href on Ladders' own tracker and store it as the url (G3 unwraps it). A
 * company part containing "$" is not a company: the card is incomplete (counted company_incomplete).
 * markers: distinct title anchors found by any of the three selectors, before any field check.
 * @param {string} html decoded text/html body (Ladders ships no text/plain part)
 * @param {Date} now
 * @returns {ParseResult}
 */
export function analyzeLadders(html, now) {
  const r = emptyResult();
  const $ = cheerio.load(String(html ?? ''));
  /** @type {Set<any>} */
  const cards = new Set();
  const seenIds = new Set();
  /** @param {{ title: string, company: string, location: string|null, salaryRaw: string|null, url: string|null }} c */
  const push = (c) => {
    const externalId = `ladders:${identityHash(c.title, c.company, c.location)}`;
    if (seenIds.has(externalId)) return;
    seenIds.add(externalId);
    r.listings.push(rawListing({ source: 'gmail', externalId, url: c.url, title: c.title, company: c.company, location: c.location, salaryRaw: c.salaryRaw, postedAt: isoDate(now) }));
  };
  /** @param {string} s */
  const salaryOf = (s) => (/\$/.test(s) ? s.replace(/\*+$/, '').trim() : null);

  // A. The id repeats once per job card (real captured markup); cheerio's attribute selector matches every one.
  $('[id="jobs-company-container"]').each((_i, el) => {
    const $span = $(el);
    const titleAnchor = $span.closest('tr').prev('tr').find('a').first();
    const key = titleAnchor.length ? titleAnchor.get(0) : el;
    if (cards.has(key)) return;
    cards.add(key);
    r.markers++;
    const parts = squashSpace($span.text()).split('|').map((p) => p.trim()).filter(Boolean);
    const title = squashSpace(titleAnchor.text());
    if (parts.length < 2 || !title) {
      r.incomplete++;
      return;
    }
    const company = parts[0];
    if (/\$/.test(company)) {
      r.incomplete++;
      drop(r, 'company_incomplete');
      return;
    }
    push({ title, company, location: parts.length >= 3 ? parts[1] : null, salaryRaw: salaryOf(parts[parts.length - 1]), url: null });
  });

  // B.
  $('a.jobTitle').each((_i, el) => {
    if (cards.has(el)) return;
    cards.add(el);
    r.markers++;
    const $a = $(el);
    const href = String($a.attr('href') ?? '');
    const title = squashSpace($a.text());
    const td = $a.closest('td');
    const parts = squashSpace(td.find('span.jobCompanyAndLocation').first().text()).replace(/^\|\s*/, '').split('|').map((p) => p.trim()).filter(Boolean);
    if (!isLaddersTracker(href) || !title || parts.length < 1) {
      r.incomplete++;
      return;
    }
    if (/\$/.test(parts[0])) {
      r.incomplete++;
      drop(r, 'company_incomplete');
      return;
    }
    const salaryText = squashSpace(td.find('span.jobSalary').first().text());
    push({ title, company: parts[0], location: parts[1] ?? null, salaryRaw: salaryText ? salaryOf(salaryText) : null, url: href });
  });

  // C.
  $('a.mobileLink').each((_i, el) => {
    if (cards.has(el)) return;
    cards.add(el);
    r.markers++;
    const $a = $(el);
    const href = String($a.attr('href') ?? '');
    const title = squashSpace($a.text());
    /** @type {string[]} */
    const after = [];
    for (let n = el.nextSibling; n && n.type !== 'tag'; n = n.nextSibling) after.push(String(/** @type {any} */ (n).data ?? ''));
    const parts = squashSpace(after.join('')).replace(/^\|\s*/, '').split('|').map((p) => p.trim()).filter(Boolean);
    if (!isLaddersTracker(href) || !title || parts.length < 1) {
      r.incomplete++;
      return;
    }
    if (/\$/.test(parts[0])) {
      r.incomplete++;
      drop(r, 'company_incomplete');
      return;
    }
    const salary = parts.slice(1).find((p) => /\$/.test(p)) ?? null;
    push({ title, company: parts[0], location: null, salaryRaw: salary ? salaryOf(salary) : null, url: href });
  });
  return r;
}

// ---------------------------------------------------------------------------
// Dice (dice@connect.dice.com), text
// ---------------------------------------------------------------------------

const DICE_JOB_RE = /https:\/\/www\.dice\.com\/job-detail\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Dice (addendum G2): the title is the joined lines after the preceding company-logo link line (or blank)
 * up to the job-detail URL (titles wrap); the next non-blank lines are company, location, and an optional
 * "Posted" line. url is the job-detail URL (normalizeUrl gives external_id dice:<uuid>).
 * @param {string} text
 * @param {Date} now
 * @returns {ParseResult}
 */
export function analyzeDice(text, now) {
  const r = emptyResult();
  const lines = stripZeroWidth(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = DICE_JOB_RE.exec(lines[i]);
    if (!m) continue;
    r.markers++;
    const id = m[1].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    /** @type {string[]} */
    const titleLines = [];
    const sameLine = lines[i].slice(0, lines[i].indexOf('<') === -1 ? lines[i].indexOf('http') : lines[i].indexOf('<')).trim();
    if (sameLine) titleLines.unshift(sameLine);
    for (let j = i - 1; j >= 0; j--) {
      if (!lines[j] || /dice\.com\/company\//i.test(lines[j])) break;
      titleLines.unshift(lines[j]);
    }
    const title = squashSpace(titleLines.join(' '));
    /** @type {string[]} */
    const next = [];
    for (let j = i + 1; j < lines.length && next.length < 3; j++) {
      if (!lines[j]) continue;
      if (DICE_JOB_RE.test(lines[j]) || /dice\.com\/company\//i.test(lines[j])) break;
      next.push(lines[j]);
    }
    const company = next[0] ?? '';
    const location = next[1] && !/^posted\b/i.test(next[1]) ? next[1] : null;
    if (!title || !company || CTA_TEXT_RE.test(title)) {
      r.incomplete++;
      continue;
    }
    const posted = next.find((l) => /^posted:?\s*\d{2}-\d{2}-\d{4}$/i.test(l));
    const pm = posted ? /(\d{2})-(\d{2})-(\d{4})/.exec(posted) : null;
    r.listings.push(rawListing({
      source: 'gmail', externalId: null, url: `https://www.dice.com/job-detail/${id}`, title, company, location,
      remoteMode: location && /\bremote\b/i.test(location) ? 'remote' : null, remoteDeclared: Boolean(location && /\bremote\b/i.test(location)),
      postedAt: pm ? `${pm[3]}-${pm[1]}-${pm[2]}` : isoDate(now),
    }));
  }
  return r;
}

// ---------------------------------------------------------------------------
// eFinancialCareers (emails@efinancialcareers.com), text
// ---------------------------------------------------------------------------

const EFC_APPLY_RE = /^Apply now:\s*(https:\/\/www\.efinancialcareers\.com\/[^\s?]*\.id(\d+))/i;

/**
 * eFinancialCareers (addendum G2): each "Apply now: <job url>" line closes a card whose four non-blank
 * lines above are title, company, location, salary ("Competitive" means no figure). url without query,
 * externalId efc:<id>.
 * @param {string} text
 * @param {Date} now
 * @returns {ParseResult}
 */
export function analyzeEfinancialcareers(text, now) {
  const r = emptyResult();
  const lines = stripZeroWidth(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = EFC_APPLY_RE.exec(lines[i]);
    if (!m) continue;
    r.markers++;
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    /** @type {string[]} */
    const above = [];
    for (let j = i - 1; j >= 0 && above.length < 4; j--) {
      if (!lines[j]) continue;
      if (EFC_APPLY_RE.test(lines[j])) break;
      above.unshift(lines[j]);
    }
    if (above.length < 4) {
      r.incomplete++;
      continue;
    }
    const [title, company, location, salary] = above;
    r.listings.push(rawListing({
      source: 'gmail', externalId: `efc:${m[2]}`, url: m[1], title, company, location,
      salaryRaw: /^competitive$/i.test(salary) || !/\d/.test(salary) ? null : salary, postedAt: isoDate(now),
    }));
  }
  return r;
}

// ---------------------------------------------------------------------------
// RemoteHunter (hello@mail.remotehunter.com), text
// ---------------------------------------------------------------------------

const REMOTEHUNTER_LINE_RE = /^(.+?)\s*\(\s*(https:\/\/www\.remotehunter\.com\/apply-with-ai\/([0-9a-f-]{36}))[^\s)]*\s*\)\s*$/i;

/**
 * RemoteHunter (addendum G2): "Title ( <apply-with-ai url> )" lines, excluding "Apply Now" CTA lines;
 * company is the previous non-blank line; a "Salary:" line within the next three is the salary. Every
 * row is remote. The apply-with-ai link is stored but never fetched (fork F-G3a). Deduped by uuid.
 * @param {string} text
 * @param {Date} now
 * @returns {ParseResult}
 */
export function analyzeRemotehunter(text, now) {
  const r = emptyResult();
  const lines = stripZeroWidth(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = REMOTEHUNTER_LINE_RE.exec(lines[i]);
    if (!m || CTA_TEXT_RE.test(m[1])) continue;
    const uuid = m[3].toLowerCase();
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    r.markers++;
    let company = '';
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j]) {
        company = lines[j];
        break;
      }
    }
    const title = m[1].trim();
    if (!title || !company || REMOTEHUNTER_LINE_RE.test(company)) {
      r.incomplete++;
      continue;
    }
    let salaryRaw = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const s = /^Salary:\s*(.+)$/i.exec(lines[j]);
      if (s) {
        salaryRaw = s[1].trim();
        break;
      }
    }
    r.listings.push(rawListing({
      source: 'gmail', externalId: `remotehunter:${uuid}`, url: `https://www.remotehunter.com/apply-with-ai/${uuid}`, title, company, location: null,
      remoteMode: 'remote', remoteDeclared: true, salaryRaw, postedAt: isoDate(now),
    }));
  }
  return r;
}

// ---------------------------------------------------------------------------
// jobs2web / SuccessFactors job agents (e.g. blackveatch-jobnotification@noreply12.jobs2web.com), html
// ---------------------------------------------------------------------------

const JOBS2WEB_HREF_RE = /^https?:\/\/([a-z0-9.-]+)\/(?:[A-Z]+\/)?job\/[^/]+\/(\d+)\//;

/**
 * jobs2web (addendum G2): anchors on the employer's career host whose path is /job/<slug>/<digits>/; the
 * text is "Title - City, ST, CC" (split on the LAST " - "); the company comes from the sender entry's own
 * `company` (config/alert-senders.json requires it for this parser). url without query, externalId
 * jobs2web:<host>/<digits>.
 * @param {string} html
 * @param {Date} now
 * @param {ParseCtx} [ctx]
 * @returns {ParseResult}
 */
export function analyzeJobs2web(html, now, ctx = {}) {
  const r = emptyResult();
  const $ = cheerio.load(String(html ?? ''));
  const company = String(ctx.sender?.company ?? '').trim();
  const seen = new Set();
  $('a[href]').each((_i, el) => {
    const href = String($(el).attr('href') ?? '');
    const m = JOBS2WEB_HREF_RE.exec(href);
    if (!m) return;
    r.markers++;
    const key = `${m[1].toLowerCase()}/${m[2]}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = squashSpace($(el).text());
    const cut = text.lastIndexOf(' - ');
    const title = cut === -1 ? text : text.slice(0, cut).trim();
    const location = cut === -1 ? null : text.slice(cut + 3).trim() || null;
    if (!title || !company || CTA_TEXT_RE.test(title)) {
      r.incomplete++;
      return;
    }
    r.listings.push(rawListing({
      source: 'gmail', externalId: `jobs2web:${key}`, url: href.split('?')[0], title, company, location, postedAt: isoDate(now),
    }));
  });
  return r;
}

/** Wrap a legacy (body, now) -> RawListing[] parser into the ParseResult contract. */
function legacyAnalyze(/** @type {(b: string, n: Date) => import('../core/normalize.js').RawListing[]} */ fn, /** @type {(b: string) => number} */ markers) {
  return (/** @type {string} */ body, /** @type {Date} */ now) => {
    const listings = fn(body, now);
    return { listings, markers: Math.max(markers(body), listings.length), incomplete: 0, dropped: {} };
  };
}

/**
 * Parser registry (addendum common contract): name -> { input, version, analyze(body, now, ctx) }.
 * PARSERS and PARSER_INPUT below are derived views kept for existing callers and tests.
 */
export const PARSER_SPECS = Object.freeze({
  linkedin: Object.freeze({ input: 'text', version: 2, analyze: analyzeLinkedin }),
  'indeed-alert': Object.freeze({ input: 'text', version: 1, analyze: legacyAnalyze(parseIndeedAlert, (b) => (stripZeroWidth(b).match(/^https?:\/\/(?:www\.)?indeed\.com\/(?:rc|pagead)\/clk\S*[?&]jk=[0-9a-f]{8,}/gim) ?? []).length) }),
  'indeed-match': Object.freeze({ input: 'text', version: 1, analyze: legacyAnalyze(parseIndeedMatch, (b) => (/^(Benefits:|View job:)/im.test(stripZeroWidth(b)) ? 1 : 0)) }),
  lensa: Object.freeze({ input: 'html', version: 2, analyze: analyzeLensa }),
  ladders: Object.freeze({ input: 'html', version: 2, analyze: analyzeLadders }),
  dice: Object.freeze({ input: 'text', version: 1, analyze: analyzeDice }),
  efinancialcareers: Object.freeze({ input: 'text', version: 1, analyze: analyzeEfinancialcareers }),
  remotehunter: Object.freeze({ input: 'text', version: 1, analyze: analyzeRemotehunter }),
  jobs2web: Object.freeze({ input: 'html', version: 1, analyze: analyzeJobs2web }),
});

/** Which body the sender's parser wants (derived from PARSER_SPECS). */
export const PARSER_INPUT = Object.freeze(Object.fromEntries(Object.entries(PARSER_SPECS).map(([k, v]) => [k, v.input])));

/** Legacy view: name -> (body, now, ctx) -> RawListing[] (derived from PARSER_SPECS). */
/** @type {Readonly<Record<string, (body: string, now: Date, ctx?: ParseCtx) => import('../core/normalize.js').RawListing[]>>} */
export const PARSERS = Object.freeze(Object.fromEntries(Object.entries(PARSER_SPECS).map(([k, v]) => [k, (/** @type {string} */ b, /** @type {Date} */ n, /** @type {any} */ c) => v.analyze(b, n, c).listings])));
