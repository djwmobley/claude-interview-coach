// @ts-check
/**
 * Review page "Applications awaiting approval" section (review-approvals-list PR spec A3): the operator
 * could previously only Approve a docs_ready application from the Job detail page's application-card.js,
 * and had no single place to find every docs_ready application across all listings. This renders that
 * list as its own section card (existing section-card style, thin cyan accent, dashboard UI restraint --
 * minimal color beyond that one accent), plus a read-only "Parked (needs human)" group underneath.
 *
 * Kept out of application-card.js deliberately: this is a cross-listing LIST view (GET /api/applications),
 * not a single listing's own application panel, and its Approve handler has its own explicit
 * ok/validation/other branching (see approveRow() below) that the existing card's simpler handler does
 * not need.
 */
import { h, setChildren } from '../lib/dom.js';
import { buildHash } from '../lib/router.js';
import { postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { emptyState } from './empty-state.js';
import { chipClassName, atsChip, reviewVerdictChip } from './chips.js';
import { relativeTime, approvalRowFindingsState, approvalRowApproveState } from '../lib/format.js';

/** @param {{ severity?: string, text?: string }} f */
function findingText(f) {
  return `${f.severity ? `${f.severity}: ` : ''}${f.text ?? ''}`;
}

/**
 * One docs_ready row. `state.inFlight`/`state.inlineMessage`/`state.findingsOpen` are per-row UI-only
 * state the caller (renderApprovalSection) owns and re-renders on; this function is a pure(ish) DOM
 * builder given that state, matching every other components/*.js file's own "no hidden module state"
 * convention. `state.findingsOpen` is `null` until the operator toggles it -- while `null`,
 * approvalRowFindingsState()'s own computed default (expanded on FAIL, or on empty non-PASS) applies;
 * `h()` has no safe-listed `open` attribute for a native `<details>` element, so the panel is a plain
 * toggle button plus a conditionally-rendered body instead.
 * @param {any} row
 * @param {{ inFlight: boolean, inlineMessage: string|null, findingsOpen: boolean|null }} rowState
 * @param {{ onApprove: (row: any) => void, onOpenDoc: (relPath: string) => void, onToggleFindings: (id: number) => void }} opts
 */
function approvalRow(row, rowState, opts) {
  const ats = atsChip(row.apply_ats);
  const verdict = reviewVerdictChip(row.review_verdict);
  const findingsState = approvalRowFindingsState(row);
  const approveState = approvalRowApproveState(row, { inFlight: rowState.inFlight });
  const findings = Array.isArray(row.review_findings) ? row.review_findings : [];
  const findingsOpen = rowState.findingsOpen === null ? findingsState.expanded : rowState.findingsOpen;

  const findingsBody = !findingsOpen ? null : (findings.length === 0
    ? h('p', { className: `approval-row__empty-findings ${findingsState.emptyMessage ? 'approval-row__empty-findings--amber' : ''}`.trim(), text: findingsState.emptyMessage ?? 'No findings.' })
    : h('ul', { className: 'approval-row__findings-list' }, findings.map((f) => h('li', { text: findingText(f) }))));

  const findingsPanel = h('div', { className: 'approval-row__findings' }, [
    h('button', {
      className: 'approval-row__findings-toggle', attrs: { type: 'button', 'aria-expanded': String(Boolean(findingsOpen)) },
      text: `${verdict.label} findings (${findingsOpen ? 'hide' : 'show'})`,
      on: { click: () => opts.onToggleFindings(row.application_id) },
    }),
    findingsBody,
  ]);

  const approveButton = approveState.visible
    ? h('button', {
      className: 'btn btn--primary btn--small',
      attrs: { type: 'button', title: approveState.reason ?? undefined },
      disabled: approveState.disabled,
      text: rowState.inFlight ? 'Approving...' : 'Approve',
      on: { click: () => opts.onApprove(row) },
    })
    : null;

  const openResumeButton = row.resume_rel_path
    ? h('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: 'Open resume', on: { click: () => opts.onOpenDoc(row.resume_rel_path) } })
    : null;
  const openCoverLetterButton = row.coverletter_doc_id && row.coverletter_rel_path
    ? h('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: 'Open cover letter', on: { click: () => opts.onOpenDoc(row.coverletter_rel_path) } })
    : null;

  return h('div', { className: 'approval-row', dataset: { applicationId: row.application_id } }, [
    h('div', { className: 'approval-row__main' }, [
      h('a', { className: 'approval-row__title', hashHref: buildHash('job-detail', { id: row.listing_id }), text: row.title ?? 'untitled' }),
      h('span', { className: 'approval-row__company', text: row.company ?? 'unknown company' }),
      h('span', { className: 'approval-row__location', text: row.location_norm ?? 'not listed' }),
      h('span', { className: chipClassName(ats), text: ats.label }),
      h('span', { className: 'approval-row__age', text: `Resume ${relativeTime(row.updated_at)}` }),
      h('span', { className: chipClassName(verdict), text: verdict.label }),
    ]),
    findingsPanel,
    rowState.inlineMessage ? h('p', { className: 'approval-row__inline-message', text: rowState.inlineMessage }) : null,
    h('div', { className: 'approval-row__actions' }, [openResumeButton, openCoverLetterButton, approveButton]),
  ]);
}

/** @param {any} row */
function parkedRow(row) {
  return h('div', { className: 'approval-row approval-row--parked' }, [
    h('a', { className: 'approval-row__title', hashHref: buildHash('job-detail', { id: row.listing_id }), text: row.title ?? 'untitled' }),
    h('span', { className: 'approval-row__company', text: row.company ?? 'unknown company' }),
    h('p', { className: 'approval-row__parked-reason', text: row.parked_reason ?? 'Needs your attention.' }),
  ]);
}

/**
 * @param {HTMLElement} container
 * @param {{ docsReadyRows: any[], parkedRows: any[], total: number, onChanged: () => void }} opts
 *   `total` (GET /api/applications' own full-match count, not the capped page length) drives the
 *   "showing N of total" note when the docs_ready list itself was capped at 200.
 */
export function renderApprovalSection(container, opts) {
  /** @type {Map<number, { inFlight: boolean, inlineMessage: string|null, findingsOpen: boolean|null }>} */
  const rowState = new Map();
  const stateFor = (id) => {
    if (!rowState.has(id)) rowState.set(id, { inFlight: false, inlineMessage: null, findingsOpen: null });
    return rowState.get(id);
  };

  async function onOpenDoc(relPath) {
    handleOutcome(await postJson('/api/documents/open', { path: relPath }));
  }

  function onToggleFindings(id) {
    const st = stateFor(id);
    const current = st.findingsOpen === null
      ? approvalRowFindingsState(opts.docsReadyRows.find((r) => r.application_id === id) ?? {}).expanded
      : st.findingsOpen;
    st.findingsOpen = !current;
    renderAll();
  }

  async function onApprove(row) {
    const st = stateFor(row.application_id);
    st.inFlight = true;
    st.inlineMessage = null;
    renderAll();

    const outcome = await postJson(`/api/applications/${row.application_id}/approve`, {});
    // Explicit ok/validation/other branching (spec A3): handleOutcome's own shared side-effect toasts still
    // fire for network/db/internal-style branches, but 'ok' and 'validation' are never left to its silent
    // default case -- this is the one place in the app that must not rely on that default.
    const out = handleOutcome(outcome);
    if (out.kind === 'ok') {
      showToast({ message: 'Approved, submitting' });
      opts.onChanged();
      return;
    }
    st.inFlight = false;
    if (out.kind === 'validation') {
      st.inlineMessage = out.message ?? 'Could not approve this application.';
      renderAll();
      opts.onChanged();
      return;
    }
    st.inlineMessage = out.message ?? 'Something went wrong. The application was not approved.';
    renderAll();
  }

  function renderAll() {
    const docsReadyBody = opts.docsReadyRows.length === 0
      ? emptyState({ message: 'No applications awaiting approval' })
      : h('div', { className: 'approval-list' }, opts.docsReadyRows.map((row) => approvalRow(row, stateFor(row.application_id), { onApprove, onOpenDoc, onToggleFindings })));

    const cappedNote = opts.total > opts.docsReadyRows.length
      ? h('p', { className: 'approval-section__note', text: `Showing ${opts.docsReadyRows.length} of ${opts.total}.` })
      : null;

    const parkedBody = opts.parkedRows.length === 0
      ? emptyState({ message: 'Nothing parked' })
      : h('div', { className: 'approval-list' }, opts.parkedRows.map((row) => parkedRow(row)));

    setChildren(container, [
      h('div', { className: 'approval-section' }, [
        h('h2', { className: 'approval-section__title', text: 'Applications awaiting approval' }),
        cappedNote,
        docsReadyBody,
      ]),
      h('div', { className: 'approval-section approval-section--parked' }, [
        h('h2', { className: 'approval-section__title', text: 'Parked (needs human)' }),
        parkedBody,
      ]),
    ]);
  }

  renderAll();
}
