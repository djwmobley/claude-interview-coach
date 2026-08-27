// @ts-check
/**
 * "Add opportunity" drawer (plan line 100: Pipeline, with a dedup hint; also opened from Home's action
 * bar). POST /api/listings (src/dashboard/routes/listings.js): title, company required; url, location,
 * status, via optional. On 409 DUPLICATE_CANDIDATE, shows the candidate listings inline with a "Create
 * anyway" second step that resubmits with force:true, matching src/core/manual.js's own force semantics
 * (not a native confirmation dialog -- a real second click inside the same drawer). On success, closes and navigates
 * to the new listing's detail page.
 */
import { h } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { drawer } from './drawer.js';
import { stageChip } from './chips.js';
import { validateManualListing, MANUAL_STATUS_OPTIONS } from '../lib/validate.js';

/**
 * @param {{ navigate: (route: string, params?: any) => void }} app
 */
export function openAddOpportunityDrawer(app) {
  const titleInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'Role title' } });
  const companyInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'Company' } });
  const urlInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'https://...' } });
  const locationInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'City, ST or Remote' } });
  const viaInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'Recruiter or contact' } });
  const statusSelect = h('select', { className: 'drawer__input' }, MANUAL_STATUS_OPTIONS.map((s) => h('option', { value: s, selected: s === 'new', text: stageChip(s).label })));
  const errorEl = h('div', { className: 'drawer__errors' });
  const dedupEl = h('div', { className: 'drawer__dedup' });

  function readForm() {
    return {
      title: /** @type {HTMLInputElement} */ (titleInput).value,
      company: /** @type {HTMLInputElement} */ (companyInput).value,
      url: /** @type {HTMLInputElement} */ (urlInput).value,
      location: /** @type {HTMLInputElement} */ (locationInput).value,
      via: /** @type {HTMLInputElement} */ (viaInput).value,
      status: /** @type {HTMLSelectElement} */ (statusSelect).value,
    };
  }

  function showFieldErrors(errors) {
    errorEl.replaceChildren(...Object.values(errors).map((msg) => h('p', { className: 'field-error', text: /** @type {string} */ (msg) })));
  }

  /** @param {number[]} candidateIds */
  async function showDedupHint(candidateIds, onForce) {
    const briefs = await Promise.all(candidateIds.slice(0, 5).map(async (id) => {
      const outcome = handleOutcome(await getJson(`/api/listings/${id}`), { silenceNotFound: true });
      return outcome.kind === 'ok' ? outcome.body.row : { id, title: 'listing removed', company: '' };
    }));
    dedupEl.replaceChildren(
      h('p', { className: 'drawer__dedup-note', text: 'This looks like an existing listing:' }),
      h('ul', {}, briefs.map((b) => h('li', { text: `${b.title} at ${b.company} (#${b.id})` }))),
      h('button', { className: 'btn btn--danger', text: 'Create anyway', on: { click: onForce } }),
    );
  }

  async function submit(force) {
    const parsed = validateManualListing(readForm());
    if (!parsed.ok) {
      showFieldErrors(parsed.errors);
      return;
    }
    errorEl.replaceChildren();
    const outcome = handleOutcome(await postJson('/api/listings', { ...parsed.value, force }));
    if (outcome.kind === 'ok') {
      showToast({ message: 'Opportunity added.' });
      close();
      app.navigate('job-detail', { id: outcome.body.id });
      return;
    }
    if (outcome.kind === 'duplicate_candidate') {
      // createManualListing's `candidates` (src/core/manual.js) is an array of plain listing ids.
      showDedupHint(outcome.candidates, () => submit(true));
      return;
    }
    // Any other outcome kind is already toasted/bannered by handleOutcome.
  }

  const { el, close } = drawer({
    title: 'Add opportunity',
    body: [
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Title' }), titleInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Company' }), companyInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'URL' }), urlInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Location' }), locationInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Via' }), viaInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Stage' }), statusSelect]),
      errorEl,
      dedupEl,
      h('div', { className: 'drawer__actions' }, [
        h('button', { className: 'btn btn--primary', text: 'Add opportunity', on: { click: () => submit(false) } }),
        h('button', { className: 'btn', text: 'Cancel', on: { click: () => close() } }),
      ]),
    ],
  });
  document.body.appendChild(el);
}
