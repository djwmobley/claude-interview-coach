// @ts-check
/**
 * Review page "Submissions" section (unattended submit spec item 7): what was actually submitted in the
 * last 24 hours, read from the database (GET /api/submissions, the same rows the morning report shows),
 * and every unconfirmed submit in its own list. Read-only: an unconfirmed submit is never resubmitted from
 * here; a matching confirmation email moves it to confirmed, or Damian withdraws it from its card.
 * Section-card style with the thin cyan accent (dashboard UI restraint: a little color, no more).
 */
import { h, setChildren } from '../lib/dom.js';
import { buildHash } from '../lib/router.js';
import { emptyState } from './empty-state.js';

/** @param {any} row @param {string} extra */
function submissionRow(row, extra) {
  return h('div', { className: 'approval-row' }, [
    h('div', { className: 'approval-row__main' }, [
      h('a', { className: 'approval-row__title', hashHref: buildHash('job-detail', { id: row.listingId }), text: row.title ?? 'untitled' }),
      h('span', { className: 'approval-row__company', text: row.company ?? 'unknown company' }),
      h('span', { className: 'approval-row__age', text: extra }),
    ]),
  ]);
}

/**
 * @param {HTMLElement} container
 * @param {{ submitted: any[], unconfirmed: any[] }} data
 */
export function renderSubmissionsSection(container, data) {
  const submitted = Array.isArray(data?.submitted) ? data.submitted : [];
  const unconfirmed = Array.isArray(data?.unconfirmed) ? data.unconfirmed : [];
  setChildren(container, [
    h('div', { className: 'approval-section' }, [
      h('h2', { className: 'approval-section__title', text: `Submitted in the last 24 hours (${submitted.length})` }),
      submitted.length === 0 ? emptyState({ message: 'Nothing submitted in the last 24 hours' })
        : h('div', { className: 'approval-list' }, submitted.map((r) => submissionRow(r, `${r.ats ?? 'n/a'}, ${r.state}`))),
      h('h2', { className: 'approval-section__title', text: `Submitted, unconfirmed (${unconfirmed.length})` }),
      unconfirmed.length === 0 ? emptyState({ message: 'No unconfirmed submits' })
        : h('div', { className: 'approval-list' }, unconfirmed.map((r) => submissionRow(r, `${r.ats ?? 'n/a'}, already submitted (unconfirmed)`))),
    ]),
  ]);
}
