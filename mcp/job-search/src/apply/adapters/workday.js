// @ts-check
/**
 * Workday apply adapter (apply pipeline slice 6, plan section 3: "workday (per-tenant account creation
 * with generated 24-char password stored in Credential Manager under `ic-jobsearch/<tenant-host>`,
 * verify-email via the existing Gmail token, multi-page flow, clears unverifiable parsed roles and
 * re-enters from the bank)"). Unlike Greenhouse/Lever (slice 5, no account needed, single page), Workday
 * needs a per-tenant candidate account and its application flow is a multi-step wizard, not one form.
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section, and read this before touching SELECTORS): the
 * `data-automation-id` values below are this build's best understanding of Workday's Candidate Experience
 * (CX) UI, written and tested against a SCRIPTED FAKE page (test/workday-adapter.test.js) -- they have NOT
 * been verified against a live *.myworkdayjobs.com tenant in this sandboxed environment (no real
 * Chrome/network available here, and the Google refresh grant needed for live email verification is
 * currently invalid_grant). Every Workday tenant is its own deployment with its own branding and some
 * amount of custom field configuration; the account-creation and multi-step wizard shapes here are the
 * common CX pattern, not a guarantee for any specific tenant. The failure mode on a wrong selector is safe
 * by construction, exactly like greenhouse.js/lever.js: `cap.waitFor(..., {optional: true})` returns null
 * rather than guessing, and every branch below that cannot recognize what it sees parks in needs_human
 * (kind 'unrecognized_page', 'credential', or 'email_verification' as appropriate) instead of proceeding
 * against a page it does not actually recognize.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { classifyCompensationLabel } from '../answers.js';

// Entry into the apply flow. The apply URL is the job-description page (apply-target.js requires a /job/
// path); the auth gate only appears after Apply -> Apply Manually. Verified READ-ONLY on 2026-10-05
// against two live tenants (talentmanagementsolution.wd3 and att.wd1): the Apply control is an <a> with
// adventureButton, and the modal offers autofillWithResume / applyManually / useMyLastApplication (one
// tenant also applyWithLinkedIn). Only applyManually is ever clicked.
const APPLY_BUTTON = '[data-automation-id="adventureButton"]';
// signInContent / form signInFormo are the live ids (att.wd1, default panel = create account); the
// signInFormContainer / createAccountForm ids are this build's original, unverified guesses, kept as a fallback.
const AUTH_GATE = '[data-automation-id="signInContent"], form[data-automation-id="signInFormo"], [data-automation-id="signInFormContainer"], [data-automation-id="createAccountForm"], form[data-automation-id="signInFormContainer"], form[data-automation-id="createAccountForm"]';
// A tenant that allows guest applications (talentmanagementsolution.wd3) goes from Apply Manually straight to
// the My Information step with no auth gate. applyFlowPage is deliberately NOT here: it also wraps the auth
// gate page, so it cannot tell the two apart.
const GUEST_WIZARD = '[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="pageFooterNextButton"]';

/** Selector contract this adapter targets. Grouped here (not inlined) so a future selector fix touches one place. */
export const SELECTORS = Object.freeze({
  applyButton: APPLY_BUTTON,
  applyManually: '[data-automation-id="applyManually"]',
  guestWizard: GUEST_WIZARD,
  // Union probes: the first answers "job page or already at the auth gate?", the second "where did Apply
  // Manually land?". Each is followed by a short authGate-only probe to tell the members apart.
  entryProbe: `${AUTH_GATE}, ${APPLY_BUTTON}`,
  postManualProbe: `${AUTH_GATE}, ${GUEST_WIZARD}`,
  // The auth gate: either a sign-in panel or a create-account panel, sometimes both behind one toggle.
  authGate: AUTH_GATE,
  createAccountToggle: '[data-automation-id="createAccountLink"], a[data-automation-id="createAccountLink"]',
  authError: '[data-automation-id="errorMessage"], [role="alert"]',
  signInEmail: '[data-automation-id="email"]',
  signInPassword: '[data-automation-id="password"]',
  signInSubmit: '[data-automation-id="signInSubmitButton"]',
  createEmail: '[data-automation-id="email"]',
  createPassword: '[data-automation-id="password"]',
  createVerifyPassword: '[data-automation-id="verifyPassword"]',
  createAccountCheckbox: '[data-automation-id="createAccountCheckbox"]',
  // Live (att.wd1): createAccountSubmitButton is aria-hidden with a click_filter overlay on top that takes
  // the pointer; the overlay precedes the button in DOM order, so page.click resolves to it first.
  createAccountSubmit: '[data-automation-id="noCaptchaWrapper"] [data-automation-id="click_filter"], [data-automation-id="createAccountSubmitButton"]',
  verifyCodeInput: '[data-automation-id="verificationCode"], input[name="verificationCode"]',
  verifySubmit: '[data-automation-id="verifyButton"]',
  captcha: '.g-recaptcha, iframe[title*="recaptcha" i], [data-sitekey]',
  // Each wizard step (My Information / My Experience / Application Questions / Voluntary Disclosures /
  // Review) renders inside this same page-body container in Workday's CX shell.
  stepProbe: '[data-automation-id="pageBodyContainer"], [data-automation-id="applyFlowPage"]',
  firstName: '[data-automation-id="legalNameSection_firstName"], input[name="firstName"]',
  lastName: '[data-automation-id="legalNameSection_lastName"], input[name="lastName"]',
  phone: '[data-automation-id="phone-number"], input[name="phoneNumber"]',
  resumeUpload: '[data-automation-id="resumeUpload"] input[type="file"], input[name="resume"]',
  coverLetterUpload: '[data-automation-id="coverLetterUpload"] input[type="file"], input[name="coverLetter"]',
  customFields: '[data-automation-id="formField"], [data-automation-id$="Question"]',
  next: '[data-automation-id="bottom-navigation-next-button"], button[data-automation-id="next"]',
  submit: '[data-automation-id="bottom-navigation-next-button"][data-automation-id-submit="true"], button[data-automation-id="submit"]',
  confirmationHeading: '[data-automation-id="applicationConfirmationHeader"], h1, h2',
});

/** Bounded multi-step wizard loop (My Information / My Experience / Questions / Disclosures / Review, plus slack). Never an unbounded loop. */
export const MAX_STEPS = 8;
/** Verify-email poll: attempts and the delay between them (ctx.sleep, test-injectable). */
export const VERIFY_POLL_ATTEMPTS = 4;
export const VERIFY_POLL_DELAY_MS = 15000;

/**
 * @param {string|null|undefined} fullName
 */
function splitName(fullName) {
  if (!fullName || !String(fullName).trim()) return { first: null, last: null };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/**
 * Map one enumerated field's DOM shape to answers.js's CONTROL_TYPES vocabulary. Total: an unrecognized
 * tag/type combination maps to `undefined`, which resolveControl() already treats as
 * 'unsupported_control_type' -> parks. Identical to greenhouse.js/lever.js's own helper.
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

/** A sibling field's own options read like a pay-unit/currency choice list ("Hourly"/"Annual",
 * "USD"/"GBP", "Per Hour"/"Per Year", ...). */
const UNIT_OPTION_RE = /\b(hour|hourly|annual|annually|year|yearly|salary|week|weekly|month|monthly|currency|usd|gbp|eur|cad)\b/i;
/** A sibling field's own label reads as a bare unit/currency/frequency picker rather than a question of
 * its own (empty text, or a generic "Unit"/"Currency"/"Frequency"/"Pay Type"/"Per" label). */
const UNIT_FIELD_LABEL_RE = /^\s*$|^(unit|currency|frequency|pay\s*type|per)\s*$/i;

/**
 * KNOWN LIMITATION (see the PR body's Blind Spots section): best-effort, UNVERIFIED-against-a-live-tenant
 * detection of Workday's two-step compensation question -- a compensation-family number field immediately
 * next to (either side of, wizard field order is not guaranteed) a 'radio' (rendered `<select>`) sibling
 * whose own label is empty/generic and whose options read like pay-unit/currency choices. When detected,
 * the descriptor's `hasUnitSelector` is set so classifyCompensationLabel's rule 5 parks the pair rather
 * than guessing which unit the sibling selector is currently set to.
 * @param {any[]} fields
 * @param {number} index
 */
function hasSiblingUnitSelector(fields, index) {
  const candidates = [fields[index - 1], fields[index + 1]];
  return candidates.some((sib) => {
    if (!sib || controlTypeFor(sib) !== 'radio' || !Array.isArray(sib.options) || sib.options.length === 0) return false;
    const sibLabel = String(sib.text ?? '').trim();
    return UNIT_FIELD_LABEL_RE.test(sibLabel) && sib.options.some((/** @type {unknown} */ o) => UNIT_OPTION_RE.test(String(o)));
  });
}

/**
 * Answer every enumerated custom screening field found on the CURRENT wizard step. Compensation gate
 * (Damian's ruling, spec item B): a compensation-family label (classifyCompensationLabel) is ALWAYS
 * routed through that gate before the generic bank matcher, and every shape but a plain-text BASE ANNUAL
 * figure with a configured floor always parks. Workday's own two-step compensation shape (a number field
 * plus a sibling unit/currency selector) is detected via hasSiblingUnitSelector above and populates the
 * descriptor so rule 5 (salary_unit_selector_present) fires instead of a guessed fill.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 */
async function answerCustomFields(cap, ctx) {
  const fields = /** @type {any[]} */ (await cap.waitFor(SELECTORS.customFields, { all: true, timeoutMs: 3000 }));
  const list = fields ?? [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const label = String(f.text ?? '').trim();
    if (!label) continue;
    const controlType = controlTypeFor(f);
    const selector = f.id ? `#${f.id}` : null;

    const compClass = classifyCompensationLabel(label, {
      controlType,
      floor: ctx.answers.bank?.meta?.salary_floor ?? null,
      hasUnitSelector: hasSiblingUnitSelector(list, i),
    });
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

/**
 * Fill whichever profile fields are present on the current step. Every fill is guarded by an optional
 * probe first -- a field simply not being on THIS step of the wizard is normal, not an error.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 */
async function fillProfileFieldsIfPresent(cap, ctx) {
  const { first, last } = splitName(ctx.profile.fullName);
  if (first !== null && await cap.waitFor(SELECTORS.firstName, { optional: true, timeoutMs: 1500 })) await cap.fill(SELECTORS.firstName, first);
  if (last !== null && await cap.waitFor(SELECTORS.lastName, { optional: true, timeoutMs: 1500 })) await cap.fill(SELECTORS.lastName, last);
  if (ctx.profile.phone && await cap.waitFor(SELECTORS.phone, { optional: true, timeoutMs: 1500 })) await cap.fill(SELECTORS.phone, ctx.profile.phone);
}

/**
 * Upload the linked resume/cover letter, once (idempotent across steps via `uploaded.resume`/`.cover`,
 * mutated in place). Same "never proceed on an unconfirmed upload" guard as greenhouse.js/lever.js.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {{ resume: boolean, cover: boolean }} uploaded
 * @returns {Promise<{ ok: true } | { ok: false, pendingQuestion: any }>}
 */
async function uploadDocumentsIfPresent(cap, ctx, uploaded) {
  if (!uploaded.resume && ctx.documents.resumePath && await cap.waitFor(SELECTORS.resumeUpload, { optional: true, timeoutMs: 2000 })) {
    const uploadedName = await cap.upload(SELECTORS.resumeUpload, ctx.documents.resumePath);
    if (!uploadedName) {
      return { ok: false, pendingQuestion: { kind: 'unrecognized_page', label: 'Resume upload could not be confirmed; the file input did not register a file.', page_url: ctx.applyUrl } };
    }
    uploaded.resume = true;
  }
  if (!uploaded.cover && ctx.documents.coverletterPath && await cap.waitFor(SELECTORS.coverLetterUpload, { optional: true, timeoutMs: 2000 })) {
    await cap.upload(SELECTORS.coverLetterUpload, ctx.documents.coverletterPath);
    uploaded.cover = true;
  }
  return { ok: true };
}

/**
 * Captcha check: a DOM probe plus the reCAPTCHA v3 script-loader heuristic. Never solved, only detected.
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
 * Sign in with an existing stored credential, or create a new tenant account when none is stored.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @returns {Promise<{ outcome: 'ok', createdAccount: boolean } | { outcome: 'needs_human', pendingQuestion: any }>}
 */
async function authenticate(cap, ctx) {
  const existing = await ctx.credentials.read();
  if (existing) {
    await cap.fill(SELECTORS.signInEmail, existing.username);
    await cap.fill(SELECTORS.signInPassword, existing.password);
    await cap.click(SELECTORS.signInSubmit);
    const error = await cap.waitFor(SELECTORS.authError, { optional: true, timeoutMs: 4000 });
    if (error) {
      return {
        outcome: 'needs_human',
        pendingQuestion: {
          kind: 'credential', target: ctx.credentials.target, username: existing.username,
          label: 'The stored Workday credential was rejected at sign-in. Update the saved password (or the site account) and resume.',
          page_url: ctx.applyUrl,
        },
      };
    }
    return { outcome: 'ok', createdAccount: false };
  }

  // No stored credential: self-register. Amended spec (plan section 5a): the password is generated and
  // WRITTEN to Credential Manager BEFORE any account-creation form interaction, so a crash mid-creation
  // never loses it -- a retry finds the credential already stored and can decide by hand whether the
  // account actually exists.
  const password = ctx.credentials.generatePassword();
  const username = ctx.profile.email;
  await ctx.credentials.write(username, password);

  const toggle = await cap.waitFor(SELECTORS.createAccountToggle, { optional: true, timeoutMs: 3000 });
  if (toggle) await cap.click(SELECTORS.createAccountToggle);

  await cap.fill(SELECTORS.createEmail, username);
  await cap.fill(SELECTORS.createPassword, password);
  const verifyField = await cap.waitFor(SELECTORS.createVerifyPassword, { optional: true, timeoutMs: 2000 });
  if (verifyField) await cap.fill(SELECTORS.createVerifyPassword, password);
  const checkbox = await cap.waitFor(SELECTORS.createAccountCheckbox, { optional: true, timeoutMs: 2000 });
  if (checkbox) await cap.click(SELECTORS.createAccountCheckbox);
  await cap.click(SELECTORS.createAccountSubmit);

  const error = await cap.waitFor(SELECTORS.authError, { optional: true, timeoutMs: 4000 });
  if (error) {
    return {
      outcome: 'needs_human',
      pendingQuestion: {
        kind: 'credential', target: ctx.credentials.target, username,
        label: 'Account creation was rejected (the credential was already saved locally in case an account exists already -- sign in manually, then resume).',
        page_url: ctx.applyUrl,
      },
    };
  }
  return { outcome: 'ok', createdAccount: true };
}

/**
 * Poll Gmail for the tenant's verification code and complete the in-page code entry step, when the site
 * shows one. A tenant that never shows a code-entry step (verification skipped, or handled entirely by a
 * one-click email link this capability cannot follow) is not an error -- the caller simply continues.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @param {Date} createdAt
 * @returns {Promise<null | { outcome: 'needs_human', pendingQuestion: any }>}
 */
async function verifyEmailIfRequired(cap, ctx, createdAt) {
  const codeField = await cap.waitFor(SELECTORS.verifyCodeInput, { optional: true, timeoutMs: 5000 });
  if (!codeField) return null; // this tenant did not present a code-entry step; nothing to do here

  for (let attempt = 1; attempt <= VERIFY_POLL_ATTEMPTS; attempt++) {
    const result = await ctx.gmailVerify({ sentAfter: createdAt });
    if (!result.ok) {
      return {
        outcome: 'needs_human',
        pendingQuestion: {
          kind: 'email_verification',
          label: `Could not check Gmail for the Workday verification email (${result.reason}). Verify manually, then resume.`,
          page_url: ctx.applyUrl,
        },
      };
    }
    if (result.code) {
      await cap.fill(SELECTORS.verifyCodeInput, result.code);
      await cap.click(SELECTORS.verifySubmit);
      return null;
    }
    if (result.link) {
      // A link-only verification email cannot be completed through this capability (no navigate verb,
      // and following an arbitrary link from an email is out of scope for the route-policy-scoped apply
      // page). Documented blind spot -- see the PR body.
      return {
        outcome: 'needs_human',
        pendingQuestion: {
          kind: 'email_verification',
          label: 'The verification email contains a link, not a code; this cannot be completed automatically. Click the link by hand, then resume.',
          page_url: ctx.applyUrl,
        },
      };
    }
    if (attempt < VERIFY_POLL_ATTEMPTS) await ctx.sleep(VERIFY_POLL_DELAY_MS);
  }
  return {
    outcome: 'needs_human',
    pendingQuestion: {
      kind: 'email_verification',
      label: 'No Workday verification email arrived within the wait window. Verify manually, then resume.',
      page_url: ctx.applyUrl,
    },
  };
}

/**
 * Get from the job-description page to the auth gate (or a guest wizard): Apply, then Apply Manually. Skipped
 * when the page already shows the auth gate. Never clicks the Autofill / Use My Last Application / LinkedIn
 * options. Every step that cannot find what it expects parks as 'unrecognized_page' naming that step.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @returns {Promise<{ outcome: 'ok', gate: any } | { outcome: 'needs_human', pendingQuestion: any }>} gate is
 *   null for a guest wizard (this tenant asks for no account)
 */
async function enterApplyFlow(cap, ctx) {
  const park = (/** @type {string} */ label) => ({ outcome: /** @type {const} */ ('needs_human'), pendingQuestion: { kind: 'unrecognized_page', label, page_url: ctx.applyUrl } });

  const entry = await cap.waitFor(SELECTORS.entryProbe, { optional: true, timeoutMs: 15000 });
  if (entry) {
    const gateNow = await cap.waitFor(SELECTORS.authGate, { optional: true, timeoutMs: 1000 });
    if (gateNow) return { outcome: 'ok', gate: gateNow };
  }
  const applyButton = entry ? await cap.waitFor(SELECTORS.applyButton, { optional: true, timeoutMs: 1000 }) : null;
  if (!applyButton) return park('Apply button not found: no Workday Apply control or sign-in/create-account form on this page.');
  await cap.click(SELECTORS.applyButton);

  const manual = await cap.waitFor(SELECTORS.applyManually, { optional: true, timeoutMs: 10000 });
  if (!manual) return park('Apply Manually option not found after clicking Apply.');
  await cap.click(SELECTORS.applyManually);

  const landed = await cap.waitFor(SELECTORS.postManualProbe, { optional: true, timeoutMs: 15000 });
  if (!landed) return park('Workday auth form not found after Apply Manually (no sign-in/create-account form and no application wizard).');
  const gate = await cap.waitFor(SELECTORS.authGate, { optional: true, timeoutMs: 1500 });
  return { outcome: 'ok', gate };
}

export const workday = {
  ats: 'workday',
  requires: ['credential'],
  classifyOnly: false,
  // Workday's own tenant host (e.g. acme.wd5.myworkdayjobs.com) already covers this ATS's application
  // POST traffic under src/browser/session.js's per-page route policy (worker.js always allows
  // ctx.tenantHost itself) -- there is no separate CDN/upload host to widen for, unlike Greenhouse/Lever.
  uploadHosts: [],
  /**
   * @param {import('../apply-capability.js').ApplyCapability} cap
   * @param {any} ctx
   */
  async run(cap, ctx) {
    const entered = await enterApplyFlow(cap, ctx);
    if (entered.outcome === 'needs_human') return entered;
    const gate = entered.gate;

    // A null gate is a guest wizard: this tenant asks for no account, so no credential is read or written.
    if (gate) {
      const captchaAtGate = await checkCaptcha(cap, ctx, gate);
      if (captchaAtGate) return captchaAtGate;

      const authedAt = new Date();
      const authResult = await authenticate(cap, ctx);
      if (authResult.outcome === 'needs_human') return authResult;

      if (authResult.createdAccount) {
        const verifyResult = await verifyEmailIfRequired(cap, ctx, authedAt);
        if (verifyResult) return verifyResult;
      }
    }

    // Multi-page wizard: My Information / My Experience / Application Questions / Voluntary Disclosures /
    // Review -> Submit. Bounded loop, never unbounded: MAX_STEPS caps the number of steps this adapter
    // will ever walk on one run, regardless of whether a submit control is ever found.
    const uploaded = { resume: false, cover: false };
    let submittedThisRun = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      const stepInfo = await cap.waitFor(SELECTORS.stepProbe, { optional: true, timeoutMs: 15000 });
      if (!stepInfo) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Could not find the Workday application wizard on this page.', page_url: ctx.applyUrl } };
      }
      const captchaHit = await checkCaptcha(cap, ctx, stepInfo);
      if (captchaHit) return captchaHit;

      await fillProfileFieldsIfPresent(cap, ctx);
      const uploadResult = await uploadDocumentsIfPresent(cap, ctx, uploaded);
      if (!uploadResult.ok) return { outcome: 'needs_human', pendingQuestion: uploadResult.pendingQuestion };

      const questionResult = await answerCustomFields(cap, ctx);
      if (questionResult.parked) {
        return { outcome: 'needs_human', pendingQuestion: questionResult.pendingQuestion };
      }

      const submitButton = await cap.waitFor(SELECTORS.submit, { optional: true, timeoutMs: 3000 });
      if (submitButton) {
        await ctx.recordSubmitRequestSent();
        await cap.click(SELECTORS.submit);
        submittedThisRun = true;
        break;
      }
      const nextButton = await cap.waitFor(SELECTORS.next, { optional: true, timeoutMs: 3000 });
      if (!nextButton) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Neither a Next nor a Submit control was found on this wizard step.', page_url: ctx.applyUrl } };
      }
      await cap.click(SELECTORS.next);
    }
    if (!submittedThisRun) {
      return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: `The application wizard did not reach a submit step within ${MAX_STEPS} steps.`, page_url: ctx.applyUrl } };
    }

    const confirmation = await cap.waitFor(SELECTORS.confirmationHeading, { optional: true, timeoutMs: 20000 });
    const confirmedByHeading = Boolean(confirmation && /thank you|application (received|submitted|complete)|we('| ha)ve received/i.test(String(confirmation.text ?? '')));
    if (confirmedByHeading) {
      return { outcome: 'submitted', confirmationRef: null };
    }
    return { outcome: 'needs_human', pendingQuestion: { kind: 'post_submit_uncertain', label: 'Submitted, but no confirmation heading was seen; verify manually.', page_url: ctx.applyUrl } };
  },
};
