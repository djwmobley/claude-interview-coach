// @ts-check
/**
 * Targets (plan 18): companies worth approaching directly, found by the target finder. A list with filters, a
 * detail drawer, and the human actions Reclassify, Discard and Restore. No drafting, outreach or send path
 * lives here (drafts are a later PR); nothing on this page contacts anyone.
 *
 * Rendering rule (A6): every string that came from SEC or Gmail (company, excerpts, URLs, names, notes) is set
 * through h()'s text path (textContent), never as markup. An evidence link is live only when the server says
 * `url_ok` (https and a registry host, checked server side) and it goes through hLink(), which re-validates the
 * scheme. A blocked row arrives from the server with the company already replaced by "[blocked]" and nothing
 * else to show; this page adds no name of its own.
 *
 * Section cards with the thin cyan accent; color only on chips.
 */
import { h, setChildren, hLink } from '../lib/dom.js';
import { getJson, postJson } from '../lib/api.js';
import { handleOutcome } from '../lib/outcome.js';
import { showToast } from '../lib/toast.js';
import { skeleton, emptyState } from '../components/empty-state.js';
import { dataTable } from '../components/data-table.js';
import { drawer } from '../components/drawer.js';
import { chipClassName, targetClassChip, targetStatusChip, targetBadge } from '../components/chips.js';
import { relativeTime } from '../lib/format.js';

/** kbaction manifest: this page has no row keyboard map of its own. */
export const KEYBOARD_ACTIONS = Object.freeze({
  'row-nav': 'not-applicable',
  'row-open': 'not-applicable',
  'row-stage': 'not-applicable',
  digit: 'not-applicable',
  shortcut: 'not-applicable',
});

export const PAGE_SIZE = 50;

const KIND_LABELS = Object.freeze({ pe_deal: 'PE deal', exec_departure: 'Exec departure', leadership_gap: 'Leadership gap' });
const SOURCE_LABELS = Object.freeze({ edgar_form_d: 'SEC Form D', edgar_8k: 'SEC 8-K', edgar_fts: 'SEC full text', google_alert: 'Google Alert', listings: 'Our listings' });
const REASON_LABELS = Object.freeze({
  size_confirmed: 'Size confirmed',
  trigger_confirmed: 'Trigger confirmed',
  other_verified: 'Verified another way',
  not_a_fit: 'Not a fit',
  already_known: 'Already known',
  blocked_relationship: 'Blocked relationship',
  stale: 'Stale',
});
const ACTION_LABELS = Object.freeze({ reclassify: 'Reclassified', discard: 'Discarded', restore: 'Restored', blocked_refused: 'Promotion refused (blocked)' });

/** @param {string|null|undefined} k */
export function kindLabel(k) { return KIND_LABELS[/** @type {string} */ (k)] ?? 'Unknown trigger'; }
/** @param {string|null|undefined} s */
export function sourceLabel(s) { return SOURCE_LABELS[/** @type {string} */ (s)] ?? (s ? String(s) : 'n/a'); }
/** @param {string|null|undefined} r */
export function reasonLabel(r) { return REASON_LABELS[/** @type {string} */ (r)] ?? (r ? String(r) : 'n/a'); }
/** @param {string|null|undefined} a */
export function actionLabel(a) { return ACTION_LABELS[/** @type {string} */ (a)] ?? 'Changed'; }

/** @param {{ size_verified?: boolean|null }} row @returns {string} badge kind for chips.targetBadge */
export function sizeKind(row) {
  if (row.size_verified === true) return 'size_verified';
  if (row.size_verified === false) return 'size_unverified';
  return 'size_unknown';
}

/** @returns {{ class: string, status: string, trigger_kind: string, source: string, size_verified: string, q: string, offset: number }} */
export function defaultFilters() {
  return { class: '', status: 'active', trigger_kind: '', source: '', size_verified: '', q: '', offset: 0 };
}

/**
 * Filters to the query the list endpoint takes. An empty value is omitted (the server defaults apply).
 * @param {ReturnType<typeof defaultFilters>} f
 * @returns {Record<string, string|number>}
 */
export function buildListQuery(f) {
  /** @type {Record<string, string|number>} */
  const q = { limit: PAGE_SIZE };
  if (f.class) q.class = f.class;
  if (f.status && f.status !== 'active') q.status = f.status;
  if (f.trigger_kind) q.trigger_kind = f.trigger_kind;
  if (f.source) q.source = f.source;
  if (f.size_verified) q.size_verified = f.size_verified;
  if (f.q.trim()) q.q = f.q.trim();
  if (f.offset > 0) q.offset = f.offset;
  return q;
}

/** @param {{ label: string, fg: string, bg: string, style: 'outline'|'filled' }} c */
function chipEl(c) { return h('span', { className: chipClassName(c), text: c.label }); }

/** @param {any} row */
function badgesFor(row) {
  return [
    row.blocked ? chipEl(targetBadge('blocked')) : null,
    row.new_evidence ? chipEl(targetBadge('new_evidence')) : null,
    row.stale_evidence ? chipEl(targetBadge('stale_evidence')) : null,
  ];
}

/** @param {HTMLElement} container */
export async function render(container, params, app) {
  setChildren(container, [skeleton({ rows: 8 })]);
  const filters = defaultFilters();
  /** @type {any} */
  let options = null;

  /** @param {string} label @param {string} key @param {Array<[string, string]>} choices */
  function select(label, key, choices) {
    const sel = h('select', { className: 'filter-bar__select', attrs: { 'aria-label': label } },
      choices.map(([v, text]) => h('option', { value: v, selected: /** @type {any} */ (filters)[key] === v, text })));
    sel.addEventListener('change', () => {
      /** @type {any} */ (filters)[key] = /** @type {HTMLSelectElement} */ (sel).value;
      filters.offset = 0;
      void load();
    });
    return h('label', { className: 'filter-bar__field' }, [h('span', { text: label }), sel]);
  }

  function filterBar() {
    const o = options ?? {};
    const search = h('input', { className: 'filter-bar__search', attrs: { type: 'search', placeholder: 'Search company, PE firm, contact', 'aria-label': 'Search targets' }, value: filters.q });
    search.addEventListener('keydown', (ev) => {
      if (/** @type {KeyboardEvent} */ (ev).key === 'Enter') {
        filters.q = /** @type {HTMLInputElement} */ (search).value;
        filters.offset = 0;
        void load();
      }
    });
    return h('div', { className: 'filter-bar' }, [
      search,
      select('Class', 'class', [['', 'Target and needs review'], ['target', 'Target'], ['needs-review', 'Needs review'], ['not-target', 'Not a target'], ['all', 'All classes']]),
      select('Status', 'status', [['active', 'Active'], ['open', 'Open only'], ['reclassified', 'Reclassified'], ['discarded', 'Discarded'], ['any', 'Any']]),
      select('Trigger', 'trigger_kind', [['', 'Any trigger'], ...(o.trigger_kinds ?? Object.keys(KIND_LABELS)).map((/** @type {string} */ k) => /** @type {[string, string]} */ ([k, kindLabel(k)]))]),
      select('Source', 'source', [['', 'Any source'], ...(o.sources ?? []).map((/** @type {string} */ s) => /** @type {[string, string]} */ ([s, sourceLabel(s)]))]),
      select('Size', 'size_verified', [['', 'Any size state'], ['verified', 'Verified'], ['unverified', 'Unverified'], ['unknown', 'Unknown']]),
    ]);
  }

  /** @param {any} counts */
  function countsLine(counts) {
    const c = counts ?? {};
    return h('p', { className: 'approval-section__note targets-counts', text: `Target ${c.target ?? 0} | Needs review ${c['needs-review'] ?? 0} | Not a target ${c['not-target'] ?? 0} (blocked ${c.blocked ?? 0}) | Discarded ${c.discarded ?? 0}` });
  }

  /** @param {any} row */
  function listRow(row) {
    const tr = h('tr', { className: 'targets-row', attrs: { tabindex: 0 } }, [
      h('td', {}, [h('span', { className: 'targets-company', text: row.company }), ...badgesFor(row)]),
      h('td', { text: kindLabel(row.trigger_kind) }),
      h('td', { text: row.trigger_date ?? 'n/a' }),
      h('td', { text: sourceLabel(row.evidence_source) }),
      h('td', {}, [chipEl(targetBadge(sizeKind(row)))]),
      h('td', {}, [chipEl(targetClassChip(row.class)), row.status !== 'open' ? chipEl(targetStatusChip(row.status)) : null]),
    ]);
    tr.addEventListener('click', () => { void openDetail(row.id); });
    tr.addEventListener('keydown', (ev) => { if (/** @type {KeyboardEvent} */ (ev).key === 'Enter') void openDetail(row.id); });
    return tr;
  }

  async function load() {
    if (!options) {
      const o = await getJson('/api/targets/options');
      if (o.kind === 'ok') options = o.body;
    }
    const outcome = handleOutcome(await getJson('/api/targets', buildListQuery(filters)));
    if (outcome.kind !== 'ok') {
      setChildren(container, [emptyState({ message: 'The Targets list could not be loaded right now.' })]);
      return;
    }
    const d = outcome.body;
    const prev = filters.offset > 0
      ? h('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: 'Previous', on: { click: () => { filters.offset = Math.max(0, filters.offset - PAGE_SIZE); void load(); } } }) : null;
    const next = filters.offset + d.rows.length < d.total
      ? h('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: 'Next', on: { click: () => { filters.offset += PAGE_SIZE; void load(); } } }) : null;
    setChildren(container, [
      h('h1', { className: 'page-title', text: `Targets (${d.total})` }),
      h('section', { className: 'approval-section' }, [
        countsLine(d.counts),
        filterBar(),
        d.rows.length === 0
          ? emptyState({ message: 'No targets match these filters.', hint: 'The default view shows open targets and needs-review rows. Change Class or Status to see others.' })
          : dataTable({ columns: ['Company', 'Trigger', 'Date', 'Evidence', 'Size', 'Class'], rows: d.rows.map(listRow) }),
        h('div', { className: 'targets-pager' }, [prev, next, d.total > 0 ? h('span', { className: 'ready-muted', text: ` ${filters.offset + 1} to ${filters.offset + d.rows.length} of ${d.total}` }) : null]),
      ]),
    ]);
    void params;
    void app;
  }

  /** @param {number} id */
  async function openDetail(id) {
    const out = handleOutcome(await getJson(`/api/targets/${id}`), { silenceNotFound: true });
    if (out.kind !== 'ok') {
      if (out.kind === 'not_found') showToast({ message: 'That target no longer exists.', tone: 'error' });
      return;
    }
    const host = h('div', { className: 'targets-detail' });
    const { el } = drawer({ title: 'Target', body: [host], panelClass: 'drawer__panel--wide' });
    document.body.appendChild(el);
    renderDetail(host, out.body.target);
  }

  /** @param {HTMLElement} host @param {any} t */
  function renderDetail(host, t) {
    /** @type {{ action: 'reclassify'|'discard'|'restore', to?: 'target'|'not-target' }|null} */
    let pending = null;
    const formHost = h('div', { className: 'targets-form' });

    /** @param {string} label @param {Node|string|null} value */
    const fact = (label, value) => h('div', { className: 'targets-fact' }, [h('span', { className: 'targets-fact__label', text: label }), typeof value === 'string' || value === null ? h('span', { text: value ?? 'n/a' }) : value]);

    /** @param {any} ev */
    function evidenceNode(ev) {
      if (!ev || !ev.text) return h('span', { text: 'n/a' });
      return ev.url_ok === true && ev.url ? hLink({ url: ev.url, urlOk: true, text: ev.host ?? 'evidence', target: '_blank' }) : h('span', { text: ev.text });
    }

    async function refreshBoth() {
      const fresh = handleOutcome(await getJson(`/api/targets/${t.id}`), { silenceNotFound: true });
      if (fresh.kind === 'ok') renderDetail(host, fresh.body.target);
      await load();
    }

    /** @param {string} reason @param {string} note */
    async function submit(reason, note) {
      if (!pending) return;
      /** @type {Record<string, unknown>} */
      const body = { expected_decision_version: t.decision_version };
      if (pending.action !== 'restore') body.reason_code = reason;
      if (pending.action === 'reclassify') body.to = pending.to;
      if (note.trim()) body.note = note.trim();
      const out = handleOutcome(await postJson(`/api/targets/${t.id}/${pending.action}`, body));
      if (out.kind === 'ok') {
        showToast({ message: out.body.noop ? 'No change: it was already there.' : `${actionLabel(pending.action)}.` });
        renderDetail(host, out.body.target);
        await load();
        return;
      }
      // A stale version or a refusal: the server message was shown; reload the row so the next try is current.
      if (out.kind === 'message') await refreshBoth();
    }

    /** @param {{ action: 'reclassify'|'discard'|'restore', to?: 'target'|'not-target' }} p */
    function startAction(p) {
      pending = p;
      const reasons = p.action === 'restore' ? [] : (p.action === 'reclassify' && p.to === 'target' ? options?.reasons?.to_target : p.action === 'reclassify' ? options?.reasons?.to_not_target : options?.reasons?.discard) ?? [];
      const reasonSel = h('select', { className: 'drawer__input', attrs: { 'aria-label': 'Reason' } }, reasons.map((/** @type {string} */ r) => h('option', { value: r, text: reasonLabel(r) })));
      const noteIn = h('textarea', { className: 'drawer__input', attrs: { placeholder: 'Note (optional, 500 characters)', rows: 2 } });
      const title = p.action === 'restore' ? 'Restore to its prior class' : p.action === 'discard' ? 'Discard this target' : p.to === 'target' ? 'Mark as a target' : 'Mark as not a target';
      setChildren(formHost, [
        h('p', { className: 'drawer__context', text: title }),
        p.action === 'restore' ? null : h('label', { className: 'drawer__field' }, [h('span', { text: 'Reason' }), reasonSel]),
        h('label', { className: 'drawer__field' }, [h('span', { text: 'Note' }), noteIn]),
        h('div', { className: 'drawer__actions' }, [
          h('button', { className: 'btn btn--primary', attrs: { type: 'button' }, text: 'Confirm', on: { click: () => { void submit(/** @type {HTMLSelectElement} */ (reasonSel).value, /** @type {HTMLTextAreaElement} */ (noteIn).value); } } }),
          h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Cancel', on: { click: () => { pending = null; setChildren(formHost, []); } } }),
        ]),
      ]);
    }

    const allowed = t.allowed ?? { reclassify: [], discard: false, restore: false };
    const actionButtons = [
      allowed.reclassify.includes('target') ? h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Mark as target', on: { click: () => startAction({ action: 'reclassify', to: 'target' }) } }) : null,
      allowed.reclassify.includes('not-target') ? h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Mark as not a target', on: { click: () => startAction({ action: 'reclassify', to: 'not-target' }) } }) : null,
      allowed.discard ? h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Discard', on: { click: () => startAction({ action: 'discard' }) } }) : null,
      allowed.restore ? h('button', { className: 'btn', attrs: { type: 'button' }, text: 'Restore', on: { click: () => startAction({ action: 'restore' }) } }) : null,
    ];

    const inputs = Object.entries(t.inputs ?? {}).map(([k, v]) => h('li', { text: `${k}: ${String(v)}` }));
    const signals = (t.signals ?? []).map((/** @type {any} */ s) => h('li', { className: 'targets-signal' }, [
      h('div', { className: 'targets-signal__head', text: `${sourceLabel(s.source)} | ${s.parse_outcome ?? 'n/a'}${s.parse_reason ? ` (${s.parse_reason})` : ''} | ${relativeTime(s.fetched_at)}` }),
      s.url ? h('div', { className: 'ready-muted', text: s.url }) : null,
      s.excerpt ? h('pre', { className: 'targets-excerpt', text: s.excerpt }) : null,
    ]));
    const history = (t.history ?? []).map((/** @type {any} */ e) => h('li', { text: `v${e.decision_version} ${actionLabel(e.action)}${e.to_class ? ` to ${targetClassChip(e.to_class).label}` : ''}${e.reason_code ? `, ${reasonLabel(e.reason_code)}` : ''}${e.note ? `: ${e.note}` : ''} (${relativeTime(e.at)})` }));

    setChildren(host, [
      h('h2', { className: 'targets-title', text: t.company }),
      h('div', { className: 'targets-chips' }, [chipEl(targetClassChip(t.class)), chipEl(targetStatusChip(t.status)), chipEl(targetBadge(sizeKind(t))), ...badgesFor(t)]),
      h('section', { className: 'approval-section' }, [
        fact('Verdict rule', t.verdict_rule ?? 'n/a'),
        fact('Trigger', `${kindLabel(t.trigger_kind)}, ${t.trigger_date ?? 'no date'}`),
        t.blocked ? fact('Blocked', 'A blocked party is involved. Details are withheld.') : null,
        t.blocked ? null : fact('Evidence', evidenceNode(t.evidence)),
        t.blocked ? null : fact('PE firm', t.pe_firm ?? 'n/a'),
        t.blocked ? null : fact('Contact', [t.contact_role, t.contact_name].filter(Boolean).join(', ') || 'n/a'),
        fact('Size', t.size && t.size.basis ? `${t.size.basis}, ${t.size.confidence ?? 'n/a'}` : 'not known'),
        inputs.length ? h('ul', { className: 'targets-inputs' }, inputs) : null,
      ]),
      h('section', { className: 'approval-section' }, [
        h('h3', { className: 'approval-section__title', text: 'Decision' }),
        actionButtons.some(Boolean)
          ? h('div', { className: 'ready-actions' }, actionButtons)
          : h('p', { className: 'approval-section__note', text: 'No action is available for this target in its current state.' }),
        formHost,
      ]),
      h('section', { className: 'approval-section' }, [
        h('h3', { className: 'approval-section__title', text: `Signals (${signals.length})` }),
        t.signals_withheld ? h('p', { className: 'approval-section__note', text: 'Signals are withheld for a blocked row.' })
          : signals.length ? h('ul', {}, signals) : h('p', { className: 'approval-section__note', text: 'No signals linked yet.' }),
      ]),
      h('section', { className: 'approval-section' }, [
        h('h3', { className: 'approval-section__title', text: 'History' }),
        history.length ? h('ul', {}, history) : h('p', { className: 'approval-section__note', text: 'No decisions yet.' }),
      ]),
    ]);
  }

  await load();
  return { name: 'targets', refresh: load };
}
