// @ts-check
/**
 * Deterministic gates for a target outreach draft (plan 19.5). TOTAL classification: every gate returns true
 * (pass) or one code from GATE_CODES (fail). A throw, a missing input, a return value that is neither true nor
 * a known code, is the code gate_error. No gate is skipped, none short-circuits another: runGates() always
 * returns one result per gate so the park reason is complete.
 *
 * Machine mode: the model's sentence tags are authoritative and a gate FAIL parks the draft. Edited mode (after
 * Damian edited the text): the same gates run as ADVISORY warnings; an unchanged sentence keeps its tag, a new
 * or changed one is tagged "edited" and warns (edited_uncited). Nothing here ever blocks a human's own text.
 *
 * Findings carry a code only: a blocked name, an excerpt or a draft word never appears in a result.
 *
 * Known gaps (plan 19.1 O6): the compensation, confidential and US English checks are lexical and incomplete.
 * The independent reviewer checks them too, and a reviewer FAIL parks the draft.
 *
 * The only dynamic regular expressions here are built from config/style-checks.json (operator config), never
 * from document text.
 */
import { foldText, squash, squashLeet, tokens, padded, hasPhrase, numbersOf, splitSentences, collapse } from './draft-text.js';
import { normalizeName, strippedForm } from '../core/target-exclusion.js';

export const FIELDS = Object.freeze(['hook', 'bridge', 'claim', 'ask']);
export const MAX_WORDS = 90;
export const FIELD_MAX_CHARS = 600;
export const MAX_SENTENCES = 30;

export const GATE_CODES = Object.freeze([
  'shape', 'forged_verdict', 'too_long', 'greeting_signoff', 'dash', 'quote', 'buzzword', 'problem_comparison',
  'blocked_name', 'employer_leak', 'compensation', 'confidential', 'uk_spelling', 'url', 'person_name',
  'citation_cover', 'citation_source', 'citation_number', 'citation_name', 'citation_missing', 'ask_claim',
  'company_unnamed', 'trigger_mismatch', 'edited_uncited', 'gate_error',
]);
const CODE_SET = new Set(GATE_CODES);

/** Trigger verbs per trigger_kind (plan 19.5 citation gate, F1). Phrases of plain words. */
export const TRIGGER_VERBS = Object.freeze(/** @type {Record<string, readonly string[]>} */ ({
  pe_deal: Object.freeze(['acquired', 'acquires', 'acquire', 'acquisition', 'invested', 'invests', 'investment', 'backed', 'backing', 'recapitalization', 'recapitalized', 'buyout', 'majority stake', 'minority stake', 'private equity', 'raised', 'funding', 'financing', 'partnered', 'partners with']),
  exec_departure: Object.freeze(['stepped down', 'step down', 'steps down', 'stepping down', 'departed', 'departure', 'departs', 'resigned', 'resigns', 'resignation', 'retired', 'retires', 'retirement', 'left', 'leaves', 'leaving', 'transition', 'replaced', 'succeeded', 'successor']),
  leadership_gap: Object.freeze(['hiring', 'hires', 'seeking', 'searching', 'search', 'recruiting', 'looking for', 'open role', 'opening', 'vacancy', 'vacant', 'posted', 'posting']),
}));

const SENTENCE_STARTERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'their', 'its', 'it', 'after', 'following', 'with', 'as', 'in', 'on', 'at', 'when', 'while', 'since', 'for', 'from', 'by', 'to', 'of', 'and', 'but', 'so', 'with', 'having', 'given', 'your', 'our', 'we', 'i', 'my', 'could', 'would', 'might', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'will', 'happy', 'curious', 'open', 'worth', 'if', 'once', 'because', 'before', 'during', 'recent', 'new']);
const GENERIC_CAPS = new Set(['i', 'ceo', 'cfo', 'coo', 'cto', 'cio', 'cdo', 'pe', 'ai', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const LEGAL_SUFFIX = new Set(['inc', 'llc', 'corp', 'corporation', 'co', 'company', 'ltd', 'lp', 'llp', 'plc', 'holdings', 'holding', 'group', 'the', 'and', 'of', 'partners', 'international', 'intl']);

const GREETINGS = new Set(['hi', 'hello', 'hey', 'dear', 'greetings']);
const SIGNOFF_PHRASES = Object.freeze(['best regards', 'kind regards', 'warm regards', 'regards', 'sincerely', 'cheers', 'yours truly', 'best wishes', 'warm wishes', 'thanks', 'thank you', 'talk soon', 'speak soon', 'respectfully']);

/** Phrases that tie the note to the author's current employer (F3). Plain regular expressions on folded text. */
export const EMPLOYER_PATTERNS = Object.freeze([
  /\bmy (?:current|present|previous|former|last) (?:employer|firm|company|role|position|job|organi[sz]ation|team|boss|manager|title)\b/,
  /\b(?:i|we) (?:currently|presently|now) (?:work|serve|lead|run|am|are)\b/,
  /\b(?:i'm|i am|we're|we are) (?:currently|presently|now) (?:at|with|leading|running|working)\b/,
  /\bat my (?:current|present) /,
  /\bcurrent(?:ly)? (?:employer|employed)\b/,
  /\bmy (?:employer|firm|company)\b/,
  /\bwhere i (?:work|am employed)\b/,
]);

const COMPENSATION_PHRASES = Object.freeze([
  'salary', 'salaries', 'salaried', 'compensation', 'comp', 'rate', 'rates', 'pay band', 'pay range', 'six figures', 'seven figures',
  'base salary', 'ote', 'bonus', 'bonuses', 'equity', 'stock options', 'stock option', 'total package', 'pay package', 'hourly', 'per hour', 'per year',
]);
const CURRENCY_RE = /[$\u{20ac}\u{a3}\u{a5}\u{20b9}\u{20a9}\u{20bd}]|\b(?:usd|eur|gbp|cad|aud)\b/u;
const K_FIGURE_RE = /\b\d[\d,.]*\s?(?:k|m|mm|bn|b)\b/;
const MAGNITUDE_RE = /\b\d[\d,.]*\s?(?:thousand|million|billion|trillion)\b/;

const UK_WORDS = new Set([
  'colour', 'colours', 'coloured', 'favour', 'favours', 'favoured', 'favourite', 'favourites', 'honour', 'honours', 'honoured', 'behaviour', 'behaviours',
  'labour', 'labours', 'neighbour', 'neighbours', 'harbour', 'harbours', 'rumour', 'humour', 'savour', 'flavour', 'flavours', 'vapour', 'armour', 'endeavour', 'endeavours',
  'centre', 'centres', 'centred', 'metre', 'metres', 'litre', 'litres', 'theatre', 'fibre', 'calibre', 'sombre', 'spectre',
  'catalogue', 'catalogues', 'programme', 'programmes', 'licence', 'licences', 'defence', 'offence', 'pretence', 'practise', 'practised', 'cheque', 'cheques',
  'grey', 'judgement', 'judgements', 'ageing', 'enquiry', 'enquiries', 'enquire', 'whilst', 'amongst', 'learnt', 'spelt', 'burnt', 'dreamt',
  'travelling', 'travelled', 'traveller', 'labelled', 'labelling', 'cancelled', 'cancelling', 'modelling', 'modelled', 'signalling', 'signalled', 'fuelled', 'fuelling', 'counselling', 'channelled',
  'jewellery', 'fulfil', 'fulfils', 'instalment', 'skilful', 'wilful', 'artefact', 'artefacts', 'aluminium', 'tyre', 'tyres', 'kerb', 'plough', 'sceptic', 'sceptical', 'mould',
  'anaemia', 'manoeuvre', 'manoeuvres', 'paediatric', 'oestrogen', 'draught', 'storey', 'mum', 'maths', 'autumnal', 'colouring', 'honouring', 'favouring', 'labouring', 'neighbourhood', 'neighbourhoods',
  'organisation', 'organisations', 'organisational', 'analyse', 'analysed', 'analyses', 'analysing', 'paralyse', 'paralysed',
]);
const UK_ISE_STEMS = Object.freeze(['organ', 'real', 'recogn', 'special', 'priorit', 'optim', 'maxim', 'minim', 'summar', 'util', 'final', 'emphas', 'apolog', 'author', 'capital', 'categor', 'critic', 'custom', 'digit', 'harmon', 'item', 'legitim', 'mobil', 'modern', 'normal', 'penal', 'rational', 'standard', 'synchron', 'visual', 'character', 'central', 'civil', 'crystal', 'equal', 'fertil', 'general', 'hospital', 'industrial', 'initial', 'memor', 'moral', 'neutral', 'personal', 'privat', 'social', 'stabil', 'sympath', 'trivial', 'unif', 'urban', 'vandal', 'commerci', 'itemi', 'localis', 'monetis', 'popularis', 'randomis', 'revolutionis', 'sanitis', 'stylis']);
const ISE_ENDS = Object.freeze(['ise', 'ised', 'ises', 'ising', 'isation', 'isations', 'iser', 'isers']);

/**
 * @typedef {Object} GateContext
 * @property {string} company the target company as stored
 * @property {string|null} triggerKind
 * @property {string[]} blockedEntries MENTION_FORBIDDEN (src/core/mention-forbidden.js): the current employer plus blocked_affiliates
 * @property {{ buzzwords: string[], problemComparisonPatterns: string[] }} style
 * @property {Record<string, string>} evidence signal id (string) to sanitized excerpt, only the ids sent to the drafter
 * @property {Array<{ id: string, text: string, tags?: string[] }>} facts
 * @property {string[]} [denylist]
 * @property {string[]} [candidateNames]
 * @property {string[]} [personNames] names the cited signals carry as structured contacts
 * @property {string|null} [contactName]
 */

/**
 * @typedef {Object} GateInput
 * @property {unknown} fields {hook, bridge, claim, ask}
 * @property {unknown} sentences [{text, src}]
 * @property {'machine'|'edited'} [mode]
 * @property {GateContext} ctx
 */

/**
 * @typedef {{ gate: string, ok: boolean, code: string|null }} GateResult
 */

/** @param {unknown} v @returns {Record<string, string>} */
function fieldsOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('fields');
  const o = /** @type {Record<string, unknown>} */ (v);
  /** @type {Record<string, string>} */
  const out = {};
  for (const f of FIELDS) {
    if (typeof o[f] !== 'string') throw new Error('fields');
    out[f] = /** @type {string} */ (o[f]);
  }
  return out;
}

/** @param {unknown} v @returns {Array<{ text: string, src: string }>} */
function sentencesOf(v) {
  if (!Array.isArray(v)) throw new Error('sentences');
  return v.map((x) => {
    if (!x || typeof x !== 'object' || typeof x.text !== 'string' || typeof x.src !== 'string') throw new Error('sentences');
    return { text: x.text, src: x.src };
  });
}

/** @param {Record<string, string>} f @returns {string} */
function body(f) {
  return FIELDS.map((k) => f[k]).join(' ');
}

const INVISIBLE_OR_CONTROL = /[\p{C}\u{2028}\u{2029}\u0085]/u;

/** @param {string} raw @returns {boolean} true when the text is one clean line of visible characters */
function cleanLine(raw) {
  return !INVISIBLE_OR_CONTROL.test(raw) && !/[\r\n\v\f]/.test(raw);
}

// ---------------------------------------------------------------------------------------------------------------
// The gates. Each takes the parsed inputs and returns true or a failure code.
// ---------------------------------------------------------------------------------------------------------------

/** @param {{ f: Record<string,string>, s: Array<{text:string,src:string}> }} i */
function gShape(i) {
  for (const k of FIELDS) {
    const v = i.f[k];
    if (v.trim() === '' || v.length > FIELD_MAX_CHARS) return 'shape';
    if (!cleanLine(v)) return 'shape';
  }
  if (i.s.length === 0 || i.s.length > MAX_SENTENCES) return 'shape';
  for (const s of i.s) {
    if (s.text.trim() === '' || s.text.length > FIELD_MAX_CHARS || !cleanLine(s.text)) return 'shape';
    if (!/^(?:e\d{1,9}|c\d{1,3}|ask|edited)$/.test(s.src)) return 'shape';
  }
  return true;
}

/** @param {{ f: Record<string,string>, s: Array<{text:string,src:string}> }} i */
function gVerdict(i) {
  const all = [...FIELDS.map((k) => i.f[k]), ...i.s.map((x) => x.text), ...i.s.map((x) => x.src)];
  for (const t of all) if (squash(t).includes('verdict') || squashLeet(t).includes('verdict')) return 'forged_verdict';
  return true;
}

/** @param {{ f: Record<string,string> }} i */
function gWords(i) {
  const n = tokens(body(i.f).normalize('NFKC')).length;
  return n <= MAX_WORDS ? true : 'too_long';
}

/** @param {{ f: Record<string,string> }} i */
function gGreeting(i) {
  for (const k of FIELDS) {
    const t = i.f[k];
    for (const s of splitSentences(t)) {
      const first = tokens(s)[0];
      if (first && GREETINGS.has(first)) return 'greeting_signoff';
      if (/^good (?:morning|afternoon|evening)\b/.test(foldText(s))) return 'greeting_signoff';
    }
    for (const p of SIGNOFF_PHRASES) if (hasPhrase(t, p)) return 'greeting_signoff';
  }
  return true;
}

/** @param {string} c @returns {boolean} */
function isDashLike(c) {
  return /\p{Pd}/u.test(c) || c === '\u{2212}' || c === '\u{2043}' || c === '\u{ad}';
}

/** @param {{ f: Record<string,string> }} i */
function gDashes(i) {
  const check = (/** @type {string} */ t) => {
    const chars = Array.from(t);
    for (let k = 0; k < chars.length; k++) {
      const c = chars[k];
      if (!isDashLike(c)) continue;
      if (c !== '-') return false;
      const prev = chars[k - 1] ?? '';
      const next = chars[k + 1] ?? '';
      if (!/[\p{L}\p{N}]/u.test(prev) || !/[\p{L}\p{N}]/u.test(next)) return false;
    }
    return true;
  };
  for (const k of FIELDS) {
    if (!check(i.f[k]) || !check(i.f[k].normalize('NFKC'))) return 'dash';
  }
  return true;
}

const ALWAYS_QUOTE = new Set(['"', '\u{201c}', '\u{201d}', '\u{201e}', '\u{201f}', '\u{ab}', '\u{bb}', '\u{2039}', '\u{203a}', '\u{2018}', '\u{201a}', '\u{201b}', '`', '\u{b4}', '\u{ff02}', '\u{301d}', '\u{301e}', '\u{301f}', '\u{2033}', '\u{2036}']);
const APOSTROPHE = new Set(["'", '\u{2019}', '\u{2bc}', '\u{ff07}', '\u{2032}']);
/** The plain brackets of ordinary prose; every other Ps/Pe character is a quote mark of some script (fix 2). */
const PLAIN_BRACKETS = new Set(['(', ')', '[', ']', '{', '}']);

/**
 * Quote class (F5, fix 2): any initial or final quote (Pi, Pf), and any opening or closing bracket (Ps, Pe) that is
 * not one of the six plain ASCII brackets. That covers the CJK corner brackets and every other paired quote form,
 * not a list of literals. An apostrophe-like character is judged by its neighbors instead (APOSTROPHE).
 * @param {string} c
 * @returns {boolean}
 */
function isQuoteClass(c) {
  if (APOSTROPHE.has(c)) return false;
  if (/[\p{Pi}\p{Pf}]/u.test(c)) return true;
  return /[\p{Ps}\p{Pe}]/u.test(c) && !PLAIN_BRACKETS.has(c);
}

/** @param {{ f: Record<string,string> }} i */
function gQuotes(i) {
  const check = (/** @type {string} */ t) => {
    const chars = Array.from(t);
    for (let k = 0; k < chars.length; k++) {
      const c = chars[k];
      if (ALWAYS_QUOTE.has(c) || isQuoteClass(c)) return false;
      if (APOSTROPHE.has(c)) {
        const prev = chars[k - 1] ?? '';
        const next = chars[k + 1] ?? '';
        if (!/\p{L}/u.test(prev) || !/\p{L}/u.test(next)) return false;
      }
    }
    return true;
  };
  for (const k of FIELDS) if (!check(i.f[k]) || !check(i.f[k].normalize('NFKC'))) return 'quote';
  return true;
}

/** @param {{ f: Record<string,string> }} i @param {GateContext} ctx */
function gBuzzwords(i, ctx) {
  const text = body(i.f);
  const pad = padded(text);
  for (const w of ctx.style.buzzwords) if (hasPhrase(pad, w)) return 'buzzword';
  return true;
}

/** @param {{ f: Record<string,string> }} i @param {GateContext} ctx */
function gProblemComparison(i, ctx) {
  const t = foldText(body(i.f));
  for (const p of ctx.style.problemComparisonPatterns) {
    if (new RegExp(p, 'i').test(t)) return 'problem_comparison';
  }
  // "not X, it is Y" / "not X but Y" in one sentence.
  if (/\b(?:isn't|is not|wasn't|was not|aren't|are not|not)\b[^.;!?]{1,60}[,;]\s*(?:it's|it is|this is|that's|that is|but rather|rather)\b/.test(t)) return 'problem_comparison';
  // "not about X but about Y" (fix 2): the same preposition after "not" and after "but", in one sentence. Also in
  // config/style-checks.json for render_doc; here so the gate never depends on the config being current.
  if (/\bnot (?:just |only |really |simply |merely )?(about|for|on|in|with|to|of|by|because|how|what|who|why)\b[^.;!?]{1,60}?[,;]?\s+but (?:rather |instead )?\1\b/.test(t)) return 'problem_comparison';
  return true;
}

/**
 * @param {string} text
 * @param {string} entry
 * @returns {boolean}
 */
function hitsEntry(text, entry) {
  const nameForms = [foldText(normalizeName(entry)), foldText(entry)];
  for (const n of nameForms) if (n.length >= 3 && hasPhrase(text, n)) return true;
  const sq = squash(entry);
  const sf = strippedForm(normalizeName(entry));
  const t1 = squash(text);
  const t2 = squashLeet(text);
  const t3 = strippedForm(normalizeName(text));
  if (sq.length >= 4 && (t1.includes(sq) || t3.includes(sq))) return true;
  if (sf.length >= 4 && t3.includes(sf)) return true;
  const sl = squashLeet(entry);
  return sl.length >= 4 && t2.includes(sl);
}

/** @param {{ f: Record<string,string>, s: Array<{text:string,src:string}> }} i @param {GateContext} ctx */
function gBlocked(i, ctx) {
  const texts = [...FIELDS.map((k) => i.f[k]), ...i.s.map((x) => x.text)];
  for (const e of ctx.blockedEntries) {
    if (typeof e !== 'string' || e.trim() === '') continue;
    for (const t of texts) if (hitsEntry(t, e)) return 'blocked_name';
  }
  return true;
}

/** @param {{ f: Record<string,string> }} i */
function gEmployer(i) {
  const t = foldText(body(i.f));
  for (const re of EMPLOYER_PATTERNS) if (re.test(t)) return 'employer_leak';
  return true;
}

/** @param {{ f: Record<string,string> }} i */
function gCompensation(i) {
  const raw = body(i.f).normalize('NFKC');
  const t = foldText(raw);
  if (CURRENCY_RE.test(raw.toLowerCase()) || K_FIGURE_RE.test(t) || MAGNITUDE_RE.test(t)) return 'compensation';
  for (const p of COMPENSATION_PHRASES) if (hasPhrase(t, p)) return 'compensation';
  return true;
}

/** @param {{ f: Record<string,string> }} i @param {GateContext} ctx */
function gConfidential(i, ctx) {
  const t = body(i.f);
  for (const d of ctx.denylist ?? []) {
    if (typeof d !== 'string' || squash(d).length < 3) continue;
    if (hasPhrase(t, d) || squash(t).includes(squash(d))) return 'confidential';
  }
  return true;
}

/** @param {string} w @returns {boolean} */
function isUkWord(w) {
  if (UK_WORDS.has(w)) return true;
  for (const stem of UK_ISE_STEMS) {
    if (w.startsWith(stem)) {
      const rest = w.slice(stem.length);
      if (ISE_ENDS.includes(rest)) return true;
    }
  }
  return false;
}

/** @param {{ f: Record<string,string> }} i */
function gUk(i) {
  for (const w of tokens(body(i.f))) if (isUkWord(w.replace(/'s$/, ''))) return 'uk_spelling';
  return true;
}

/** @param {{ f: Record<string,string>, s: Array<{text:string,src:string}> }} i @param {GateContext} ctx */
function gUrls(i, ctx) {
  const t = foldText(body(i.f));
  if (/:\/\/|\bwww\b|@/.test(t) || /\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}/.test(t) || /[[({]\s*(?:dot|at)\s*[\])}]/.test(t)) return 'url';
  if (hasPhrase(t, 'dot') || hasPhrase(t, 'dot com')) return 'url';
  // A domain split around a dot token (fix 2): a label, whitespace, a lone dot, then a label ("acme . com"), or a
  // dot token glued to the label on its right ("acme .com"). A sentence boundary ("end. Com") has no whitespace
  // before its dot and does not match; neither does an ellipsis or a bare dot at the start of a line.
  if (/[a-z0-9]\s+\.\s*[a-z]{2,}\b/.test(t)) return 'url';
  const citedIds = new Set(i.s.map((x) => /^e(\d+)$/.exec(x.src)?.[1]).filter((x) => typeof x === 'string'));
  const cited = foldText([...citedIds].map((id) => ctx.evidence[/** @type {string} */ (id)] ?? '').join(' '));
  for (const m of t.matchAll(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+/g)) {
    const tok = m[0].replace(/\.+$/, '');
    const labels = tok.split('.');
    const last = labels[labels.length - 1];
    if (labels.length < 2 || !/^[a-z]{2,}$/.test(last)) continue;
    if (/^[\d.]+$/.test(tok)) continue;
    if (!cited.includes(tok)) return 'url';
  }
  return true;
}

/** @param {{ f: Record<string,string> }} i @param {GateContext} ctx */
function gNames(i, ctx) {
  const t = body(i.f);
  const pad = padded(t);
  const names = [ctx.contactName ?? '', ...(ctx.candidateNames ?? []), ...(ctx.personNames ?? [])];
  for (const n of names) {
    if (typeof n !== 'string' || n.trim() === '') continue;
    if (hasPhrase(pad, n)) return 'person_name';
    for (const part of tokens(n)) if (part.length >= 3 && pad.includes(` ${part} `)) return 'person_name';
  }
  if (/\b(?:[Mm]r|[Mm]rs|[Mm]s|[Mm]x|[Dd]r|[Pp]rof)\.?\s+[A-Z]/.test(t)) return 'person_name';
  return true;
}

/** @param {string} s @returns {Set<string>} */
function wordSet(s) {
  return new Set(tokens(s).map((w) => w.replace(/'s$/, '')));
}

/**
 * Capitalized name tokens of a sentence: every capitalized token after the first, and a capitalized first token
 * that is not an ordinary sentence starter. Possessives are stripped. Generic capitalized words are skipped.
 * @param {string} sentence
 * @returns {string[]}
 */
function capitalizedNames(sentence) {
  const raw = sentence.normalize('NFKC').split(/[^\p{L}\p{N}'-]+/u).filter((x) => x !== '');
  const out = [];
  for (let k = 0; k < raw.length; k++) {
    const w = raw[k].replace(/^['-]+|['-]+$/g, '').replace(/'s$/i, '');
    if (!w || !/^\p{Lu}/u.test(w)) continue;
    const low = foldText(w);
    if (GENERIC_CAPS.has(low)) continue;
    if (k === 0 && SENTENCE_STARTERS.has(low)) continue;
    for (const part of low.split('-')) if (part) out.push(part);
  }
  return out;
}

/** @param {string} company @returns {Set<string>} */
function companyTokens(company) {
  return new Set(tokens(company).filter((t) => t.length >= 2));
}

/** @param {string} company @returns {string[]} usable naming tokens */
function companyKeyTokens(company) {
  return tokens(company).filter((t) => t.length >= 3 && !LEGAL_SUFFIX.has(t));
}

/**
 * @param {Record<string, string>} f
 * @param {Array<{text:string,src:string}>} s
 * @returns {Array<{ text: string, src: string, field: string }>|null} null when the sentences do not cover the fields exactly
 */
function assignFields(f, s) {
  const target = FIELDS.map((k) => collapse(f[k]));
  const joinedFields = target.join(' ');
  const joinedSentences = s.map((x) => collapse(x.text)).join(' ');
  if (joinedFields !== joinedSentences) return null;
  /** @type {Array<{ text: string, src: string, field: string }>} */
  const out = [];
  let pos = 0;
  const ranges = [];
  for (let k = 0; k < FIELDS.length; k++) {
    ranges.push([pos, pos + target[k].length, FIELDS[k]]);
    pos += target[k].length + 1;
  }
  let cursor = 0;
  for (const x of s) {
    const t = collapse(x.text);
    const start = cursor;
    const end = cursor + t.length;
    const r = ranges.find((rg) => start >= Number(rg[0]) && end <= Number(rg[1]));
    if (!r) return null;
    out.push({ text: t, src: x.src, field: String(r[2]) });
    cursor = end + 1;
  }
  return out;
}

/**
 * @param {{ f: Record<string,string>, s: Array<{text:string,src:string}> }} i
 * @param {GateContext} ctx
 * @param {'machine'|'edited'} mode
 * @returns {true|string}
 */
function gCitation(i, ctx, mode) {
  const kind = ctx.triggerKind;
  if (kind !== 'pe_deal' && kind !== 'exec_departure' && kind !== 'leadership_gap') return 'trigger_mismatch';
  const rows = assignFields(i.f, i.s);
  if (!rows) return 'citation_cover';
  const factById = new Map(ctx.facts.map((x) => [x.id, x]));
  const co = companyTokens(ctx.company);
  let worst = /** @type {string|null} */ (null);
  const fail = (/** @type {string} */ code) => { worst = worst ?? code; };
  let hookHasE = false;
  let claimHasC = false;
  let ownKindSeen = false;
  let uncited = false;
  for (const r of rows) {
    if (r.src === 'edited') {
      if (mode !== 'edited') return 'citation_source';
      uncited = true;
      continue;
    }
    if (r.src === 'ask') {
      if (r.field !== 'ask') return 'citation_source';
      if (/\d/.test(r.text)) { fail('ask_claim'); continue; }
      const allowed = new Set([...co]);
      for (const n of capitalizedNames(r.text)) if (!allowed.has(n)) fail('ask_claim');
      continue;
    }
    if (r.field === 'ask') { fail('citation_source'); continue; }
    const em = /^e(\d+)$/.exec(r.src);
    if (em) {
      const excerpt = ctx.evidence[em[1]];
      if (typeof excerpt !== 'string') { fail('citation_source'); continue; }
      const exNums = new Set(numbersOf(excerpt));
      for (const n of numbersOf(r.text)) if (!exNums.has(n)) fail('citation_number');
      const exWords = wordSet(excerpt);
      for (const n of capitalizedNames(r.text)) if (!exWords.has(n) && !co.has(n)) fail('citation_name');
      let own = false;
      let other = false;
      for (const [k, verbs] of Object.entries(TRIGGER_VERBS)) {
        const hit = verbs.some((v) => hasPhrase(r.text, v));
        if (hit && k === kind) own = true;
        if (hit && k !== kind) other = true;
      }
      if (own) ownKindSeen = true;
      if (other && !own) fail('trigger_mismatch');
      if (r.field === 'hook') hookHasE = true;
      continue;
    }
    const cm = /^c(\d+)$/.exec(r.src);
    if (cm) {
      const fact = factById.get(r.src);
      if (!fact) { fail('citation_source'); continue; }
      if ((fact.tags ?? []).some((t) => /employer/i.test(t))) { fail('employer_leak'); continue; }
      const fNums = new Set(numbersOf(fact.text));
      for (const n of numbersOf(r.text)) if (!fNums.has(n)) fail('citation_number');
      const fWords = wordSet(fact.text);
      for (const n of capitalizedNames(r.text)) if (!fWords.has(n) && !co.has(n)) fail('citation_name');
      if (r.field === 'claim') claimHasC = true;
      continue;
    }
    fail('citation_source');
  }
  if (!hookHasE && mode === 'machine') fail('citation_missing');
  if (!claimHasC && mode === 'machine') fail('citation_missing');
  if (!ownKindSeen && mode === 'machine') fail('trigger_mismatch');
  if (worst) return worst;
  if (uncited) return 'edited_uncited';
  if (mode === 'edited' && (!hookHasE || !claimHasC || !ownKindSeen)) return 'citation_missing';
  return true;
}

/** @param {{ f: Record<string,string> }} i @param {GateContext} ctx */
function gCompanyNamed(i, ctx) {
  const keys = companyKeyTokens(ctx.company);
  if (keys.length === 0) return 'company_unnamed';
  const have = new Set(tokens(`${i.f.hook} ${i.f.bridge}`).map((t) => t.replace(/'s$/, '')));
  return keys.some((k) => have.has(k)) ? true : 'company_unnamed';
}

/**
 * Derive sentence tags for an edited text. A field that is unchanged keeps its previous tagged sentences; in a
 * changed field a sentence identical to a previous one of the same field keeps its tag, any other sentence is
 * tagged "edited". Total: when the previous tags do not cover the previous fields, every sentence is "edited".
 * @param {Record<string, string>} fields
 * @param {{ fields: Record<string, string>, sentences: Array<{ text: string, src: string }> }} previous
 * @returns {Array<{ text: string, src: string }>}
 */
export function deriveSentences(fields, previous) {
  /** @type {Array<{ text: string, src: string, field: string }>|null} */
  let prevRows = null;
  try {
    prevRows = assignFields(fieldsOf(previous.fields), sentencesOf(previous.sentences));
  } catch {
    prevRows = null;
  }
  /** @type {Array<{ text: string, src: string }>} */
  const out = [];
  for (const k of FIELDS) {
    const rows = (prevRows ?? []).filter((r) => r.field === k);
    if (prevRows && collapse(fields[k]) === collapse(previous.fields[k])) {
      for (const r of rows) out.push({ text: r.text, src: r.src });
      continue;
    }
    const prev = new Map(rows.map((r) => [r.text, r.src]));
    for (const sentence of splitSentences(fields[k])) {
      const src = prev.get(collapse(sentence));
      out.push({ text: sentence, src: src !== undefined && src !== 'edited' ? src : 'edited' });
    }
  }
  return out;
}

/** The fixed gate table: [name, function]. */
const GATES = Object.freeze([
  ['shape', (/** @type {any} */ i) => gShape(i)],
  ['verdict_token', (/** @type {any} */ i) => gVerdict(i)],
  ['words', (/** @type {any} */ i) => gWords(i)],
  ['greeting_signoff', (/** @type {any} */ i) => gGreeting(i)],
  ['dashes', (/** @type {any} */ i) => gDashes(i)],
  ['quotes', (/** @type {any} */ i) => gQuotes(i)],
  ['buzzwords', (/** @type {any} */ i, /** @type {GateContext} */ c) => gBuzzwords(i, c)],
  ['problem_comparison', (/** @type {any} */ i, /** @type {GateContext} */ c) => gProblemComparison(i, c)],
  ['blocked_names', (/** @type {any} */ i, /** @type {GateContext} */ c) => gBlocked(i, c)],
  ['employer', (/** @type {any} */ i) => gEmployer(i)],
  ['compensation', (/** @type {any} */ i) => gCompensation(i)],
  ['confidential', (/** @type {any} */ i, /** @type {GateContext} */ c) => gConfidential(i, c)],
  ['us_english', (/** @type {any} */ i) => gUk(i)],
  ['urls', (/** @type {any} */ i, /** @type {GateContext} */ c) => gUrls(i, c)],
  ['names', (/** @type {any} */ i, /** @type {GateContext} */ c) => gNames(i, c)],
  ['company_named', (/** @type {any} */ i, /** @type {GateContext} */ c) => gCompanyNamed(i, c)],
  ['citation', (/** @type {any} */ i, /** @type {GateContext} */ c, /** @type {'machine'|'edited'} */ m) => gCitation(i, c, m)],
]);

export const GATE_NAMES = Object.freeze(GATES.map((g) => g[0]));

/**
 * Run every gate. Total: always one result per gate, in table order.
 * @param {GateInput} input
 * @returns {{ pass: boolean, advisory: boolean, mode: 'machine'|'edited', results: GateResult[], codes: string[] }}
 */
export function runGates(input) {
  const mode = input && input.mode === 'edited' ? 'edited' : 'machine';
  /** @type {{ f: Record<string,string>, s: Array<{text:string,src:string}> }|null} */
  let parsed = null;
  /** @type {GateContext|null} */
  let ctx = null;
  try {
    ctx = input.ctx;
    if (!ctx || typeof ctx !== 'object' || !ctx.style || !Array.isArray(ctx.blockedEntries) || !Array.isArray(ctx.facts) || !ctx.evidence) throw new Error('ctx');
    parsed = { f: fieldsOf(input.fields), s: sentencesOf(input.sentences) };
  } catch {
    parsed = null;
  }
  /** @type {GateResult[]} */
  const results = [];
  for (const [name, fn] of GATES) {
    /** @type {GateResult} */
    let r;
    try {
      if (!parsed || !ctx) {
        r = { gate: name, ok: false, code: name === 'shape' ? 'shape' : 'gate_error' };
      } else {
        const v = fn(parsed, ctx, mode);
        if (v === true) r = { gate: name, ok: true, code: null };
        else if (typeof v === 'string' && CODE_SET.has(v)) r = { gate: name, ok: false, code: v };
        else r = { gate: name, ok: false, code: 'gate_error' };
      }
    } catch {
      r = { gate: name, ok: false, code: 'gate_error' };
    }
    results.push(r);
  }
  const codes = [...new Set(results.filter((x) => !x.ok).map((x) => /** @type {string} */ (x.code)))];
  return { pass: codes.length === 0, advisory: mode === 'edited', mode, results, codes };
}
