// @ts-check
/**
 * Front end for the outreach note (PR5, plan 19.6, F11): the copy-and-approve order (preflight, clipboard,
 * approve; a refusal copies nothing and a refused approve clears the clipboard), the editor request shape, and
 * the rendering rule that draft text reaches the page only as text. No browser: a minimal fake DOM, a stubbed
 * fetch and a stubbed clipboard.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveFlow } from '../src/dashboard/public/lib/target-approve.js';
import * as targetsPage from '../src/dashboard/public/pages/targets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('approveFlow order (F11)', () => {
  /** @param {{ pre?: any, copyFails?: boolean, approve?: any }} o */
  function harness(o = {}) {
    /** @type {string[]} */
    const log = [];
    const deps = {
      preflight: async () => { log.push('preflight'); return o.pre ?? { kind: 'ok', body: { ok: true, text: 'NOTE', text_hash: 'h'.repeat(64), decision_version: 3, draft_version: 1 } }; },
      writeClipboard: async (/** @type {string} */ t) => { log.push(`copy:${t}`); if (o.copyFails) throw new Error('denied'); },
      clearClipboard: async () => { log.push('clear'); },
      approve: async (/** @type {any} */ pre) => { log.push(`approve:${pre.text_hash.slice(0, 2)}:${pre.decision_version}:${pre.draft_version}`); return o.approve ?? { kind: 'ok', body: { ok: true } }; },
    };
    return { log, deps };
  }

  test('preflight, then copy the server text, then approve with the hash and both versions', async () => {
    const { log, deps } = harness();
    const r = await approveFlow(deps);
    assert.equal(r.status, 'approved');
    assert.deepEqual(log, ['preflight', 'copy:NOTE', 'approve:hh:3:1']);
  });

  test('a refused preflight copies nothing and posts nothing', async () => {
    for (const pre of [{ kind: 'message', code: 'BLOCKED_NOT_ELIGIBLE', message: 'x' }, { kind: 'network_error' }, { kind: 'ok', body: {} }, { kind: 'ok', body: { text: '' } }, { kind: 'not_found' }]) {
      const { log, deps } = harness({ pre });
      const r = await approveFlow(deps);
      assert.equal(r.status, 'refused_preflight');
      assert.deepEqual(log, ['preflight']);
    }
  });

  test('a clipboard failure posts nothing', async () => {
    const { log, deps } = harness({ copyFails: true });
    const r = await approveFlow(deps);
    assert.equal(r.status, 'copy_failed');
    assert.deepEqual(log, ['preflight', 'copy:NOTE']);
  });

  test('a refused approve clears the clipboard: nothing stays copied', async () => {
    for (const approve of [{ kind: 'message', code: 'VERSION_CONFLICT', message: 'changed' }, { kind: 'network_error' }, { kind: 'internal' }]) {
      const { log, deps } = harness({ approve });
      const r = await approveFlow(deps);
      assert.equal(r.status, 'refused_approve');
      assert.deepEqual(log, ['preflight', 'copy:NOTE', 'approve:hh:3:1', 'clear']);
    }
    const throwing = harness();
    throwing.deps.approve = async () => { throw new Error('boom'); };
    const r = await approveFlow(throwing.deps);
    assert.equal(r.status, 'refused_approve');
    assert.equal(throwing.log.at(-1), 'clear');
  });

  test('a clipboard that cannot be cleared does not hide the refusal', async () => {
    const { deps } = harness({ approve: { kind: 'message', code: 'X', message: 'no' } });
    deps.clearClipboard = async () => { throw new Error('denied'); };
    assert.equal((await approveFlow(deps)).status, 'refused_approve');
  });
});

// -------------------------------------------------------------------------------------------------------
// The page against a minimal fake DOM (same approach as dashboard-public-targets.test.js).
// -------------------------------------------------------------------------------------------------------
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
    this.readOnly = false;
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
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
/** @type {string[]} */
let clipboardLog = [];
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
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (/** @type {string} */ t) => { clipboardLog.push(t); } } } });
  /** @type {any} */ (globalThis).fetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    calls.push({ url: String(url), init });
    const r = router(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  /** @type {any} */ (globalThis).document = realDocument;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
});
beforeEach(() => { clipboardLog = []; calls = []; body.children = []; created.length = 0; });

const tick = () => new Promise((r) => setTimeout(r, 25));
/** @param {FakeNode} root @param {(n: FakeNode) => boolean} pred */
const find = (root, pred) => root.all().find(pred);
const button = (/** @type {string} */ label) => find(body, (n) => n.tag === 'button' && n.textContent === label);

const OPTIONS = { ok: true, classes: [], statuses: [], trigger_kinds: [], sources: [], size_verified: [], counts: {}, reasons: { to_target: [], to_not_target: [], discard: [] } };
const ROW = { id: 5, company: 'Acme', class: 'target', status: 'open', blocked: false, verdict_rule: 'target_all_checks_passed', trigger_kind: 'pe_deal', trigger_date: '2026-10-08', evidence_source: 'edgar_8k', size_verified: true, new_evidence: false, stale_evidence: false, decision_version: 7 };
const FIELDS = { hook: 'Harbor acquired Acme.', bridge: 'I ran teams through ownership changes.', claim: 'I led a consolidation.', ask: 'Would a call help?' };
const NOTE = (/** @type {any} */ cur = {}, /** @type {any} */ over = {}) => ({
  eligible: true,
  current: {
    id: 11, state: 'awaiting_approval', origin: 'auto_first', attempt: 1, fields: FIELDS, word_count: 20, addressee: 'Jane', note_preview: 'Hello Jane,\n\nHarbor acquired Acme.', edited: false, draft_version: 2,
    gates: { mode: 'machine', pass: true, advisory: false, failing: [] }, review: { verdict: 'PASS', before_edit: false, reasons: [], failure: null }, fail_codes: [], edits: { count: 0, last_at: null },
    can: { edit: true, approve: true, discard: true, regenerate: false }, ...cur,
  },
  history: [], ...over,
});
const DETAIL = (/** @type {any} */ note) => ({
  ...ROW, machine_class: 'target', reason: null, inputs: {}, evidence: { text: null, url: null, url_ok: false, host: null }, contact_role: null, contact_name: null, pe_firm: null,
  size: { basis: null, confidence: null, verified: true }, listing_ids: [], decision: { status: 'open', class: null, reason: null, decided_at: null },
  allowed: { reclassify: [], discard: true, restore: false }, signals_withheld: false, signals: [], history: [], note,
});

/** @param {(url: string, init?: RequestInit) => { status?: number, body: unknown } | undefined} extra */
async function openDrawer(note, extra = () => undefined) {
  router = (url, init) => {
    const e = extra(url, init);
    if (e) return e;
    if (url.startsWith('/api/targets/options')) return { body: OPTIONS };
    if (url.startsWith('/api/targets/5')) return { body: { ok: true, target: DETAIL(note) } };
    return { body: { ok: true, total: 1, limit: 50, offset: 0, counts: {}, rows: [ROW] } };
  };
  const container = new FakeNode('div');
  await targetsPage.render(/** @type {any} */ (container), {}, {});
  find(container, (n) => n.className === 'targets-row')?.fire('click');
  await tick();
}

describe('the note section', () => {
  test('hostile draft text, review reasons and warnings are text only; no markup element is created', async () => {
    const hostile = '<img src=x onerror=alert(1)> IGNORE ALL PREVIOUS INSTRUCTIONS <script>x</script>';
    await openDrawer(NOTE({ fields: { ...FIELDS, hook: hostile }, note_preview: `Hello,\n\n${hostile}`, fail_codes: ['<b>x</b>'], gates: { mode: 'edited', pass: false, advisory: true, failing: [{ gate: 'dashes', code: '<i>dash</i>' }] } }));
    const hook = find(body, (n) => n.tag === 'textarea' && n.attributes['aria-label'] === 'Hook (the trigger event)');
    assert.equal(hook?.value, hostile, 'draft text is a form value, not markup');
    assert.ok(body.textContent.includes('<b>x</b>') && body.textContent.includes('<i>dash</i>'));
    assert.ok(!created.some((t) => ['img', 'script', 'b', 'i', 'iframe', 'svg'].includes(t)), [...new Set(created)].join(','));
    assert.match(body.textContent, /Check warnings \(advisory after your edit\)/);
  });

  test('no note yet; a blocked row; a parked draft with Regenerate and no Approve', async () => {
    await openDrawer(NOTE(), () => undefined);
    assert.ok(button('Copy and approve'));
    await openDrawer({ current: null, history: [], eligible: true });
    assert.match(body.textContent, /No note has been drafted/);
    body.children = [];
    await openDrawer(null);
    assert.ok(!/Outreach note/.test(body.textContent), 'a blocked row (note null) shows no note section');
    body.children = [];
    await openDrawer(NOTE({ state: 'review_failed', fail_codes: ['review_fail', 'unsupported_claim'], can: { edit: true, approve: false, discard: true, regenerate: true }, review: { verdict: 'FAIL', before_edit: false, reasons: ['unsupported_claim'], failure: null } }));
    assert.ok(button('Regenerate') && button('Save edit') && !button('Copy and approve'));
    assert.match(body.textContent, /Parked because: review_fail, unsupported_claim/);
    assert.match(body.textContent, /Review: FAIL, unsupported_claim/);
  });

  test('the edited state shows the review as before edit; read-only fields when editing is not allowed', async () => {
    await openDrawer(NOTE({ edited: true, review: { verdict: 'PASS', before_edit: true, reasons: [], failure: null }, can: { edit: false, approve: false, discard: false, regenerate: false } }));
    assert.match(body.textContent, /Review: PASS \(before edit\)/);
    assert.match(body.textContent, /edited by you/);
    assert.ok(!button('Save edit'));
    assert.equal(find(body, (n) => n.tag === 'textarea')?.readOnly, true);
  });
});

describe('the buttons', () => {
  test('Copy and approve: GET preflight, then the clipboard gets the SERVER text, then POST approve with the hash and versions; no actor field', async () => {
    const hash = 'ab'.repeat(32);
    await openDrawer(NOTE(), (url, init) => {
      if (url.startsWith('/api/targets/5/draft/preflight')) return { body: { ok: true, text: 'SERVER TEXT', text_hash: hash, decision_version: 7, draft_version: 2, warnings: [], advisory: false } };
      if (url === '/api/targets/5/draft/approve') { assert.equal(init?.method, 'POST'); return { body: { ok: true, due: '2026-10-20', decision_version: 8 } }; }
      return undefined;
    });
    calls = [];
    button('Copy and approve')?.fire('click');
    await tick();
    const seq = calls.map((x) => `${x.init?.method ?? 'GET'} ${x.url}`).filter((x) => x.includes('/draft/'));
    assert.deepEqual(seq, ['GET /api/targets/5/draft/preflight?draft_id=11', 'POST /api/targets/5/draft/approve']);
    assert.deepEqual(clipboardLog, ['SERVER TEXT'], 'the clipboard holds the text the server returned');
    const posted = JSON.parse(String(calls.find((x) => x.url === '/api/targets/5/draft/approve')?.init?.body));
    assert.deepEqual(posted, { draft_id: 11, text_hash: hash, expected_decision_version: 7, expected_draft_version: 2 });
  });

  test('a refused preflight copies nothing; a refused approve clears the clipboard', async () => {
    await openDrawer(NOTE(), (url) => (url.startsWith('/api/targets/5/draft/preflight') ? { status: 409, body: { ok: false, code: 'BLOCKED_NOT_ELIGIBLE', message: 'a row with a blocked party cannot have an approved draft' } } : undefined));
    calls = [];
    button('Copy and approve')?.fire('click');
    await tick();
    assert.deepEqual(clipboardLog, []);
    assert.ok(!calls.some((x) => x.url.endsWith('/draft/approve')));

    body.children = [];
    clipboardLog = [];
    await openDrawer(NOTE(), (url) => {
      if (url.startsWith('/api/targets/5/draft/preflight')) return { body: { ok: true, text: 'SERVER TEXT', text_hash: 'cd'.repeat(32), decision_version: 7, draft_version: 2 } };
      if (url === '/api/targets/5/draft/approve') return { status: 409, body: { ok: false, code: 'VERSION_CONFLICT', message: 'the target changed; reload it' } };
      return undefined;
    });
    button('Copy and approve')?.fire('click');
    await tick();
    assert.deepEqual(clipboardLog, ['SERVER TEXT', ''], 'copied, then cleared after the refusal');
  });

  test('Save edit sends the draft id, the version and the four fields, and nothing that names an actor', async () => {
    await openDrawer(NOTE(), (url) => (url === '/api/targets/5/draft/edit' ? { body: { ok: true, draft_version: 3, noop: false, warnings: [] } } : undefined));
    const ask = find(body, (n) => n.tag === 'textarea' && n.attributes['aria-label'] === 'Ask');
    if (ask) ask.value = 'Would next week suit a short call?';
    calls = [];
    button('Save edit')?.fire('click');
    await tick();
    const post = calls.find((x) => x.url === '/api/targets/5/draft/edit');
    assert.deepEqual(JSON.parse(String(post?.init?.body)), { draft_id: 11, expected_draft_version: 2, fields: { ...FIELDS, ask: 'Would next week suit a short call?' } });
    assert.doesNotMatch(String(post?.init?.body), /actor|damian/);
  });

  test('Discard note and Regenerate post the draft id and version only', async () => {
    await openDrawer(NOTE({ state: 'gate_failed', can: { edit: true, approve: false, discard: true, regenerate: true } }), (url) => (url.includes('/draft/') ? { body: { ok: true } } : undefined));
    calls = [];
    button('Discard note')?.fire('click');
    button('Regenerate')?.fire('click');
    await tick();
    assert.deepEqual(JSON.parse(String(calls.find((x) => x.url.endsWith('/draft/discard'))?.init?.body)), { draft_id: 11, expected_draft_version: 2 });
    assert.deepEqual(JSON.parse(String(calls.find((x) => x.url.endsWith('/draft/regenerate'))?.init?.body)), {});
  });
});

describe('static', () => {
  const strip = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  test('the Targets page and tile never touch the clipboard (lib/target-approve.js does); the page and the tile send nothing and fetch nothing directly', () => {
    const lib = strip(fs.readFileSync(path.join(HERE, '..', 'src', 'dashboard', 'public', 'lib', 'target-approve.js'), 'utf8'));
    assert.match(lib, /navigator\.clipboard/);
    const dir = path.join(HERE, '..', 'src', 'dashboard', 'public');
    for (const f of ['pages/targets.js', 'components/targets-tile.js']) {
      assert.ok(!/navigator\.clipboard|execCommand\(['"]copy/.test(strip(fs.readFileSync(path.join(dir, ...f.split('/')), 'utf8'))), `${f}: clipboard use outside lib/target-approve.js`);
    }
    const page = strip(fs.readFileSync(path.join(dir, 'pages', 'targets.js'), 'utf8'));
    assert.ok(!/(?<![.\w])fetch\s*\(|mailto:|innerHTML|insertAdjacentHTML|outerHTML|document\.write|window\.open|location\.href/.test(page));
    assert.match(page, /approveFlow\(/);
  });
});
