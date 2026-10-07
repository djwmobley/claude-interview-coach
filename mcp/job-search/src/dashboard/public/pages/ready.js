// @ts-check
/**
 * Ready to apply (spec section 10, R4, R7, R8, A1, A10). Every live fit >= floor listing the unattended
 * path cannot submit, sorted by fit, with its apply link (opened in a new tab, host shown beside it) and
 * the tailored resume state. Opening this page is a DISPLAY: the server writes the manual-only lock for
 * every listed row the first time it is shown (A1), so the auto path never submits a job Damian may be
 * applying to by hand. "Hand back" lifts that lock (logged on the listing).
 *
 * "I applied" and "Dismiss" reuse the existing POST /api/listings/:id/status route (applied / passed);
 * nothing here clicks anything on any site. Section cards with the thin cyan accent, a little color only.
 */
import { h, setChildren, hLink } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { confirmButton } from '../components/confirm-button.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { dataTable } from '../components/data-table.js';

/** kbaction manifest: this page has no row keyboard map of its own. */
export const KEYBOARD_ACTIONS = Object.freeze({
  'row-nav': 'not-applicable',
  'row-open': 'not-applicable',
  'row-stage': 'not-applicable',
  digit: 'not-applicable',
  shortcut: 'not-applicable',
});

/** @param {any} r */
export function resumeLabel(r) {
  const s = r.resume ?? {};
  if (!s.eligible || s.status === 'skipped_no_description') return 'no description';
  if (s.status === 'ready') return s.verdict ? `ready, review ${s.verdict}` : 'ready, not reviewed';
  if (s.status === 'running') return 'drafting';
  if (s.status === 'failed') return s.verdict === 'FAIL' ? 'review FAIL, will retry' : `failed (${s.lastError ?? 'unknown'})`;
  if (s.status === 'gave_up') return s.verdict === 'FAIL' ? 'gave up, review FAIL' : `gave up (${s.lastError ?? 'unknown'})`;
  return 'pending';
}

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 8 })]);

  /** Spec F5: the existing listing status route (no application row exists for these listings).
   * @param {number} id @param {{ status: 'applied'|'passed', note: string }} body */
  async function setStatus(id, body) {
    const out = handleOutcome(await postJson(`/api/listings/${id}/status`, body));
    if (out.kind === 'ok') {
      showToast({ message: body.status === 'applied' ? 'Marked applied.' : 'Dismissed.' });
      await load();
    }
  }

  /** @param {number} id */
  async function generate(id) {
    const out = await postJson(`/api/ready-to-apply/${id}/resume`, {});
    if (out.kind === 'ok') {
      showToast({ message: 'Resume drafting started.' });
      await load();
      return;
    }
    handleOutcome(out);
  }

  /** @param {number} id */
  async function handBack(id) {
    const out = handleOutcome(await postJson(`/api/ready-to-apply/${id}/hand-back`, {}));
    if (out.kind === 'ok') showToast({ message: 'Handed back: the auto path may submit this job again.' });
  }

  /** @param {any} r */
  function actions(r) {
    return h('div', { className: 'ready-actions' }, [
      confirmButton({ label: 'I applied', confirmLabel: 'Confirm applied', onConfirm: () => { void setStatus(r.listingId, { status: 'applied', note: 'applied from Ready list' }); } }),
      confirmButton({ label: 'Dismiss', confirmLabel: 'Confirm dismiss', onConfirm: () => { void setStatus(r.listingId, { status: 'passed', note: 'dismissed from Ready list' }); } }),
      confirmButton({ label: 'Hand back', confirmLabel: 'Confirm hand back', onConfirm: () => { void handBack(r.listingId); } }),
    ]);
  }

  /** @param {any} r */
  function resumeCell(r) {
    const s = r.resume ?? {};
    const canGenerate = s.eligible && ['none', 'queued', 'failed'].includes(s.status);
    return h('td', {}, [
      h('span', { className: 'ready-resume', text: resumeLabel(r) }),
      s.status === 'ready' && s.relPath
        ? h('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: 'Open', on: { click: async () => { handleOutcome(await postJson('/api/documents/open', { path: s.relPath })); } } })
        : null,
      canGenerate ? h('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: s.status === 'failed' ? 'Retry' : 'Generate', on: { click: () => { void generate(r.listingId); } } }) : null,
    ]);
  }

  /** @param {any} r */
  function linkCell(r) {
    if (!r.link) return h('td', { className: 'ready-muted', text: 'no usable link' });
    return h('td', {}, [hLink({ url: r.link, urlOk: true, text: 'Apply', target: '_blank' }), h('span', { className: 'ready-host', text: ` ${r.host ?? ''}` })]);
  }

  async function load() {
    const outcome = handleOutcome(await getJson('/api/ready-to-apply'));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'The Ready to apply list could not be loaded right now.' })]);
      return;
    }
    const d = outcome.body;
    if (d.enabled === false) {
      setChildren(container, [h('h1', { className: 'page-title', text: 'Ready to apply' }), emptyState({ message: 'The Ready to apply list is disabled in config.' })]);
      return;
    }
    const rc = d.resumeCounts;
    const summary = `auto-submit path ${d.autoSubmitCount} | ready ${d.counts.ready} | held ${d.counts.held} | excluded ${d.counts.excluded} | resumes ready ${rc.ready}, pending ${rc.pending}, failed ${rc.failed}, gave up ${rc.gaveUp}, no description ${rc.noDescription}`;
    const readyRows = d.ready.map((/** @type {any} */ r) => h('tr', {}, [
      h('td', { text: String(r.fit ?? '?') }),
      h('td', {}, [h('a', { hashHref: `#/jobs/${r.listingId}`, text: r.title ?? 'n/a' }), r.isNew ? h('span', { className: 'chip ready-new', text: 'NEW' }) : null]),
      h('td', { text: r.company ?? 'n/a' }),
      h('td', {}, [h('span', { className: 'chip ready-channel', text: r.channelLabel }), r.alsoOn.length ? h('span', { className: 'ready-muted', text: ` also on ${r.alsoOn.join(', ')}` }) : null,
        r.flagLabels.length ? h('div', { className: 'ready-muted', text: r.flagLabels.join('; ') }) : null]),
      linkCell(r),
      resumeCell(r),
      h('td', {}, [actions(r)]),
    ]));
    const heldRows = d.held.map((/** @type {any} */ r) => h('tr', {}, [
      h('td', { text: String(r.fit ?? '?') }),
      h('td', {}, [h('a', { hashHref: `#/jobs/${r.listingId}`, text: r.title ?? 'n/a' })]),
      h('td', { text: r.company ?? 'n/a' }),
      h('td', {}, [h('span', { className: 'chip ready-reason', text: r.bucketLabel }), r.applicationId ? h('span', { className: 'ready-muted', text: ` application #${r.applicationId}` }) : null]),
      linkCell(r),
      h('td', {}, [actions(r)]),
    ]));
    const excluded = Object.entries(d.excludedCounts ?? {}).map(([k, n]) => `${k} ${n}`).join(', ');
    setChildren(container, [
      h('h1', { className: 'page-title', text: `Ready to apply (${d.counts.ready})` }),
      h('section', { className: 'approval-section' }, [
        h('p', { className: 'approval-section__note', text: summary }),
        d.drift && d.drift.tripped ? h('p', { className: 'ready-warn', text: `Markup drift: ${d.drift.driftRows} of ${d.drift.probedRows} probed LinkedIn pages showed no Apply control. Those rows are held and not locked.` }) : null,
        h('p', { className: 'approval-section__note', text: 'Showing a job here makes it manual only: the auto path will not submit it unless you hand it back.' }),
        d.ready.length === 0 ? emptyState({ message: 'Nothing ready to apply right now.' })
          : dataTable({ columns: ['Fit', 'Role', 'Company', 'Channel', 'Apply', 'Resume', 'Actions'], rows: readyRows }),
      ]),
      h('section', { className: 'approval-section' }, [
        h('details', {}, [
          h('summary', { className: 'approval-section__title', text: `Held (${d.held.length})` }),
          d.held.length === 0 ? h('p', { className: 'approval-section__note', text: 'Nothing held.' })
            : dataTable({ columns: ['Fit', 'Role', 'Company', 'Reason', 'Link', 'Actions'], rows: heldRows }),
        ]),
      ]),
      h('p', { className: 'approval-section__note', text: `Excluded (${d.counts.excluded}): ${excluded || 'none'}` }),
    ]);
    void params;
    void app;
  }

  await load();
  return { name: 'ready', refresh: load };
}
