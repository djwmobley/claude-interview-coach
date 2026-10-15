// @ts-check
/**
 * Deterministic text extraction shared by the EDGAR full-text, 8-K, and Google Alerts adapters.
 * Everything here reads UNTRUSTED text, so every function:
 *   - works on input already capped at DOC_READ_MAX (or caps it itself),
 *   - uses only fixed, hand-written regexes (never a regex built from document text),
 *   - returns data, never an instruction, URL, or path.
 */
import { load } from 'cheerio';
import { DOC_READ_MAX, sanitizeText, NAME_MAX } from './signal-text.js';

const FORMAT_RE = /[\p{Cf}\u00AD\uFEFF]/gu;

/**
 * HTML to plain text that keeps line structure (block elements end a line), so "Item 5.02" headings can be
 * found at the start of a line. Scripts and styles are dropped.
 * @param {unknown} html
 * @returns {string}
 */
export function htmlToPlain(html) {
  const raw = typeof html === 'string' ? html.slice(0, DOC_READ_MAX) : '';
  if (!raw) return '';
  const $ = load(raw);
  $('script,style,noscript,head,template').remove();
  $('br').replaceWith('\n');
  $('p,div,tr,li,h1,h2,h3,h4,h5,h6,table,center,section,article').each((_, el) => {
    $(el).append('\n');
  });
  return $.root().text()
    .normalize('NFKC')
    .replace(FORMAT_RE, '')
    .replace(/\r/g, '')
    .replace(/[\t\u00A0 ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MONTHS = Object.freeze({ jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });

/**
 * Loose date to YYYY-MM-DD, or null. Accepts "October 1, 2026", "Oct. 1, 2026", "10/01/2026", "2026-10-01".
 * Impossible calendar dates are null.
 * @param {unknown} v
 * @returns {string|null}
 */
export function parseLooseDate(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 40);
  let y; let m; let d;
  let mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  if (!mm) {
    mm = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
    if (mm) {
      const key = mm[1].slice(0, 3).toLowerCase();
      m = /** @type {Record<string, number>} */ (MONTHS)[key];
      d = +mm[2]; y = +mm[3];
    }
  }
  if (!mm) {
    mm = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (mm) { m = +mm[1]; d = +mm[2]; y = mm[3].length === 2 ? 2000 + +mm[3] : +mm[3]; }
  }
  if (!mm || !m || !d || !y) return null;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return back.toISOString().slice(0, 10);
}

const COVER_DATE_RE = /Date of Report[^\n]{0,80}?:?\s*((?:[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})|(?:\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))|(?:\d{4}-\d{2}-\d{2}))/i;

/**
 * 8-K cover "Date of Report (Date of earliest event reported)". Looks only at the first 6000 characters.
 * @param {string} plain
 * @returns {string|null}
 */
export function extractCoverDate(plain) {
  const head = plain.slice(0, 6000);
  const m = COVER_DATE_RE.exec(head.replace(/\n/g, ' ').replace(/\s+/g, ' '));
  return m ? parseLooseDate(m[1]) : null;
}

// ---------------------------------------------------------------------------
// CTO-class role phrases and departure binding (plan 14.4 D + 15.2 item 5)
// ---------------------------------------------------------------------------

const ROLE_RES = Object.freeze([
  /\bchief\s+(?:technology|technical|information|digital|data|artificial\s+intelligence|ai)\s+officer\b/gi,
  /\b(?:CTO|CIO|CDO|CAIO)\b/g,
  /\bhead\s+of\s+(?:technology|IT|information\s+technology)\b/gi,
]);

const OTHER_TITLE_RE = /\b(?:chief\s+(?:executive|financial|operating|marketing|legal|commercial|revenue|people|human\s+resources|product|accounting|strategy|security|risk|compliance|medical|scientific|administrative|growth)\s+officer|CEO|CFO|COO|CMO|CLO|CRO|CPO|CHRO|CSO|CISO|president|chairman|chair\s+of\s+the\s+board|general\s+counsel|vice\s+president|controller|treasurer|corporate\s+secretary|director)\b/gi;

const DEPARTURE_RE = /\b(?:resign(?:ed|s|ing|ation)?|terminat(?:ed|es|ing|ion)|retir(?:e|ed|es|ing|ement)|depart(?:ed|s|ing|ure)?|step(?:s|ped|ping)?\s+down|separat(?:ed|es|ing|ion))\b/gi;
const APPOINTMENT_RE = /\b(?:appoint(?:ed|s|ing|ment)?|elect(?:ed|s|ing|ion)|hir(?:e|ed|es|ing)|promot(?:ed|es|ing|ion)|join(?:ed|s|ing)?|succeed(?:ed|s|ing)?|designat(?:ed|es|ing|ion)|name[ds]?)\b/gi;
const NEGATION_RE = /\b(?:not|no|never|without|nor)\b[^.\n]{0,25}$/i;
const NEAREST_TITLE_MAX = 150;

/**
 * @param {string} text
 * @param {RegExp} re a /g regex
 * @param {number} [limit]
 * @returns {Array<{ index: number, end: number, phrase: string }>}
 */
function allMatches(text, re, limit = 40) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null && out.length < limit) {
    out.push({ index: m.index, end: m.index + m[0].length, phrase: m[0] });
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

/**
 * CTO-class role phrases in the text, in document order.
 * @param {string} text
 * @returns {Array<{ index: number, end: number, phrase: string }>}
 */
export function findRoles(text) {
  const t = text.slice(0, DOC_READ_MAX);
  return ROLE_RES.flatMap((re) => allMatches(t, re)).sort((a, b) => a.index - b.index);
}

const ITEM_HEADING_RE = /\b(?:Departure\s+of\s+Directors\s+or\s+(?:Certain|Principal)\s+Officers|Election\s+of\s+Directors|Appointment\s+of\s+(?:Certain|Principal)\s+Officers|Compensatory\s+Arrangements\s+of\s+Certain\s+Officers)\b/gi;

/**
 * The standard Item 5.02 heading ("Departure of Directors or Certain Officers; Election of Directors;
 * Appointment of Certain Officers") names a departure and an appointment in every filing. Remove it so its
 * verbs are never read as events.
 * @param {string} text
 * @returns {string}
 */
export function stripItemHeading(text) {
  return text.replace(ITEM_HEADING_RE, ' ');
}

/**
 * @typedef {Object} DepartureAnalysis
 * @property {'no_role'|'departure'|'appointment_only'|'ambiguous'|'both'} kind
 * @property {string|null} role first CTO-class role phrase, as written
 * @property {boolean} ambiguous true when the departure verb does not demonstrably bind to the role-holder
 */

/**
 * Decide whether the section describes a CTO-class departure. A departure verb counts only when the title
 * NEAREST to it (within NEAREST_TITLE_MAX characters) is a CTO-class role; "appointed X as CTO following the
 * resignation of the CFO" therefore does not count as a CTO departure. Both a bound departure and a bound
 * appointment, or a departure verb that binds to nothing, set ambiguous (needs-review).
 * @param {string} section
 * @returns {DepartureAnalysis}
 */
export function analyzeDeparture(section) {
  const text = stripItemHeading(section.slice(0, DOC_READ_MAX));
  const roles = findRoles(text);
  if (roles.length === 0) return { kind: 'no_role', role: null, ambiguous: false };
  const others = allMatches(text, OTHER_TITLE_RE, 80).filter((o) => !roles.some((r) => o.index >= r.index && o.index < r.end));
  /** @param {number} pos @param {number} end @returns {'role'|'other'|null} */
  const nearestTitle = (pos, end) => {
    let best = /** @type {'role'|'other'|null} */ (null);
    let bestDist = NEAREST_TITLE_MAX + 1;
    for (const r of roles) {
      const dist = r.end <= pos ? pos - r.end : (r.index >= end ? r.index - end : 0);
      if (dist < bestDist) { bestDist = dist; best = 'role'; }
    }
    for (const o of others) {
      const dist = o.end <= pos ? pos - o.end : (o.index >= end ? o.index - end : 0);
      if (dist < bestDist) { bestDist = dist; best = 'other'; }
    }
    return best;
  };
  const deps = allMatches(text, DEPARTURE_RE).filter((v) => !NEGATION_RE.test(text.slice(Math.max(0, v.index - 30), v.index)));
  const apps = allMatches(text, APPOINTMENT_RE);
  const boundDeparture = deps.some((v) => nearestTitle(v.index, v.end) === 'role');
  const boundAppointment = apps.some((v) => nearestTitle(v.index, v.end) === 'role');
  const role = sanitizeText(roles[0].phrase, NAME_MAX);
  if (boundDeparture && boundAppointment) return { kind: 'both', role, ambiguous: true };
  if (boundDeparture) return { kind: 'departure', role, ambiguous: false };
  if (boundAppointment && deps.length === 0) return { kind: 'appointment_only', role, ambiguous: false };
  return { kind: 'ambiguous', role, ambiguous: true };
}

// ---------------------------------------------------------------------------
// Contact adjacency (plan section 6, 14.4 D)
// ---------------------------------------------------------------------------

const NAME_PART = "[A-Z][a-z]{1,20}(?:[-'][A-Z][a-z]{1,20})?";
const NAME_RE_SRC = `${NAME_PART}(?:\\s+[A-Z]\\.)?(?:\\s+${NAME_PART}){1,2}`;
const CONTACT_TITLE_SRC = '(?:Chief\\s+Executive\\s+Officer|Chief\\s+Technology\\s+Officer|Chief\\s+Information\\s+Officer|Chief\\s+Digital\\s+Officer|CEO|CTO|CIO|CDO|Operating\\s+Partner)';
const CONTACT_A = new RegExp(`(${NAME_RE_SRC}),?\\s+(?:our\\s+|the\\s+|the\\s+Company['\u2019]s\\s+)?(${CONTACT_TITLE_SRC})\\b`, 'g');
const CONTACT_B = new RegExp(`\\b(${CONTACT_TITLE_SRC})\\s*[,:]?\\s+(${NAME_RE_SRC})`, 'g');
const CONTACT_EXCLUDE_RE = /\b(?:resign\w*|former(?:ly)?|depart\w*|terminat\w*|retir\w*|step(?:s|ped)?\s+down|successor|succeed\w*|outgoing|interim|media|press|investor\s+relations|contacts?|spokes\w*|inquiries)\b/i;
const NAME_STOPWORDS = new Set(['chief', 'executive', 'officer', 'technology', 'information', 'digital', 'president', 'board', 'company', 'inc', 'corporation', 'corp', 'the', 'operating', 'partner', 'item', 'form', 'securities', 'exchange', 'commission', 'search', 'committee', 'council', 'group', 'team', 'office', 'department', 'division', 'directors', 'members', 'agreement', 'plan']);

/**
 * A name only when it is adjacent to a CEO, CTO, CIO, CDO, or operating partner title AND the surrounding
 * 120 characters carry no departing / former / media / contact language. Otherwise role-only (or null).
 * @param {string} text
 * @returns {{ role: string, name: string }|null}
 */
export function extractContact(text) {
  const t = text.slice(0, DOC_READ_MAX);
  /** @type {Array<{ index: number, end: number, name: string, role: string }>} */
  const cands = [];
  for (const [re, nameIdx, roleIdx] of /** @type {Array<[RegExp, number, number]>} */ ([[CONTACT_A, 1, 2], [CONTACT_B, 2, 1]])) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null && cands.length < 20) {
      cands.push({ index: m.index, end: m.index + m[0].length, name: m[nameIdx], role: m[roleIdx] });
    }
  }
  cands.sort((a, b) => a.index - b.index);
  for (const c of cands) {
    if (c.name.length > NAME_MAX) continue;
    if (c.name.toLowerCase().split(/\s+/).some((w) => NAME_STOPWORDS.has(w.replace(/\.$/, '')))) continue;
    const around = t.slice(Math.max(0, c.index - 120), Math.min(t.length, c.end + 120));
    if (CONTACT_EXCLUDE_RE.test(around)) continue;
    return { role: sanitizeText(c.role, 60), name: sanitizeText(c.name, NAME_MAX) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Party and window helpers
// ---------------------------------------------------------------------------

const PARTY_NAME = "([A-Z][\\w&.'-]{1,40}(?:\\s+(?:[A-Z&][\\w&.'-]{0,40}|of|and|the|&)){0,5})";
const PARTY_RES = Object.freeze([
  { kind: 'acquirer', re: new RegExp(`\\bacquired\\s+by\\s+${PARTY_NAME}`) },
  { kind: 'acquirer', re: new RegExp(`\\bmerger\\s+with\\s+${PARTY_NAME}`) },
  { kind: 'investor', re: new RegExp(`\\binvestment\\s+from\\s+${PARTY_NAME}`) },
]);

/**
 * The first "acquired by | merger with | investment from <Name>" sentence in the first 20 KB.
 * @param {string} plain
 * @returns {{ kind: 'acquirer'|'investor', name: string }|null}
 */
export function extractParty(plain) {
  const head = plain.slice(0, 20 * 1024);
  let best = null;
  for (const { kind, re } of PARTY_RES) {
    const m = re.exec(head);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, kind, name: m[1] };
  }
  if (!best) return null;
  const name = sanitizeText(best.name.replace(/[.,;]+$/, ''), NAME_MAX);
  return name ? { kind: /** @type {'acquirer'|'investor'} */ (best.kind), name } : null;
}

/**
 * Terms for a window search taken from a query declaration (operator config), not from a document.
 * @param {string} q
 * @returns {string[]}
 */
export function queryTerms(q) {
  const quoted = [...String(q).matchAll(/"([^"]{2,80})"/g)].map((m) => m[1]);
  const words = String(q).replace(/"[^"]*"/g, ' ').split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9.-]/g, '')).filter((w) => w.length >= 3 && !/^(?:and|or|not|near)$/i.test(w));
  return [...quoted, ...words];
}

/**
 * ~size characters around the first occurrence of any term, else the head of the text.
 * @param {string} plain
 * @param {string[]} terms
 * @param {number} size
 * @returns {string}
 */
export function windowAround(plain, terms, size) {
  const lower = plain.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return plain.slice(0, size);
  const start = Math.max(0, at - Math.floor(size / 3));
  return plain.slice(start, start + size);
}

/**
 * Cut the text of the longest "Item 5.02" section (up to the next "Item N.NN" heading or SIGNATURES).
 * @param {string} plain
 * @returns {string|null}
 */
export function cutItem502(plain) {
  const t = plain.slice(0, DOC_READ_MAX);
  const startRe = /^[ \t]*Item\s+5\.02\b/gim;
  const nextRe = /^[ \t]*(?:Item\s+\d{1,2}\.\d{2}\b|SIGNATURES?\b)/gim;
  /** @type {string|null} */
  let best = null;
  let m;
  startRe.lastIndex = 0;
  let guard = 0;
  while ((m = startRe.exec(t)) !== null && guard++ < 20) {
    nextRe.lastIndex = m.index + m[0].length;
    const n = nextRe.exec(t);
    const section = t.slice(m.index, n ? n.index : t.length).trim();
    if (best === null || section.length > best.length) best = section;
  }
  return best;
}
