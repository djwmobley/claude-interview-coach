// @ts-check
/**
 * Application mail classifier (apply pipeline slice 7, plan `let-s-brainstorm-a-bit-humble-umbrella.md`
 * section "6. Confirmation tracking", amended by the slice-7 spec-adversary pass -- see the PR body for
 * the full list of amendments). Pure, no DB, no network: classifyApplicationMail(msg) -> a TOTAL
 * classification of one already-decoded Gmail message into exactly one of {received, rejected, closed,
 * unknown}, plus a best-effort company extraction. `unknown` is the default branch -- a message this
 * module cannot confidently place is never silently treated as any of the other three.
 *
 * PRECEDENCE (amended decision 4): rejection clauses OUTRANK the shared "thank you for applying" opener
 * -- checked in the order rejected -> closed -> received -> unknown below, because many real rejection
 * mails open with a thank-you line before the actual decision. A message matching more than one category
 * always resolves to the highest-precedence one, never the first one found by accident of regex order
 * within a category.
 *
 * A contentless status-change notification (the plan's own Workday example, "your application status has
 * changed", carrying no other wording) is `unknown` BY CONSTRUCTION: it is not special-cased anywhere
 * below, it simply fails to match any of the three phrase libraries and falls through to the default
 * branch. Direction (confirm vs reject) is NEVER inferred from the sender's identity, only from this
 * module's own reading of the subject/body content -- see the module's own test file for a message from a
 * legitimate ATS sender address that still classifies `unknown` because its content says nothing.
 */
import { normalizeCompany } from '../core/normalize.js';
import { classifyApplyUrl } from './ats-detect.js';

/**
 * @typedef {{ kind: 'received'|'rejected'|'closed'|'unknown', company_raw: string|null, company_norm: string, matchedPhrase: string|null }} MailClassification
 */

// ---------------------------------------------------------------------------
// Phrase library. Every array entry is a case-insensitive regex tested against
// the COMBINED subject + body text. Order within a category never matters
// (first match short-circuits, but any match in the category has the same
// effect); order BETWEEN categories is the precedence rule documented above.
// ---------------------------------------------------------------------------

/** Rejection clauses: outrank everything else (amended decision 4). */
const REJECTION_PHRASES = Object.freeze([
  /\bwe(?:'| ha)ve decided (?:not )?to (?:move forward|proceed) with (?:other|different) candidates?\b/i,
  /\bwe will not be moving forward with your application\b/i,
  /\bnot (?:be )?moving forward with your (?:candidacy|application)\b/i,
  /\bwe regret to inform you\b/i,
  /\byour application (?:was|has been) not selected\b/i,
  /\bwe(?:'| ha)ve chosen to (?:pursue|move forward with) other candidates\b/i,
  /\b(?:after (?:careful|further) (?:review|consideration)|unfortunately)[^.\n]{0,120}\b(?:will not be moving forward|not moving forward|decided not to proceed|not selected|unable to offer you)\b/i,
  /\byou (?:were|are) not selected for (?:this|the) (?:position|role)\b/i,
  /\bno longer (?:being considered|under consideration) for this (?:position|role)\b/i,
  /\bwe have decided to pursue candidates? whose (?:experience|qualifications|background) (?:more closely|better) (?:match|matches|align)\b/i,
]);

/**
 * Position-closed clauses: the requisition itself closed, distinct from a personal rejection. The
 * "position ... has been filled/closed" and "role/job is no longer ..." shapes tolerate an OPTIONAL
 * intervening "at <company>" / "for <role>" clause between the noun ("position"/"role"/"job") and the
 * verb clause -- a real closed-posting mail commonly reads "The position at Acme has been filled", not
 * only the bare "This position has been filled" -- so the gap between them is `[^.\n]{0,60}?` (anything
 * short of a sentence break), not a fixed literal phrase.
 */
const CLOSED_PHRASES = Object.freeze([
  /\b(?:this|the)\s+position[^.\n]{0,60}?\s+(?:has been|is)\s+(?:filled|closed)\b/i,
  /\b(?:this|the)\s+(?:role|position|job)[^.\n]{0,60}?\s+is no longer\s+(?:available|accepting applications)\b/i,
  /\bthe requisition (?:has been|is) closed\b/i,
  /\bthis job posting (?:has|is) (?:closed|expired)\b/i,
  /\bno longer accepting applications for this (?:role|position)\b/i,
  /\bthis (?:opening|vacancy) has been withdrawn\b/i,
]);

/** Confirmation ("thank you for applying") opener: LOWEST precedence, checked only when nothing above matched. */
const RECEIVED_PHRASES = Object.freeze([
  /\bthank you for applying\b/i,
  /\bthanks for applying\b/i,
  /\bwe(?:'| ha)ve received your application\b/i,
  /\byour application (?:has been|was) (?:successfully )?(?:received|submitted)\b/i,
  /\bthank you for your interest in (?:this|the) (?:position|role|opportunity)[^.\n]{0,60}\bapplication\b/i,
  /\bwe appreciate you(?:r| having) applied\b/i,
]);

/**
 * @param {readonly RegExp[]} phrases
 * @param {string} text
 * @returns {string|null} the source of the first matching regex, or null
 */
function firstMatch(phrases, text) {
  for (const re of phrases) {
    if (re.test(text)) return re.source;
  }
  return null;
}

/**
 * Total: any input (including empty strings) maps to exactly one of the four kinds.
 * @param {{ subject: string, text: string }} body
 * @returns {{ kind: MailClassification['kind'], matchedPhrase: string|null }}
 */
export function classifyBody(body) {
  const combined = `${body.subject ?? ''}\n${body.text ?? ''}`;
  const rejected = firstMatch(REJECTION_PHRASES, combined);
  if (rejected) return { kind: 'rejected', matchedPhrase: rejected };
  const closed = firstMatch(CLOSED_PHRASES, combined);
  if (closed) return { kind: 'closed', matchedPhrase: closed };
  const received = firstMatch(RECEIVED_PHRASES, combined);
  if (received) return { kind: 'received', matchedPhrase: received };
  return { kind: 'unknown', matchedPhrase: null };
}

// ---------------------------------------------------------------------------
// Company extraction (best effort, documented blind spot: real-world phrasing
// diversity beyond these patterns is not covered -- see the PR body). Direction
// is never derived from any of this; company extraction is purely a
// correlation aid for finding WHICH application a message is about.
// ---------------------------------------------------------------------------

/** Company name shape: starts with an uppercase/digit char, stops at sentence punctuation or newline. */
const COMPANY_TOKEN = `[A-Z0-9][\\w&.,'’\\- ]{0,79}?`;
const COMPANY_EXTRACT_PATTERNS = Object.freeze([
  new RegExp(`thank you for (?:applying|your application) (?:to|at|with)\\s+(${COMPANY_TOKEN})(?=[.!,\\n]|$)`, 'i'),
  new RegExp(`your application (?:to|for|with)\\s+(${COMPANY_TOKEN})(?=[.!,\\n]|$)`, 'i'),
  new RegExp(`application (?:to|for|at)\\s+(${COMPANY_TOKEN})(?=[.!,\\n]|$)`, 'i'),
  new RegExp(`\\bat\\s+(${COMPANY_TOKEN})\\s+(?:has been|is no longer|position)`, 'i'),
  new RegExp(`interest in (?:working at|joining)\\s+(${COMPANY_TOKEN})(?=[.!,\\n]|$)`, 'i'),
]);

/** Strip a trailing recruiting-team suffix from a From display name ("Acme Corp Careers" -> "Acme Corp"). */
const FROM_NAME_SUFFIX_RE = /\s+(?:careers?|recruiting|talent acquisition|talent team|hiring team|hr team|human resources|team|no-?reply)\s*$/i;

/**
 * Best-effort raw company string from subject/body text, falling back to the mail's From display name.
 * Total: no match anywhere yields null, never a throw.
 * @param {{ subject: string, text: string, fromName: string|null }} body
 * @returns {string|null}
 */
export function extractCompanyRaw(body) {
  const combined = `${body.subject ?? ''}\n${body.text ?? ''}`;
  for (const re of COMPANY_EXTRACT_PATTERNS) {
    const m = re.exec(combined);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  if (body.fromName) {
    const cleaned = body.fromName.replace(FROM_NAME_SUFFIX_RE, '').trim();
    // A From display name with nothing left after stripping the recruiting-team suffix (e.g. the whole
    // name WAS "Careers Team") carries no company signal; also refuse a name that still ends in a
    // suffix word after one pass (rare double-suffix form like "X Recruiting Team") by requiring the
    // survivor look like an actual name (starts with a letter/digit, at least 2 chars).
    if (cleaned && cleaned.length >= 2 && /^[A-Za-z0-9]/.test(cleaned)) return cleaned;
  }
  return null;
}

/**
 * Full classification of one decoded application-related mail. Total: never throws.
 * @param {{ subject?: string|null, text?: string|null, html?: string|null, fromName?: string|null }} msg
 * @returns {MailClassification}
 */
export function classifyApplicationMail(msg) {
  const subject = typeof msg.subject === 'string' ? msg.subject : '';
  const text = typeof msg.text === 'string' && msg.text ? msg.text : (typeof msg.html === 'string' ? stripTags(msg.html) : '');
  const fromName = typeof msg.fromName === 'string' ? msg.fromName : null;
  const { kind, matchedPhrase } = classifyBody({ subject, text });
  const companyRaw = extractCompanyRaw({ subject, text, fromName });
  const { company_norm } = normalizeCompany(companyRaw);
  return { kind, company_raw: companyRaw, company_norm, matchedPhrase };
}

// ---------------------------------------------------------------------------
// URL-based corroboration/veto (classifier traps, plan "Known blind spots of the design": a staffing
// agency reposting on boards.greenhouse.io/embed/job_app?for=agency must not cause a confirmation for the
// wrong company; host suffix matching must reject a spoofed host like greenhouse.io.example.com). Reuses
// classifyApplyUrl from ats-detect.js -- the SAME host-boundary-safe (new URL(...).hostname, dot-anchored
// suffix match) classifier the apply worker already trusts for routing -- rather than any new home-grown
// substring/regex host check here.
// ---------------------------------------------------------------------------

const URL_SCAN_RE = /https?:\/\/[^\s"'<>]+/g;

/**
 * Every http(s) URL in `text`, in document order. Total: no URLs found -> empty array.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  return String(text ?? '').match(URL_SCAN_RE) ?? [];
}

/**
 * True only when the mail body contains an EXACT-confidence ATS URL (never an 'inferred' or 'low' one --
 * an agency's `?for=agency` query param is 'inferred' by ats-detect.js's own design, and a spoofed host
 * like `boards.greenhouse.io.example.com` classifies 'unknown', so NEITHER can ever trigger this veto)
 * whose ats+tenant DIFFERS from `candidateApplyUrl`'s own exact-confidence classification. This function
 * only ever NARROWS a match (a caller uses it to veto an otherwise-plausible company-text correlation) --
 * it never asserts a match on its own: no URL in the mail, no exact-confidence URL, no
 * candidateApplyUrl, or matching tenants all return false.
 * @param {string} text
 * @param {string|null|undefined} candidateApplyUrl
 * @returns {boolean}
 */
export function mailUrlContradictsCandidate(text, candidateApplyUrl) {
  if (!candidateApplyUrl) return false;
  const candidate = classifyApplyUrl(candidateApplyUrl);
  if (candidate.confidence !== 'exact' || !candidate.tenant) return false;
  const exactMailUrls = extractUrls(text)
    .map((u) => classifyApplyUrl(u))
    .filter((c) => c.confidence === 'exact' && c.tenant);
  if (exactMailUrls.length === 0) return false;
  const corroborated = exactMailUrls.some((c) => c.ats === candidate.ats && c.tenant === candidate.tenant);
  return !corroborated;
}

/**
 * Minimal HTML-to-text: strips tags so the phrase/company regexes above can scan an HTML-only body the
 * same way they scan text/plain. Not a real HTML parser -- mirrors src/apply/gmail-verify.js's own
 * stripTags, duplicated deliberately rather than imported (see that file's doc comment on why the apply
 * side keeps its small text helpers self-contained instead of depending on src/adapters/*).
 * @param {string} html
 */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ');
}
