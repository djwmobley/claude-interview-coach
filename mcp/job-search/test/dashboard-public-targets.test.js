// @ts-check
/**
 * Front end for the Targets page, the Home tile and the g t chord (PR4, plan 18.3 and 18.4). No browser: the
 * pages are driven against a minimal fake DOM and a stubbed fetch. The point of the fake DOM is the rendering
 * rule: SEC and Gmail text reaches the page only as text (a property whose setter for markup throws), links are
 * created only for https evidence the server vouched for, and the action requests carry the version and a
 * closed reason and nothing that names an actor.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, buildHash } from '../src/dashboard/public/lib/router.js';
import { reduceKeyboard, initialKbState, CHORD_WINDOW_MS } from '../src/dashboard/public/lib/shortcuts.js';
import { targetClassChip, targetStatusChip, targetBadge, chipClassName } from '../src/dashboard/public/components/chips.js';
import { railIcon } from '../src/dashboard/public/components/rail-icons.js';
import * as targetsPage from '../src/dashboard/public/pages/targets.js';
import { targetsTile, sourceLine } from '../src/dashboard/public/components/targets-tile.js';

describe('route, chord, chips', () => {
  test('#/targets parses and builds; the rest of the table is unaffected', () => {
    assert.deepEqual(parseHash('#/targets'), { kind: 'ok', route: 'targets', params: {} });
    assert.equal(buildHash('targets'), '#/targets');
    assert.equal(parseHash('#/targets/5').kind, 'not_found');
    assert.deepEqual(parseHash('#/ready'), { kind: 'ok', route: 'ready', params: {} });
  });

  test('g t navigates to targets; the chord window and the other chords still work', () => {
    const armed = reduceKeyboard(initialKbState(), { key: 'g', inInput: false, now: 1000 });
    const nav = reduceKeyboard(armed.state, { key: 't', inInput: false, now: 1000 + CHORD_WINDOW_MS - 1 });
    assert.deepEqual(nav.action, { type: 'navigate', route: 'targets' });
    const late = reduceKeyboard(armed.state, { key: 't', inInput: false, now: 1000 + CHORD_WINDOW_MS + 1 });
    assert.equal(late.action, null);
    const home = reduceKeyboard(reduceKeyboard(initialKbState(), { key: 'g', inInput: false, now: 1 }).state, { key: 'h', inInput: false, now: 2 });
    assert.deepEqual(home.action, { type: 'navigate', route: 'home' });
    assert.equal(reduceKeyboard(initialKbState(), { key: 't', inInput: false, now: 1 }).action, null, 'a bare t does nothing');
    assert.equal(reduceKeyboard(armed.state, { key: 't', inInput: true, now: 2 }).action, null, 'never while typing');
  });

  test('chip tables are total: unknown input gets the closed fallback', () => {
    for (const k of ['target', 'needs-review', 'not-target']) assert.notEqual(targetClassChip(k).label, 'Unknown');
    assert.equal(targetClassChip('whatever').label, 'Unknown');
    for (const k of ['open', 'reclassified', 'discarded', 'approved']) assert.notEqual(targetStatusChip(k).label, 'Unknown');
    assert.equal(targetStatusChip(/** @type {any} */ (null)).label, 'Unknown');
    for (const k of ['blocked', 'new_evidence', 'stale_evidence', 'size_verified', 'size_unverified', 'size_unknown']) assert.notEqual(targetBadge(k).label, 'Unknown');
    assert.match(chipClassName(targetBadge('blocked')), /fg-red/);
  });

  test('pure page helpers', () => {
    assert.deepEqual(targetsPage.buildListQuery(targetsPage.defaultFilters()), { limit: 50 });
    assert.deepEqual(targetsPage.buildListQuery({ class: 'all', status: 'discarded', trigger_kind: 'pe_deal', source: 'listings', size_verified: 'unknown', q: ' acme ', offset: 50 }),
      { limit: 50, class: 'all', status: 'discarded', trigger_kind: 'pe_deal', source: 'listings', size_verified: 'unknown', q: 'acme', offset: 50 });
    assert.equal(targetsPage.sizeKind({ size_verified: true }), 'size_verified');
    assert.equal(targetsPage.sizeKind({ size_verified: false }), 'size_unverified');
    assert.equal(targetsPage.sizeKind({ size_verified: null }), 'size_unknown');
    assert.equal(targetsPage.kindLabel('nope'), 'Unknown trigger');
    assert.equal(targetsPage.reasonLabel('stale'), 'Stale');
    assert.equal(sourceLine({ name: '8k', status: 'partial', reason: 'run_cap', backlog_days: 4 }), '8k partial (run_cap, backlog 4d)');
    assert.equal(sourceLine({ name: 'form_d', status: 'complete', reason: null, backlog_days: 0 }), 'form_d complete');
  });

  test('every page keyboard manifest entry is a valid value and the page declares no handlers', () => {
    for (const k of ['row-nav', 'row-open', 'row-stage', 'digit', 'shortcut']) assert.equal(targetsPage.KEYBOARD_ACTIONS[/** @type {keyof typeof targetsPage.KEYBOARD_ACTIONS} */ (k)], 'not-applicable');
  });
});

// ---------------------------------------------------------------------------------------------------------
// A minimal DOM: just enough for lib/dom.js h(), the drawer and the page. innerHTML throws if anything sets it.
// ---------------------------------------------------------------------------------------------------------
const created = /** @type {string[]} */ ([]);
class FakeNode {
  /** @param {string} tag */
  constructor(tag) {
    this.tag = tag;
    created.push(tag);
    /** @type {any[]} */
    this.children = [];
    /** @type {Record<string, string>} */
    this.attributes = {};
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
    this.dataset = /** @type {Record<string, string>} */ ({});
    this.className = '';
    this.parentNode = /** @type {any} */ (null);
    this.nodeType = 1;
    this._text = '';
    this.value = '';
    this.disabled = false;
    this.tabIndex = 0;
    this.classList = { add() {}, remove() {} };
  }
  /** @param {string} v */
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join(''); }
  set innerHTML(_v) { throw new Error('innerHTML must never be set'); }
  set outerHTML(_v) { throw new Error('outerHTML must never be set'); }
  /** @param {string} k @param {string} v */
  setAttribute(k, v) { this.attributes[k] = String(v); }
  /** @param {string} k */
  getAttribute(k) { return this.attributes[k] ?? null; }
  /** @param {any} c */
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  /** @param {...any} nodes */
  replaceChildren(...nodes) { this.children = []; this._text = ''; for (const n of nodes) this.appendChild(n); }
  /** @param {string} evt @param {Function} fn */
  addEventListener(evt, fn) { (this.listeners[evt] ??= []).push(fn); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((/** @type {any} */ c) => c !== this); }
  querySelectorAll() { return []; }
  focus() {}
  /** @returns {FakeNode[]} */
  all() { return [this, ...this.children.flatMap((c) => (c.nodeType === 3 ? [] : c.all()))]; }
  /** @param {string} evt */
  fire(evt) { for (const fn of this.listeners[evt] ?? []) fn({ key: 'Enter', target: this }); }
}
/** @type {FakeNode} */
let body;
const realFetch = globalThis.fetch;
const realDocument = /** @type {any} */ (globalThis).document;

/** @type {Array<{ url: string, init?: RequestInit }>} */
let calls = [];
/** @type {(url: string, init?: RequestInit) => { status?: number, body: unknown }} */
let router = () => ({ body: {} });

before(() => {
  body = new FakeNode('body');
  /** @type {any} */ (globalThis).document = {
    createElement: (/** @type {string} */ t) => new FakeNode(t),
    createElementNS: (/** @type {string} */ _ns, /** @type {string} */ t) => new FakeNode(t),
    createTextNode: (/** @type {string} */ s) => ({ nodeType: 3, text: String(s) }),
    body,
    activeElement: null,
  };
  /** @type {any} */ (globalThis).fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    calls.push({ url: String(url), init });
    const r = router(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  /** @type {any} */ (globalThis).document = realDocument;
});

const tick = () => new Promise((r) => setTimeout(r, 15));
/** @param {FakeNode} root @param {(n: FakeNode) => boolean} pred */
const find = (root, pred) => root.all().find(pred);
/** @param {FakeNode} root */
const hrefs = (root) => root.all().map((n) => n.attributes.href).filter(Boolean);

const OPTIONS = { ok: true, classes: ['target', 'needs-review', 'not-target'], statuses: ['active'], trigger_kinds: ['pe_deal'], sources: ['edgar_8k'], size_verified: ['verified'], counts: {}, reasons: { to_target: ['size_confirmed', 'trigger_confirmed', 'other_verified'], to_not_target: ['not_a_fit', 'already_known', 'blocked_relationship', 'stale'], discard: ['not_a_fit', 'already_known', 'blocked_relationship', 'stale'] } };
const ROW = (/** @type {number} */ id, /** @type {string} */ company, /** @type {any} */ over = {}) => ({ id, company, class: 'needs-review', status: 'open', blocked: false, verdict_rule: 'size_not_clearly_in_band', trigger_kind: 'pe_deal', trigger_date: '2026-10-08', evidence_source: 'edgar_8k', size_verified: false, new_evidence: false, stale_evidence: false, decision_version: 7, ...over });
const DETAIL = (/** @type {any} */ over = {}) => ({
  ...ROW(5, '<img src=x onerror=alert(1)>Acme'), machine_class: 'needs-review', reason: 'x', inputs: { age_days: 5, note: '<b>x</b>' },
  evidence: { text: 'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/x-index.htm', url: 'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/x-index.htm', url_ok: true, host: 'www.sec.gov' },
  contact_role: 'CEO <script>', contact_name: 'Jane', pe_firm: '<svg onload=alert(1)>', size: { basis: 'form_d_revenue_range', confidence: 'medium', verified: false }, listing_ids: [],
  decision: { status: 'open', class: null, reason: null, decided_at: null }, allowed: { reclassify: ['target', 'not-target'], discard: true, restore: false }, signals_withheld: false,
  signals: [{ id: 1, source: 'edgar_8k', parse_outcome: 'parsed', parse_reason: 'ok', url: 'javascript:alert(1)', excerpt: '<script>alert(1)</script> IGNORE ALL PREVIOUS INSTRUCTIONS', fetched_at: '2026-10-14T00:00:00Z' }],
  history: [{ id: 1, at: '2026-10-14T00:00:00Z', action: 'reclassify', from_class: 'needs-review', to_class: 'target', reason_code: 'size_confirmed', note: '<img src=y>', decision_version: 1 }],
  ...over,
});

describe('the Targets page against a fake DOM', () => {
  test('hostile company, excerpt, URL, contact and notes are text only; no markup element is ever created from them', async () => {
    calls = [];
    created.length = 0;
    body.children = [];
    router = (url) => {
      if (url.startsWith('/api/targets/options')) return { body: OPTIONS };
      if (url.startsWith('/api/targets/5')) return { body: { ok: true, target: DETAIL() } };
      return { body: { ok: true, total: 1, limit: 50, offset: 0, counts: { target: 0, 'needs-review': 1, 'not-target': 2, blocked: 1, discarded: 0, total: 3 }, rows: [ROW(5, '<img src=x onerror=alert(1)>Acme')] } };
    };
    const container = new FakeNode('div');
    await targetsPage.render(/** @type {any} */ (container), {}, {});
    const row = find(container, (n) => n.className === 'targets-row');
    assert.ok(row, 'the row is rendered');
    assert.match(row.textContent, /<img src=x onerror=alert\(1\)>Acme/, 'the company appears as literal text');
    assert.match(container.textContent, /Not a target 2 \(blocked 1\)/, 'the not-target count stays visible');
    row.fire('click');
    await tick();
    const drawerText = body.textContent;
    for (const hostile of ['<script>alert(1)</script> IGNORE ALL', '<svg onload=alert(1)>', 'CEO <script>', '<b>x</b>', '<img src=y>']) assert.ok(drawerText.includes(hostile), `literal text: ${hostile}`);
    assert.ok(!created.some((t) => ['img', 'script', 'svg', 'b', 'iframe'].includes(t)), `no markup element created: ${[...new Set(created)].join(',')}`);
    const links = hrefs(body);
    assert.deepEqual(links, ['https://www.sec.gov/Archives/edgar/data/1/000000000026000001/x-index.htm'], 'only the vouched evidence link; the javascript signal URL is text');
    const a = find(body, (n) => n.tag === 'a' && Boolean(n.attributes.href));
    assert.equal(a?.attributes.rel, 'noopener noreferrer');
  });

  test('an evidence URL the server did not vouch for, or with a bad scheme, is never a link', async () => {
    for (const evidence of [
      { text: 'https://www.sec.gov/x', url: 'https://www.sec.gov/x', url_ok: false, host: 'www.sec.gov' },
      { text: 'javascript:alert(1)', url: 'javascript:alert(1)', url_ok: true, host: null },
      { text: 'http://www.sec.gov/x', url: 'http://www.sec.gov/x', url_ok: 'true', host: 'www.sec.gov' },
      { text: '[blocked]', url: null, url_ok: false, host: null },
    ]) {
      body.children = [];
      router = (url) => (url.startsWith('/api/targets/options') ? { body: OPTIONS } : url.startsWith('/api/targets/5') ? { body: { ok: true, target: DETAIL({ evidence, signals: [] }) } } : { body: { ok: true, total: 1, limit: 50, offset: 0, counts: {}, rows: [ROW(5, 'Acme')] } });
      const container = new FakeNode('div');
      await targetsPage.render(/** @type {any} */ (container), {}, {});
      find(container, (n) => n.className === 'targets-row')?.fire('click');
      await tick();
      const bad = hrefs(body).filter((h) => !String(h).startsWith('https://'));
      assert.deepEqual(bad, [], JSON.stringify(evidence));
      if (evidence.url_ok !== true || !String(evidence.url).startsWith('https://')) assert.deepEqual(hrefs(body), [], JSON.stringify(evidence));
    }
  });

  test('a blocked row shows what the server sent and offers no promotion; its signals are withheld', async () => {
    body.children = [];
    const blocked = DETAIL({
      ...ROW(9, '[blocked]', { blocked: true, class: 'not-target', verdict_rule: 'excl_blocked_company' }), evidence: { text: null, url: null, url_ok: false, host: null },
      allowed: { reclassify: [], discard: true, restore: false }, signals_withheld: true, signals: [], pe_firm: null, contact_name: null, contact_role: null, inputs: {},
    });
    router = (url) => (url.startsWith('/api/targets/options') ? { body: OPTIONS } : url.startsWith('/api/targets/9') ? { body: { ok: true, target: blocked } } : { body: { ok: true, total: 1, limit: 50, offset: 0, counts: {}, rows: [ROW(9, '[blocked]', { blocked: true, class: 'not-target' })] } });
    const container = new FakeNode('div');
    await targetsPage.render(/** @type {any} */ (container), {}, {});
    find(container, (n) => n.className === 'targets-row')?.fire('click');
    await tick();
    const txt = body.textContent;
    assert.match(txt, /\[blocked\]/);
    assert.match(txt, /Blocked/);
    assert.match(txt, /Signals are withheld for a blocked row/);
    const labels = body.all().filter((n) => n.tag === 'button').map((n) => n.textContent);
    assert.ok(labels.includes('Discard'));
    assert.ok(!labels.includes('Mark as target') && !labels.includes('Restore'));
  });

  test('Discard sends the row version and a closed reason and nothing that names an actor; a conflict reloads the row', async () => {
    body.children = [];
    calls = [];
    let version = 7;
    router = (url, init) => {
      if (url.startsWith('/api/targets/options')) return { body: OPTIONS };
      if (url === '/api/targets/5/discard') {
        const sent = JSON.parse(String(init?.body));
        if (sent.expected_decision_version !== version) return { status: 409, body: { ok: false, code: 'VERSION_CONFLICT', message: 'the target changed; reload it', details: { current_version: version } } };
        return { body: { ok: true, noop: false, decision_version: version + 1, target: DETAIL({ status: 'discarded', decision_version: version + 1, allowed: { reclassify: [], discard: false, restore: true } }) } };
      }
      if (url.startsWith('/api/targets/5')) return { body: { ok: true, target: DETAIL({ decision_version: version }) } };
      return { body: { ok: true, total: 1, limit: 50, offset: 0, counts: {}, rows: [ROW(5, 'Acme', { decision_version: version })] } };
    };
    const container = new FakeNode('div');
    await targetsPage.render(/** @type {any} */ (container), {}, {});
    find(container, (n) => n.className === 'targets-row')?.fire('click');
    await tick();
    const discard = find(body, (n) => n.tag === 'button' && n.textContent === 'Discard');
    assert.ok(discard);
    discard.fire('click');
    const select = find(body, (n) => n.tag === 'select' && n.attributes['aria-label'] === 'Reason');
    assert.deepEqual(select?.children.map((o) => o.value), OPTIONS.reasons.discard, 'the reason list is the closed discard list');
    /** @type {any} */ (select).value = 'already_known';
    const confirm = find(body, (n) => n.tag === 'button' && n.textContent === 'Confirm');

    version = 8; // the row moved on while the drawer was open
    calls = [];
    confirm?.fire('click');
    await tick();
    const post1 = calls.find((c) => c.url === '/api/targets/5/discard');
    assert.equal(post1?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(post1?.init?.body)), { expected_decision_version: 7, reason_code: 'already_known' });
    assert.equal(/** @type {any} */ (post1?.init?.headers)['Content-Type'], 'application/json');
    assert.ok(calls.some((c) => c.url === '/api/targets/5' && c.init?.method === 'GET'), 'a conflict reloads the detail');

    // Now the drawer carries version 8: the retry succeeds.
    const again = find(body, (n) => n.tag === 'button' && n.textContent === 'Discard');
    again?.fire('click');
    /** @type {any} */ (find(body, (n) => n.tag === 'select' && n.attributes['aria-label'] === 'Reason')).value = 'stale';
    calls = [];
    find(body, (n) => n.tag === 'button' && n.textContent === 'Confirm')?.fire('click');
    await tick();
    const post2 = calls.find((c) => c.url === '/api/targets/5/discard');
    assert.deepEqual(JSON.parse(String(post2?.init?.body)), { expected_decision_version: 8, reason_code: 'stale' });
    for (const c of calls.filter((x) => x.init?.method === 'POST')) assert.doesNotMatch(String(c.init?.body), /actor|decided_by|damian/);
    assert.ok(find(body, (n) => n.tag === 'button' && n.textContent === 'Restore'), 'the refreshed detail offers Restore');
  });
});

describe('the Home tile', () => {
  test('counts, last run status, per-source coverage and the link; no free text from sources', () => {
    body.children = [];
    const el = /** @type {any} */ (targetsTile({ summary: {
      since: '2026-10-12T00:00:00Z', since_basis: 'last_digest', new_targets: 4, new_needs_review: 2, open: { targets: 9, needs_review: 5 },
      last_run: { id: 3, status: 'partial', trigger: 'scan', started_at: '2026-10-15T07:00:00Z', finished_at: '2026-10-15T07:05:00Z' },
      sources: [{ name: 'form_d', status: 'complete', reason: null, backlog_days: 0 }, { name: '8k', status: 'partial', reason: 'run_cap', backlog_days: 4 }],
    } }));
    const txt = el.textContent;
    assert.match(txt, /4/);
    assert.match(txt, /New targets since the last digest/);
    assert.match(txt, /New needs-review since the last digest/);
    assert.match(txt, /Partial/);
    assert.match(txt, /form_d complete \| 8k partial \(run_cap, backlog 4d\)/);
    assert.match(txt, /Open Targets \(9 targets, 5 needs review\)/);
    const link = find(el, (n) => n.tag === 'a');
    assert.equal(link?.attributes.href, '#/targets');
  });

  test('a skipped_locked last run, no run at all, and no coverage each have a defined rendering', () => {
    const locked = /** @type {any} */ (targetsTile({ summary: { since_basis: 'last_7_days', new_targets: 0, new_needs_review: 0, open: { targets: 0, needs_review: 0 }, last_run: { status: 'skipped_locked', started_at: '2026-10-15T07:00:00Z' }, sources: [] } }));
    assert.match(locked.textContent, /Skipped \(busy\)/);
    assert.match(locked.textContent, /in the last 7 days/);
    assert.match(locked.textContent, /No per-source coverage recorded yet/);
    const none = /** @type {any} */ (targetsTile({ summary: { since_basis: 'last_7_days', new_targets: 1, new_needs_review: 0, open: {}, last_run: null, sources: [] } }));
    assert.match(none.textContent, /never run/);
  });

  test('the rail icon exists for targets', () => {
    assert.ok(railIcon('targets'));
  });
});
