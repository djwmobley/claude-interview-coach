// @ts-check
/**
 * Workday apply adapter: the SCRIPTED, model-blind half of assisted Workday (spec v1 clause 6, v2 A15).
 *
 * prepare(cap, ctx) gets from the job-description page to the first wizard step and nothing further:
 * Apply -> Apply Manually (enterApplyFlow), then the per-tenant account (authenticate: sign in with the
 * Credential Manager credential, or create the account with a generated 24-char password written to
 * Credential Manager BEFORE any form interaction), then email verification (verifyEmailIfRequired, via the
 * existing Gmail token), then a check that the wizard is present. It is deterministic, never sees the
 * model, and the model never sees a password: src/apply/worker.js runs it under the Playwright route
 * policy, then hands the tab to the assisted_apply tool (src/apply/assisted/handoff.js), which fills the
 * wizard pages and stops before Submit. Damian clicks Submit himself.
 *
 * run() is the old unattended entry point. It is unreachable (the worker dispatches on `assisted` and calls
 * prepare); it does nothing and parks, so a caller that ignores `assisted` fails safe. The unattended wizard
 * walk (screening answers, profile fills, and the Submit click behind recordSubmitRequestSent) was removed
 * in assisted Workday PR-2 (spec v1 clause 4: answerCustomFields and fillProfileFieldsIfPresent deleted).
 *
 * KNOWN LIMITATION: the `data-automation-id` values below are this build's best understanding of Workday's
 * Candidate Experience UI. The entry and auth ids were verified READ-ONLY on live tenants on 2026-10-05;
 * account creation, sign-in success, and email verification were never exercised live. Every branch that
 * cannot recognize what it sees parks in needs_human (kind 'unrecognized_page', 'credential',
 * 'email_verification', or 'captcha') instead of proceeding.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';

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
  // Live (att.wd1): the gate opens on Create Account; signInLink switches to the Sign In panel, whose
  // aria-hidden signInSubmitButton exists only on that panel (attached probe), behind the same click_filter
  // overlay as Create Account. Only one panel is rendered at a time, so the overlay is unambiguous.
  signInToggle: '[data-automation-id="signInLink"]',
  signInFormReady: '[data-automation-id="signInSubmitButton"]',
  signInSubmit: '[data-automation-id="noCaptchaWrapper"] [data-automation-id="click_filter"], [data-automation-id="signInSubmitButton"]',
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
  // The wizard: the My Information page id (live, talentmanagementsolution.wd3), its live footer Next
  // button, or the step bar. applyFlowPage alone is NOT enough (it also wraps the auth gate).
  wizardProbe: '[data-automation-id="applyFlowMyInfoPage"], [data-automation-id="pageFooterNextButton"], [data-automation-id="progressBar"]',
});

/** Verify-email poll: attempts and the delay between them (ctx.sleep, test-injectable). */
export const VERIFY_POLL_ATTEMPTS = 4;
export const VERIFY_POLL_DELAY_MS = 15000;

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
    // The gate may open on Create Account (live att.wd1); switch to the Sign In panel first.
    const toSignIn = await cap.waitFor(SELECTORS.signInToggle, { optional: true, timeoutMs: 2000 });
    if (toSignIn) {
      await cap.click(SELECTORS.signInToggle);
      const ready = await cap.waitFor(SELECTORS.signInFormReady, { optional: true, state: 'attached', timeoutMs: 5000 });
      if (!ready) {
        return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Workday Sign In form not found after clicking the Sign In link.', page_url: ctx.applyUrl } };
      }
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

/**
 * The scripted prelude (spec v1 clause 6): entry, auth, email verification, then confirm the wizard is
 * on screen. Returns { outcome: 'ok' } with the tab on the first wizard step, or a needs_human outcome.
 * Never answers a question, never clicks Next, never reaches Submit.
 * @param {import('../apply-capability.js').ApplyCapability} cap
 * @param {any} ctx
 * @returns {Promise<{ outcome: 'ok' } | { outcome: 'needs_human', pendingQuestion: any }>}
 */
async function prepare(cap, ctx) {
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

  const wizard = await cap.waitFor(SELECTORS.wizardProbe, { optional: true, timeoutMs: 20000 });
  if (!wizard) {
    return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'The Workday application wizard did not appear after sign-in.', page_url: ctx.applyUrl } };
  }
  const captchaHit = await checkCaptcha(cap, ctx, wizard);
  if (captchaHit) return captchaHit;
  return { outcome: 'ok' };
}

export const workday = {
  ats: 'workday',
  requires: ['credential'],
  classifyOnly: false,
  /** src/apply/worker.js routes every Workday application through the assisted handoff (prepare + model). */
  assisted: true,
  // Workday's own tenant host (e.g. acme.wd5.myworkdayjobs.com) already covers this ATS's application
  // POST traffic under src/browser/session.js's per-page route policy (worker.js always allows
  // ctx.tenantHost itself) -- there is no separate CDN/upload host to widen for, unlike Greenhouse/Lever.
  uploadHosts: [],
  prepare,
  /**
   * The old unattended entry point (spec v2 A15): unreachable, touches nothing, parks.
   * @param {unknown} _cap
   * @param {{ applyUrl?: string|null }} ctx
   */
  async run(_cap, ctx) {
    return {
      outcome: 'needs_human',
      pendingQuestion: {
        kind: 'assisted_stopped',
        label: 'Workday runs only through the assisted flow (Damian submits); this adapter entry point does nothing.',
        page_url: ctx && ctx.applyUrl ? ctx.applyUrl : null,
      },
    };
  },
};
