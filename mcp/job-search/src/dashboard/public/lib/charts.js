// @ts-check
/**
 * Inline SVG chart primitives for the Analytics page (plan "Analytics", `charts.js: bars, line, funnel,
 * stat`). Every mark's color is a CSS class (`bar--<token>`), never an inline fill or style attribute value,
 * built exclusively through `hSvg()`/`h()` from lib/dom.js.
 */
import { hSvg, h } from './dom.js';

/** Fixed source color order (design's analytics legend, extended with `manual` and a fallback per section 9 item 17). */
export const SOURCE_COLORS = Object.freeze({
  greenhouse: 'accent', lever: 'cyan', linkedin: 'purple', indeed: 'yellow',
  builtin: 'green', ziprecruiter: 'pink', manual: 'purple',
});

/** @param {string|null|undefined} source */
export function sourceColorToken(source) {
  return SOURCE_COLORS[source ?? ''] ?? 'muted-2';
}

/**
 * Simple vertical bar chart. `data`: [{label, value, colorToken}]. Zero-height (all values 0) still
 * renders axis and labels, an explicit empty-safe branch rather than a divide-by-zero blank canvas.
 * @param {{ data: Array<{label:string, value:number, colorToken?:string}>, width?: number, height?: number, title: string }} opts
 */
export function barChart(opts) {
  const width = opts.width ?? 480;
  const height = opts.height ?? 160;
  const padBottom = 22;
  const max = Math.max(1, ...opts.data.map((d) => d.value));
  const barWidth = opts.data.length ? Math.min(36, (width - 16) / opts.data.length - 6) : 0;
  const bars = opts.data.map((d, i) => {
    const barHeight = Math.round(((height - padBottom) * d.value) / max);
    const x = 8 + i * ((width - 16) / Math.max(1, opts.data.length));
    const y = height - padBottom - barHeight;
    return hSvg('g', {}, [
      hSvg('rect', { class: `chart-bar bar--${d.colorToken ?? 'accent'}`, x, y, width: Math.max(2, barWidth), height: Math.max(0, barHeight) }),
      hSvg('text', { class: 'chart-label', x: x + barWidth / 2, y: height - 6, 'text-anchor': 'middle' }, [d.label]),
    ]);
  });
  return hSvg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.title, width: '100%', height }, bars);
}

/**
 * Simple polyline chart for a single series.
 * @param {{ points: Array<{x:number, label:string, value:number}>, width?: number, height?: number, title: string, colorToken?: string }} opts
 */
export function lineChart(opts) {
  const width = opts.width ?? 480;
  const height = opts.height ?? 160;
  const padBottom = 22;
  const max = Math.max(1, ...opts.points.map((p) => p.value));
  const n = Math.max(1, opts.points.length - 1);
  const coords = opts.points.map((p, i) => {
    const x = 8 + (i * (width - 16)) / n;
    const y = height - padBottom - ((height - padBottom) * p.value) / max;
    return `${x},${y}`;
  });
  return hSvg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.title, width: '100%', height }, [
    hSvg('polyline', { class: `chart-line line--${opts.colorToken ?? 'accent'}`, points: coords.join(' ') }),
    ...opts.points.map((p, i) => {
      const x = 8 + (i * (width - 16)) / n;
      return hSvg('text', { class: 'chart-label', x, y: height - 6, 'text-anchor': 'middle' }, [p.label]);
    }),
  ]);
}

/**
 * Horizontal funnel: a shrinking series of bars, one per stage, labeled with counts.
 * @param {{ stages: Array<{label:string, value:number}>, width?: number }} opts
 */
export function funnelChart(opts) {
  const width = opts.width ?? 360;
  const rowHeight = 26;
  const max = Math.max(1, ...opts.stages.map((s) => s.value));
  const height = opts.stages.length * rowHeight + 8;
  const rows = opts.stages.map((s, i) => {
    const barWidth = Math.round(((width - 8) * s.value) / max);
    const y = 4 + i * rowHeight;
    return hSvg('g', {}, [
      hSvg('rect', { class: 'chart-bar bar--accent', x: 4, y, width: Math.max(2, barWidth), height: rowHeight - 8 }),
      hSvg('text', { class: 'chart-label chart-label--inline', x: 8, y: y + rowHeight / 2 }, [`${s.label}: ${s.value}`]),
    ]);
  });
  return hSvg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Pipeline funnel', width: '100%', height }, rows);
}

/** A single big stat number with a caption, no chart shape. @param {{ value: string, caption: string }} opts */
export function statTile(opts) {
  return h('div', { className: 'stat-tile' }, [
    h('div', { className: 'stat-tile__value', text: opts.value }),
    h('div', { className: 'stat-tile__caption', text: opts.caption }),
  ]);
}
