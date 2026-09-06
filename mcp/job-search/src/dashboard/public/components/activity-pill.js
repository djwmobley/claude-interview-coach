// @ts-check
/**
 * Topbar activity pill (activity pill spec item 3). Replaces the old scan-only pill in
 * components/scan-progress.js -- kept as a separate new file rather than a rename of that one, because
 * scan-progress.js's `scanProgressPanel`/`heartbeatBucket` exports are still used by pages/home.js for the
 * Home page's own scan-run detail panel, which this feature does not touch (renaming that file would have
 * dragged an unrelated page's imports along for no reason).
 *
 * Shows what the OPERATOR is doing (GET /api/activity's `operator` field) -- "Idle" when null, otherwise
 * `operator.label` with a "+N" suffix when `operator_extra > 0` (more than one operator-driven action is
 * running at once). It NEVER shows background automation (a scheduled scan, auto-apply, confirm) -- that
 * is components/background-banner.js's job instead, by design (spec item 3's own instruction).
 */
import { h } from '../lib/dom.js';

/**
 * Pure text computation, kept DOM-free so it is directly unit-testable (this codebase has no jsdom --
 * see test/dashboard-public-linksafety.test.js's note on hApplicationScreenshot for the house convention:
 * `h()`-calling render functions are exercised through the app itself, not a unit test).
 * @param {{ operator: { label: string } | null, operator_extra: number } | null | undefined} activity
 * @returns {{ text: string, running: boolean }}
 */
export function pillText(activity) {
  if (!activity || !activity.operator) return { text: 'Idle', running: false };
  const extra = activity.operator_extra > 0 ? ` +${activity.operator_extra}` : '';
  return { text: `${activity.operator.label}${extra}`, running: true };
}

/**
 * @param {{ operator: any, operator_extra: number } | null | undefined} activity
 */
export function activityPill(activity) {
  const { text, running } = pillText(activity);
  return h('span', { className: `activity-pill ${running ? 'activity-pill--running' : 'activity-pill--idle'}`, text });
}
