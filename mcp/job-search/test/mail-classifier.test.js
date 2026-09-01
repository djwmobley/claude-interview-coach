// @ts-check
/**
 * src/apply/mail-classifier.js (apply pipeline slice 7): the pure mail classification, company
 * extraction, and URL-veto logic. No DB, no network -- see test/mail-confirm.test.js for the DB-backed
 * orchestration tests (matching pools, idempotency, review routing).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBody, classifyApplicationMail, extractCompanyRaw, extractUrls, mailUrlContradictsCandidate,
} from '../src/apply/mail-classifier.js';

describe('classifyBody: total classification, rejection outranks the thank-you opener', () => {
  test('a plain rejection classifies "rejected"', () => {
    const r = classifyBody({ subject: 'Update on your application', text: 'Unfortunately, we have decided to move forward with other candidates for this role.' });
    assert.equal(r.kind, 'rejected');
  });

  test('a rejection mail that OPENS with "thank you for applying" still classifies "rejected" (amended decision 4)', () => {
    const r = classifyBody({
      subject: 'Your application to Acme Corp',
      text: 'Thank you for applying to the Director of Engineering role at Acme Corp. After careful consideration, we have decided to move forward with other candidates.',
    });
    assert.equal(r.kind, 'rejected');
  });

  test('a position-closed mail classifies "closed", not "rejected"', () => {
    const r = classifyBody({ subject: 'Job posting update', text: 'This position has been filled and is no longer accepting applications.' });
    assert.equal(r.kind, 'closed');
  });

  test('a plain confirmation classifies "received"', () => {
    const r = classifyBody({ subject: 'Thank you for applying', text: 'We have received your application and will be in touch.' });
    assert.equal(r.kind, 'received');
  });

  test('a contentless Workday-style status-change notification is "unknown" BY CONSTRUCTION (never inferred)', () => {
    const r = classifyBody({ subject: 'Your application status has changed', text: 'Your application status has changed. Log in to the candidate portal to view details.' });
    assert.equal(r.kind, 'unknown');
  });

  test('unrelated mail (not application-related at all) is "unknown"', () => {
    const r = classifyBody({ subject: 'Your order has shipped', text: 'Your package is on its way.' });
    assert.equal(r.kind, 'unknown');
  });

  test('empty subject and body is "unknown", never a throw', () => {
    const r = classifyBody({ subject: '', text: '' });
    assert.equal(r.kind, 'unknown');
  });
});

describe('classifyApplicationMail: direction is never inferred from sender identity, only content', () => {
  test('a legitimate-looking ATS sender with contentless body still classifies "unknown"', () => {
    const r = classifyApplicationMail({ subject: 'Application Update', text: 'Your application status has changed.', fromName: 'Greenhouse Notifications' });
    assert.equal(r.kind, 'unknown');
  });

  test('company_raw and company_norm are both populated for a confirmation mail', () => {
    const r = classifyApplicationMail({ subject: 'Thank you for applying to Mercy Ships', text: 'Thank you for applying to Mercy Ships. We have received your application.' });
    assert.equal(r.kind, 'received');
    assert.equal(r.company_raw, 'Mercy Ships');
    assert.ok(r.company_norm.length > 0);
  });

  test('an HTML-only body is scanned too (tags stripped)', () => {
    const r = classifyApplicationMail({ subject: 'Thank you for applying', html: '<p>We have received your application to <b>Acme Corp</b>.</p>' });
    assert.equal(r.kind, 'received');
  });
});

describe('extractCompanyRaw', () => {
  test('extracts from "thank you for applying to X"', () => {
    assert.equal(extractCompanyRaw({ subject: '', text: 'Thank you for applying to Acme Corp.', fromName: null }), 'Acme Corp');
  });

  test('falls back to the From display name, stripping a recruiting-team suffix', () => {
    const r = extractCompanyRaw({ subject: 'Application received', text: 'We got it.', fromName: 'Acme Corp Careers' });
    assert.equal(r, 'Acme Corp');
  });

  test('no signal anywhere returns null, never a throw', () => {
    assert.equal(extractCompanyRaw({ subject: '', text: '', fromName: null }), null);
  });

  test('Mercy Ships vs Mercy Health: raw text is preserved verbatim for downstream logging (amended decision 7)', () => {
    const ships = extractCompanyRaw({ subject: '', text: 'Thank you for applying to Mercy Ships.', fromName: null });
    const health = extractCompanyRaw({ subject: '', text: 'Thank you for applying to Mercy Health.', fromName: null });
    assert.equal(ships, 'Mercy Ships');
    assert.equal(health, 'Mercy Health');
    assert.notEqual(ships, health);
  });
});

describe('classifier traps (plan "Known blind spots of the design")', () => {
  test('extractUrls finds every http(s) url in document order', () => {
    const urls = extractUrls('see https://boards.greenhouse.io/acme/jobs/123 and also https://jobs.lever.co/acme/abc-def');
    assert.deepEqual(urls, ['https://boards.greenhouse.io/acme/jobs/123', 'https://jobs.lever.co/acme/abc-def']);
  });

  test('trap: host-suffix spoof (greenhouse.io.example.com) never triggers the URL veto -- it classifies non-exact and is ignored', () => {
    const candidateUrl = 'https://boards.greenhouse.io/acme/jobs/999';
    const spoofedText = 'Thank you for applying. Details: https://boards.greenhouse.io.example.com/acme/jobs/123';
    assert.equal(mailUrlContradictsCandidate(spoofedText, candidateUrl), false);
  });

  test('trap: a staffing-agency repost URL (?for=agency, confidence "inferred") never triggers the veto', () => {
    const candidateUrl = 'https://boards.greenhouse.io/acme/jobs/999';
    const agencyText = 'Thank you for applying. See also: https://boards.greenhouse.io/embed/job_app?for=agency';
    assert.equal(mailUrlContradictsCandidate(agencyText, candidateUrl), false);
  });

  test('an EXACT-confidence URL for a genuinely different tenant DOES trigger the veto', () => {
    const candidateUrl = 'https://boards.greenhouse.io/acme/jobs/999';
    const differentTenantText = 'Thank you for applying: https://boards.greenhouse.io/othercorp/jobs/111';
    assert.equal(mailUrlContradictsCandidate(differentTenantText, candidateUrl), true);
  });

  test('a matching exact-confidence URL never triggers the veto (corroboration, not contradiction)', () => {
    const candidateUrl = 'https://boards.greenhouse.io/acme/jobs/999';
    const sameTenantText = 'Thank you for applying: https://boards.greenhouse.io/acme/jobs/999';
    assert.equal(mailUrlContradictsCandidate(sameTenantText, candidateUrl), false);
  });

  test('no URL at all in the mail body never triggers the veto', () => {
    assert.equal(mailUrlContradictsCandidate('Thank you for applying.', 'https://boards.greenhouse.io/acme/jobs/999'), false);
  });

  test('no candidateApplyUrl (unknown ats) never triggers the veto', () => {
    assert.equal(mailUrlContradictsCandidate('https://boards.greenhouse.io/othercorp/jobs/111', null), false);
  });
});
