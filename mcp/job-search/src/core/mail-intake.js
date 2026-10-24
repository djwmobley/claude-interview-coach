// @ts-check
/**
 * Personal mail intake classifier (sql/029). PURE: no network, no DB, no model. Every Gmail message in the
 * intake window maps to EXACTLY ONE bucket, checked in this fixed priority; an input nothing matches lands in
 * the default branch (`unsorted`), whose failure mode is a visible, correctable row, never a silent drop:
 *
 *   1 self              From (lowercased, +tag stripped) is the Gmail profile address or a configured alias.
 *                       Reply-To and Sender are shown but NEVER grant self.
 *   2 registered_alert  a sender in config/alert-senders.json (the existing parsers handle these, unchanged).
 *   3 application_mail  whatever src/apply/mail-classifier.js recognizes (received, rejected, closed). Counted only.
 *   4 internal          the current employer's domain, or a calendar invite. Counted only.
 *   5 thread_reply      a message in a thread Damian sent to, from someone else, excluding auto-replies.
 *   6 recruiter_like    STRONG (title term near a recruiting term, any headers), KNOWN FIRM (search-firm domain
 *                       plus a title term), LINKEDIN INMAIL (a LinkedIn messaging notification), WEAK (non-bulk,
 *                       title term, near "opportunity"/"role"/"position"), or body_unreadable (a body we tried
 *                       and failed to read, so a human looks). Bulk headers alone NEVER exclude STRONG or
 *                       KNOWN FIRM.
 *   7 bulk_noise        bulk headers and no recruiter match. Counted, top senders listed.
 *   8 unsorted          the default.
 *
 * Privacy: nothing in this module is ever passed to a model. Triage and every Claude step are structurally
 * separate (test/mail-intake-no-model.test.js asserts it).
 */
import crypto from 'node:crypto';
import { classifyBody } from '../apply/mail-classifier.js';
import { htmlToText } from './normalize.js';

/** Bump when the classification rules below change; the config content hash is appended (rulesVersionFor). */
export const MAIL_RULES_VERSION = 'mail-1';

export const BUCKETS = Object.freeze(['self', 'registered_alert', 'application_mail', 'internal', 'thread_reply', 'recruiter_like', 'bulk_noise', 'unsorted']);

/** Buckets that become review items. */
export const SURFACED_BUCKETS = Object.freeze(['recruiter_like', 'thread_reply']);

/** Buckets whose subject and snippet are stored (the rest keep the sender address only). */
export const DETAIL_BUCKETS = Object.freeze(['recruiter_like', 'thread_reply', 'unsorted']);

/** Distance (chars) within which a title term and a recruiting term count as the same sentence. */
export const PROXIMITY_CHARS = 200;

/**
 * rules_version for a config: the code version plus a short hash of the mail-intake config, so editing the
 * search-firm list reprocesses the rows that might now match.
 * @param {any} cfg
 */
export function rulesVersionFor(cfg) {
  const h = crypto.createHash('sha1').update(JSON.stringify(cfg ?? {})).digest('hex').slice(0, 8);
  return `${MAIL_RULES_VERSION}:${h}`;
}

// ---------------------------------------------------------------------------
// Headers and addresses
// ---------------------------------------------------------------------------

/**
 * Lowercase header-name -> first value map from a Gmail payload.
 * @param {any} payload
 * @returns {Record<string, string>}
 */
export function headerMap(payload) {
  /** @type {Record<string, string>} */
  const out = {};
  const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
  for (const h of headers) {
    const k = String(h && h.name).toLowerCase();
    if (k && !(k in out)) out[k] = String(h.value ?? '');
  }
  return out;
}

/**
 * Display name and addr-spec of an address header ("Name <a@b.com>" or a bare address).
 * @param {string|null|undefined} header
 * @returns {{ addr: string|null, name: string|null }}
 */
export function parseAddress(header) {
  if (!header) return { addr: null, name: null };
  const angle = /<([^<>]+)>/.exec(header);
  const rawAddr = (angle ? angle[1] : header).trim().toLowerCase();
  const addr = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(rawAddr) ? rawAddr : null;
  let name = angle ? header.slice(0, header.indexOf('<')).trim().replace(/^"|"$/g, '').trim() : null;
  if (name === '') name = null;
  return { addr, name };
}

/**
 * Self-comparison form of an address: lowercased, the +tag stripped from the local part. Nothing else (a
 * lookalike domain or a dotted variant is NOT self).
 * @param {string|null|undefined} addr
 * @returns {string|null}
 */
export function normalizeSelf(addr) {
  if (!addr) return null;
  const a = String(addr).trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at < 1) return null;
  const local = a.slice(0, at).replace(/\+.*$/, '');
  return `${local}@${a.slice(at + 1)}`;
}

/** @param {string|null|undefined} addr */
export function domainOf(addr) {
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : null;
}

/**
 * Domain equals one of `domains`, or is a subdomain of one (dot-anchored, never a substring match).
 * @param {string|null} domain
 * @param {readonly string[]} domains
 */
export function domainInList(domain, domains) {
  if (!domain) return false;
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Bulk-mail headers: a mailing list or an auto-generated message. @param {Record<string, string>} h */
export function isBulk(h) {
  if ('list-unsubscribe' in h || 'list-id' in h) return true;
  const prec = (h.precedence || '').trim().toLowerCase();
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return true;
  if (isAutoSubmitted(h)) return true;
  return false;
}

/** Auto-Submitted other than "no". @param {Record<string, string>} h */
function isAutoSubmitted(h) {
  const a = (h['auto-submitted'] || '').trim().toLowerCase();
  return a !== '' && a !== 'no';
}

/** An automatic reply: Auto-Submitted other than "no", or Precedence auto_reply. @param {Record<string, string>} h */
export function isAutoReply(h) {
  return isAutoSubmitted(h) || (h.precedence || '').trim().toLowerCase() === 'auto_reply';
}

// ---------------------------------------------------------------------------
// Term matching
// ---------------------------------------------------------------------------

/** Chief * Officer, CIO, CTO, CDO, CAIO, COO, VP, SVP, EVP, Head of (plus the spelled-out "vice president"). */
const TITLE_RE = /\b(?:chief\s+(?:[a-z&-]+\s+){0,3}officer|cio|cto|cdo|caio|coo|vp|svp|evp|vice\s+president|head\s+of)\b/gi;
const RECRUIT_RE = /\b(?:recruit\w*|executive\s+search|retained\s+search|search\s+firm|your\s+profile|your\s+background|confidential\s+search|candidates?)\b/gi;
/** Recruiting cues that earn a body read for bulk mail (subject or snippet). */
const RECRUITING_CUE_RE = /\b(?:opportunit\w*|role|position|search|confidential|recruit\w*|your\s+profile|your\s+background|executive)\b/i;
const OPPORTUNITY_RE = /\b(?:opportunity|opportunities|role|position)\b/gi;

/**
 * Start/end offsets of every match of a global regex.
 * @param {RegExp} re
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function spans(re, text) {
  /** @type {Array<[number, number]>} */
  const out = [];
  const r = new RegExp(re.source, re.flags);
  let m;
  while ((m = r.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) r.lastIndex++;
  }
  return out;
}

/** True when some span in `a` lies within `max` chars of some span in `b` (gap between them, not start to start). */
function anyNear(a, b, max) {
  for (const [s1, e1] of a) {
    for (const [s2, e2] of b) {
      const gap = Math.max(s1, s2) - Math.min(e1, e2);
      if (gap <= max) return true;
    }
  }
  return false;
}

/** @param {string} text */
export function hasTitleTerm(text) {
  return spans(TITLE_RE, text).length > 0;
}

/** Title term within PROXIMITY_CHARS of a recruiting term. @param {string} text */
export function strongMatch(text) {
  return anyNear(spans(TITLE_RE, text), spans(RECRUIT_RE, text), PROXIMITY_CHARS);
}

/** Title term within PROXIMITY_CHARS of "opportunity", "role" or "position". @param {string} text */
export function weakMatch(text) {
  return anyNear(spans(TITLE_RE, text), spans(OPPORTUNITY_RE, text), PROXIMITY_CHARS);
}

// ---------------------------------------------------------------------------
// Display text
// ---------------------------------------------------------------------------

/**
 * Display snippet: HTML tags and URLs stripped, whitespace collapsed, at most `max` chars. The result is
 * plain text; every renderer escapes it (escapeHtml, or textContent in the dashboard).
 * @param {string|null|undefined} text
 * @param {number} [max]
 */
export function sanitizeSnippet(text, max = 500) {
  let s = String(text ?? '');
  s = htmlToText(s);
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/**
 * The Gmail tab a label set puts a message in.
 * @param {string[]|null|undefined} labels
 */
export function gmailTab(labels) {
  const set = new Set(labels ?? []);
  if (set.has('SPAM')) return 'Spam';
  if (set.has('CATEGORY_PROMOTIONS')) return 'Promotions';
  if (set.has('CATEGORY_SOCIAL')) return 'Social';
  if (set.has('CATEGORY_UPDATES')) return 'Updates';
  if (set.has('CATEGORY_FORUMS')) return 'Forums';
  if (set.has('CATEGORY_PERSONAL') || set.has('INBOX')) return 'Primary';
  return 'Other';
}

/** Link to a message in Gmail; null for an id that is not a Gmail hex id. @param {string} id */
export function gmailMessageUrl(id) {
  return /^[0-9a-f]{8,32}$/.test(id) ? `https://mail.google.com/mail/u/0/#all/${id}` : null;
}

/**
 * LinkedIn InMail notices carry the real sender and subject in the BODY; the headers only say LinkedIn.
 * @param {string} bodyText decoded body
 * @param {string|null} fromName From display name ("Jane Doe via LinkedIn")
 * @param {string} subject header subject
 * @returns {{ name: string|null, subject: string }}
 */
export function parseInmail(bodyText, fromName, subject) {
  const body = String(bodyText ?? '');
  let name = null;
  const m1 = /^\s*(.{2,60}?)\s+(?:sent you a message|messaged you|has sent you (?:a )?(?:message|inmail)|just messaged you|InMail)/im.exec(body);
  if (m1) name = m1[1].trim();
  if (!name && fromName) name = fromName.replace(/\s+via\s+LinkedIn\s*$/i, '').trim() || null;
  let subj = null;
  const m2 = /^\s*(?:Subject|Re)\s*:\s*(.+)$/im.exec(body);
  if (m2) subj = m2[1].trim();
  if (!subj) {
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const idx = lines.findIndex((l) => m1 && l.startsWith(m1[0].trim().slice(0, 12)));
    if (idx >= 0 && lines[idx + 1]) subj = lines[idx + 1];
  }
  return { name, subject: (subj || subject || '').slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MailInput one message as the Gmail API returned it (format=metadata, plus body when fetched)
 * @property {string} id
 * @property {string|null} threadId
 * @property {string[]} labelIds
 * @property {string} snippet Gmail's snippet
 * @property {number|null} internalDate epoch ms
 * @property {Record<string, string>} headers lowercase-name map
 * @property {null|{ text: string, unreadable: boolean, calendar: boolean }} body null until a full read was done
 */

/**
 * @typedef {Object} MailEnv
 * @property {Set<string>} selfSet normalized self addresses
 * @property {Set<string>} registered lowercased addresses from config/alert-senders.json
 * @property {Set<string>} sentThreads thread ids Damian has sent to
 * @property {import('./mail-intake-config.js').MailIntakeConfig} cfg
 */

/**
 * @typedef {Object} MailVerdict
 * @property {typeof BUCKETS[number]} bucket
 * @property {string|null} signal strong | known_firm | inmail | weak | body_unreadable | thread_reply | ...
 * @property {boolean} candidate true when a full body read could change the outcome
 * @property {boolean} [lowPriority] candidate only because of a recruiting cue on bulk mail; read after the stronger candidates
 * @property {boolean} bodyUnreadable
 * @property {string|null} fromAddr
 * @property {string|null} fromName
 * @property {string|null} replyTo
 * @property {boolean} replyToDiffers
 * @property {string} subject
 */

/**
 * Total: never throws, always returns exactly one bucket.
 * @param {MailInput} msg
 * @param {MailEnv} env
 * @returns {MailVerdict}
 */
export function classifyMail(msg, env) {
  const h = msg.headers || {};
  const from = parseAddress(h.from);
  const replyTo = parseAddress(h['reply-to']);
  const subject = String(h.subject ?? '').trim();
  const replyToDiffers = Boolean(replyTo.addr && from.addr && replyTo.addr !== from.addr);
  /** @param {MailVerdict['bucket']} bucket @param {string|null} signal @param {boolean} [candidate] */
  const v = (bucket, signal, candidate = false) => ({
    bucket, signal, candidate, bodyUnreadable: Boolean(msg.body && msg.body.unreadable), fromAddr: from.addr, fromName: from.name,
    replyTo: replyTo.addr, replyToDiffers, subject,
  });
  const cfg = env.cfg;
  const domain = domainOf(from.addr);
  const body = msg.body && !msg.body.unreadable ? msg.body.text : '';
  const text = `${subject}\n${msg.snippet || ''}\n${body}`;
  const bulk = isBulk(h);

  // 1 self: From only.
  const selfForm = normalizeSelf(from.addr);
  if (selfForm && env.selfSet.has(selfForm)) return v('self', null);
  // 2 registered alert senders (parsed by the existing adapter pass, unchanged).
  if (from.addr && env.registered.has(from.addr)) return v('registered_alert', null);
  // 3 application mail, via the confirm.js classifier.
  if (classifyBody({ subject, text: `${msg.snippet || ''}\n${body}` }).kind !== 'unknown') return v('application_mail', null);
  // 4 internal: employer domain or a calendar invite.
  const calendarHeader = /text\/calendar/i.test(h['content-type'] || '');
  if (domainInList(domain, cfg.employerDomains)) return v('internal', 'employer');
  if (calendarHeader || (msg.body && msg.body.calendar) || /^\s*(?:updated\s+)?invitation\b/i.test(subject)) return v('internal', 'calendar');
  // 5 thread reply.
  if (msg.threadId && env.sentThreads.has(msg.threadId) && !isAutoReply(h)) return v('thread_reply', 'thread_reply');
  // 6 recruiter-like.
  const inmail = Boolean(from.addr && cfg.linkedinInmailSenders.includes(from.addr));
  const knownFirm = domainInList(domain, cfg.searchFirmDomains);
  if (inmail) return v('recruiter_like', msg.body && msg.body.unreadable ? 'body_unreadable' : 'inmail', !msg.body);
  if (strongMatch(text)) return v('recruiter_like', 'strong');
  if (knownFirm && hasTitleTerm(text)) return v('recruiter_like', 'known_firm');
  if (!bulk && weakMatch(text)) return v('recruiter_like', 'weak');
  // Unresolved so far. A full read can still change the answer for: non-bulk mail, a known firm, a subject with
  // a title term, and the InMail sender (handled above).
  const strongCandidate = !msg.body && (!bulk || knownFirm || hasTitleTerm(subject));
  // Bulk mail from a firm NOT on the domain list: a recruiting cue in the subject or snippet earns a (lower
  // priority) body read, because a template with List-Unsubscribe may carry the title only in the body.
  const cue = bulk && RECRUITING_CUE_RE.test(`${subject} ${msg.snippet || ''}`);
  const candidate = strongCandidate || (!msg.body && cue);
  /** @param {MailVerdict['bucket']} bucket */
  const unresolved = (bucket) => ({ ...v(bucket, null, candidate), lowPriority: candidate && !strongCandidate });
  // A body we tried and could not read is never silently filed: a human looks.
  if (msg.body && msg.body.unreadable && (!bulk || knownFirm || hasTitleTerm(subject) || cue)) return v('recruiter_like', 'body_unreadable');
  // 7 bulk noise, 8 default.
  if (bulk) return unresolved('bulk_noise');
  return unresolved('unsorted');
}

/**
 * Count rows by bucket and list the top senders for the privacy-limited buckets.
 * @param {Array<{ bucket: string, fromAddr: string|null }>} rows
 * @param {number} [top]
 */
export function summarizeIntake(rows, top = 10) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  /** @type {Record<string, Map<string, number>>} */
  const senders = { unsorted: new Map(), bulk_noise: new Map() };
  for (const r of rows) {
    counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
    if (senders[r.bucket]) {
      const k = r.fromAddr ?? '(unparseable)';
      senders[r.bucket].set(k, (senders[r.bucket].get(k) ?? 0) + 1);
    }
  }
  const topOf = (/** @type {Map<string, number>} */ m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top);
  return { counts, topUnsorted: topOf(senders.unsorted), topBulk: topOf(senders.bulk_noise) };
}
