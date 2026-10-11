// @ts-check
/**
 * Jobs page Dismiss button: the jobRow button wiring (label, no bubbling to the row's open handler) and
 * the optimistic remove / restore-on-failure helper. Uses a minimal fake `document` (the repo has no
 * jsdom), so real-browser layout and event dispatch are not exercised.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dismissRowOptimistic } from '../src/dashboard/public/lib/dismiss-row.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

class FakeEl {
  /** @param {string} tag */
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.dataset = {}; this.attrs = {}; this.textContent = ''; this.listeners = {}; this.parentNode = null; }
  addEventListener(/** @type {string} */ e, /** @type {any} */ fn) { this.listeners[e] = fn; }
  setAttribute(/** @type {string} */ k, /** @type {string} */ v) { this.attrs[k] = v; }
  appendChild(/** @type {any} */ c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(/** @type {any} */ c, /** @type {any} */ ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    c.parentNode = this;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((/** @type {any} */ x) => x !== this); this.parentNode = null; } }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] ?? null; }
  replaceChildren() { this.children = []; }
}
/** @param {any} el @param {(e: any) => boolean} pred @returns {any} */
function find(el, pred) {
  if (pred(el)) return el;
  for (const c of el.children ?? []) { const r = find(c, pred); if (r) return r; }
  return null;
}

/** @type {(row: any, opts: any) => any} */
let jobRow;
before(async () => {
  /** @type {any} */ (globalThis).document = { createElement: (/** @type {string} */ t) => new FakeEl(t), createTextNode: (/** @type {string} */ s) => ({ textContent: s, children: [] }) };
  ({ jobRow } = await import('../src/dashboard/public/components/job-row.js'));
});

const ROW = { id: 42, title: 'CTO', company: 'Acme', source: 'linkedin', status: 'new', prescore: 70, fit_score: null, url_ok: false };
const noop = () => {};

describe('jobRow Dismiss button', () => {
  test('renders exactly one small button labeled Dismiss', () => {
    const tr = jobRow(ROW, { selected: false, onToggleSelect: noop, onOpen: noop, onApplyNow: noop, onDismiss: noop });
    /** @type {any[]} */ const btns = [];
    (function walk(/** @type {any} */ e) { if (e.tag === 'button' && e.textContent === 'Dismiss') btns.push(e); (e.children ?? []).forEach(walk); })(tr);
    assert.equal(btns.length, 1);
    assert.match(btns[0].className, /btn--small/);
  });

  test('click calls onDismiss(id, tr), stops propagation, and never calls onOpen', () => {
    /** @type {any[]} */ const dismissed = [];
    let opened = 0;
    const tr = jobRow(ROW, { selected: false, onToggleSelect: noop, onOpen: () => { opened += 1; }, onApplyNow: noop, onDismiss: (/** @type {any} */ id, /** @type {any} */ el) => dismissed.push([id, el]) });
    const btn = find(tr, (e) => e.tag === 'button' && e.textContent === 'Dismiss');
    let stopped = false;
    btn.listeners.click({ target: btn, stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
    assert.deepEqual(dismissed.map((d) => d[0]), [42]);
    assert.equal(dismissed[0][1], tr);
    assert.equal(opened, 0);
  });

  test('Enter keydown on the button does not bubble to the row open handler', () => {
    const tr = jobRow(ROW, { selected: false, onToggleSelect: noop, onOpen: noop, onApplyNow: noop, onDismiss: noop });
    const btn = find(tr, (e) => e.tag === 'button' && e.textContent === 'Dismiss');
    let stopped = false;
    btn.listeners.keydown({ key: 'Enter', stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
  });
});

describe('dismissRowOptimistic', () => {
  function table() {
    const tbody = new FakeEl('tbody');
    const rows = [1, 2, 3].map(() => tbody.appendChild(new FakeEl('tr')));
    return { tbody, rows };
  }

  test('removes the row before the server answers and keeps it removed on success', async () => {
    const { tbody, rows } = table();
    let goneDuringCall = false;
    const ok = await dismissRowOptimistic(/** @type {any} */ (rows[1]), async () => { goneDuringCall = !tbody.children.includes(rows[1]); return true; });
    assert.equal(goneDuringCall, true);
    assert.equal(ok, true);
    assert.deepEqual(tbody.children, [rows[0], rows[2]]);
  });

  test('puts the row back in its original position when the call reports failure', async () => {
    const { tbody, rows } = table();
    const ok = await dismissRowOptimistic(/** @type {any} */ (rows[1]), async () => false);
    assert.equal(ok, false);
    assert.deepEqual(tbody.children, rows);
  });

  test('puts the row back when the call throws', async () => {
    const { tbody, rows } = table();
    const ok = await dismissRowOptimistic(/** @type {any} */ (rows[2]), async () => { throw new Error('boom'); });
    assert.equal(ok, false);
    assert.deepEqual(tbody.children, rows);
  });
});

describe('exactly one error toast per failed dismissal (real handleOutcome and toast root)', () => {
  const KINDS = [
    'answer_refused', 'apply_excluded', 'apply_needs_override', 'client_bug', 'config_lock_mismatch', 'db_unavailable',
    'duplicate_application', 'duplicate_candidate', 'easy_apply_conflict', 'internal', 'locked', 'message', 'network_error',
    'not_found', 'payload_too_large', 'rejected_request', 'resume_refused', 'resume_runner_busy', 'unparsable', 'validation',
    'withdraw_refused', 'some_future_kind',
  ];

  test('every failure kind produces exactly one toast, never zero or two', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(console, 'error', () => {});
    const { initToastRoot, showToast } = await import('../src/dashboard/public/lib/toast.js');
    const { handleOutcome } = await import('../src/dashboard/public/lib/outcome.js');
    const { reportDismissFailure } = await import('../src/dashboard/public/lib/dismiss-row.js');
    const root = new FakeEl('div');
    const banners = /** @type {any} */ (new FakeEl('div'));
    banners.querySelector = () => null;
    initToastRoot(/** @type {any} */ (root), banners);
    for (const kind of KINDS) {
      root.children = [];
      reportDismissFailure({ kind, code: 'X', message: 'm' }, {
        handle: handleOutcome,
        toast: () => showToast({ message: 'Could not dismiss that job. It was put back.', tone: 'error' }),
      });
      assert.equal(root.children.length, 1, `kind ${kind} showed ${root.children.length} toasts`);
    }
  });
});

describe('Dismiss column is never hidden by a breakpoint', () => {
  test('no CSS rule sets display none on job-row__dismiss', () => {
    const css = fs.readFileSync(path.join(HERE, '..', 'src', 'dashboard', 'public', 'app.css'), 'utf8');
    assert.doesNotMatch(css, /job-row__dismiss[^{}]*\{[^}]*display\s*:\s*none/);
    assert.match(css, /job-row__dismiss/);
  });
});

describe('jobs page wiring', () => {
  const page = fs.readFileSync(path.join(HERE, '..', 'src', 'dashboard', 'public', 'pages', 'jobs.js'), 'utf8');
  test('Dismiss posts the existing passed status to POST /api/listings/:id/status and passes onDismiss to jobRow', () => {
    assert.match(page, /\/api\/listings\/\$\{id\}\/status`, \{ status: 'passed'/);
    assert.match(page, /onDismiss: dismiss/);
    assert.match(page, /Could not dismiss/);
  });
});
