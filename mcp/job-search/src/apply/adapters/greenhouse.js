// @ts-check
/**
 * Greenhouse apply adapter (apply pipeline slice 5, plan section 3). No account needed, a single-page
 * form: fill from ctx.profile, upload the linked resume/cover letter, answer screening questions from the
 * bank (auto-answer only 'learned'-tier matches; anything else parks with a screenshot), submit, and
 * confirm via a heading match or a `/thanks`-shaped URL.
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section): the CSS selectors below are this build's best
 * understanding of Greenhouse's application-form DOM, written and tested against a SCRIPTED FAKE page
 * (test/greenhouse-adapter.test.js) -- they have not been verified against a live boards.greenhouse.io
 * page in this sandboxed environment (no real Chrome/network available here). Greenhouse has shipped more
 * than one application-form UI generation ("Job Board 2.0" vs the classic embed) with different markup.
 * The FAILURE MODE if a selector is wrong is safe by construction, not silent: `cap.waitFor(..., {optional:
 * true})` returns null rather than guessing, and this adapter treats "the form probe selector never
 * matched" as `needs_human` (kind 'unrecognized_page') rather than proceeding to fill/submit against a
 * page it does not actually recognize. It will not silently submit a malformed application; it may simply
 * not automate anything until the selectors are corrected against a real page.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { classifyCompensationLabel } from '../answers.js';

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
  confirmationHeading: '.application-confirmation, [data-qa="application-confirmation"], h1, h2',
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

/**
 * Map one enumerated field's DOM shape (src/apply/apply-capability.js's ElementInfo) to answers.js's
 * CONTROL_TYPES vocabulary. Total: an unrecognized tag/type combination maps to `undefined`, which
 * resolveControl() (src/apply/answers.js) already treats as 'unsupported_control_type' -> parks.
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
 * Answer every enumerated custom screening field. Compensation gate (Damian's ruling, spec item B): a
 * compensation-family label (classifyCompensationLabel) is ALWAYS routed through that gate before the
 * generic bank matcher, and every shape but a plain-text BASE ANNUAL figure with a configured floor always
 * parks. Returns `{ parked: false }` when every required field either auto-answered or was
 * optional-and-unmatched (skipped, logged); returns `{ parked: true, pendingQuestion }` on the FIRST
 * required field that does not auto-answer (never guesses a required answer -- amended spec).
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
          kind: 'question',
          label,
          page_url: ctx.applyUrl,
          screenshot: shot.relPath,
          suggestion: match.suggestion ?? null,
          tier: match.tier,
        },
      };
    }
    ctx.log({ evt: 'question_unmatched_optional', label: label.slice(0, 200) });
  }
  return { parked: false };
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

    const { first, last } = splitName(ctx.profile.fullName);
    if (first !== null) await cap.fill(SELECTORS.firstName, first);
    if (last !== null) await cap.fill(SELECTORS.lastName, last);
    if (ctx.profile.email) await cap.fill(SELECTORS.email, ctx.profile.email);
    if (ctx.profile.phone) await cap.fill(SELECTORS.phone, ctx.profile.phone);

    if (ctx.documents.resumePath) {
      const uploadedName = await cap.upload(SELECTORS.resumeUpload, ctx.documents.resumePath);
      if (!uploadedName) {
        // The browser's own file input never registered a file: uploading is not confirmed even locally,
        // let alone over the (route-policy-gated) network request that follows. Never proceed to submit on
        // an unconfirmed upload -- that is exactly the "silently looks submitted" failure mode the amended
        // spec calls out.
        return { outcome: 'needs_human', pendingQuestion: { kind: 'unrecognized_page', label: 'Resume upload could not be confirmed; the file input did not register a file.', page_url: ctx.applyUrl } };
      }
    }
    if (ctx.documents.coverletterPath) {
      await cap.upload(SELECTORS.coverLetterUpload, ctx.documents.coverletterPath);
    }

    const questionResult = await answerCustomFields(cap, ctx);
    if (questionResult.parked) {
      return { outcome: 'needs_human', pendingQuestion: questionResult.pendingQuestion };
    }

    await ctx.recordSubmitRequestSent();
    await cap.click(SELECTORS.submit);

    const confirmation = await cap.waitFor(SELECTORS.confirmationHeading, { optional: true, timeoutMs: 20000 });
    const confirmedByUrl = typeof ctx.applyUrl === 'string' && /\/thanks(\/|$|\?)/i.test(ctx.applyUrl);
    const confirmedByHeading = Boolean(confirmation && /thank you|application (received|submitted)|we('| ha)ve received/i.test(String(confirmation.text ?? '')));
    if (confirmedByHeading || confirmedByUrl) {
      return { outcome: 'submitted', confirmationRef: null };
    }
    // The submit request was already recorded above, so a failure to confirm from here on is the
    // worker's own duplicate-submission guard's concern (needs_human), never a plain retryable failure --
    // this adapter simply reports what it saw.
    return { outcome: 'needs_human', pendingQuestion: { kind: 'post_submit_uncertain', label: 'Submitted, but no confirmation heading or /thanks URL was seen; verify manually.', page_url: ctx.applyUrl } };
  },
};
