// @ts-check
/**
 * Company detail: listings, research files, session moments, follow-ups, Add moment. Section 9 item 7:
 * POST /companies/:norm/moments requires exactly `question` and `response`, never `content`/`text`.
 */
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { drawer } from '../components/drawer.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { chipClassName, stageChip } from '../components/chips.js';
import { shortDate, shortDateTime, sourceLabel } from '../lib/format.js';

/** @param {HTMLElement} container @param {{norm:string}} params */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const outcome = handleOutcome(await getJson('/api/memory/company', { company: params.norm }));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'This company could not be loaded right now.' })]);
      return;
    }
    const moments = outcome.body.moments ?? [];
    const research = outcome.body.research ?? [];
    const listings = outcome.body.listings ?? [];
    const followups = outcome.body.followups ?? [];

    const openAddMoment = () => {
      const questionInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'Question' } });
      const responseInput = h('textarea', { className: 'drawer__input', attrs: { placeholder: 'Response' } });
      const { el, close } = drawer({
        title: 'Add moment',
        body: [
          h('label', {}, [h('span', { text: 'Question' }), questionInput]),
          h('label', {}, [h('span', { text: 'Response' }), responseInput]),
          h('button', { className: 'btn btn--primary', text: 'Save', on: {
            click: async () => {
              const question = /** @type {HTMLInputElement} */ (questionInput).value.trim();
              const response = /** @type {HTMLTextAreaElement} */ (responseInput).value.trim();
              if (!question || !response) { showToast({ message: 'Question and response are required.', tone: 'error' }); return; }
              const out = handleOutcome(await postJson(`/api/companies/${encodeURIComponent(params.norm)}/moments`, { question, response }));
              if (out.kind === 'ok') { showToast({ message: 'Moment saved.' }); close(); load(); }
            },
          } }),
        ],
      });
      document.body.appendChild(el);
    };

    setChildren(container, [
      h('h1', { className: 'page-title', text: outcome.body.company }),
      h('button', { className: 'btn', text: 'Add moment', on: { click: openAddMoment } }),
      h('h2', { className: 'section-title', text: 'Listings' }),
      listings.length === 0 ? emptyState({ message: 'No listings recorded for this company yet.' }) : h('ul', { className: 'company-listings' }, listings.map((l) => h('li', { className: 'company-listing' }, [
        h('a', { className: 'company-listing__title', hashHref: `#/jobs/${l.id}`, text: l.title ?? 'untitled' }),
        h('span', { className: chipClassName(stageChip(l.status)), text: stageChip(l.status).label }),
        h('span', { className: 'company-listing__source', text: sourceLabel(l.source) }),
        h('span', { className: 'company-listing__date', text: shortDate(l.first_seen) }),
      ]))),
      h('h2', { className: 'section-title', text: 'Follow-ups' }),
      followups.length === 0 ? emptyState({ message: 'No open follow-ups for this company.' }) : h('ul', { className: 'company-followups' }, followups.map((f) => h('li', { className: 'company-followup' }, [
        h('span', { className: 'company-followup__date', text: shortDateTime(f.due_at) }),
        h('span', { text: `${f.action} with ${f.contact}` }),
        f.listing_id != null ? h('a', { hashHref: `#/jobs/${f.listing_id}`, text: 'View listing' }) : null,
        h('button', { className: 'btn btn--small', text: 'Done', on: { click: async () => { handleOutcome(await postJson(`/api/followups/${f.id}/complete`, {})); load(); } } }),
        h('button', { className: 'btn btn--small', text: 'Snooze', on: { click: async () => { handleOutcome(await postJson(`/api/followups/${f.id}/snooze`, { snoozed_until: new Date(Date.now() + 86400000).toISOString() })); load(); } } }),
      ]))),
      h('h2', { className: 'section-title', text: 'Session moments' }),
      moments.length === 0 ? emptyState({ message: 'No session moments recorded for this company yet.' }) : h('ul', {}, moments.map((m) => h('li', {}, [
        h('span', { className: 'company-moment__date', text: shortDate(m.session_date) }),
        h('span', { text: `${m.question}: ${m.response}` }),
      ]))),
      h('h2', { className: 'section-title', text: 'Research files' }),
      research.length === 0 ? emptyState({ message: 'No research files linked to this company yet.' }) : h('ul', {}, research.map((f) => h('li', { text: f.relPath }))),
    ]);
  }

  await load();
  return { name: 'company-detail', refresh: load };
}
