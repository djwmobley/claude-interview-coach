// @ts-check
/**
 * Application card with no application, apply-by-hand listings (manual-only lock, or an external /
 * no_control / closed apply page): the /write-resume copy command shows and Create application stays
 * hidden. Uses a minimal fake `document` (the repo has no jsdom); the drafting and normal-create paths
 * are asserted unchanged.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { manualNoApplicationControls } from '../src/dashboard/public/lib/format.js';

class FakeEl {
  /** @param {string} tag */
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this.dataset = {}; this.attrs = {}; this.textContent = ''; this.listeners = {}; }
  addEventListener(/** @type {string} */ e, /** @type {any} */ fn) { this.listeners[e] = fn; }
  setAttribute(/** @type {string} */ k, /** @type {string} */ v) { this.attrs[k] = v; }
  appendChild(/** @type {any} */ c) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
}
/** @param {any} el @returns {string[]} */
function texts(el) {
  if (typeof el === 'string') return [el];
  if (!el) return [];
  return [el.textContent, ...el.children.flatMap(texts)].filter(Boolean);
}

/** @type {(opts: any) => any} */
let applicationCard;
before(async () => {
  /** @type {any} */ (globalThis).document = { createElement: (/** @type {string} */ t) => new FakeEl(t), createTextNode: (/** @type {string} */ s) => ({ textContent: s, children: [] }) };
  ({ applicationCard } = await import('../src/dashboard/public/components/application-card.js'));
});

const base = { listing: { id: 16451, url: 'https://www.linkedin.com/jobs/view/16451', apply_page_branch: 'easy_apply' }, application: null, ats: null, documents: [], onChanged: () => {} };
const render = (/** @type {any} */ over) => texts(applicationCard({ ...base, ...over }));

describe('manualNoApplicationControls (total)', () => {
  test('locked or external/no_control/closed -> command, no create; otherwise create', () => {
    assert.deepEqual(manualNoApplicationControls({ id: 5, apply_page_branch: 'easy_apply' }, true), { showCreate: false, writeResumeCommand: '/write-resume 5', hint: 'Apply-by-hand listing: copy the command below to draft a resume in Claude Code.' });
    for (const b of ['external', 'no_control', 'closed']) {
      const r = manualNoApplicationControls({ id: 7, apply_page_branch: b }, false);
      assert.equal(r.showCreate, false);
      assert.equal(r.writeResumeCommand, '/write-resume 7');
    }
    const c = manualNoApplicationControls({ id: 9, apply_page_branch: 'easy_apply' }, false);
    assert.deepEqual(c, { showCreate: true, writeResumeCommand: null, hint: '' });
    assert.equal(manualNoApplicationControls(null, true).writeResumeCommand, null);
  });
});

describe('applicationCard render', () => {
  test('manual-locked, no application: write-resume command and Copy, no Create application', () => {
    const t = render({ manualLocked: true });
    assert.ok(t.includes('/write-resume 16451'));
    assert.ok(t.includes('Copy'));
    assert.ok(!t.includes('Create application'));
    assert.ok(t.includes('I applied'));
  });
  test('external branch, no application: write-resume command shown, no Create', () => {
    const t = render({ listing: { ...base.listing, apply_page_branch: 'external' }, manualLocked: false });
    assert.ok(t.includes('/write-resume 16451'));
    assert.ok(!t.includes('Create application'));
  });
  test('normal create path unchanged: Create application, no write-resume command', () => {
    const t = render({ manualLocked: false });
    assert.ok(t.includes('Create application'));
    assert.ok(!t.some((x) => x.startsWith('/write-resume')));
  });
  test('drafting state unchanged: write-resume command and Copy, no Create application', () => {
    const t = render({ application: { id: 1, state: 'drafting', resume_doc_id: null, coverletter_doc_id: null }, manualLocked: false });
    assert.ok(t.includes('/write-resume 16451'));
    assert.ok(t.includes('Copy'));
    assert.ok(!t.includes('Create application'));
  });
});
