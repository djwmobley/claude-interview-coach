// @ts-check
/**
 * The Jobs "Filters" modal (dashboard UX slice 2), built on drawer.js -- Escape closes it, focus is
 * trapped, and it applies filters through the same onChange path filter-bar.js already uses (opts.onApply
 * is a plain state-patch callback, exactly like filter-bar's onChange).
 *
 * public/ code cannot import src/core/statuses.js or src/core/config.js directly (both are Node/zod
 * modules the browser has no way to resolve): status options are drawn from stage-buttons.js's own
 * DIGIT_STAGE_ORDER + MORE_STAGES (already the total, hand-maintained PIPELINE_STATUSES mirror this app
 * uses everywhere else, e.g. Job detail's stage buttons), and noise classes are a small local mirror,
 * cross-checked for drift by test/dashboard-filter-modal.test.js against the real NOISE_CLASSES list
 * (the same pattern chips.js and test/dashboard-chips.test.js already use for statuses/actors/kinds).
 *
 * Source options are NOT a fixed closed list: `sourceOptions` is passed in by the caller (pages/jobs.js),
 * which accumulates the running union of `row.source` values seen across every /api/listings response
 * this session. Documented blind spot: a source that has never yet appeared in a loaded page of rows
 * (because every visible row so far predates it, or the current filters exclude every row carrying it)
 * will not have a checkbox until a row bearing it has been fetched at least once. Wiring a dedicated
 * distinct-sources endpoint was considered and rejected for this slice: no such endpoint exists today
 * (see PR body's decisions section), and adding one is out of scope here.
 */
import { h } from '../lib/dom.js';
import { drawer } from './drawer.js';
import { stageChip } from './chips.js';
import { sourceLabel } from '../lib/format.js';
import { DIGIT_STAGE_ORDER, MORE_STAGES } from './stage-buttons.js';

/** Local mirror of src/core/config.js's NOISE_CLASSES (public/ cannot import that module -- see file
 * header). Cross-checked against the real list by test/dashboard-filter-modal.test.js. */
export const FILTER_MODAL_NOISE_CLASSES = Object.freeze([
  'ok', 'ok_manual', 'aggregator_repost', 'fractional_or_founder', 'staffing_generic', 'unknown_source', 'suspect',
]);

/** Every status the "Status" checkbox group offers, in digit order then the two "more stages" entries.
 * Exported so a totality test can assert this set matches the real PIPELINE_STATUSES list exactly. */
export const FILTER_MODAL_STATUSES = Object.freeze([...DIGIT_STAGE_ORDER, ...MORE_STAGES]);

const NOISE_LABELS = Object.freeze({
  ok: 'Ok', ok_manual: 'Ok (manual)', aggregator_repost: 'Aggregator repost',
  fractional_or_founder: 'Fractional or founder', staffing_generic: 'Staffing (generic)',
  unknown_source: 'Unknown source', suspect: 'Suspect',
});

/**
 * 0-of-N and all-N checked both collapse to `undefined` (no filter): downstream (filterStateToQuery,
 * activeFilterCount) never needs to know an option universe's size, since a "some but not all" selection
 * is the only shape that ever survives into filter state as a non-empty array.
 * @param {string[]} selected @param {readonly string[]} allOptions
 */
function normalizeMultiSelect(selected, allOptions) {
  if (selected.length === 0 || selected.length === allOptions.length) return undefined;
  return selected;
}

/**
 * @param {{ options: readonly string[], selected: string[]|undefined, onChange: (next: string[]|undefined) => void, labelFor?: (opt: string) => string }} opts
 */
function checkboxGroup(opts) {
  const set = new Set(opts.selected ?? []);
  const hintText = () => (set.size === 0 ? 'Nothing checked: no filter, matches every value.' : '');
  const hint = h('p', { className: 'filter-modal__hint', text: hintText() });
  const boxes = opts.options.map((opt) => h('label', { className: 'filter-modal__checkbox' }, [
    h('input', {
      attrs: { type: 'checkbox' },
      checked: set.has(opt),
      on: {
        change: (ev) => {
          const checked = /** @type {HTMLInputElement} */ (ev.target).checked;
          if (checked) set.add(opt);
          else set.delete(opt);
          hint.textContent = hintText();
          opts.onChange(normalizeMultiSelect([...set], opts.options));
        },
      },
    }),
    h('span', { text: opts.labelFor ? opts.labelFor(opt) : opt }),
  ]));
  return h('div', { className: 'filter-modal__group' }, [...boxes, hint]);
}

/**
 * @param {{ state: any, sourceOptions: string[], onApply: (next: any) => void }} opts
 */
export function openFilterModal(opts) {
  // A local draft, copied from the live filter state: Apply commits it via onApply; Escape/Close discard
  // it (the drawer's own Escape/overlay-click handling closes without ever calling onApply), so opening
  // the modal and backing out never mutates the real filter state.
  let draft = { ...opts.state };

  const remoteSelect = h('select', { className: 'drawer__input' }, [
    h('option', { value: '', selected: !draft.remote, text: 'Any' }),
    h('option', { value: 'remote', selected: draft.remote === 'remote', text: 'Remote' }),
    h('option', { value: 'hybrid', selected: draft.remote === 'hybrid', text: 'Hybrid' }),
    h('option', { value: 'onsite', selected: draft.remote === 'onsite', text: 'Onsite' }),
  ]);
  remoteSelect.addEventListener('change', () => {
    const v = /** @type {HTMLSelectElement} */ (remoteSelect).value;
    draft = { ...draft, remote: v || undefined };
  });

  const postedAfterInput = h('input', {
    className: 'drawer__input', attrs: { type: 'date' }, value: draft.postedAfterExact ?? '',
    on: { change: (ev) => { draft = { ...draft, postedAfterExact: /** @type {HTMLInputElement} */ (ev.target).value || undefined }; } },
  });

  const minPrescoreInput = h('input', {
    className: 'drawer__input', attrs: { type: 'number', min: 0, max: 100 }, value: draft.minPrescore ?? '',
    on: { change: (ev) => { const n = Number(/** @type {HTMLInputElement} */ (ev.target).value); draft = { ...draft, minPrescore: Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined }; } },
  });
  const minFitInput = h('input', {
    className: 'drawer__input', attrs: { type: 'number', min: 0, max: 100 }, value: draft.minFit ?? '',
    on: { change: (ev) => { const n = Number(/** @type {HTMLInputElement} */ (ev.target).value); draft = { ...draft, minFit: Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined }; } },
  });

  const unscoredCheckbox = h('input', {
    attrs: { type: 'checkbox' }, checked: Boolean(draft.unscored),
    on: { change: (ev) => { draft = { ...draft, unscored: /** @type {HTMLInputElement} */ (ev.target).checked }; } },
  });
  const includeExpiredCheckbox = h('input', {
    attrs: { type: 'checkbox' }, checked: Boolean(draft.includeExpired),
    on: { change: (ev) => { draft = { ...draft, includeExpired: /** @type {HTMLInputElement} */ (ev.target).checked }; } },
  });
  // Untriaged is its OWN boolean toggle, never folded into the status checkbox group as a pseudo-value:
  // `l.status = ANY(array)` never matches NULL, so an "Untriaged" entry inside that array would silently
  // do nothing. buildQuery (src/tools/query_jobs.js) combines this with any status selection via an
  // explicit `OR l.status IS NULL` clause; see that file's own comment for the three tested combinations.
  const untriagedCheckbox = h('input', {
    attrs: { type: 'checkbox' }, checked: Boolean(draft.untriaged),
    on: { change: (ev) => { draft = { ...draft, untriaged: /** @type {HTMLInputElement} */ (ev.target).checked }; } },
  });

  const { el, close } = drawer({
    title: 'Filters',
    body: [
      h('h3', { text: 'Status' }),
      checkboxGroup({
        options: FILTER_MODAL_STATUSES,
        selected: draft.status,
        onChange: (next) => { draft = { ...draft, status: next }; },
        labelFor: (s) => stageChip(s).label,
      }),
      h('label', { className: 'drawer__field filter-bar__checkbox' }, [untriagedCheckbox, h('span', { text: 'Untriaged (never triaged)' })]),
      h('h3', { text: 'Source' }),
      opts.sourceOptions.length === 0
        ? h('p', { className: 'filter-modal__hint', text: 'No sources seen yet in the loaded rows.' })
        : checkboxGroup({
            options: opts.sourceOptions,
            selected: draft.source,
            onChange: (next) => { draft = { ...draft, source: next }; },
            labelFor: (s) => sourceLabel(s),
          }),
      h('h3', { text: 'Noise class' }),
      checkboxGroup({
        options: FILTER_MODAL_NOISE_CLASSES,
        selected: draft.noiseClass,
        onChange: (next) => { draft = { ...draft, noiseClass: next }; },
        labelFor: (c) => NOISE_LABELS[c] ?? c,
      }),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Remote mode' }), remoteSelect]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Posted after (exact date)' }), postedAfterInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Minimum prescore' }), minPrescoreInput]),
      h('label', { className: 'drawer__field' }, [h('span', { text: 'Minimum fit' }), minFitInput]),
      h('label', { className: 'drawer__field filter-bar__checkbox' }, [unscoredCheckbox, h('span', { text: 'Unscored only (no fit score yet)' })]),
      h('label', { className: 'drawer__field filter-bar__checkbox' }, [includeExpiredCheckbox, h('span', { text: 'Include expired listings' })]),
      h('div', { className: 'drawer__actions' }, [
        h('button', { className: 'btn btn--primary', text: 'Apply', on: { click: () => { opts.onApply(draft); close(); } } }),
        h('button', { className: 'btn', text: 'Clear', on: {
          click: () => {
            const cleared = {
              ...draft,
              status: undefined, source: undefined, noiseClass: undefined, remote: undefined,
              postedAfterExact: undefined, minPrescore: undefined, minFit: undefined,
              unscored: false, includeExpired: false, untriaged: false,
            };
            opts.onApply(cleared);
            close();
          },
        } }),
        h('button', { className: 'btn', text: 'Cancel', on: { click: () => close() } }),
      ]),
    ],
  });
  document.body.appendChild(el);
}
