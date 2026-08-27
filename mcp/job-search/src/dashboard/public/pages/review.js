// @ts-check
/** Review: candidate vs matches cards, differing fields highlighted, Merge (two-step)/Separate/Repost. */
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { confirmButton } from '../components/confirm-button.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { on, off } from '../lib/bus.js';
import { createListCursor } from '../lib/list-cursor.js';

/** kbaction totality (independent review comment 5440498360, blocking finding 1). Review resolution is
 * merge/separate/repost, not a stage-set, and has no digit/Job-detail-only shortcuts. */
export const KEYBOARD_ACTIONS = Object.freeze({
  'row-nav': 'handled',
  'row-open': 'handled',
  'row-stage': 'not-applicable',
  digit: 'not-applicable',
  shortcut: 'not-applicable',
});

/** @param {any} field @param {string[]} differs */
function fieldCell(field, value, differs) {
  return h('span', { className: `review-field ${differs.includes(field) ? 'review-field--diff' : ''}`.trim(), text: `${field}: ${value ?? 'not set'}` });
}

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  const cursor = createListCursor();
  /** @type {Map<string, number|null>} */
  let candidateIdByQueueId = new Map();
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const outcome = handleOutcome(await getJson('/api/review'));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'The review queue could not be loaded right now.' })]);
      return;
    }
    const rows = outcome.body.rows;
    const autoNote = outcome.body.auto_separated > 0 ? h('p', { className: 'review-auto-note', text: `${outcome.body.auto_separated} items auto-resolved.` }) : null;

    const resolve = async (queueId, resolution, targetId) => {
      const out = handleOutcome(await postJson(`/api/review/${queueId}/resolve`, { resolution, target_id: targetId ?? null }));
      if (out.kind === 'ok') { showToast({ message: `Resolved as ${resolution}.` }); load(); }
    };

    const cards = rows.map((item) => {
      const candidate = item.candidate;
      const matches = item.matches ?? [];
      return h('div', { className: 'review-card', dataset: { rowId: item.queue_id }, attrs: { tabindex: '0' } }, [
        h('div', { className: 'review-card__reason', text: `Reason: ${item.reason}` }),
        h('div', { className: 'review-card__candidate' }, [
          h('h3', { text: candidate ? candidate.title : 'candidate removed' }),
          candidate ? h('div', {}, [fieldCell('company', candidate.company, []), fieldCell('location', candidate.location, [])]) : null,
        ]),
        h('div', { className: 'review-card__matches' }, matches.map((m) => h('div', { className: 'review-card__match' }, [
          h('span', { text: `#${m.id} ${m.title}` }),
          fieldCell('company', m.company, m.differs),
          fieldCell('location', m.location, m.differs),
          fieldCell('status', m.status, m.differs),
          confirmButton({ label: 'Merge into this', confirmLabel: 'Confirm merge', onConfirm: () => resolve(item.queue_id, 'merge', m.id) }),
        ]))),
        h('div', { className: 'review-card__actions' }, [
          h('button', { className: 'btn', text: 'Separate', on: { click: () => resolve(item.queue_id, 'separate') } }),
          h('button', { className: 'btn', text: 'Repost', on: { click: () => resolve(item.queue_id, 'repost') } }),
        ]),
      ]);
    });

    setChildren(container, [
      h('h1', { className: 'page-title', text: 'Review' }),
      autoNote,
      rows.length === 0 ? emptyState({ message: 'No items pending review.' }) : h('div', { className: 'review-cards' }, cards),
    ]);
    cursor.setRows([...container.querySelectorAll('.review-card')]);
    candidateIdByQueueId = new Map(rows.map((item) => [String(item.queue_id), item.candidate?.id ?? null]));
  }

  /** @param {{ type: string, [k: string]: any }} action */
  function onKbAction(action) {
    switch (action.type) {
      case 'row-nav':
        cursor.move(action.dir);
        return;
      case 'row-open': {
        const id = cursor.currentId();
        const candidateId = id ? candidateIdByQueueId.get(id) : null;
        if (candidateId) app.navigate('job-detail', { id: candidateId });
        return;
      }
      default:
        // row-stage / digit / shortcut: not applicable on Review (see KEYBOARD_ACTIONS).
        return;
    }
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  on('dashboard:kbaction', onKbAction);
  return {
    name: 'review',
    refresh: load,
    teardown: () => { off('dashboard:changed', onChanged); off('dashboard:kbaction', onKbAction); },
  };
}
