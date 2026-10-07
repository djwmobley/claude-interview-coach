// @ts-check
/**
 * iCIMS apply adapter (apply pipeline slice 8). Unlike Workday/Dayforce, an iCIMS posting is normally
 * reachable as a guest, single-page application -- structurally closer to Greenhouse/Lever/SmartRecruiters
 * (slices 5-6) than to a wizard-with-account ATS. `requires: []` reflects that: this adapter never signs in
 * and never creates an account. Some tenants nonetheless present a MANDATORY sign-in/registration panel
 * before the form is reachable (an iCIMS configuration option, not the default); this adapter recognizes
 * only that blocking shape and parks for a human, rather than attempting to sign in itself -- there is no
 * designed credential flow here, so a stored credential is never read, and generatePassword()/credential
 * write are never called (spec: "Never call credential write or generatePassword").
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section, and read this before touching SELECTORS): the
 * CSS selectors below are this build's best understanding of iCIMS's public apply-page DOM, written and
 * tested against a SCRIPTED FAKE page (test/icims-adapter.test.js) -- they have NOT been verified against a
 * live *.icims.com tenant in this sandboxed environment (no real Chrome/network available here). Every
 * iCIMS tenant carries its own theme/branding and some custom field configuration; the shapes here are the
 * common public-apply pattern, not a guarantee for any specific tenant. The failure mode on a wrong
 * selector is safe by construction, exactly like every other adapter in this package:
 * `cap.waitFor(..., {optional: true})` returns null rather than guessing, and every branch below that
 * cannot recognize what it sees parks in needs_human ('unrecognized_page', 'credential', or 'question' as
 * appropriate) instead of proceeding against a page it does not actually recognize.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { answerCustomFields, fillAndRecord, uploadAndRecord } from './form-fill.js';

/** Selector contract this adapter targets. Grouped here (not inlined) so a future selector fix touches one place. */
export const SELECTORS = Object.freeze({
  // A general page-loaded probe (NOT the auth gate) whose captured text is reused for the captcha check --
  // exactly workday.js's checkCaptcha(cap, ctx, gate) single-probe pattern, run before the auth-gate check
  // even runs, so a captcha wall in front of a guest-reachable posting is caught either way.
  pageProbe: '[data-testid="icimsApplyPage"], .iCIMS_JobsTable, #icims_content_iframe, .icims-content, .iCIMS_MainWrapper',
  captcha: '.g-recaptcha, iframe[title*="recaptcha" i], [data-sitekey]',
  // MANDATORY sign-in/registration gate ONLY -- a password input inside the page's single application
  // form, or an explicit blocking "you must sign in to apply" container. A merely-present, dismissible
  // "Sign In" header link (present on nearly every iCIMS page, optional, not part of the application form)
  // must NEVER match here: it carries no password input of its own and does not block the form underneath.
  authGate: '[data-testid="mandatorySignIn"], .icims-signin-required, .icims-mandatory-authwall, form:only-of-type input[type="password"][required]',
  firstName: '#firstName, input[name="firstName"]',
  lastName: '#lastName, input[name="lastName"]',
  email: '#email, input[name="email"]',
  phone: '#phone, input[name="phone"], input[name="phoneNumber"]',
  resumeUpload: '#resume, input[name="resume"], input[type="file"][name*="resume" i]',
  coverLetterUpload: '#coverLetter, input[name="coverLetter"]',
  customFields: '[data-testid="question-field"], .iCIMS_MainWrapper .question-field, [data-field-type]',
  submit: '#icims_submit_button, button[type="submit"]',
});

/**
 * Captcha check: a DOM probe plus the reCAPTCHA v3 script-loader heuristic, reusing a prior waitFor
 * result's captured text -- the exact single-probe pattern workday.js's checkCaptcha uses. Never solved,
 * only detected.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {any} probeResult a prior waitFor() result whose `.text` may carry inline script markup
 */
async function checkCaptcha(cap, ctx, probeResult) {
  const captchaHit = await cap.waitFor(SELECTORS.captcha, { optional: true, timeoutMs: 2000 });
  if (captchaHit || (probeResult && typeof probeResult.text === 'string' && detectRecaptchaV3Script(probeResult.text))) {
    const shot = await cap.screenshot();
    return { outcome: 'needs_human', pendingQuestion: { kind: 'captcha', label: 'A CAPTCHA challenge is present; this is never solved automatically.', page_url: ctx.applyUrl, screenshot: shot.relPath } };
  }
  return null;
}

/**
 * Fill whichever profile fields are present. Every fill is guarded by an optional probe first.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {any[]} ledger appended to in place (see the form fill module)
 */
async function fillProfileFieldsIfPresent(cap, ctx, ledger) {
  if (ctx.profile.fullName) {
    const parts = String(ctx.profile.fullName).trim().split(/\s+/);
    const first = parts[0] ?? '';
    const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
    if (await cap.waitFor(SELECTORS.firstName, { optional: true, timeoutMs: 1500 })) await fillAndRecord(cap, ledger, { key: 'first_name', selector: SELECTORS.firstName, label: 'First name', value: first, source: 'contact' });
    if (await cap.waitFor(SELECTORS.lastName, { optional: true, timeoutMs: 1500 })) await fillAndRecord(cap, ledger, { key: 'last_name', selector: SELECTORS.lastName, label: 'Last name', value: last, source: 'contact' });
  }
  if (ctx.profile.email && await cap.waitFor(SELECTORS.email, { optional: true, timeoutMs: 1500 })) await fillAndRecord(cap, ledger, { key: 'email', selector: SELECTORS.email, label: 'Email', value: ctx.profile.email, source: ctx.profile.emailSource ?? 'contact' });
  if (ctx.profile.phone && await cap.waitFor(SELECTORS.phone, { optional: true, timeoutMs: 1500 })) await fillAndRecord(cap, ledger, { key: 'phone', selector: SELECTORS.phone, label: 'Phone', value: ctx.profile.phone, source: 'contact' });
}

/**
 * Upload the linked resume/cover letter. Never proceeds past an unconfirmed upload -- same guard as every
 * other adapter in this package.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {any[]} ledger appended to in place
 * @returns {Promise<{ ok: true } | { ok: false, pendingQuestion: any }>}
 */
async function uploadDocumentsIfPresent(cap, ctx, ledger) {
  if (ctx.documents.resumePath) {
    const uploadedName = await uploadAndRecord(cap, ledger, { key: 'resume', selector: SELECTORS.resumeUpload, label: 'Resume', relPath: ctx.documents.resumePath });
    if (!uploadedName) {
      return { ok: false, pendingQuestion: { kind: 'unrecognized_page', label: 'Resume upload could not be confirmed; the file input did not register a file.', page_url: ctx.applyUrl } };
    }
  }
  if (ctx.documents.coverletterPath) {
    await uploadAndRecord(cap, ledger, { key: 'cover_letter', selector: SELECTORS.coverLetterUpload, label: 'Cover letter', relPath: ctx.documents.coverletterPath });
  }
  return { ok: true };
}

export const icims = {
  ats: 'icims',
  requires: [],
  classifyOnly: false,
  uploadHosts: [],
  /**
   * @param {import('../apply-capability.js').ApplyCapability} cap
   * @param {any} ctx
   */
  async run(cap, ctx) {
    // (1) One gate probe, reused for both the captcha selector check and detectRecaptchaV3Script -- the
    // workday.js checkCaptcha(cap, ctx, gate) single-probe pattern, run before the auth-gate check.
    const gate = await cap.waitFor(SELECTORS.pageProbe, { optional: true, timeoutMs: 15000 });
    if (!gate) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find the iCIMS apply page on this URL.', page_url: ctx.applyUrl } };
    }
    const captchaHit = await checkCaptcha(cap, ctx, gate);
    if (captchaHit) return captchaHit;

    // (2) Mandatory-auth-panel probe. A dismissible "Sign In" header link never matches SELECTORS.authGate
    // (see its own doc comment), so it never trips this park. This adapter has no designed sign-in flow:
    // it never reads a stored credential and never calls credential write/generatePassword.
    const authPanel = await cap.waitFor(SELECTORS.authGate, { optional: true, timeoutMs: 3000 });
    if (authPanel) {
      return {
        outcome: 'needs_human',
        pendingQuestion: {
          kind: 'credential', target: ctx.credentials?.target ?? null, username: ctx.profile.email,
          label: 'This iCIMS posting requires signing in or registering before applying. Sign in manually, then resume.',
          page_url: ctx.applyUrl,
        },
      };
    }

    // (3) Profile fields, (4) document uploads (refuse submit if unconfirmed).
    /** @type {any[]} the fill ledger the click-time audit re-reads */
    const ledger = [];
    await fillProfileFieldsIfPresent(cap, ctx, ledger);
    const uploadResult = await uploadDocumentsIfPresent(cap, ctx, ledger);
    if (!uploadResult.ok) return { outcome: 'needs_human', pendingQuestion: uploadResult.pendingQuestion };

    // (5) Screening questions via the bank; a compensation-family label is routed through
    // classifyCompensationLabel (src/apply/adapters/form-fill.js answerCustomFields) before the generic matcher ever runs.
    const questionResult = await answerCustomFields(cap, ctx, SELECTORS.customFields, ledger);
    if (questionResult.parked) {
      return { outcome: 'needs_human', pendingQuestion: questionResult.pendingQuestion };
    }

    // (6) The click-time gate, the submit marker, the single click, and the confirmation check all live in
    // ctx.submit (src/apply/unattended-submit.js); a missing submit control parks there (review check).
    return ctx.submit({ submitSelector: SELECTORS.submit, scopeSelector: SELECTORS.pageProbe, ledger });
  },
};
