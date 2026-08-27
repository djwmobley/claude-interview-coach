// @ts-check
/**
 * "New follow-up" drawer (plan line 101: Follow-ups page; also opened from Home's action bar and, per
 * plan line 99, inline when a listing is set to `applied` on Job detail, and from Job detail's `f`
 * shortcut, pre-filled with that listing). POST /api/followups (src/dashboard/routes/followups.js):
 * contact, action_text, channel, due_at required; org, listing_id, notify optional.
 */
import { h } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { drawer } from './drawer.js';
import { validateFollowup, CHANNELS } from '../lib/validate.js';

const CHANNEL_LABELS = Object.freeze({ phone: 'Phone', email: 'Email', linkedin: 'LinkedIn', other: 'Other' });

/** @param {Date} d */
function toLocalDatetimeInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {{
 *   listingId?: number|null,
 *   listingLabel?: string|null,
 *   contact?: string,
 *   dueInDays?: number,
 *   actionText?: string,
 *   onCreated?: (row: any) => void,
 * }} [opts]
 */
export function openNewFollowupDrawer(opts = {}) {
  const contactInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'Contact name' }, value: opts.contact ?? '' });
  const orgInput = h('input', { className: 'drawer__input', attrs: { type: 'text', placeholder: 'Organization (optional)' } });
  const dueDefault = new Date(Date.now() + (opts.dueInDays ?? 3) * 86400000);
  dueDefault.setHours(9, 0, 0, 0);
  const dueInput = h('input', { className: 'drawer__input', attrs: { type: 'datetime-local' }, value: toLocalDatetimeInputValue(dueDefault) });
  const channelSelect = h('select', { className: 'drawer__input' }, CHANNELS.map((c) => h('option', { value: c, selected: c === 'email', text: CHANNEL_LABELS[c] })));
  const actionInput = h('textarea', { className: 'drawer__input', attrs: { placeholder: 'What to do' }, value: opts.actionText ?? '' });
  const errorEl = h('div', { className: 'drawer__errors' });

  function readForm() {
    return {
      contact: /** @type {HTMLInputElement} */ (contactInput).value,
      org: /** @type {HTMLInputElement} */ (orgInput).value,
      due_at: /** @type {HTMLInputElement} */ (dueInput).value,
      channel: /** @type {HTMLSelectElement} */ (channelSelect).value,
      action_text: /** @type {HTMLTextAreaElement} */ (actionInput).value,
      listing_id: opts.listingId ?? null,
    };
  }

  async function submit() {
    const parsed = validateFollowup(readForm());
    if (!parsed.ok) {
      errorEl.replaceChildren(...Object.values(parsed.errors).map((msg) => h('p', { className: 'field-error', text: /** @type {string} */ (msg) })));
      return;
    }
    errorEl.replaceChildren();
    const out = handleOutcome(await postJson('/api/followups', parsed.value));
    if (out.kind === 'ok') {
      showToast({ message: 'Follow-up created.' });
      close();
      opts.onCreated?.(out.body.row);
    }
  }

  const { el, close } = drawer({
    title: 'New follow-up',
    body: [
      opts.listingLabel ? h('p', { className: 'drawer__context', text: `For: ${opts.listingLabel}` }) : null,
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Contact' }), contactInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Organization' }), orgInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Due' }), dueInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Channel' }), channelSelect]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Action' }), actionInput]),
      errorEl,
      h('div', { className: 'drawer__actions' }, [
        h('button', { className: 'btn btn--primary', text: 'Create follow-up', on: { click: submit } }),
        h('button', { className: 'btn', text: 'Cancel', on: { click: () => close() } }),
      ]),
    ],
  });
  document.body.appendChild(el);
}
