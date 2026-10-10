// @ts-check
/**
 * Deterministic job-title gate. Pure function, no I/O.
 *
 *   classifyTitle(title) -> { verdict: 'pass'|'drop', reason: null|'director_level'|'non_tech_function', rule }
 *
 * The candidate is a CTO-level technology executive, so two kinds of listing are dropped before anyone
 * (or any model) spends time on them: plain Director-level roles (Senior Director and above are kept),
 * and roles whose function has nothing to do with technology.
 *
 * It is a TOTAL classification: every input lands on exactly one branch below, first match wins, and an
 * unrecognized or blank title is 'pass' (friction: it flows on to triage, where a human or the model
 * decides). All list matching is whole-word / whole-phrase on the normalized string, never substring.
 *
 * Normalization: lowercase; dotted initials collapsed first (s.v.p. -> svp, v.p. -> vp, sr. -> sr,
 * dir. -> dir); then punctuation other than '&' and ',' becomes a space; whitespace collapsed.
 *
 * HEAD is the title up to the first of ',', ' - ', '|', '(', ' reports to', ' reporting to' (cut BEFORE
 * punctuation is flattened, so ' - ' is still visible), with the non-exec phrases in HEAD_STRIP removed.
 *
 *   Step 1 LEVEL, on HEAD
 *     a. NOT_EXEC_LEVEL phrase (non executive director, board member, avp, ...)  -> drop director_level
 *     b. an EXEC token (chief ... officer, cto, vp, senior director, head of, ...) -> level ok, step 2
 *     c. 'director' or 'dir' (incl. associate/assistant director)                -> drop director_level
 *     d. otherwise level unknown                                                  -> step 2
 *   Step 2 FUNCTION, on the full normalized title
 *     a NONTECH token with no TECH token -> drop non_tech_function; otherwise pass.
 *     NEUTRALIZED phrases (finance transformation, product marketing, ...) are blanked out for the TECH
 *     check only: their embedded 'transformation' / 'product' / 'engineering' are not technology
 *     signals, but their NONTECH word ('finance', 'marketing', 'sales') still counts.
 *
 * KNOWN ACCEPTED GAP: a single TECH token cancels NONTECH, so 'Head of Sales, Payments Platform' passes to
 * triage. Friction over silent escape: triage scores it, nothing is lost.
 */

/** Phrases (HEAD only) that signal a board/sub-director level rather than an operating role. Drop. */
export const NOT_EXEC_LEVEL = Object.freeze([
  'non executive director', 'board director', 'board member', 'assistant vice president', 'associate vice president', 'avp',
]);

/** Phrases removed from HEAD before the level check: their embedded exec words are not the role's level. */
export const HEAD_STRIP = Object.freeze(['executive assistant', 'assistant to', 'chief of staff', 'administrative assistant']);

/** Exec-level tokens. 'chief <1-4 words> officer' is handled by CHIEF_OFFICER_RE below. */
export const EXEC_TOKENS = Object.freeze([
  'cto', 'cio', 'cdo', 'caio', 'coo', 'ceo', 'ciso', 'cpo', 'president', 'vp', 'vice president', 'svp', 'evp', 'head of',
  'managing director', 'executive director', 'senior director', 'sr director', 'senior dir', 'sr dir', 'general manager',
]);
const CHIEF_OFFICER_RE = /\bchief(\s+[\w&]+){1,4}\s+officer\b/;

/** Phrases whose TECH-looking words are not technology signals (blanked for the TECH check only). */
export const NEUTRALIZED = Object.freeze([
  'finance transformation', 'hr transformation', 'people transformation', 'product marketing', 'product supply', 'sales engineering',
]);

export const NONTECH_TOKENS = Object.freeze([
  'chief financial', 'cfo', 'chief marketing', 'cmo', 'chief human', 'chro', 'chief people', 'chief legal', 'general counsel',
  'chief nursing', 'chief medical', 'chief clinical', 'chief revenue', 'chief sales', 'chief commercial', 'chief accounting',
  'chief merchandising', 'chief development officer', 'chief diversity', 'chief investment', 'sales', 'marketing', 'finance',
  'accounting', 'human resources', 'hr', 'people', 'talent', 'legal', 'nursing', 'clinical', 'merchandising', 'fundraising',
  'philanthropy',
]);

/** A trailing '*' is a stem match (technolog* matches technology, technologist, technologies). */
export const TECH_TOKENS = Object.freeze([
  'technolog*', 'technical', 'digital', 'data', 'ai', 'artificial intelligence', 'it', 'information', 'informatics', 'ehr',
  'interoperability', 'health it', 'fintech', 'martech', 'systems', 'software', 'engineering', 'e commerce', 'ecommerce',
  'payments', 'platform', 'cyber', 'cybersecurity', 'information security', 'infosec', 'product', 'cloud', 'analytics',
  'automation', 'transformation',
]);

/** @param {string} token */
function tokenRe(token) {
  const stem = token.endsWith('*');
  const body = (stem ? token.slice(0, -1) : token).replace(/ /g, '\\s+');
  return new RegExp(`\\b${body}${stem ? '\\w*' : ''}\\b`);
}

/** @param {readonly string[]} tokens @returns {Array<[string, RegExp]>} */
function compile(tokens) {
  return tokens.map((t) => /** @type {[string, RegExp]} */ ([t, tokenRe(t)]));
}

const NOT_EXEC_RES = compile(NOT_EXEC_LEVEL);
const HEAD_STRIP_RES = compile(HEAD_STRIP);
const EXEC_RES = compile(EXEC_TOKENS);
const NEUTRAL_RES = compile(NEUTRALIZED);
const NONTECH_RES = compile(NONTECH_TOKENS);
const TECH_RES = compile(TECH_TOKENS);
const DIRECTOR_RE = /\b(director|dir)\b/;

/** Lowercase and collapse dotted initials / abbreviations; punctuation is left alone (HEAD needs ' - '). */
function preNormalize(/** @type {string} */ s) {
  return s
    .toLowerCase()
    .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .replace(/\b(sr|dir)\./g, '$1');
}

/** Punctuation other than '&' and ',' becomes a space; whitespace collapsed. */
function flatten(/** @type {string} */ s) {
  return s.replace(/[^a-z0-9&,\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const HEAD_CUT_RE = /,|\s[-\u2013\u2014]\s|\||\(|\sreports to|\sreporting to/;

/** @param {Array<[string, RegExp]>} res @param {string} s @returns {string|null} first matching token */
function firstHit(res, s) {
  for (const [token, re] of res) if (re.test(s)) return token;
  return null;
}

/**
 * @param {string|null|undefined} title
 * @returns {{ verdict: 'pass'|'drop', reason: null|'director_level'|'non_tech_function', rule: string }}
 */
export function classifyTitle(title) {
  const pre = preNormalize(String(title ?? ''));
  const full = flatten(pre);
  if (!full) return { verdict: 'pass', reason: null, rule: 'blank_title' };

  let head = flatten(pre.split(HEAD_CUT_RE)[0] ?? '');
  for (const [, re] of HEAD_STRIP_RES) head = head.replace(new RegExp(re.source, 'g'), ' ');
  head = head.replace(/\s+/g, ' ').trim();

  // Step 1: level.
  const notExec = firstHit(NOT_EXEC_RES, head);
  if (notExec) return { verdict: 'drop', reason: 'director_level', rule: `level:${notExec}` };
  const execTok = firstHit(EXEC_RES, head) ?? (CHIEF_OFFICER_RE.test(head) ? 'chief_officer' : null);
  if (!execTok && DIRECTOR_RE.test(head)) return { verdict: 'drop', reason: 'director_level', rule: 'level:director' };

  // Step 2: function.
  let techText = full;
  for (const [, re] of NEUTRAL_RES) techText = techText.replace(new RegExp(re.source, 'g'), ' ');
  const nonTech = firstHit(NONTECH_RES, full);
  if (nonTech && !firstHit(TECH_RES, techText)) return { verdict: 'drop', reason: 'non_tech_function', rule: `function:${nonTech}` };
  return { verdict: 'pass', reason: null, rule: execTok ? `level:${execTok}` : 'level:unknown' };
}
