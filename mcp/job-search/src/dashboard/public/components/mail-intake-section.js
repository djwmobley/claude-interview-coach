// @ts-check
/**
 * Review page "Recruiter mail" section (sql/029): recruiter-like mail and replies in threads Damian sent to,
 * one row per Gmail thread, each with sender, subject, date, Gmail tab, the signal that matched, From/Reply-To
 * when they differ, a snippet (HTML and URLs already stripped server side), an Open in Gmail link and a Dismiss
 * button. Spam-folder items sit in their own subsection with an unverified tag. Unsorted mail (subject level,
 * dashboard only) is a collapsed list underneath.
 *
 * Every string reaches the DOM through textContent (h()); the Gmail link goes through hLink only. Read-only
 * toward Gmail: Dismiss writes the ledger, never the mailbox. Section-card style with the thin cyan accent
 * (dashboard UI restraint: a little color, no more).
 */
import { h, hLink, setChildren } from '../lib/dom.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { emptyState } from './empty-state.js';

/** @param {string|null|undefined} iso */
function dayOf(iso) {
  return iso ? String(iso).slice(0, 10) : 'undated';
}

/**
 * @param {any} it
 * @param {{ onChanged: () => void, dismissible: boolean }} o
 */
function itemRow(it, o) {
  const who = it.from_name ? `${it.from_name} <${it.from_addr ?? 'unknown'}>` : (it.from_addr ?? 'unknown sender');
  const signal = it.signal ? `${it.bucket}: ${it.signal}` : it.bucket;
  const dismiss = o.dismissible
    ? h('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Dismiss',
      on: {
        click: async (ev) => {
          const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
          btn.disabled = true;
          const out = handleOutcome(await postJson(`/api/mail-intake/${encodeURIComponent(it.message_id)}/dismiss`, {}));
          if (out.kind === 'ok') {
            showToast({ message: 'Dismissed.' });
            o.onChanged();
          } else {
            btn.disabled = false;
          }
        },
      },
    })
    : null;
  return h('div', { className: 'approval-row mail-intake-row', dataset: { messageId: it.message_id } }, [
    h('div', { className: 'approval-row__main' }, [
      h('span', { className: 'approval-row__title', text: it.subject || '(no subject)' }),
      h('span', { className: 'approval-row__company', text: who }),
      h('span', { className: 'approval-row__age', text: `${dayOf(it.msg_date)} | ${it.tab ?? 'Other'} | ${signal}` }),
      it.spam ? h('span', { className: 'badge badge--error', text: 'spam folder' }) : null,
      it.link ? hLink({ url: it.link, urlOk: true, text: 'Open in Gmail', target: '_blank' }) : null,
      dismiss,
    ]),
    it.reply_to_differs && it.reply_to ? h('div', { className: 'approval-section__note', text: `From ${it.from_addr ?? 'unknown'} but Reply-To ${it.reply_to}` }) : null,
    it.body_unreadable ? h('div', { className: 'approval-section__note', text: 'Body unreadable: review by hand.' }) : null,
    it.snippet ? h('div', { className: 'approval-section__note', text: it.snippet }) : null,
  ]);
}

/**
 * @param {HTMLElement} container
 * @param {{ items?: any[], items_total?: number, unsorted?: any[], counts?: Record<string, number> }|null} data GET /api/mail-intake body
 * @param {{ onChanged: () => void }} opts
 */
export function renderMailIntakeSection(container, data, opts) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const unsorted = Array.isArray(data?.unsorted) ? data.unsorted : [];
  const inbox = items.filter((i) => !i.spam);
  const spam = items.filter((i) => i.spam);
  const total = Number.isFinite(data?.items_total) ? Number(data?.items_total) : items.length;
  setChildren(container, [
    h('div', { className: 'approval-section' }, [
      h('h2', { className: 'approval-section__title', text: `Recruiter mail (${inbox.length})` }),
      inbox.length === 0 ? emptyState({ message: 'No recruiter-like mail or replies waiting' })
        : h('div', { className: 'approval-list' }, inbox.map((i) => itemRow(i, { onChanged: opts.onChanged, dismissible: true }))),
      spam.length ? h('h2', { className: 'approval-section__title', text: `Spam folder, unverified (${spam.length})` }) : null,
      spam.length ? h('div', { className: 'approval-list' }, spam.map((i) => itemRow(i, { onChanged: opts.onChanged, dismissible: true }))) : null,
      total > items.length ? h('p', { className: 'approval-section__note', text: `${total - items.length} more not shown.` }) : null,
      unsorted.length
        ? h('h2', { className: 'approval-section__title', text: `Unsorted mail, last 14 days (${unsorted.length})` })
        : null,
      unsorted.length ? h('div', { className: 'approval-list' }, unsorted.map((i) => itemRow(i, { onChanged: opts.onChanged, dismissible: false }))) : null,
    ]),
  ]);
}
