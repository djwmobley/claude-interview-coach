// @ts-check
/**
 * "Run scan" options drawer (Home's action bar). The primary "Run scan" button opens this drawer rather
 * than starting a scan directly -- the single-primary-button-per-page rule (action-bar.js's own doc
 * comment) still holds, because the drawer's "Start" button is the one control that actually starts a
 * scan. Source checkboxes come from GET /api/profiles' `sources` field (config/adapters.json's own keys,
 * the same set src/core/scan-run.js's resolveSources() validates against), default all checked; "Dry
 * run" defaults off. POST /api/scans body is `{ sources, dryRun }`, built by the pure
 * lib/scan-options.js#buildScanRequestBody so the request shape is unit-testable without a DOM.
 */
import { h } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { sourceLabel } from '../lib/format.js';
import { drawer } from './drawer.js';
import { buildScanRequestBody } from '../lib/scan-options.js';

/** @param {{ onStarted?: () => void }} [opts] */
export async function openRunScanDrawer(opts = {}) {
  const outcome = handleOutcome(await getJson('/api/profiles'));
  const allSources = outcome.kind === 'ok' && Array.isArray(outcome.body.sources) ? outcome.body.sources : [];

  /** @type {Record<string, HTMLInputElement>} */
  const checkboxes = {};
  const sourceRows = allSources.length === 0
    ? [h('p', { className: 'drawer__hint', text: 'No configured sources found.' })]
    : allSources.map((name) => {
        const cb = h('input', { attrs: { type: 'checkbox' }, checked: true });
        checkboxes[name] = /** @type {HTMLInputElement} */ (cb);
        return h('label', { className: 'drawer__checkbox-row' }, [cb, h('span', { text: sourceLabel(name) })]);
      });

  const dryRunCheckbox = h('input', { attrs: { type: 'checkbox' }, checked: false });

  async function start() {
    /** @type {Record<string, boolean>} */
    const checked = {};
    for (const [name, cb] of Object.entries(checkboxes)) checked[name] = cb.checked;
    const body = buildScanRequestBody({ allSources, checked, dryRun: dryRunCheckbox.checked });
    const res = handleOutcome(await postJson('/api/scans', body));
    if (res.kind === 'ok') {
      showToast({ message: body.dryRun ? 'Dry run started.' : 'Scan started.' });
      close();
      opts.onStarted?.();
    }
  }

  const { el, close } = drawer({
    title: 'Run scan',
    body: [
      h('div', { className: 'drawer__field' }, [h('span', { text: 'Sources' }), ...sourceRows]),
      h('label', { className: 'drawer__checkbox-row' }, [dryRunCheckbox, h('span', { text: 'Dry run (no writes)' })]),
      h('div', { className: 'drawer__actions' }, [
        h('button', { className: 'btn btn--primary', text: 'Start', on: { click: start } }),
        h('button', { className: 'btn', text: 'Cancel', on: { click: () => close() } }),
      ]),
    ],
  });
  document.body.appendChild(el);
}
