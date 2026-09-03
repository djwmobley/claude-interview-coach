// @ts-check
/**
 * Lever apply adapter (apply pipeline slice 5, plan section 3). No account needed, a single-page form:
 * fill from ctx.profile, upload the linked resume/cover letter, answer screening questions from the bank
 * (auto-answer only 'learned'-tier matches; anything else parks with a screenshot), submit, and confirm
 * via a heading match or a `/thanks`-shaped URL.
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section): same caveat as src/apply/adapters/greenhouse.js
 * -- the CSS selectors below are this build's best understanding of Lever's application-form DOM, written
 * and tested against a SCRIPTED FAKE page (test/lever-adapter.test.js), not verified against a live
 * jobs.lever.co page in this sandboxed environment. The failure mode on a wrong selector is safe: a
 * `waitFor({optional:true})` miss parks in needs_human ('unrecognized_page') rather than guessing.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { classifyCompensationLabel } from '../answers.js';

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
  confirmationHeading: '.confirmation, [data-qa="posting-confirmation"], h1, h2',
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
 * Compensation gate (Damian's ruling, spec item B): a compensation-family label
 * (classifyCompensationLabel) is ALWAYS routed through that gate before the generic bank matcher, and
 * every shape but a plain-text BASE ANNUAL figure with a configured floor always parks.
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

    if (ctx.profile.fullName) await cap.fill(SELECTORS.fullName, ctx.profile.fullName);
    if (ctx.profile.email) await cap.fill(SELECTORS.email, ctx.profile.email);
    if (ctx.profile.phone) await cap.fill(SELECTORS.phone, ctx.profile.phone);

    if (ctx.documents.resumePath) {
      const uploadedName = await cap.upload(SELECTORS.resumeUpload, ctx.documents.resumePath);
      if (!uploadedName) {
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
    return { outcome: 'needs_human', pendingQuestion: { kind: 'post_submit_uncertain', label: 'Submitted, but no confirmation heading or /thanks URL was seen; verify manually.', page_url: ctx.applyUrl } };
  },
};
