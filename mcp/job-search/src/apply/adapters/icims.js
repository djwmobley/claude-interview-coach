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
import { classifyCompensationLabel } from '../answers.js';

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
  confirmationHeading: '[data-testid="application-confirmation"], h1, h2',
});

/**
 * @param {{ tagName: string, type: string|null }} f
 */
function controlTypeFor(f) {
  if (f.tagName === 'select') return 'radio';
  if (f.tagName === 'textarea') return 'text';
  if (f.tagName === 'input') {
    if (f.type === 'checkbox') return 'checkbox-group';
    if (f.type === 'radio') return 'radio';
    if (f.type === null || f.type === 'text' || f.type === 'tel' || f.type === 'email' || f.type === 'number') return 'text';
  }
  return undefined;
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
 * Fill whichever profile fields are present. Every fill is guarded by an optional probe first.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 */
async function fillProfileFieldsIfPresent(cap, ctx) {
  if (ctx.profile.fullName) {
    const parts = String(ctx.profile.fullName).trim().split(/\s+/);
    const first = parts[0] ?? '';
    const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
    if (await cap.waitFor(SELECTORS.firstName, { optional: true, timeoutMs: 1500 })) await cap.fill(SELECTORS.firstName, first);
    if (await cap.waitFor(SELECTORS.lastName, { optional: true, timeoutMs: 1500 })) await cap.fill(SELECTORS.lastName, last);
  }
  if (ctx.profile.email && await cap.waitFor(SELECTORS.email, { optional: true, timeoutMs: 1500 })) await cap.fill(SELECTORS.email, ctx.profile.email);
  if (ctx.profile.phone && await cap.waitFor(SELECTORS.phone, { optional: true, timeoutMs: 1500 })) await cap.fill(SELECTORS.phone, ctx.profile.phone);
}

/**
 * Upload the linked resume/cover letter. Never proceeds past an unconfirmed upload -- same guard as every
 * other adapter in this package.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @returns {Promise<{ ok: true } | { ok: false, pendingQuestion: any }>}
 */
async function uploadDocumentsIfPresent(cap, ctx) {
  if (ctx.documents.resumePath) {
    const uploadedName = await cap.upload(SELECTORS.resumeUpload, ctx.documents.resumePath);
    if (!uploadedName) {
      return { ok: false, pendingQuestion: { kind: 'unrecognized_page', label: 'Resume upload could not be confirmed; the file input did not register a file.', page_url: ctx.applyUrl } };
    }
  }
  if (ctx.documents.coverletterPath) {
    await cap.upload(SELECTORS.coverLetterUpload, ctx.documents.coverletterPath);
  }
  return { ok: true };
}

/**
 * Answer every enumerated custom screening field on the page. Compensation gate (Damian's ruling, spec
 * item B): a label classifying as compensation-family (classifyCompensationLabel) is ALWAYS routed
 * through that gate before the generic bank matcher ever runs -- never answered by an unrelated
 * alias/synonym/learned match. Hourly is a disqualifier and is never filled; only a plain-text BASE ANNUAL
 * figure with a configured floor ever auto-fills. Every other compensation-family shape always parks,
 * regardless of the field's own required flag -- never silently skipped, since guessing or skipping a
 * compensation figure is a worse failure mode than an extra manual click.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 */
async function answerCustomFields(cap, ctx) {
  const fields = /** @type {any[]} */ (await cap.waitFor(SELECTORS.customFields, { all: true, timeoutMs: 3000 }));
  for (const f of fields ?? []) {
    const label = String(f.text ?? '').trim();
    if (!label) continue;
    const controlType = controlTypeFor(f);
    const selector = f.id ? `#${f.id}` : null;

    const compClass = classifyCompensationLabel(label, { controlType, floor: ctx.answers.bank?.meta?.salary_floor ?? null });
    if (compClass.category !== 'not_compensation') {
      if (compClass.category === 'fill' && selector) {
        await cap.fill(selector, String(compClass.value));
        continue;
      }
      const shot = await cap.screenshot();
      return {
        parked: true,
        pendingQuestion: {
          kind: 'question', label, page_url: ctx.applyUrl, screenshot: shot.relPath, suggestion: null, tier: null,
        },
      };
    }

    const match = ctx.answers.match(label, controlType, f.options ?? undefined);
    if (match.outcome === 'auto_answer') {
      if (!selector) continue;
      if (controlType === 'text') {
        await cap.fill(selector, String(match.controlResult?.text ?? match.value ?? ''));
      } else if (controlType === 'radio' && f.tagName === 'select') {
        await cap.select(selector, String(match.controlResult?.selectedOption ?? ''));
      } else {
        await cap.click(selector);
      }
      continue;
    }
    if (f.required) {
      const shot = await cap.screenshot();
      return {
        parked: true,
        pendingQuestion: {
          kind: 'question', label, page_url: ctx.applyUrl, screenshot: shot.relPath, suggestion: match.suggestion ?? null, tier: match.tier,
        },
      };
    }
    ctx.log({ evt: 'question_unmatched_optional', label: label.slice(0, 200) });
  }
  return { parked: false };
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
    await fillProfileFieldsIfPresent(cap, ctx);
    const uploadResult = await uploadDocumentsIfPresent(cap, ctx);
    if (!uploadResult.ok) return { outcome: 'needs_human', pendingQuestion: uploadResult.pendingQuestion };

    // (5) Screening questions via the bank; salary routes through resolveSalaryAnswer first.
    const questionResult = await answerCustomFields(cap, ctx);
    if (questionResult.parked) {
      return { outcome: 'needs_human', pendingQuestion: questionResult.pendingQuestion };
    }

    // (6) Submit and confirm.
    const submitButton = await cap.waitFor(SELECTORS.submit, { optional: true, timeoutMs: 3000 });
    if (!submitButton) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find a submit control on the iCIMS application form.', page_url: ctx.applyUrl } };
    }
    await ctx.recordSubmitRequestSent();
    await cap.click(SELECTORS.submit);

    const confirmation = await cap.waitFor(SELECTORS.confirmationHeading, { optional: true, timeoutMs: 20000 });
    const confirmedByHeading = Boolean(confirmation && /thank you|application (received|submitted|complete)|we('| ha)ve received/i.test(String(confirmation.text ?? '')));
    if (confirmedByHeading) {
      return { outcome: 'submitted', confirmationRef: null };
    }
    return { outcome: 'needs_human', pendingQuestion: { kind: 'post_submit_uncertain', label: 'Submitted, but no confirmation heading was seen; verify manually.', page_url: ctx.applyUrl } };
  },
};
