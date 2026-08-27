// @ts-check
/**
 * Run detail. Section 5 item 1: an incoming SSE `run` event is treated as a signal to re-fetch
 * GET /api/scans/:id (not a partial-payload merge), since the SSE payload omits several fields this page
 * displays (trigger, started_at, profile, errors, dry_run).
 */
import { h, setChildren } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { confirmButton } from '../components/confirm-button.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { runStatusChip, runItemOutcomeChip, triggerBadge, chipClassName } from '../components/chips.js';
import { shortDateTime } from '../lib/format.js';
import { on, off } from '../lib/bus.js';

/** @param {HTMLElement} container @param {{id:number}} params */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 6 })]);

  async function load() {
    const outcome = handleOutcome(await getJson(`/api/scans/${params.id}`), { silenceNotFound: true });
    if (outcome.kind === 'not_found') {
      setChildren(container, [emptyState({ message: 'This run was not found.' }), h('a', { hashHref: '#/runs', text: 'Back to Runs' })]);
      return;
    }
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'This run could not be loaded right now.' })]);
      return;
    }
    const run = outcome.body.run;
    const chip = runStatusChip(run);
    const trig = triggerBadge(run.trigger);
    const sources = Object.entries(run.pages_by_source ?? {});

    setChildren(container, [
      h('h1', { className: 'page-title', text: `Run #${run.run_id}` }),
      h('div', { className: 'run-detail-meta' }, [
        h('span', { className: chipClassName(chip), text: chip.label }),
        h('span', { className: chipClassName(trig), text: trig.label }),
        h('span', { text: `Started ${shortDateTime(run.started_at)}` }),
        run.status === 'running' ? confirmButton({ label: 'Cancel scan', confirmLabel: 'Confirm cancel', className: 'btn--danger', onConfirm: async () => {
          const out = handleOutcome(await postJson(`/api/scans/${run.run_id}/cancel`, {}));
          if (out.kind === 'ok') { showToast({ message: out.body.note }); load(); }
        } }) : null,
        h('a', { hashHref: `#/reports/${run.started_at.slice(0, 10)}`, text: "View that day's report" }),
      ]),
      h('div', { className: 'run-detail-grid' }, [
        h('div', {}, [
          h('h3', { text: 'Per-source pages' }),
          sources.length === 0 ? emptyState({ message: 'No source activity reported.' }) : h('ul', {}, sources.map(([s, n]) => h('li', { text: `${s}: ${n} pages` }))),
          h('h3', { text: 'Errors' }),
          (run.errors ?? []).length === 0 ? emptyState({ message: 'No errors recorded.' }) : h('ul', {}, run.errors.map((e) => h('li', { text: e.message ?? e.code ?? 'error' }))),
        ]),
        h('div', {}, [
          h('h3', { text: `Items (${outcome.body.items.length})` }),
          outcome.body.items.length === 0 ? emptyState({ message: 'No items recorded for this run.' }) : h('ul', { className: 'run-items' }, outcome.body.items.map((it) => {
            const oc = runItemOutcomeChip(it.outcome);
            return h('li', {}, [h('span', { className: chipClassName(oc), text: oc.label }), h('a', { hashHref: `#/jobs/${it.listing_id}`, text: it.title })]);
          })),
        ]),
      ]),
    ]);
  }

  await load();
  const onRunUpdate = () => load();
  const onChanged = () => load();
  on('dashboard:run-update', onRunUpdate);
  on('dashboard:changed', onChanged);
  return { name: 'run-detail', refresh: load, teardown: () => { off('dashboard:run-update', onRunUpdate); off('dashboard:changed', onChanged); } };
}
