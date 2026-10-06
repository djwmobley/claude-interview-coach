// @ts-check
/**
 * Resume control (resume gate R1) shared by the Review page's parked rows (approval-section.js) and the
 * Job detail application card (application-card.js): a two-click confirm button (components/
 * confirm-button.js, no native dialogs) posting POST /api/applications/:id/resume. When the row carries
 * `partial_draft` (an assisted run clicked Next on it before, A10), the warning is shown above the button
 * and confirming it sends `acknowledge_partial_draft: true`, which the server records on the event. A
 * refusal (409 RESUME_REFUSED) toasts the server's message through handleOutcome. Callers decide
 * visibility with lib/format.js resumeButtonVisible(); the server's classifyResume() is the authority.
 */
import { h } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { confirmButton } from './confirm-button.js';
import { PARTIAL_DRAFT_CARD_WARNING } from '../lib/format.js';

/**
 * @param {number} applicationId
 * @param {{ partialDraft?: boolean, onChanged: () => void }} opts
 */
export function resumeControl(applicationId, opts) {
  const partialDraft = Boolean(opts.partialDraft);
  const button = confirmButton({
    label: 'Resume',
    confirmLabel: partialDraft ? 'Confirm: I checked the draft' : 'Confirm resume',
    className: 'btn--small',
    onConfirm: async () => {
      const out = handleOutcome(await postJson(`/api/applications/${applicationId}/resume`, partialDraft ? { acknowledge_partial_draft: true } : {}));
      if (out.kind === 'ok') {
        const outcome = out.body && out.body.outcome;
        showToast({ message: outcome === 'drafting' ? 'Back to drafting. Use Apply now to draft the resume again.' : 'Resumed. The apply run starts shortly.' });
        if (out.body && typeof out.body.warning === 'string' && out.body.warning) showToast({ message: String(out.body.warning), tone: 'error' });
        opts.onChanged();
      }
    },
  });
  return h('div', { className: 'approval-row__resume' }, [
    partialDraft ? h('p', { className: 'application-card__note application-card__warning', text: PARTIAL_DRAFT_CARD_WARNING }) : null,
    button,
  ]);
}

/**
 * The partial-draft warning alone, for needs_human cards whose own action (answer box, credential save)
 * resumes them: the card shows it, and those actions send `acknowledge_partial_draft`.
 */
export function partialDraftWarning() {
  return h('p', { className: 'application-card__note application-card__warning', text: PARTIAL_DRAFT_CARD_WARNING });
}
