// @ts-check
/**
 * SmartRecruiters apply adapter (apply pipeline slice 6, plan section 3: "SmartRecruiters if small").
 * Assessed after building the Workday adapter: SmartRecruiters needs no account (like Greenhouse/Lever),
 * a single-page form, no new state-machine state, and no new auth flow -- it is a straight structural
 * copy of greenhouse.js/lever.js's own shape, so it was folded into this slice rather than deferred. The
 * final Submit goes through ctx.submit (src/apply/unattended-submit.js), like every other form adapter.
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section): same caveat as greenhouse.js/lever.js -- the
 * CSS selectors below are this build's best understanding of SmartRecruiters' application-form DOM,
 * written and tested against a SCRIPTED FAKE page (test/apply-adapters.test.js) and local HTML fixtures,
 * not verified against a live jobs.smartrecruiters.com/careers.smartrecruiters.com page in this sandboxed
 * environment. The failure mode on a wrong selector is safe: a `waitFor({optional:true})` miss parks in
 * needs_human ('unrecognized_page') rather than guessing.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { answerCustomFields, fillAndRecord, uploadAndRecord } from './form-fill.js';

/** Selector contract this adapter targets. Grouped here (not inlined) so a future selector fix touches one place. */
export const SELECTORS = Object.freeze({
  formProbe: '#apply-form, form[data-testid="application-form"], form[action*="/apply"]',
  firstName: '#firstName, input[name="firstName"]',
  lastName: '#lastName, input[name="lastName"]',
  email: '#email, input[name="email"]',
  phone: '#phoneNumber, input[name="phoneNumber"]',
  resumeUpload: '#resume, input[name="resume"]',
  coverLetterUpload: '#coverLetter, input[name="coverLetter"]',
  captcha: '.g-recaptcha, iframe[title*="recaptcha" i], [data-sitekey]',
  customFields: '[data-testid="question-field"], .question-field',
  submit: '#apply-button, button[type="submit"]',
});

export const smartrecruiters = {
  ats: 'smartrecruiters',
  requires: [],
  classifyOnly: false,
  /** Upload allow-class (same reasoning as greenhouse.js/lever.js): the application form posts (including
   * the resume field) directly to SmartRecruiters' own registered hosts as far as this build could
   * determine without live verification -- no separate CDN/S3 upload host is declared. */
  uploadHosts: ['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'],
  /**
   * @param {import('../apply-capability.js').ApplyCapability} cap
   * @param {any} ctx
   */
  async run(cap, ctx) {
    const formInfo = await cap.waitFor(SELECTORS.formProbe, { optional: true, timeoutMs: 15000 });
    if (!formInfo) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find the SmartRecruiters application form on this page.', page_url: ctx.applyUrl } };
    }

    const captchaHit = await cap.waitFor(SELECTORS.captcha, { optional: true, timeoutMs: 2000 });
    if (captchaHit) {
      const shot = await cap.screenshot();
      return { outcome: 'needs_human', pendingQuestion: { kind: 'captcha', label: 'A CAPTCHA challenge is present; this is never solved automatically.', page_url: ctx.applyUrl, screenshot: shot.relPath } };
    }
    if (typeof formInfo.text === 'string' && detectRecaptchaV3Script(formInfo.text)) {
      const shot = await cap.screenshot();
      return { outcome: 'needs_human', pendingQuestion: { kind: 'captcha', label: 'A reCAPTCHA v3 script is present on this page; this is never solved automatically.', page_url: ctx.applyUrl, screenshot: shot.relPath } };
    }

    /** @type {any[]} the fill ledger the click-time audit re-reads */
    const ledger = [];
    if (ctx.profile.fullName) {
      const parts = String(ctx.profile.fullName).trim().split(/\s+/);
      const first = parts[0] ?? '';
      const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
      await fillAndRecord(cap, ledger, { key: 'first_name', selector: SELECTORS.firstName, label: 'First name', value: first, source: 'contact' });
      await fillAndRecord(cap, ledger, { key: 'last_name', selector: SELECTORS.lastName, label: 'Last name', value: last, source: 'contact' });
    }
    if (ctx.profile.email) await fillAndRecord(cap, ledger, { key: 'email', selector: SELECTORS.email, label: 'Email', value: ctx.profile.email, source: ctx.profile.emailSource ?? 'contact' });
    if (ctx.profile.phone) await fillAndRecord(cap, ledger, { key: 'phone', selector: SELECTORS.phone, label: 'Phone', value: ctx.profile.phone, source: 'contact' });

    if (ctx.documents.resumePath) {
      const uploadedName = await uploadAndRecord(cap, ledger, { key: 'resume', selector: SELECTORS.resumeUpload, label: 'Resume', relPath: ctx.documents.resumePath });
      if (!uploadedName) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Resume upload could not be confirmed; the file input did not register a file.', page_url: ctx.applyUrl } };
      }
    }
    if (ctx.documents.coverletterPath) {
      await uploadAndRecord(cap, ledger, { key: 'cover_letter', selector: SELECTORS.coverLetterUpload, label: 'Cover letter', relPath: ctx.documents.coverletterPath });
    }

    const questionResult = await answerCustomFields(cap, ctx, SELECTORS.customFields, ledger);
    if (questionResult.parked) {
      return { outcome: 'needs_human', pendingQuestion: questionResult.pendingQuestion };
    }

    return ctx.submit({ submitSelector: SELECTORS.submit, scopeSelector: SELECTORS.formProbe, ledger });
  },
};
