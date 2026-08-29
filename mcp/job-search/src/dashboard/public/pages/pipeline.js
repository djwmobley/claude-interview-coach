// @ts-check
/** Pipeline: grouped list (not kanban) per status group, with aging chips and manual-row styling. */
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showUndoToast } from '../lib/toast.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { stageChip, chipClassName, agingChip } from '../components/chips.js';
import { ageDays } from '../lib/format.js';
import { on, off } from '../lib/bus.js';
import { createListCursor } from '../lib/list-cursor.js';
import { openAddOpportunityDrawer } from '../components/add-opportunity-drawer.js';

// 'untriaged' (status IS NULL: never manually triaged) and 'new' (the literal status='new' a manual add
// defaults to, and digit-1 maps to -- see components/stage-buttons.js) used to be the same section under
// one 'new' key, with loadGroup() silently redirecting every 'new' request to the untriaged query. That
// made literal status='new' rows permanently invisible on this page: a manually added opportunity, or any
// row someone explicitly set back to 'new', never showed up anywhere. They are two distinct groups now:
// Untriaged immediately before New, then Maybe, Shortlisted, and the rest unchanged. Decision: 'review'
// keeps its original first position rather than moving after the new Untriaged/New split -- it is its own
// urgent pseudo-group (rows with an open review-queue item awaiting human reconciliation), not part of
// the triage ladder the task ordering describes, and nothing asked for it to move.
const ACTIVE_GROUPS = Object.freeze(['review', 'untriaged', 'new', 'maybe', 'shortlisted', 'applied', 'interviewing', 'offer']);
const OUTCOME_GROUPS = Object.freeze(['accepted', 'passed', 'lost', 'dead']);

/** Section 12/kbaction totality (independent review comment 5440498360, blocking finding 1). */
export const KEYBOARD_ACTIONS = Object.freeze({
  'row-nav': 'handled',
  'row-open': 'handled',
  'row-stage': 'handled',
  digit: 'not-applicable',
  shortcut: 'not-applicable',
});

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  const cursor = createListCursor();
  setChildren(container, [skeleton({ rows: 8 })]);

  const setStage = async (id, status, prev) => {
    const out = handleOutcome(await postJson(`/api/listings/${id}/status`, { status }));
    if (out.kind === 'ok') {
      showUndoToast({ message: `Stage set to ${status}.`, onUndo: async () => { handleOutcome(await postJson(`/api/listings/${id}/status`, { status: prev ?? 'new' })); load(); } });
      load();
    }
  };

  async function loadGroup(status) {
    const query = status === 'untriaged' ? { untriaged: '1', limit: '50' } : { status, limit: '50' };
    const outcome = handleOutcome(await getJson('/api/listings', query));
    return outcome.kind === 'ok' ? outcome.body.rows : [];
  }

  async function load() {
    const groups = await Promise.all([...ACTIVE_GROUPS, ...OUTCOME_GROUPS].map((g) => loadGroup(g)));
    const byGroup = Object.fromEntries([...ACTIVE_GROUPS, ...OUTCOME_GROUPS].map((g, i) => [g, groups[i]]));

    // Only rows in the ungrouped "active" sections are keyboard-cursorable: the Outcomes rows sit inside
    // a collapsed <details>, where .focus()/scrollIntoView are inert on not-yet-rendered content anyway.
    const renderRow = (row, cursorable) => {
      const chip = stageChip(row.status);
      const aging = agingChip(ageDays(row.first_seen));
      return h('div', {
        className: `pipeline-row ${row.record_kind === 'manual' ? 'pipeline-row--manual' : ''}`.trim(),
        dataset: cursorable ? { rowId: row.id } : undefined,
        attrs: cursorable ? { tabindex: '0' } : {},
      }, [
        h('a', { className: 'pipeline-row__title', hashHref: `#/jobs/${row.id}`, text: row.title ?? 'untitled' }),
        h('span', { className: 'pipeline-row__company', text: row.company ?? 'unknown company' }),
        row.record_kind === 'manual' && row.notes ? h('span', { className: 'pipeline-row__via', text: `via ${row.notes}` }) : null,
        h('span', { className: chipClassName(aging), text: aging.label }),
        h('span', { className: chipClassName(chip), text: chip.label }),
      ]);
    };

    const activeSections = ACTIVE_GROUPS.map((g) => h('section', { className: 'pipeline-group' }, [
      h('h2', { className: 'pipeline-group__title', text: `${groupLabel(g)} (${byGroup[g].length})` }),
      byGroup[g].length === 0 ? emptyState({ message: `Nothing in ${groupLabel(g)} right now.` }) : h('div', { className: 'pipeline-group__rows' }, byGroup[g].map((row) => renderRow(row, true))),
    ]));

    const outcomeSections = h('details', { className: 'pipeline-outcomes' }, [
      h('summary', { text: 'Outcomes (accepted, passed, lost, dead)' }),
      ...OUTCOME_GROUPS.map((g) => h('section', { className: 'pipeline-group' }, [
        h('h3', { text: `${groupLabel(g)} (${byGroup[g].length})` }),
        byGroup[g].length === 0 ? emptyState({ message: `No ${groupLabel(g).toLowerCase()} listings.` }) : h('div', { className: 'pipeline-group__rows' }, byGroup[g].map((row) => renderRow(row, false))),
      ])),
    ]);

    const activeGroupsWrapper = h('div', { className: 'pipeline-active-groups' }, activeSections);

    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Pipeline' }),
      h('button', { className: 'btn btn--primary', text: 'Add opportunity', on: { click: () => openAddOpportunityDrawer(app) } }),
      h('div', { className: 'pipeline-legend' }, [
        h('span', { text: 'Aging:' }),
        h('span', { className: chipClassName(agingChip(0)), text: 'Under 7 days' }),
        h('span', { className: chipClassName(agingChip(10)), text: '7 to 14 days' }),
        h('span', { className: chipClassName(agingChip(20)), text: 'Over 14 days' }),
      ]),
      activeGroupsWrapper,
      outcomeSections,
    ]);
    cursor.setRows([...container.querySelectorAll('.pipeline-active-groups .pipeline-row')]);
  }

  /** @param {{ type: string, [k: string]: any }} action */
  function onKbAction(action) {
    switch (action.type) {
      case 'row-nav':
        cursor.move(action.dir);
        return;
      case 'row-open': {
        const id = cursor.currentId();
        if (id) app.navigate('job-detail', { id: Number(id) });
        return;
      }
      case 'row-stage': {
        const id = cursor.currentId();
        if (id) setStage(Number(id), action.status, null);
        return;
      }
      default:
        // digit / shortcut: not applicable on Pipeline (see KEYBOARD_ACTIONS).
        return;
    }
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  on('dashboard:kbaction', onKbAction);
  return {
    name: 'pipeline',
    refresh: load,
    teardown: () => { off('dashboard:changed', onChanged); off('dashboard:kbaction', onKbAction); },
  };
}

function groupLabel(g) {
  const table = { untriaged: 'Untriaged', new: 'New', maybe: 'Maybe', shortlisted: 'Shortlisted', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', review: 'Review', accepted: 'Accepted', passed: 'Passed', lost: 'Lost', dead: 'Dead' };
  return table[g] ?? g;
}
