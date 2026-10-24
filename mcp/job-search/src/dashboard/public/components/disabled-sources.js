// @ts-check
/**
 * Disabled and paused sources (Home and Runs): one row per source with the sentence the server built
 * ("auto-disabled after 3 failed scans (dates): reason" or "paused until <time> after 1 failed scan: reason"),
 * a "view page" link to the saved snapshot when one exists, and a Re-enable button. All text reaches the DOM
 * through textContent (h()); the server's sentence is never parsed or treated as markup. The button POSTs
 * through postJson, so Content-Type: application/json is structural, then asks the page to refresh.
 */
import { h, hLink } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';

/**
 * The absolute URL of a source's saved page, or null. hLink refuses relative URLs by design, so the
 * same-origin path is resolved against the dashboard's own origin here; the file name is encoded.
 * @param {unknown} snapshot
 * @returns {string|null}
 */
export function snapshotHref(snapshot) {
  if (typeof snapshot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(snapshot)) return null;
  try {
    return new URL(`/api/wall-snapshots/${encodeURIComponent(snapshot)}`, globalThis.location.origin).href;
  } catch {
    return null;
  }
}

/** @param {string} source */
export function enablePath(source) {
  return `/api/sources/${encodeURIComponent(source)}/enable`;
}

/**
 * @param {{ sources: any[]|null|undefined, onChanged: () => void }} opts
 * @returns {HTMLElement|null} null when nothing is disabled or paused
 */
export function disabledSourcesPanel(opts) {
  const sources = Array.isArray(opts.sources) ? opts.sources : [];
  if (sources.length === 0) return null;
  return h('section', { className: 'approval-section disabled-sources' }, [
    h('h2', { className: 'approval-section__title', text: 'Sources off' }),
    h('ul', { className: 'disabled-sources__list' }, sources.map((s) => {
      const href = snapshotHref(s.snapshot);
      const button = h('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: 'Re-enable' });
      button.addEventListener('click', async () => {
        button.disabled = true;
        const outcome = handleOutcome(await postJson(enablePath(String(s.source)), {}));
        if (outcome.kind === 'ok') {
          showToast({ message: `${String(s.source)} re-enabled.` });
          opts.onChanged();
        } else {
          button.disabled = false;
        }
      });
      return h('li', { className: 'disabled-sources__row' }, [
        h('strong', { className: 'disabled-sources__name', text: String(s.source) }),
        h('span', { className: 'disabled-sources__text', text: String(s.text ?? '') }),
        href ? hLink({ url: href, urlOk: true, text: 'view page', target: '_blank', className: 'disabled-sources__link' }) : h('span', { className: 'disabled-sources__link', text: 'no page saved' }),
        button,
      ]);
    })),
  ]);
}
