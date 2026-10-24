// @ts-check
/**
 * Builders for the personal mail intake tests (sql/029): Gmail API message shapes, a classifier environment,
 * and the named fixtures the spec calls out (the forsythbarnes recruiter email with and without
 * List-Unsubscribe, an ATS thank-you, Advisicon mail, a calendar invite, vendor "Director" spam, a LinkedIn
 * InMail notice, an auto-reply, a +alias self mail, a SPAM phish with a differing Reply-To).
 * The en dash in the Simon subject is written as an escape so no literal dash character lives in the file.
 */
import { defaultMailIntakeConfig } from '../../src/core/mail-intake-config.js';
import { headerMap } from '../../src/core/mail-intake.js';

export const SELF_ADDRESS = 'damian@example.test';
export const SENT_THREAD = 'thread-sent-1';

/** @param {string} s */
export function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A Gmail message as format=metadata returns it.
 * @param {{ id: string, threadId?: string, from: string, subject: string, snippet?: string, headers?: Record<string, string>, labels?: string[], date?: string }} o
 */
export function metaMessage(o) {
  const headers = [{ name: 'From', value: o.from }, { name: 'Subject', value: o.subject }];
  for (const [name, value] of Object.entries(o.headers ?? {})) headers.push({ name, value });
  return {
    id: o.id, threadId: o.threadId ?? `t-${o.id}`, labelIds: o.labels ?? ['INBOX', 'CATEGORY_PROMOTIONS'], snippet: o.snippet ?? '',
    internalDate: String(Date.parse(o.date ?? '2026-10-23T15:00:00Z')), payload: { headers, mimeType: 'multipart/alternative' },
  };
}

/** Classifier input from a metaMessage plus an optional body. @param {ReturnType<typeof metaMessage>} m @param {null|{ text: string, unreadable?: boolean, calendar?: boolean }} [body] */
export function toInput(m, body = null) {
  return {
    id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, internalDate: Number(m.internalDate), headers: headerMap(m.payload),
    body: body ? { text: body.text, unreadable: Boolean(body.unreadable), calendar: Boolean(body.calendar) } : null,
  };
}

/** @param {Partial<import('../../src/core/mail-intake.js').MailEnv>} [over] @returns {import('../../src/core/mail-intake.js').MailEnv} */
export function env(over = {}) {
  return {
    selfSet: new Set([SELF_ADDRESS]),
    registered: new Set(['jobalerts-noreply@linkedin.com', 'jobs@my.theladders.com']),
    sentThreads: new Set([SENT_THREAD]),
    cfg: defaultMailIntakeConfig(),
    ...over,
  };
}

const SIMON_SUBJECT = 'Exciting New Opportunity \u2013 Let\u2019s Catch Up';
const SIMON_SNIPPET = 'Hi Damian, I am recruiting for a Chief Information Officer role with a client in Houston and your background looks like a strong fit.';

/** The recruiter email that was never surfaced. @param {boolean} unsubscribe */
export function simonMessage(unsubscribe) {
  return metaMessage({
    id: 'a1b2c3d4e5f60001', from: 'Simon Wilkinson <simon.wilkinson@forsythbarnes.com>', subject: SIMON_SUBJECT, snippet: SIMON_SNIPPET,
    headers: unsubscribe ? { 'List-Unsubscribe': '<mailto:unsubscribe@forsythbarnes.com>' } : {}, labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
  });
}

export const FIXTURES = {
  atsThankYou: () => metaMessage({ id: 'a1b2c3d4e5f60010', from: 'Acme Careers <careers@acme.example>', subject: 'Thank you for applying', snippet: 'Thank you for applying to the VP of Engineering role. Our recruiting team reviews every candidate.' }),
  advisicon: () => metaMessage({ id: 'a1b2c3d4e5f60011', from: 'Pat Lee <pat.lee@advisicon.com>', subject: 'Chief Information Officer search update', snippet: 'We are recruiting for a Chief Information Officer role, can you look?' }),
  advisiconSubdomain: () => metaMessage({ id: 'a1b2c3d4e5f60012', from: 'ops@mail.advisicon.com', subject: 'Weekly notes', snippet: 'Nothing special.' }),
  advisiconLookalike: () => metaMessage({ id: 'a1b2c3d4e5f60013', from: 'ops@advisicon.com.evil.test', subject: 'Weekly notes', snippet: 'Nothing special.' }),
  calendarInvite: () => metaMessage({ id: 'a1b2c3d4e5f60014', from: 'Recruiter <r@search.example>', subject: 'Invitation: CIO interview @ Tue 2pm', snippet: 'You have been invited. Recruiting for a Chief Information Officer role.' }),
  calendarByHeader: () => metaMessage({ id: 'a1b2c3d4e5f60015', from: 'Recruiter <r@search.example>', subject: 'Call', snippet: 'Recruiting for a CIO role.', headers: { 'Content-Type': 'multipart/mixed; boundary=x; text/calendar' } }),
  vendorDirector: () => metaMessage({ id: 'a1b2c3d4e5f60016', from: 'Sales <sales@cloudvendor.example>', subject: 'Director, Cloud Solutions: 20% off this week', snippet: 'Hello Director, our platform...', headers: { 'List-Unsubscribe': '<mailto:u@cloudvendor.example>' } }),
  linkedinInmail: () => metaMessage({ id: 'a1b2c3d4e5f60017', from: 'Jane Doe via LinkedIn <inmail-hit-reply@linkedin.com>', subject: 'You have a new message', snippet: 'View message', headers: { 'List-Unsubscribe': '<https://www.linkedin.com/e/v2?e=x>' } }),
  autoReplyInSentThread: () => metaMessage({ id: 'a1b2c3d4e5f60018', threadId: SENT_THREAD, from: 'Pat Out <pat@vendor.example>', subject: 'Automatic reply: hello', snippet: 'I am out of the office until Monday.', headers: { 'Auto-Submitted': 'auto-replied' } }),
  precedenceAutoReplyInSentThread: () => metaMessage({ id: 'a1b2c3d4e5f60019', threadId: SENT_THREAD, from: 'Pat Out <pat@vendor.example>', subject: 'Out of office', snippet: 'Back Monday.', headers: { Precedence: 'auto_reply' } }),
  plainReplyInSentThread: () => metaMessage({ id: 'a1b2c3d4e5f60020', threadId: SENT_THREAD, from: 'Sam Roe <sam@somefirm.example>', subject: 'Re: introduction', snippet: 'Thanks for getting back to me. Thursday works.' }),
  strongReplyInSentThread: () => metaMessage({ id: 'a1b2c3d4e5f60021', threadId: SENT_THREAD, from: 'Sam Roe <sam@somefirm.example>', subject: 'Re: introduction', snippet: 'We are recruiting for a Chief Technology Officer.' }),
  aliasSelf: () => metaMessage({ id: 'a1b2c3d4e5f60022', from: 'Damian <damian+recruiters@example.test>', subject: 'Note to self: CIO recruiting for role', snippet: 'Remember to call the recruiter about the CIO role.' }),
  replyToSelfOnly: () => metaMessage({ id: 'a1b2c3d4e5f60023', from: 'Eve <eve@elsewhere.example>', subject: 'Chief Information Officer opportunity', snippet: 'We are recruiting for a Chief Information Officer role.', headers: { 'Reply-To': 'damian@example.test', Sender: 'damian@example.test' } }),
  spamPhish: () => metaMessage({ id: 'a1b2c3d4e5f60024', from: 'HR Desk <hr@talent-portal.example>', subject: 'Confidential search: Chief Technology Officer', snippet: 'A confidential search for a Chief Technology Officer; send your details.', headers: { 'Reply-To': 'harvest@collector.example' }, labels: ['SPAM'] }),
  registeredAlert: () => metaMessage({ id: 'a1b2c3d4e5f60025', from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', subject: 'CIO jobs in Houston', snippet: 'Recruiting for a Chief Information Officer role.' }),
  weakNonBulk: () => metaMessage({ id: 'a1b2c3d4e5f60026', from: 'Lee <lee@startup.example>', subject: 'VP opportunity', snippet: 'Have a VP role open at our startup, want to chat?', labels: ['INBOX'] }),
  weakBulk: () => metaMessage({ id: 'a1b2c3d4e5f60027', from: 'Lee <lee@startup.example>', subject: 'VP opportunity', snippet: 'Have a VP role open at our startup, want to chat?', headers: { 'List-Unsubscribe': '<mailto:u@startup.example>' } }),
  personalPlain: () => metaMessage({ id: 'a1b2c3d4e5f60028', from: 'Aunt <aunt@family.example>', subject: 'Lunch on Sunday?', snippet: 'Are you free for lunch on Sunday?', labels: ['INBOX'] }),
  newsletter: () => metaMessage({ id: 'a1b2c3d4e5f60029', from: 'News <news@daily.example>', subject: 'Your daily digest', snippet: 'Top stories today.', headers: { 'List-Unsubscribe': '<mailto:u@daily.example>', Precedence: 'bulk' } }),
  knownFirmTitleOnly: () => metaMessage({ id: 'a1b2c3d4e5f60030', from: 'Kim <kim@heidrick.com>', subject: 'Following up', snippet: 'Quick note about the CTO mandate we discussed.', headers: { 'List-Unsubscribe': '<mailto:u@heidrick.com>' } }),
  knownFirmNoTitle: () => metaMessage({ id: 'a1b2c3d4e5f60031', from: 'Kim <kim@heidrick.com>', subject: 'Our latest insights', snippet: 'Read our newsletter.', headers: { 'List-Unsubscribe': '<mailto:u@heidrick.com>' } }),
};
