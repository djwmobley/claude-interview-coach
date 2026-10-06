// @ts-check
/**
 * Lever apply adapter (apply pipeline slice 5, plan section 3). No account needed, a single-page form:
 * fill from ctx.profile, upload the linked resume/cover letter, answer screening questions from the bank
 * (auto-answer only 'learned'-tier matches; anything else parks with a screenshot), then hand the final
 * Submit to ctx.submit (src/apply/unattended-submit.js): the click-time gate, the atomic submit marker, the
 * single click, and the baseline-aware confirmation check (unattended submit spec items 1-3, D1-D3).
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section): same caveat as src/apply/adapters/greenhouse.js
 * -- the CSS selectors below are this build's best understanding of Lever's application-form DOM, written
 * and tested against a SCRIPTED FAKE page (test/apply-adapters.test.js) and local HTML fixtures, not
 * verified against a live jobs.lever.co page in this sandboxed environment. The failure mode on a wrong
 * selector is safe: a `waitFor({optional:true})` miss parks in needs_human ('unrecognized_page') rather
 * than guessing.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { answerCustomFields, fillAndRecord, uploadAndRecord } from './form-fill.js';

/** Selector contract this adapter targets. Grouped here (not inlined) so a future selector fix touches one place. */
export const SELECTORS = Object.freeze({
  formProbe: 'form.application-form, form[data-qa="btn-submit-application"], #application-form',
  fullName: 'input[name="name"], #name-input',
  email: 'input[name="email"], #email-input',
  phone: 'input[name="phone"], #phone-input',
  resumeUpload: 'input[name="resume"], #resume-upload-input',
  coverLetterUpload: 'input[name="cover_letter"], #cover-letter-upload-input',
  captcha: '.g-recaptcha, iframe[title*="recaptcha" i], [data-sitekey], .h-captcha',
  customFields: '[data-qa="additional-question"], .application-question',
  submit: 'button[data-qa="btn-submit-application"], button[type="submit"]',
});

export const lever = {
  ats: 'lever',
  requires: [],
  classifyOnly: false,
  /** Upload allow-class (amended spec): Lever's own application form posts (including the resume
   * multipart field) directly to its own registered hosts as far as this build could determine without
   * live verification -- no separate CDN/S3 upload host is declared. */
  uploadHosts: ['jobs.lever.co', 'api.lever.co'],
  /**
   * @param {import('../apply-capability.js').ApplyCapability} cap
   * @param {any} ctx
   */
  async run(cap, ctx) {
    const formInfo = await cap.waitFor(SELECTORS.formProbe, { optional: true, timeoutMs: 15000 });
    if (!formInfo) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find the Lever application form on this page.', page_url: ctx.applyUrl } };
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
    if (ctx.profile.fullName) await fillAndRecord(cap, ledger, { key: 'full_name', selector: SELECTORS.fullName, label: 'Full name', value: ctx.profile.fullName, source: 'contact' });
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
