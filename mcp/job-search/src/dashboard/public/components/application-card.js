// @ts-check
/**
 * Application card (apply pipeline slice 3, plan `let-s-brainstorm-a-bit-humble-umbrella.md` section
 * "7. Dashboard human gate" -- reduced scope for this slice: create, show linked docs with Open, and
 * Approve. No screenshot/answer box/Retry here -- those belong to the needs_human/failed states the
 * slice 5+ runner introduces. Rendered by pages/job-detail.js, same panel styling as documents-panel /
 * followups-panel / dedup-card / prescore-breakdown (see app.css's shared `.application-card` selector).
 */
import { h } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { chipClassName, applicationStateChip } from './chips.js';

/**
 * @param {{ listing: any, application: any|null, ats: any, documents: any[], onChanged: () => void }} opts
 */
export function applicationCard(opts) {
  const { listing, application, ats, documents } = opts;

  if (!application) {
    return h('div', { className: 'application-card' }, [
      h('h3', { text: 'Application' }),
      h('p', { className: 'application-card__hint', text: 'No application started for this listing yet.' }),
      h('button', {
        className: 'btn btn--small',
        attrs: { type: 'button' },
        text: 'Create application',
        on: {
          click: async () => {
            const outcome = handleOutcome(await postJson(`/api/listings/${listing.id}/application`, {}));
            if (outcome.kind === 'ok') {
              showToast({ message: 'Application created in drafting.' });
              opts.onChanged();
            } else if (outcome.kind === 'duplicate_application') {
              showToast({ message: 'An application already exists for this listing.', tone: 'error' });
            }
          },
        },
      }),
    ]);
  }

  const stateChip = applicationStateChip(application.state);
  const command = `/write-resume ${listing.id}`;

  /** @param {string} label @param {number|null} docId */
  const docRow = (label, docId) => {
    const doc = docId != null ? (documents ?? []).find((d) => Number(d.id) === Number(docId)) : null;
    if (!doc) return h('li', { className: 'application-card__doc application-card__doc--missing', text: `${label}: not linked` });
    return h('li', { className: 'application-card__doc' }, [
      h('span', { text: `${label}: ${doc.rel_path}` }),
      h('button', {
        className: 'btn btn--small',
        attrs: { type: 'button' },
        text: 'Open',
        on: { click: async () => { handleOutcome(await postJson('/api/documents/open', { path: doc.rel_path })); } },
      }),
    ]);
  };

  const copyRow = h('div', { className: 'application-card__copy-row' }, [
    h('code', { className: 'application-card__copy-code', text: command }),
    h('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Copy',
      on: {
        click: async () => {
          try {
            await navigator.clipboard.writeText(command);
            showToast({ message: 'Copied to clipboard.' });
          } catch {
            showToast({ message: 'Could not copy automatically; select and copy the command.', tone: 'error' });
          }
        },
      },
    }),
  ]);

  // Apply pipeline slice 3, orchestrator decision: an unknown ATS never blocks document drafting or
  // Approve -- documents still need drafting, and the manual-apply routing itself is a slice 5+ runner
  // concern. This note is the only UI consequence of an unknown ATS in this slice.
  const unknownAtsNote = ats && ats.ats === 'unknown'
    ? h('p', { className: 'application-card__note', text: 'Unknown ATS: apply by hand after approving documents.' })
    : null;

  const approveDisabled = application.state !== 'docs_ready' || !application.resume_doc_id;
  const approveButton = h('button', {
    className: 'btn btn--primary',
    attrs: { type: 'button' },
    disabled: approveDisabled,
    text: 'Approve',
    on: {
      click: async () => {
        const outcome = handleOutcome(await postJson(`/api/applications/${application.id}/approve`, {}));
        if (outcome.kind === 'ok') {
          showToast({ message: 'Application approved.' });
          opts.onChanged();
        }
      },
    },
  });

  return h('div', { className: 'application-card' }, [
    h('div', { className: 'application-card__header' }, [
      h('h3', { text: 'Application' }),
      h('span', { className: chipClassName(stateChip), text: stateChip.label }),
    ]),
    application.state === 'drafting' ? copyRow : null,
    h('ul', { className: 'application-card__docs' }, [docRow('Resume', application.resume_doc_id), docRow('Cover letter', application.coverletter_doc_id)]),
    unknownAtsNote,
    application.state === 'docs_ready' ? approveButton : null,
    application.state === 'approved' ? h('p', { className: 'application-card__hint', text: 'Approved. Document hash recorded.' }) : null,
  ]);
}
