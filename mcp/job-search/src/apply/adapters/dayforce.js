// @ts-check
/**
 * Dayforce apply adapter (apply pipeline slice 8). Dayforce's CandidatePortal requires a candidate account
 * for every posting -- unlike Workday (slice 6), this adapter never registers one: `requires: ['credential']`
 * and sign-in is the ONLY auth path. A missing or rejected credential parks in needs_human; the operator
 * signs in by hand once (through the dashboard's own credential-save flow) and resumes. Credential write
 * and generatePassword() are never called by this adapter.
 *
 * Multi-step wizard loop mirrors workday.js's own bounded MAX_STEPS pattern (My Information / Experience /
 * Questions / Review -> Submit, plus slack) -- never an unbounded loop.
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section, and read this before touching SELECTORS): the
 * CSS/data-automation selectors below are this build's best understanding of Dayforce's CandidatePortal
 * apply-wizard DOM, written and tested against a SCRIPTED FAKE page (test/dayforce-adapter.test.js) -- they
 * have NOT been verified against a live *.dayforcehcm.com tenant in this sandboxed environment. Every
 * Dayforce tenant is its own deployment with its own branding and field configuration; the shapes here are
 * the common CandidatePortal pattern, not a guarantee for any specific tenant. The failure mode on a wrong
 * selector is safe by construction, exactly like workday.js: `cap.waitFor(..., {optional: true})` returns
 * null rather than guessing, and every branch below that cannot recognize what it sees parks in needs_human
 * ('unrecognized_page', 'credential', or 'question' as appropriate) instead of proceeding against a page it
 * does not actually recognize.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { answerCustomFields, fillAndRecord, uploadAndRecord } from './form-fill.js';

/** Selector contract this adapter targets. Grouped here (not inlined) so a future selector fix touches one place. */
export const SELECTORS = Object.freeze({
  authGate: '[data-automation="signInForm"], form[data-automation="signInForm"], input[type="password"]',
  authError: '[data-automation="errorMessage"], [role="alert"]',
  signInEmail: '#username, input[name="username"], input[name="email"]',
  signInPassword: '#password, input[name="password"]',
  signInSubmit: '#loginButton, button[data-automation="signInSubmitButton"]',
  captcha: '.g-recaptcha, iframe[title*="recaptcha" i], [data-sitekey]',
  // Each wizard step renders inside this same container in Dayforce's CandidatePortal shell.
  stepProbe: '[data-automation="wizardStep"], .candidate-portal-step, main[data-automation="applyWizard"]',
  firstName: '#firstName, input[name="firstName"]',
  lastName: '#lastName, input[name="lastName"]',
  phone: '#phone, input[name="phone"], input[name="phoneNumber"]',
  resumeUpload: '#resume, input[name="resume"], input[type="file"][name*="resume" i]',
  coverLetterUpload: '#coverLetter, input[name="coverLetter"]',
  customFields: '[data-automation="questionField"], .question-field',
  next: '[data-automation="nextButton"], button[data-automation="next"]',
  submit: '[data-automation="submitButton"], button[data-automation="submit"]',
});

/** Bounded multi-step wizard loop, mirroring workday.js. Never an unbounded loop. */
export const MAX_STEPS = 8;

/**
 * Fill whichever profile fields are present on the current step. Every fill is guarded by an optional
 * probe first -- a field simply not being on THIS step of the wizard is normal, not an error.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {any[]} ledger this step's fill ledger, appended to in place (see the form fill module)
 */
async function fillProfileFieldsIfPresent(cap, ctx, ledger) {
  if (ctx.profile.fullName) {
    const parts = String(ctx.profile.fullName).trim().split(/\s+/);
    const first = parts[0] ?? '';
    const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
    if (await cap.waitFor(SELECTORS.firstName, { optional: true, timeoutMs: 1500 })) await fillAndRecord(cap, ledger, { key: 'first_name', selector: SELECTORS.firstName, label: 'First name', value: first, source: 'contact' });
    if (await cap.waitFor(SELECTORS.lastName, { optional: true, timeoutMs: 1500 })) await fillAndRecord(cap, ledger, { key: 'last_name', selector: SELECTORS.lastName, label: 'Last name', value: last, source: 'contact' });
  }
  if (ctx.profile.phone && await cap.waitFor(SELECTORS.phone, { optional: true, timeoutMs: 1500 })) await fillAndRecord(cap, ledger, { key: 'phone', selector: SELECTORS.phone, label: 'Phone', value: ctx.profile.phone, source: 'contact' });
}

/**
 * Upload the linked resume/cover letter, once (idempotent across steps via `uploaded.resume`/`.cover`,
 * mutated in place). Same "never proceed on an unconfirmed upload" guard as every other adapter.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {{ resume: boolean, cover: boolean }} uploaded
 * @param {any[]} ledger this step's fill ledger, appended to in place
 * @returns {Promise<{ ok: true } | { ok: false, pendingQuestion: any }>}
 */
async function uploadDocumentsIfPresent(cap, ctx, uploaded, ledger) {
  if (!uploaded.resume && ctx.documents.resumePath && await cap.waitFor(SELECTORS.resumeUpload, { optional: true, timeoutMs: 2000 })) {
    const uploadedName = await uploadAndRecord(cap, ledger, { key: 'resume', selector: SELECTORS.resumeUpload, label: 'Resume', relPath: ctx.documents.resumePath });
    if (!uploadedName) {
      return { ok: false, pendingQuestion: { kind: 'unrecognized_page', label: 'Resume upload could not be confirmed; the file input did not register a file.', page_url: ctx.applyUrl } };
    }
    uploaded.resume = true;
  }
  if (!uploaded.cover && ctx.documents.coverletterPath && await cap.waitFor(SELECTORS.coverLetterUpload, { optional: true, timeoutMs: 2000 })) {
    await uploadAndRecord(cap, ledger, { key: 'cover_letter', selector: SELECTORS.coverLetterUpload, label: 'Cover letter', relPath: ctx.documents.coverletterPath });
    uploaded.cover = true;
  }
  return { ok: true };
}

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
 * Sign in with an existing stored credential. Sign-in only -- this adapter never creates a Dayforce
 * account, never calls ctx.credentials.write, and never calls ctx.credentials.generatePassword.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @returns {Promise<{ outcome: 'ok' } | { outcome: 'needs_human', pendingQuestion: any }>}
 */
async function authenticate(cap, ctx) {
  const existing = await ctx.credentials.read();
  if (!existing) {
    return {
      outcome: 'needs_human',
      pendingQuestion: {
        kind: 'credential', target: ctx.credentials.target, username: ctx.profile.email,
        label: 'No stored Dayforce credential is on file. This adapter never creates a Dayforce account -- sign in manually once (save the credential), then resume.',
        page_url: ctx.applyUrl,
      },
    };
  }
  await cap.fill(SELECTORS.signInEmail, existing.username);
  await cap.fill(SELECTORS.signInPassword, existing.password);
  await cap.click(SELECTORS.signInSubmit);
  const error = await cap.waitFor(SELECTORS.authError, { optional: true, timeoutMs: 4000 });
  if (error) {
    return {
      outcome: 'needs_human',
      pendingQuestion: {
        kind: 'credential', target: ctx.credentials.target, username: existing.username,
        label: 'The stored Dayforce credential was rejected at sign-in. Update the saved password (or the site account) and resume.',
        page_url: ctx.applyUrl,
      },
    };
  }
  return { outcome: 'ok' };
}

export const dayforce = {
  ats: 'dayforce',
  requires: ['credential'],
  classifyOnly: false,
  uploadHosts: [],
  /**
   * @param {import('../apply-capability.js').ApplyCapability} cap
   * @param {any} ctx
   */
  async run(cap, ctx) {
    const gate = await cap.waitFor(SELECTORS.authGate, { optional: true, timeoutMs: 15000 });
    if (!gate) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find a Dayforce sign-in form on this page.', page_url: ctx.applyUrl } };
    }
    const captchaAtGate = await checkCaptcha(cap, ctx, gate);
    if (captchaAtGate) return captchaAtGate;

    const authResult = await authenticate(cap, ctx);
    if (authResult.outcome === 'needs_human') return authResult;

    // Bounded multi-step wizard: My Information / Experience / Questions / Review -> Submit, plus slack.
    // MAX_STEPS caps the number of steps this adapter will ever walk on one run, regardless of whether a
    // submit control is ever found -- never an unbounded loop.
    const uploaded = { resume: false, cover: false };
    for (let step = 0; step < MAX_STEPS; step++) {
      const stepInfo = await cap.waitFor(SELECTORS.stepProbe, { optional: true, timeoutMs: 15000 });
      if (!stepInfo) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find the Dayforce application wizard on this page.', page_url: ctx.applyUrl } };
      }
      const captchaHit = await checkCaptcha(cap, ctx, stepInfo);
      if (captchaHit) return captchaHit;

      // The ledger is per step: the click-time audit re-reads only what is on the Submit step's page (the
      // earlier steps' inputs are gone from the DOM by then).
      /** @type {any[]} */
      const ledger = [];
      await fillProfileFieldsIfPresent(cap, ctx, ledger);
      const uploadResult = await uploadDocumentsIfPresent(cap, ctx, uploaded, ledger);
      if (!uploadResult.ok) return { outcome: 'needs_human', pendingQuestion: uploadResult.pendingQuestion };

      const questionResult = await answerCustomFields(cap, ctx, SELECTORS.customFields, ledger);
      if (questionResult.parked) {
        return { outcome: 'needs_human', pendingQuestion: questionResult.pendingQuestion };
      }

      const submitButton = await cap.waitFor(SELECTORS.submit, { optional: true, timeoutMs: 3000 });
      if (submitButton) {
        // The click-time gate, the submit marker, the single click, and the confirmation check
        // (src/apply/unattended-submit.js). Nothing else in this adapter clicks Submit.
        return ctx.submit({ submitSelector: SELECTORS.submit, scopeSelector: SELECTORS.stepProbe, ledger });
      }
      const nextButton = await cap.waitFor(SELECTORS.next, { optional: true, timeoutMs: 3000 });
      if (!nextButton) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Neither a Next nor a Submit control was found on this wizard step.', page_url: ctx.applyUrl } };
      }
      await cap.click(SELECTORS.next);
    }
    return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: `The application wizard did not reach a submit step within ${MAX_STEPS} steps.`, page_url: ctx.applyUrl } };
  },
};
