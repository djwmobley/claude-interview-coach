// @ts-check
/** Review: candidate vs matches cards, differing fields highlighted, Merge (two-step)/Separate/Repost. */
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { confirmButton } from '../components/confirm-button.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { on, off } from '../lib/bus.js';

/** @param {any} field @param {string[]} differs */
function fieldCell(field, value, differs) {
  return h('span', { className: `review-field ${differs.includes(field) ? 'review-field--diff' : ''}`.trim(), text: `${field}: ${value ?? 'not set'}` });
}

/** @param {HTMLElement} container */
export async function render(container, params, app) {
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
      return h('div', { className: 'review-card' }, [
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
  }

  await load();
  const onChanged = () => load();
  on('dashboard:changed', onChanged);
  return { name: 'review', refresh: load, teardown: () => off('dashboard:changed', onChanged) };
}
