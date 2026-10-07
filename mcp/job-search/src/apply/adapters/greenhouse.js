// @ts-check
/**
 * Greenhouse apply adapter (apply pipeline slice 5, plan section 3). No account needed, a single-page
 * form: fill from ctx.profile, upload the linked resume/cover letter, answer screening questions from the
 * bank (auto-answer only 'learned'-tier matches; anything else parks with a screenshot), then hand the
 * final Submit to ctx.submit (src/apply/unattended-submit.js via src/apply/worker.js): the click-time
 * gate, the atomic submit marker, the single click, and the baseline-aware confirmation check all live
 * there, never in this adapter (unattended submit spec items 1-3, D1-D3).
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section): the CSS selectors below are this build's best
 * understanding of Greenhouse's application-form DOM, written and tested against a SCRIPTED FAKE page
 * (test/apply-adapters.test.js) and local HTML fixtures (test/unattended-submit-dom.test.js) -- they have
 * not been verified against a live boards.greenhouse.io page in this sandboxed environment. Greenhouse has
 * shipped more than one application-form UI generation ("Job Board 2.0" vs the classic embed) with
 * different markup. The FAILURE MODE if a selector is wrong is safe by construction, not silent:
 * `cap.waitFor(..., {optional: true})` returns null rather than guessing, and this adapter treats "the form
 * probe selector never matched" as `needs_human` (kind 'unrecognized_page') rather than proceeding to
 * fill/submit against a page it does not actually recognize.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { answerCustomFields, fillAndRecord, uploadAndRecord } from './form-fill.js';

/** Selector contract this adapter targets. Grouped here (not inlined) so a future selector fix touches one place. */
export const SELECTORS = Object.freeze({
  formProbe: '#application_form, form[action*="submit_application"], form[data-qa="application-form"]',
  firstName: '#first_name, input[name="job_application[first_name]"]',
  lastName: '#last_name, input[name="job_application[last_name]"]',
  email: '#email, input[name="job_application[email]"]',
  phone: '#phone, input[name="job_application[phone]"]',
  resumeUpload: '#resume_upload_input, input[name="job_application[resume]"]',
  coverLetterUpload: '#cover_letter_upload_input, input[name="job_application[cover_letter]"]',
  captcha: '.g-recaptcha, iframe[title*="recaptcha" i], [data-sitekey]',
  customFields: '[data-field-id], .application--field',
  submit: '#submit_app, button[type="submit"]',
});

/**
 * @param {string|null|undefined} fullName
 */
function splitName(fullName) {
  if (!fullName || !String(fullName).trim()) return { first: null, last: null };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

export const greenhouse = {
  ats: 'greenhouse',
  requires: [],
  classifyOnly: false,
  /** Upload allow-class (amended spec): Greenhouse's own application form posts (including the resume
   * multipart field) directly to its own tenant-scoped board host -- no separate CDN/S3 upload host is
   * used by this ATS's direct-post-to-tenant flow as far as this build could determine without live
   * verification. Every registered Greenhouse host is included so a tenant landing on any of them still
   * gets a working upload allowlist. */
  uploadHosts: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'boards-api.greenhouse.io', 'my.greenhouse.io'],
  /**
   * @param {import('../apply-capability.js').ApplyCapability} cap
   * @param {any} ctx
   */
  async run(cap, ctx) {
    const formInfo = await cap.waitFor(SELECTORS.formProbe, { optional: true, timeoutMs: 15000 });
    if (!formInfo) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find the Greenhouse application form on this page.', page_url: ctx.applyUrl } };
    }

    // Captcha wall: detect via a DOM probe (the capability has no raw-HTML read verb), never solve.
    const captchaHit = await cap.waitFor(SELECTORS.captcha, { optional: true, timeoutMs: 2000 });
    if (captchaHit) {
      const shot = await cap.screenshot();
      return { outcome: 'needs_human', pendingQuestion: { kind: 'captcha', label: 'A CAPTCHA challenge is present; this is never solved automatically.', page_url: ctx.applyUrl, screenshot: shot.relPath } };
    }
    if (typeof formInfo.text === 'string' && detectRecaptchaV3Script(formInfo.text)) {
      const shot = await cap.screenshot();
      return { outcome: 'needs_human', pendingQuestion: { kind: 'captcha', label: 'A reCAPTCHA v3 script is present on this page; this is never solved automatically.', page_url: ctx.applyUrl, screenshot: shot.relPath } };
    }

    /** @type {any[]} the fill ledger the click-time audit re-reads (src/apply/submit-gate.js auditForm) */
    const ledger = [];
    const { first, last } = splitName(ctx.profile.fullName);
    if (first !== null) await fillAndRecord(cap, ledger, { key: 'first_name', selector: SELECTORS.firstName, label: 'First name', value: first, source: 'contact' });
    if (last !== null) await fillAndRecord(cap, ledger, { key: 'last_name', selector: SELECTORS.lastName, label: 'Last name', value: last, source: 'contact' });
    if (ctx.profile.email) await fillAndRecord(cap, ledger, { key: 'email', selector: SELECTORS.email, label: 'Email', value: ctx.profile.email, source: ctx.profile.emailSource ?? 'contact' });
    if (ctx.profile.phone) await fillAndRecord(cap, ledger, { key: 'phone', selector: SELECTORS.phone, label: 'Phone', value: ctx.profile.phone, source: 'contact' });

    if (ctx.documents.resumePath) {
      const uploadedName = await uploadAndRecord(cap, ledger, { key: 'resume', selector: SELECTORS.resumeUpload, label: 'Resume', relPath: ctx.documents.resumePath });
      if (!uploadedName) {
        // The browser's own file input never registered a file: uploading is not confirmed even locally,
        // let alone over the (route-policy-gated) network request that follows. Never proceed to submit on
        // an unconfirmed upload -- that is exactly the "silently looks submitted" failure mode the amended
        // spec calls out.
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

    // The click-time gate, the submit marker, the single click, and the confirmation check (D1, D2).
    return ctx.submit({ submitSelector: SELECTORS.submit, scopeSelector: SELECTORS.formProbe, ledger });
  },
};
