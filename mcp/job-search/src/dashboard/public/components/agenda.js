// @ts-check
/**
 * 7/14-day agenda rows (plan "Home": 7-day agenda; plan "Calendar": 14-day agenda). Each row shows a
 * `google`/`followup`/both badge; a row with neither is not renderable and never produced by the caller.
 */
import { h } from '../lib/dom.js';
import { agendaTimeLabel } from '../lib/format.js';

/** @param {{ items: Array<{ at: string, allDay?: boolean, title: string, google: boolean, followup: boolean, id?: number }>, onDone?: (id:number)=>void, onSnooze?: (id:number)=>void }} opts */
export function agenda(opts) {
  if (opts.items.length === 0) {
    return h('p', { className: 'agenda__empty', text: 'Nothing on the agenda in this window.' });
  }
  return h('ul', { className: 'agenda' }, opts.items.map((item) => h('li', { className: 'agenda__row' }, [
    h('span', { className: 'agenda__time', text: agendaTimeLabel({ at: item.at, allDay: item.allDay ?? false }) }),
    h('span', { className: 'agenda__title', text: item.title }),
    item.google ? h('span', { className: 'badge badge--google', text: 'Google' }) : null,
    item.followup ? h('span', { className: 'badge badge--followup', text: 'Follow-up' }) : null,
    item.followup && item.id != null && opts.onDone ? h('button', { className: 'btn btn--small', text: 'Done', on: { click: () => opts.onDone(/** @type {number} */(item.id)) } }) : null,
    item.followup && item.id != null && opts.onSnooze ? h('button', { className: 'btn btn--small', text: 'Snooze', on: { click: () => opts.onSnooze(/** @type {number} */(item.id)) } }) : null,
  ])));
}
