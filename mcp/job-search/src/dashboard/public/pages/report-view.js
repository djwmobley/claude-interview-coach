// @ts-check
/**
 * Report view: a stored day renders `output/reports/<day>-scan-report.html` through
 * GET /api/documents/file (already sandbox-CSP'd by PR 2); a day with no stored file yet (typically
 * "today") falls back to the live GET /api/report/preview.html route added in this PR (section 9 item 3),
 * which never touches ic_report_state. Both render only inside a zero-token sandboxed iframe.
 */
import { h, setChildren, hSandboxedIframe } from '../lib/dom.js';
import { getJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { skeleton } from '../components/empty-state.js';

/** @param {HTMLElement} container @param {{day:string}} params */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 4 })]);

  const listOutcome = handleOutcome(await getJson('/api/documents', { dir: 'reports', q: params.day }));
  const hasStoredFile = listOutcome.kind === 'ok' && listOutcome.body.files.some((f) => f.name === `${params.day}-scan-report.html`);

  const src = hasStoredFile
    ? `/api/documents/file?path=${encodeURIComponent(`reports/${params.day}-scan-report.html`)}`
    : `/api/report/preview.html?date=${encodeURIComponent(params.day)}`;

  setChildren(container, [
    h('h1', { className: 'page-title', text: `Report: ${params.day}` }),
    h('p', { className: 'report-view__source', text: hasStoredFile ? 'Stored report.' : 'Live preview (not stamped as sent).' }),
    hSandboxedIframe({ src, title: `Report for ${params.day}`, className: 'report-iframe' }),
  ]);

  return { name: 'report-view' };
}
