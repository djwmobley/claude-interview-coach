// @ts-check
/**
 * LinkedIn button-only external Apply capture (auto-apply GAP 1, docs/auto-apply-spec.md section 9; spec v2
 * B5/B12). When src/apply/linkedin-apply-state.js classifies a job page as 'external' with a BUTTON control
 * (no href), this module performs EXACTLY ONE click on that identified control and polls for up to
 * `timeoutMs` (default 15000, the spec's "at most 15 s") for one of these outcomes:
 *
 *   - a NEW browser target opens off LinkedIn: `{ outcome: 'new_target', url }` for the caller to feed to
 *     src/apply/apply-target.js#resolveApplyTarget -- the new target is closed immediately after reading its
 *     URL, and nothing is ever typed into or submitted on either page;
 *   - a new target opens on ANY linkedin.com host, /safety/go/ included: `{ outcome: 'linkedin_target', url }`
 *     (spec v2 B12: the caller classifies this unknown, never external);
 *   - the SAME tab's own URL gains the `applicantTrackingSystemName`/`companyName` query params
 *     (extractApplyHint below): `{ outcome: 'hint', hint }` -- diagnostic only, never a resolved target;
 *   - neither within the deadline: `{ outcome: 'timeout' }`;
 *   - the click never happened: `{ outcome: 'aborted', reason }`.
 *
 * The click target (spec v2 B5) is the classifier's identified control -- `opts.control.path`, a precise
 * nth-child locator built from the observed page, plus `opts.control.name`, its accessible name. There is no
 * default or shared CSS selector (the old `button.jobs-apply-button` selector matched Easy Apply and external
 * Apply alike). Immediately before clicking, the live element is inspected: it must match exactly one
 * element, its accessible name must equal the classified name, and that name must not contain "easy apply";
 * any failure aborts without clicking (reasons no_control | control_not_unique | easy_apply_control |
 * control_changed).
 *
 * This module never touches src/apply/apply-capability.js's makeApplyCapability -- this is not the apply
 * pipeline's submission path, and test/apply-lint.test.js's own lint enforces that constructor has exactly
 * one callsite (src/apply/worker.js). The `page`/`session` parameters are a MINIMAL, injectable interface
 * (url/inspect/click, listTargets/closeTarget) so this function is testable against fakes; production
 * callers adapt a real Playwright Page/BrowserContext to it (src/apply/linkedin-button-prepare.js's
 * adaptPlaywrightPage).
 */
import { normalizeName } from './assisted/guard.js';
import { isLinkedInHostUrl } from './linkedin-apply-state.js';

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

/**
 * @typedef {Object} ButtonProbePage
 * @property {() => Promise<string>} url current same-tab URL
 * @property {(selector: string) => Promise<{ count: number, name: string }>} inspect how many live elements
 *   the locator matches, and the first one's accessible name (aria-label, else visible text)
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
 * @param {{ control: { path: string, name: string }, timeoutMs?: number, pollIntervalMs?: number, sleep?: (ms: number) => Promise<void> }} opts
 * @returns {Promise<
 *   { outcome: 'new_target', url: string }
 *   | { outcome: 'linkedin_target', url: string }
 *   | { outcome: 'hint', hint: { applicantTrackingSystemName: string|null, companyName: string|null } }
 *   | { outcome: 'timeout' }
 *   | { outcome: 'aborted', reason: 'no_control'|'control_not_unique'|'easy_apply_control'|'control_changed' }
 * >}
 */
export async function probeLinkedInButtonApply(page, session, opts) {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const control = opts && opts.control;
  if (!control || typeof control.path !== 'string' || !control.path || typeof control.name !== 'string') {
    return { outcome: 'aborted', reason: 'no_control' };
  }

  const live = await page.inspect(control.path);
  if (!live || live.count !== 1) return { outcome: 'aborted', reason: 'control_not_unique' };
  const liveName = normalizeName(live.name);
  if (/easy\s*apply/.test(liveName)) return { outcome: 'aborted', reason: 'easy_apply_control' };
  if (liveName !== normalizeName(control.name)) return { outcome: 'aborted', reason: 'control_changed' };

  const startUrl = await page.url();
  const targetsBefore = new Set((await session.listTargets()).map((t) => t.id));
  await page.click(control.path);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const targetsNow = await session.listTargets();
    const opened = targetsNow.find((t) => !targetsBefore.has(t.id));
    if (opened) {
      try {
        await session.closeTarget(opened.id);
      } catch {
        /* best-effort close; the observed URL is still valid even if closing the new target failed */
      }
      if (isLinkedInHostUrl(opened.url)) return { outcome: 'linkedin_target', url: opened.url };
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
