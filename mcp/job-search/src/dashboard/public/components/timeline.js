// @ts-check
/** Job-detail history timeline: one row per ic_job_events row, most recent first, with the actor badge. */
import { h } from '../lib/dom.js';
import { actorBadge, chipClassName } from './chips.js';
import { shortDateTime } from '../lib/format.js';

const KIND_VERBS = Object.freeze({
  status: 'changed stage', note: 'added a note', fit: 'updated fit score', created: 'created',
  document: 'linked a document', followup: 'follow-up activity', reply: 'got a reply', migrated: 'migrated from legacy status',
});

/** @param {any} event */
function describeEvent(event) {
  const verb = KIND_VERBS[event.kind] ?? event.kind;
  if (event.kind === 'status' && event.to_status) return `${verb}: ${event.from_status ?? 'untriaged'} to ${event.to_status}`;
  return verb;
}

/** @param {{ events: any[] }} opts */
export function timeline(opts) {
  if (opts.events.length === 0) return h('p', { className: 'timeline__empty', text: 'No history recorded for this listing yet.' });
  return h('ul', { className: 'timeline' }, opts.events.map((event) => {
    const badge = actorBadge(event.actor);
    return h('li', { className: 'timeline__row' }, [
      h('span', { className: 'timeline__time', text: shortDateTime(event.at) }),
      h('span', { className: chipClassName(badge, 'timeline__actor'), text: badge.label }),
      h('span', { className: 'timeline__desc', text: describeEvent(event) }),
      event.note ? h('span', { className: 'timeline__note', text: event.note }) : null,
    ]);
  }));
}
