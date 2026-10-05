// @ts-check
/**
 * Withdraw control shared by the Review page's parked rows (approval-section.js) and the Job detail
 * application card (application-card.js): an optional note field plus a two-click confirm button
 * (components/confirm-button.js, no native dialogs). POST /api/applications/:id/withdraw; a refusal
 * (409 WITHDRAW_REFUSED) toasts the server's message through handleOutcome. Callers decide visibility
 * with lib/format.js withdrawButtonVisible(); the server's classifyWithdraw() is the authority.
 */
import { h } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { confirmButton } from './confirm-button.js';

/**
 * @param {number} applicationId
 * @param {() => void} onChanged
 */
export function withdrawControl(applicationId, onChanged) {
  const noteInput = h('input', { className: 'drawer__input approval-row__withdraw-note', attrs: { type: 'text', placeholder: 'Reason (optional)', 'aria-label': 'Withdraw reason' } });
  const button = confirmButton({
    label: 'Withdraw',
    confirmLabel: 'Confirm withdraw',
    className: 'btn--small',
    onConfirm: async () => {
      const note = /** @type {HTMLInputElement} */ (noteInput).value.trim();
      const out = handleOutcome(await postJson(`/api/applications/${applicationId}/withdraw`, note ? { note } : {}));
      if (out.kind === 'ok') {
        showToast({ message: out.body && out.body.outcome === 'already_withdrawn' ? 'Already withdrawn.' : 'Application withdrawn.' });
        // Non-fatal calendar cleanup warning (the withdraw itself succeeded): the follow-up's calendar
        // event is still on the calendar and the server retries it on the next follow-ups pass.
        const warnings = out.body && Array.isArray(out.body.warnings) ? out.body.warnings : [];
        if (warnings.length > 0) showToast({ message: `Calendar event not removed yet; it will be retried. ${String(warnings[0])}`, tone: 'error' });
        onChanged();
      }
    },
  });
  return h('div', { className: 'approval-row__withdraw' }, [noteInput, button]);
}
