// @ts-check
/**
 * Personal mail intake classifier (sql/029): every bucket, every priority conflict, and the named fixtures.
 * Pure: no network, no DB.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMail, BUCKETS, normalizeSelf, parseAddress, strongMatch, weakMatch, hasTitleTerm, sanitizeSnippet, gmailTab, gmailMessageUrl,
  parseInmail, isBulk, isAutoReply, domainInList, rulesVersionFor, summarizeIntake, PROXIMITY_CHARS,
} from '../src/core/mail-intake.js';
import { defaultMailIntakeConfig } from '../src/core/mail-intake-config.js';
import { FIXTURES, simonMessage, toInput, env, SELF_ADDRESS, SENT_THREAD } from './helpers/mail-intake-fixtures.js';

/** @param {ReturnType<typeof simonMessage>} m @param {any} [body] @param {Partial<import('../src/core/mail-intake.js').MailEnv>} [over] */
const classify = (m, body = null, over = {}) => classifyMail(toInput(m, body), env(over));

describe('the recruiter email that was never surfaced', () => {
  test('without List-Unsubscribe: recruiter_like (strong), from the subject plus snippet alone', () => {
    const v = classify(simonMessage(false));
    assert.equal(v.bucket, 'recruiter_like');
    assert.equal(v.signal, 'strong');
    assert.equal(v.fromAddr, 'simon.wilkinson@forsythbarnes.com');
  });

  test('with List-Unsubscribe: bulk headers never exclude a STRONG match', () => {
    const v = classify(simonMessage(true));
    assert.equal(v.bucket, 'recruiter_like');
    assert.equal(v.signal, 'strong');
  });

  test('a known search firm with only a title term is known_firm; without a title term it is bulk_noise', () => {
    assert.deepEqual([classify(FIXTURES.knownFirmTitleOnly()).bucket, classify(FIXTURES.knownFirmTitleOnly()).signal], ['recruiter_like', 'known_firm']);
    assert.equal(classify(FIXTURES.knownFirmNoTitle()).bucket, 'bulk_noise');
  });
});

describe('each bucket and its priority conflicts', () => {
  test('1 self: +alias mail is self even when the text is recruiter-like', () => {
    assert.equal(classify(FIXTURES.aliasSelf()).bucket, 'self');
  });

  test('1 self: Reply-To and Sender never grant self', () => {
    const v = classify(FIXTURES.replyToSelfOnly());
    assert.notEqual(v.bucket, 'self');
    assert.equal(v.bucket, 'recruiter_like');
    assert.equal(v.replyToDiffers, true);
  });

  test('1 self: a lookalike domain or a dotted variant is not self', () => {
    const m = FIXTURES.aliasSelf();
    m.payload.headers[0].value = 'damian@example.test.evil.test';
    assert.notEqual(classify(m).bucket, 'self');
    m.payload.headers[0].value = 'dam.ian@example.test';
    assert.notEqual(classify(m).bucket, 'self');
  });

  test('2 registered_alert outranks the recruiter text it carries', () => {
    assert.equal(classify(FIXTURES.registeredAlert()).bucket, 'registered_alert');
  });

  test('3 application_mail: an ATS thank-you that mentions a VP role and "candidate" is counted only', () => {
    assert.equal(classify(FIXTURES.atsThankYou()).bucket, 'application_mail');
  });

  test('3 application_mail is recognized from the body when the snippet is silent', () => {
    const m = FIXTURES.personalPlain();
    assert.equal(classify(m, { text: 'We regret to inform you that we will not be moving forward.' }).bucket, 'application_mail');
  });

  test('4 internal: employer domain, its subdomains, never a lookalike', () => {
    assert.equal(classify(FIXTURES.advisicon()).bucket, 'internal');
    assert.equal(classify(FIXTURES.advisiconSubdomain()).bucket, 'internal');
    assert.notEqual(classify(FIXTURES.advisiconLookalike()).bucket, 'internal');
  });

  test('4 internal: a calendar invite by subject, by Content-Type header, or by a text/calendar part', () => {
    assert.equal(classify(FIXTURES.calendarInvite()).bucket, 'internal');
    assert.equal(classify(FIXTURES.calendarByHeader()).bucket, 'internal');
    assert.equal(classify(FIXTURES.personalPlain(), { text: 'BEGIN:VCALENDAR', calendar: true }).bucket, 'internal');
  });

  test('5 thread_reply: a reply in a thread Damian sent to, even over a STRONG recruiter match', () => {
    assert.equal(classify(FIXTURES.plainReplyInSentThread()).bucket, 'thread_reply');
    const strong = classify(FIXTURES.strongReplyInSentThread());
    assert.equal(strong.bucket, 'thread_reply');
  });

  test('5 thread_reply excludes auto-replies (Auto-Submitted and Precedence auto_reply)', () => {
    const a = classify(FIXTURES.autoReplyInSentThread());
    assert.notEqual(a.bucket, 'thread_reply');
    assert.equal(a.bucket, 'bulk_noise', 'Auto-Submitted counts as a bulk header');
    const p = classify(FIXTURES.precedenceAutoReplyInSentThread());
    assert.notEqual(p.bucket, 'thread_reply');
  });

  test('5 thread_reply needs the thread to be one Damian sent to', () => {
    const m = FIXTURES.plainReplyInSentThread();
    assert.notEqual(classify(m, null, { sentThreads: new Set() }).bucket, 'thread_reply');
  });

  test('6 recruiter_like: LinkedIn InMail notices are recruiter_like and want a body read', () => {
    const v = classify(FIXTURES.linkedinInmail());
    assert.equal(v.bucket, 'recruiter_like');
    assert.equal(v.signal, 'inmail');
    assert.equal(v.candidate, true, 'the sender and subject live in the body');
    const withBody = classify(FIXTURES.linkedinInmail(), { text: 'Jane Doe sent you a message\nSubject: CIO role at Orbit' });
    assert.equal(withBody.candidate, false);
  });

  test('6 recruiter_like WEAK needs non-bulk; the same text with a bulk header is bulk_noise', () => {
    const weak = classify(FIXTURES.weakNonBulk());
    assert.deepEqual([weak.bucket, weak.signal], ['recruiter_like', 'weak']);
    assert.equal(classify(FIXTURES.weakBulk()).bucket, 'bulk_noise');
  });

  test('6 recruiter_like: a SPAM phish with a differing Reply-To is surfaced with both addresses', () => {
    const v = classify(FIXTURES.spamPhish());
    assert.equal(v.bucket, 'recruiter_like');
    assert.equal(v.replyToDiffers, true);
    assert.equal(v.replyTo, 'harvest@collector.example');
    assert.equal(v.fromAddr, 'hr@talent-portal.example');
  });

  test('6 recruiter_like: a body we tried and could not read is never silently filed', () => {
    const v = classify(FIXTURES.personalPlain(), { text: '', unreadable: true });
    assert.deepEqual([v.bucket, v.signal, v.bodyUnreadable], ['recruiter_like', 'body_unreadable', true]);
  });

  test('6 an unreadable body on plain bulk mail with no title term stays bulk_noise', () => {
    const v = classify(FIXTURES.newsletter(), { text: '', unreadable: true });
    assert.equal(v.bucket, 'bulk_noise');
  });

  test('7 bulk_noise: vendor "Director" spam is not a title term and is counted as bulk', () => {
    assert.equal(hasTitleTerm('Director, Cloud Solutions'), false);
    assert.equal(classify(FIXTURES.vendorDirector()).bucket, 'bulk_noise');
    assert.equal(classify(FIXTURES.newsletter()).bucket, 'bulk_noise');
  });

  test('8 unsorted is the default; it is a body-read candidate', () => {
    const v = classify(FIXTURES.personalPlain());
    assert.equal(v.bucket, 'unsorted');
    assert.equal(v.candidate, true);
  });

  test('bulk mail with a recruiting cue in the subject or snippet is a LOW-priority body-read candidate', () => {
    const m = FIXTURES.newsletter();
    m.payload.headers[1].value = 'Exciting New Opportunity';
    const v = classify(m);
    assert.deepEqual([v.bucket, v.candidate, v.lowPriority], ['bulk_noise', true, true]);
    assert.equal(classify(FIXTURES.weakBulk()).lowPriority, false, 'a title term in the subject is a stronger candidate');
    const strong = classify(FIXTURES.personalPlain());
    assert.equal(strong.lowPriority, false);
  });

  test('bulk mail with no title or firm signal is not a body-read candidate', () => {
    assert.equal(classify(FIXTURES.newsletter()).candidate, false);
  });

  test('every fixture lands in exactly one known bucket (total classification)', () => {
    for (const [name, make] of Object.entries(FIXTURES)) {
      const v = classify(make());
      assert.ok(BUCKETS.includes(v.bucket), `${name} -> ${v.bucket}`);
    }
  });

  test('an input with no headers at all still classifies (unsorted), never throws', () => {
    const v = classifyMail({ id: 'x', threadId: null, labelIds: [], snippet: '', internalDate: null, headers: {}, body: null }, env());
    assert.equal(v.bucket, 'unsorted');
  });
});

describe('matching primitives', () => {
  test('title terms: Chief * Officer, C-suite abbreviations, VP family, Head of', () => {
    for (const t of ['Chief Information Officer', 'Chief Digital and Data Officer', 'CIO', 'cto', 'CDO', 'CAIO', 'COO', 'VP', 'SVP', 'EVP', 'Head of Engineering']) {
      assert.equal(hasTitleTerm(`the ${t} seat`), true, t);
    }
    assert.equal(hasTitleTerm('Director of IT'), false);
    assert.equal(hasTitleTerm('vpn access'), false, 'word boundary');
  });

  test('STRONG needs a title term within 200 chars of a recruiting term', () => {
    const near = `We are recruiting for a Chief Information Officer role.`;
    assert.equal(strongMatch(near), true);
    const far = `Chief Information Officer. ${'x '.repeat(PROXIMITY_CHARS)} We are recruiting.`;
    assert.equal(strongMatch(far), false);
    assert.equal(strongMatch('We are recruiting for an analyst'), false);
  });

  test('WEAK needs opportunity, role or position near a title term', () => {
    assert.equal(weakMatch('A VP opportunity'), true);
    assert.equal(weakMatch('A VP and a very long gap ' + 'y '.repeat(PROXIMITY_CHARS) + 'role'), false);
  });

  test('normalizeSelf strips only the +tag and lowercases', () => {
    assert.equal(normalizeSelf('Damian+Jobs@Example.Test'), 'damian@example.test');
    assert.equal(normalizeSelf('not-an-address'), null);
  });

  test('parseAddress handles names, quotes and bare addresses', () => {
    assert.deepEqual(parseAddress('"Doe, Jane" <Jane@X.Test>'), { addr: 'jane@x.test', name: 'Doe, Jane' });
    assert.deepEqual(parseAddress('a@b.test'), { addr: 'a@b.test', name: null });
    assert.deepEqual(parseAddress(null), { addr: null, name: null });
  });

  test('isBulk and isAutoReply read the right headers', () => {
    assert.equal(isBulk({ 'list-unsubscribe': '<x>' }), true);
    assert.equal(isBulk({ 'list-id': '<x>' }), true);
    assert.equal(isBulk({ precedence: 'Bulk' }), true);
    assert.equal(isBulk({ 'auto-submitted': 'no' }), false);
    assert.equal(isAutoReply({ 'auto-submitted': 'auto-replied' }), true);
    assert.equal(isAutoReply({ precedence: 'auto_reply' }), true);
    assert.equal(isAutoReply({}), false);
  });

  test('domainInList is dot-anchored', () => {
    assert.equal(domainInList('a.advisicon.com', ['advisicon.com']), true);
    assert.equal(domainInList('xadvisicon.com', ['advisicon.com']), false);
  });

  test('parseInmail takes the sender and subject from the body', () => {
    const r = parseInmail('Jane Doe sent you a message\nSubject: CIO role at Orbit\nHello Damian', 'Jane Doe via LinkedIn', 'You have a new message');
    assert.deepEqual(r, { name: 'Jane Doe', subject: 'CIO role at Orbit' });
    const fallback = parseInmail('', 'Jane Doe via LinkedIn', 'You have a new message');
    assert.deepEqual(fallback, { name: 'Jane Doe', subject: 'You have a new message' });
  });

  test('gmailTab, gmailMessageUrl', () => {
    assert.equal(gmailTab(['INBOX', 'CATEGORY_PROMOTIONS']), 'Promotions');
    assert.equal(gmailTab(['SPAM']), 'Spam');
    assert.equal(gmailTab(['INBOX']), 'Primary');
    assert.equal(gmailTab([]), 'Other');
    assert.equal(gmailMessageUrl('a1b2c3d4e5f60001'), 'https://mail.google.com/mail/u/0/#all/a1b2c3d4e5f60001');
    assert.equal(gmailMessageUrl('../../evil'), null);
  });

  test('rulesVersionFor changes with the config content', () => {
    const a = defaultMailIntakeConfig();
    const b = { ...a, searchFirmDomains: [...a.searchFirmDomains, 'newfirm.example'] };
    assert.notEqual(rulesVersionFor(a), rulesVersionFor(b));
    assert.equal(rulesVersionFor(a), rulesVersionFor(defaultMailIntakeConfig()));
  });

  test('summarizeIntake counts every bucket and lists the top senders for unsorted and bulk only', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ bucket: 'bulk_noise', fromAddr: `s${i}@x.test` })),
      { bucket: 'bulk_noise', fromAddr: 's0@x.test' },
      { bucket: 'unsorted', fromAddr: 'u@x.test' },
      { bucket: 'recruiter_like', fromAddr: 'r@x.test' },
    ];
    const s = summarizeIntake(rows, 10);
    assert.equal(s.counts.bulk_noise, 13);
    assert.equal(s.counts.recruiter_like, 1);
    assert.equal(s.topBulk.length, 10);
    assert.deepEqual(s.topBulk[0], ['s0@x.test', 2]);
    assert.deepEqual(s.topUnsorted, [['u@x.test', 1]]);
  });
});

describe('display text', () => {
  test('sanitizeSnippet strips tags and URLs, collapses space and caps the length', () => {
    const s = sanitizeSnippet('<p>Hello <b>there</b></p> visit https://evil.example/x?y=1 and www.bad.example now   please', 500);
    assert.equal(s, 'Hello there visit and now please');
    assert.equal(sanitizeSnippet('x'.repeat(800), 500).length, 500);
    assert.equal(sanitizeSnippet(null), '');
  });

  test('script content is removed, not just the tags', () => {
    assert.equal(sanitizeSnippet('<script>alert(1)</script>ok'), 'ok');
  });
});

test('SELF_ADDRESS and SENT_THREAD fixtures are what the environment assumes', () => {
  assert.ok(env().selfSet.has(SELF_ADDRESS));
  assert.ok(env().sentThreads.has(SENT_THREAD));
});
