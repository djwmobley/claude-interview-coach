// @ts-check
/**
 * SmartRecruiters apply adapter (apply pipeline slice 6, plan section 3: "SmartRecruiters if small").
 * Assessed after building the Workday adapter: SmartRecruiters needs no account (like Greenhouse/Lever),
 * a single-page form, no new state-machine state, and no new auth flow -- it is a straight structural
 * copy of greenhouse.js/lever.js's own shape, so it was folded into this slice rather than deferred.
 *
 * KNOWN LIMITATION (see the PR body's Blind Spots section): same caveat as greenhouse.js/lever.js -- the
 * CSS selectors below are this build's best understanding of SmartRecruiters' application-form DOM,
 * written and tested against a SCRIPTED FAKE page (test/apply-adapters.test.js), not verified against a
 * live jobs.smartrecruiters.com/careers.smartrecruiters.com page in this sandboxed environment. The
 * failure mode on a wrong selector is safe: a `waitFor({optional:true})` miss parks in needs_human
 * ('unrecognized_page') rather than guessing.
 */
import { detectRecaptchaV3Script } from '../../browser/wall.js';
import { classifyCompensationLabel } from '../answers.js';

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

    if (ctx.profile.fullName) {
      const parts = String(ctx.profile.fullName).trim().split(/\s+/);
      const first = parts[0] ?? '';
      const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
      await cap.fill(SELECTORS.firstName, first);
      await cap.fill(SELECTORS.lastName, last);
    }
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
