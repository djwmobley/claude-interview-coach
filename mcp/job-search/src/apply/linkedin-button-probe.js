// @ts-check
/**
 * LinkedIn button-only Apply hint capture (auto-apply GAP 1, docs/auto-apply-spec.md section 9). When a
 * LinkedIn job detail page's own Apply control is a button with no href (src/browser/extractors.js's
 * linkedinApplyLink() already reports exactly this shape as `{ href: null, buttonOnly: true }`), this
 * module performs EXACTLY ONE click and polls for up to `timeoutMs` (default 15000, the spec's "at most
 * 15 s") for one of two outcomes:
 *
 *   - a NEW browser target opens: its URL is returned as `{ outcome: 'new_target', url }` for the caller
 *     to feed to src/apply/apply-target.js#resolveApplyTarget as the candidate -- the new target is closed
 *     immediately after reading its URL, and nothing is ever typed into or submitted on either page;
 *   - the SAME tab's own URL gains the `applicantTrackingSystemName`/`companyName` query params
 *     (extractApplyHint below): returned as `{ outcome: 'hint', hint }` -- diagnostic only, per the
 *     "hint never counts as resolved" rule; the caller must never treat this as a resolved apply_url/
 *     apply_ats.
 *   - neither within the deadline: `{ outcome: 'timeout' }`.
 *
 * This module never decides WHETHER to click (that is the caller's job, gated on `buttonOnly && !href`)
 * and never touches src/apply/apply-capability.js's makeApplyCapability -- this is not the apply
 * pipeline's submission path, and test/apply-lint.test.js's own lint enforces that constructor has exactly
 * one callsite (src/apply/worker.js). The `page`/`session` parameters here are a MINIMAL, injectable
 * interface (url/click, listTargets/closeTarget) so this function is testable against fakes; production
 * callers (bin/auto-apply.js) adapt a real Playwright Page/BrowserContext to it.
 */

/**
 * Pure: extract the same-tab hint params from a URL. Returns null when NEITHER param is present -- a URL
 * change with no hint params at all is not itself evidence of anything (see the caller's own poll loop,
 * which keeps waiting rather than treating an unrelated same-tab navigation as the hint outcome).
 * @param {string} urlStr
 * @returns {{ applicantTrackingSystemName: string|null, companyName: string|null }|null}
 */
export function extractApplyHint(urlStr) {
  /** @type {URL} */
  let u;
  try {
    u = new URL(String(urlStr));
  } catch {
    return null;
  }
  const applicantTrackingSystemName = u.searchParams.get('applicantTrackingSystemName');
  const companyName = u.searchParams.get('companyName');
  if (!applicantTrackingSystemName && !companyName) return null;
  return { applicantTrackingSystemName, companyName };
}

/** Default Apply button selector (mirrors src/browser/extractors.js's linkedinApplyLink() button match). */
export const DEFAULT_APPLY_BUTTON_SELECTOR = 'button.jobs-apply-button, button[aria-label*="Easy Apply" i]';

/**
 * @typedef {Object} ButtonProbePage
 * @property {() => Promise<string>} url current same-tab URL
 * @property {(selector: string) => Promise<void>} click
 */
/**
 * @typedef {Object} ButtonProbeSession
 * @property {() => Promise<Array<{ id: unknown, url: string }>>} listTargets every open target/page, `id`
 *   opaque to this module (a production caller can pass the Page object itself as `id`)
 * @property {(id: unknown) => Promise<void>} closeTarget
 */

/**
 * @param {ButtonProbePage} page
 * @param {ButtonProbeSession} session
 * @param {{ timeoutMs?: number, pollIntervalMs?: number, sleep?: (ms: number) => Promise<void>, selector?: string }} [opts]
 * @returns {Promise<
 *   { outcome: 'new_target', url: string }
 *   | { outcome: 'hint', hint: { applicantTrackingSystemName: string|null, companyName: string|null } }
 *   | { outcome: 'timeout' }
 * >}
 */
export async function probeLinkedInButtonApply(page, session, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const selector = opts.selector ?? DEFAULT_APPLY_BUTTON_SELECTOR;

  const startUrl = await page.url();
  const targetsBefore = new Set((await session.listTargets()).map((t) => t.id));
  await page.click(selector);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const targetsNow = await session.listTargets();
    const opened = targetsNow.find((t) => !targetsBefore.has(t.id));
    if (opened) {
      try {
        await session.closeTarget(opened.id);
      } catch {
        /* best-effort close; the resolved URL is still valid even if closing the new target failed */
      }
      return { outcome: 'new_target', url: opened.url };
    }
    const currentUrl = await page.url();
    if (currentUrl !== startUrl) {
      const hint = extractApplyHint(currentUrl);
      if (hint) return { outcome: 'hint', hint };
    }
    if (Date.now() >= deadline) return { outcome: 'timeout' };
    await sleep(Math.max(0, Math.min(pollIntervalMs, deadline - Date.now())));
  }
}
