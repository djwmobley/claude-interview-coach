// @ts-check
/**
 * Job detail. Notes autosave: 800 ms debounce, and section 7.3's flush-on-navigate rule is implemented
 * via the page's `beforeLeave` hook, which app.js calls synchronously before tearing the page down.
 */
import { h, setChildren, hLink } from '../lib/dom.js';
import { getJson, postJson, putJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast, showUndoToast } from '../lib/toast.js';
import { stageButtons } from '../components/stage-buttons.js';
import { timeline } from '../components/timeline.js';
import { documentChip, chipClassName } from '../components/chips.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { salaryRange, shortDate } from '../lib/format.js';
import { on, off } from '../lib/bus.js';

const NOTES_DEBOUNCE_MS = 800;

/** @param {HTMLElement} container @param {{id:number}} params */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 6 })]);
  let notesTimer = null;
  let pendingNotesValue = null;
  let listing = null;

  async function flushNotes() {
    if (pendingNotesValue === null || !listing) return;
    const value = pendingNotesValue;
    pendingNotesValue = null;
    if (notesTimer) clearTimeout(notesTimer);
    notesTimer = null;
    const outcome = handleOutcome(await putJson(`/api/listings/${listing.id}/notes`, { notes: value }));
    if (outcome.kind !== 'ok') showToast({ message: 'Notes failed to save.', tone: 'error' });
  }

  async function load() {
    const outcome = handleOutcome(await getJson(`/api/listings/${params.id}`), { silenceNotFound: true });
    if (outcome.kind === 'not_found') {
      setChildren(container, [emptyState({ message: 'This listing was not found.' }), h('a', { hashHref: '#/jobs', text: 'Back to Jobs' })]);
      return;
    }
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'This listing could not be loaded right now.' })]);
      return;
    }
    listing = outcome.body.row;
    const disabled = listing.duplicate_of != null;

    const setStage = async (status) => {
      const prevStatus = listing.status;
      const out = handleOutcome(await postJson(`/api/listings/${listing.id}/status`, { status }));
      if (out.kind === 'ok') {
        showUndoToast({
          message: `Stage set to ${status}.`,
          onUndo: async () => { handleOutcome(await postJson(`/api/listings/${listing.id}/status`, { status: prevStatus ?? 'new' })); load(); },
        });
        load();
      }
    };

    const descriptionPanel = h('details', { className: 'description-panel' }, [
      h('summary', { text: 'Description' }),
      h('div', { className: 'description-panel__body', text: listing.description ?? 'No description captured.' }),
    ]);

    const notesArea = h('textarea', {
      className: 'notes-textarea', attrs: { placeholder: 'Private notes' }, value: listing.notes ?? '',
      on: {
        input: (ev) => {
          pendingNotesValue = /** @type {HTMLTextAreaElement} */ (ev.target).value;
          if (notesTimer) clearTimeout(notesTimer);
          notesTimer = setTimeout(flushNotes, NOTES_DEBOUNCE_MS);
        },
      },
    });

    const docs = outcome.body.documents ?? [];
    const suggestions = outcome.body.suggestions ?? [];
    const documentsPanel = h('div', { className: 'documents-panel' }, [
      h('h3', { text: 'Documents' }),
      docs.length === 0 ? emptyState({ message: 'No documents linked yet.' }) : h('ul', { className: 'documents-list' }, docs.map((d) => {
        const chip = documentChip(d.kind);
        return h('li', {}, [
          h('span', { className: chipClassName(chip), text: chip.label }),
          h('span', { text: d.rel_path }),
          h('button', { className: 'btn btn--small', text: 'Unlink', on: { click: async () => { handleOutcome(await import('../lib/api.js').then((m) => m.deleteJson(`/api/documents/${d.id}`))); load(); } } }),
        ]);
      })),
      suggestions.length ? h('div', { className: 'documents-suggestions' }, [
        h('h4', { text: 'Suggested' }),
        h('ul', {}, suggestions.map((s) => h('li', {}, [
          h('span', { text: s.file }),
          h('button', { className: 'btn btn--small', text: 'Link', on: {
            click: async () => {
              const kind = s.file.split('/')[0].replace(/s$/, '');
              handleOutcome(await postJson(`/api/listings/${listing.id}/documents`, { relPath: s.file, kind: mapDirToKind(s.file) }));
              load();
            },
          } }),
        ]))),
      ]) : null,
    ]);

    const followups = outcome.body.followups ?? [];
    const followupsPanel = h('div', { className: 'followups-panel' }, [
      h('h3', { text: 'Follow-ups' }),
      followups.length === 0 ? emptyState({ message: 'No follow-ups for this listing.' }) : h('ul', {}, followups.map((f) => h('li', {}, [
        h('span', { text: `${f.due_at ? shortDate(f.due_at) : 'not set'}: ${f.action}` }),
      ]))),
    ]);

    const dup = listing.duplicate_of != null;
    const duplicates = outcome.body.duplicates ?? [];
    const dedupCard = (dup || duplicates.length) ? h('div', { className: 'dedup-card' }, [
      h('h3', { text: 'Duplicates' }),
      dup ? h('p', { text: `This listing is a duplicate of listing #${listing.duplicate_of}.` }) : null,
      duplicates.length ? h('ul', {}, duplicates.map((d) => h('li', { text: `${d.title} at ${d.company} (#${d.id})` }))) : null,
    ]) : null;

    setChildren(container, [
      h('div', { className: 'job-detail-header' }, [
        h('h1', { className: 'page-title', text: listing.title }),
        listing.record_kind === 'manual' ? h('span', { className: 'badge badge--manual', text: 'Manual' }) : null,
      ]),
      h('p', { className: 'job-detail-sub', text: `${listing.company ?? 'unknown company'} - ${listing.location ?? 'not listed'} - ${salaryRange(listing.salary_min, listing.salary_max)}` }),
      h('div', { className: 'job-detail-grid' }, [
        h('div', { className: 'job-detail-main' }, [
          stageButtons({ status: listing.status, disabled, onSelect: setStage }),
          h('h3', { text: 'Notes' }),
          notesArea,
          descriptionPanel,
          documentsPanel,
          followupsPanel,
        ]),
        h('div', { className: 'job-detail-side' }, [
          dedupCard,
          h('h3', { text: 'History' }),
          timeline({ events: outcome.body.events ?? [] }),
        ]),
      ]),
    ]);
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  return {
    name: 'job-detail',
    refresh: load,
    beforeLeave: () => { flushNotes(); },
    teardown: () => off('dashboard:changed', onChanged),
  };
}

/** @param {string} relPath */
function mapDirToKind(relPath) {
  const dir = relPath.split('/')[0];
  const table = { resumes: 'resume', coverletters: 'coverletter', cheatsheets: 'cheatsheet', markdown: 'markdown', research: 'research', reports: 'report' };
  return table[dir] ?? 'other';
}
