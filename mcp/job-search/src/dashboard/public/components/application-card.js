// @ts-check
/**
 * Application card (apply pipeline slice 3, extended by slice 4, plan
 * `let-s-brainstorm-a-bit-humble-umbrella.md` section "7. Dashboard human gate"). Slice 3 scope: create,
 * show linked docs with Open, and Approve. Slice 4 adds the needs_human rendering the plan's own section
 * 5a asks for: `pending_question.kind === 'credential'` renders credentialPrompt(); any other kind
 * (including one this dashboard has never seen -- total classification, never a throw) renders a generic
 * "needs your attention" card carrying the raw kind and page_url. Screenshot display, the free-text
 * answer box for `kind === 'question'`, and Retry from `failed` are still out of scope here -- those are
 * the slice 5+ runner's own UI (see the PR body's scope note). Rendered by pages/job-detail.js, same
 * panel styling as documents-panel / followups-panel / dedup-card / prescore-breakdown (see app.css's
 * shared `.application-card` selector).
 */
import { h } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { chipClassName, applicationStateChip } from './chips.js';
import { credentialPrompt } from './credential-prompt.js';

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

  // needs_human rendering (apply pipeline slice 4, plan section 5a): pending_question.kind is a total
  // classification at the model layer (src/core/applications.js's validatePendingQuestion permits any
  // non-empty string kind), so the UI must handle "a kind this dashboard has never seen" too, never
  // assume it is one of the two named ones.
  let needsHumanPanel = null;
  if (application.state === 'needs_human' && application.pending_question) {
    const pq = application.pending_question;
    if (pq.kind === 'credential') {
      needsHumanPanel = credentialPrompt({ application, pendingQuestion: pq, onChanged: opts.onChanged });
    } else {
      needsHumanPanel = h('div', { className: 'credential-prompt' }, [
        h('h4', { text: 'Needs your attention' }),
        h('p', { className: 'application-card__note', text: `Unrecognized pending question kind: ${String(pq.kind)}` }),
        pq.page_url ? h('p', { className: 'application-card__hint', text: String(pq.page_url) }) : null,
      ]);
    }
  }

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
    needsHumanPanel,
  ]);
}
