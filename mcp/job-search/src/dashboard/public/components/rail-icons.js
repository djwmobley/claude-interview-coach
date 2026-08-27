// @ts-check
/**
 * One simple 16px inline-SVG glyph per rail nav entry (defect 5: at the 1180px breakpoint the rail goes
 * icon-only with a title tooltip instead of the truncated 9px-ellipsis label fragments the old rule
 * produced). Built exclusively through `hSvg()` (lib/dom.js), the only SVG-construction path in public/
 * -- no external icon font, no icon library, no innerHTML. No shape here carries a fill/stroke attribute
 * of its own (hSvg()'s attribute allow-list has neither): color comes entirely from the
 * `.rail__icon { fill: currentColor; }` rule in app.css, so every glyph always matches its link's current
 * text color, including the active-link accent, with no second color value to keep in sync.
 */
import { hSvg } from '../lib/dom.js';

/** @param {Array<SVGElement>} children */
function icon(children) {
  return hSvg('svg', { viewBox: '0 0 16 16', width: 16, height: 16, class: 'rail__icon', 'aria-hidden': 'true', focusable: 'false' }, children);
}

/** @type {Record<string, () => SVGElement>} */
const ICON_FACTORIES = {
  home: () => icon([hSvg('path', { d: 'M2 8 8 2l6 6M4 7v7h3v-4h2v4h3V7' })]),
  jobs: () => icon([hSvg('rect', { x: 2, y: 5, width: 12, height: 8, rx: 1 }), hSvg('path', { d: 'M6 5V3.5A1.5 1.5 0 0 1 7.5 2h1A1.5 1.5 0 0 1 10 3.5V5' })]),
  pipeline: () => icon([hSvg('path', { d: 'M2 3h12l-4.5 6v4l-3 1.5V9z' })]),
  followups: () => icon([hSvg('circle', { cx: 8, cy: 8, r: 6 }), hSvg('path', { d: 'M8 5v3l2 2' })]),
  review: () => icon([hSvg('path', { d: 'M2 8s2.5-4.5 6-4.5S14 8 14 8s-2.5 4.5-6 4.5S2 8 2 8z' }), hSvg('circle', { cx: 8, cy: 8, r: 1.6 })]),
  runs: () => icon([hSvg('circle', { cx: 8, cy: 8, r: 6 }), hSvg('path', { d: 'M6.5 5.5v5l4-2.5z' })]),
  reports: () => icon([hSvg('rect', { x: 3, y: 2, width: 10, height: 12, rx: 1 }), hSvg('path', { d: 'M5.5 5.5h5M5.5 8h5M5.5 10.5h3' })]),
  calendar: () => icon([hSvg('rect', { x: 2, y: 3, width: 12, height: 11, rx: 1 }), hSvg('path', { d: 'M2 6.5h12M5 2v3M11 2v3' })]),
  analytics: () => icon([hSvg('path', { d: 'M3 13V8M7 13V5M11 13V9M13.5 13H2.5' })]),
  companies: () => icon([hSvg('rect', { x: 3, y: 2, width: 10, height: 12, rx: 1 }), hSvg('path', { d: 'M6 5h1M9 5h1M6 8h1M9 8h1M6 11h1M9 11h1' })]),
};

/** Fallback glyph for any rail route this table has not been extended for yet -- a plain dot, never a missing icon. */
function fallbackIcon() {
  return icon([hSvg('circle', { cx: 8, cy: 8, r: 5 })]);
}

/**
 * @param {string} route
 * @returns {SVGElement}
 */
export function railIcon(route) {
  const factory = ICON_FACTORIES[route] ?? fallbackIcon;
  return factory();
}
