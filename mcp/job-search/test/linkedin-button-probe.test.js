// @ts-check
/**
 * src/apply/linkedin-button-probe.js (auto-apply GAP 1, spec v2 B5/B12): extractApplyHint +
 * probeLinkedInButtonApply, against fully scripted fake page/session objects -- no real browser. The click
 * target is always the classifier's identified control (a precise locator), never a shared CSS selector.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractApplyHint, probeLinkedInButtonApply } from '../src/apply/linkedin-button-probe.js';

const CONTROL = { path: 'html > body > main:nth-child(1) > button:nth-child(2)', name: 'apply to cto on company website' };

describe('extractApplyHint', () => {
  test('both params present', () => {
    const hint = extractApplyHint('https://www.linkedin.com/jobs/view/123/?applicantTrackingSystemName=greenhouse&companyName=Acme');
    assert.deepEqual(hint, { applicantTrackingSystemName: 'greenhouse', companyName: 'Acme' });
  });
  test('only one param present', () => {
    const hint = extractApplyHint('https://www.linkedin.com/jobs/view/123/?companyName=Acme');
    assert.deepEqual(hint, { applicantTrackingSystemName: null, companyName: 'Acme' });
  });
  test('neither param present -> null', () => {
    assert.equal(extractApplyHint('https://www.linkedin.com/jobs/view/123/'), null);
  });
  test('invalid URL -> null, never throws', () => {
    assert.equal(extractApplyHint('not a url'), null);
  });
});

/**
 * @param {{ urls: string[], targetsSequence: Array<Array<{ id: unknown, url: string }>>, inspect?: { count: number, name: string } }} script
 */
function fakePageAndSession(script) {
  let urlIdx = 0;
  let targetsIdx = 0;
  /** @type {unknown[]} */
  const closed = [];
  /** @type {string[]} */
  const clicks = [];
  /** @type {string[]} */
  const inspected = [];
  const page = {
    url: async () => script.urls[Math.min(urlIdx, script.urls.length - 1)],
    inspect: async (/** @type {string} */ selector) => { inspected.push(selector); return script.inspect ?? { count: 1, name: CONTROL.name }; },
    click: async (/** @type {string} */ selector) => { clicks.push(selector); urlIdx++; },
  };
  const session = {
    listTargets: async () => {
      const t = script.targetsSequence[Math.min(targetsIdx, script.targetsSequence.length - 1)];
      targetsIdx++;
      return t;
    },
    closeTarget: async (/** @type {unknown} */ id) => { closed.push(id); },
  };
  return { page, session, closed, clicks, inspected };
}

describe('probeLinkedInButtonApply', () => {
  test('clicks exactly once, on the identified control locator', async () => {
    const { page, session, clicks, inspected } = fakePageAndSession({ urls: ['https://www.linkedin.com/jobs/view/1/'], targetsSequence: [[], []] });
    await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.deepEqual(inspected, [CONTROL.path]);
    assert.deepEqual(clicks, [CONTROL.path]);
  });

  test('no identified control: aborts without clicking (there is no default selector)', async () => {
    const { page, session, clicks } = fakePageAndSession({ urls: ['https://x/'], targetsSequence: [[]] });
    const r = await probeLinkedInButtonApply(page, session, /** @type {any} */ ({ pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} }));
    assert.deepEqual(r, { outcome: 'aborted', reason: 'no_control' });
    assert.deepEqual(clicks, []);
  });

  test('the live control name contains "easy apply": aborts the click (spec v2 B5)', async () => {
    const { page, session, clicks } = fakePageAndSession({ urls: ['https://x/'], targetsSequence: [[]], inspect: { count: 1, name: 'Easy Apply to CTO at Acme' } });
    const r = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.deepEqual(r, { outcome: 'aborted', reason: 'easy_apply_control' });
    assert.deepEqual(clicks, []);
  });

  test('the locator matches zero or several elements: aborts', async () => {
    for (const count of [0, 2]) {
      const { page, session, clicks } = fakePageAndSession({ urls: ['https://x/'], targetsSequence: [[]], inspect: { count, name: CONTROL.name } });
      const r = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
      assert.deepEqual(r, { outcome: 'aborted', reason: 'control_not_unique' });
      assert.deepEqual(clicks, []);
    }
  });

  test('the live control name differs from the classified one: aborts', async () => {
    const { page, session, clicks } = fakePageAndSession({ urls: ['https://x/'], targetsSequence: [[]], inspect: { count: 1, name: 'Save' } });
    const r = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.deepEqual(r, { outcome: 'aborted', reason: 'control_changed' });
    assert.deepEqual(clicks, []);
  });

  test('a new target opening off LinkedIn resolves to new_target and is closed', async () => {
    const newTarget = { id: 'target-2', url: 'https://boards.greenhouse.io/acme/jobs/123' };
    const { page, session, closed } = fakePageAndSession({
      urls: ['https://www.linkedin.com/jobs/view/1/'],
      targetsSequence: [
        [{ id: 'target-1', url: 'https://www.linkedin.com/jobs/view/1/' }],
        [{ id: 'target-1', url: 'https://www.linkedin.com/jobs/view/1/' }, newTarget],
      ],
    });
    const result = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 100, sleep: async () => {} });
    assert.deepEqual(result, { outcome: 'new_target', url: 'https://boards.greenhouse.io/acme/jobs/123' });
    assert.deepEqual(closed, ['target-2']);
  });

  test('a new target on any linkedin.com host, /safety/go/ included, is linkedin_target (spec v2 B12)', async () => {
    for (const url of ['https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F1', 'https://www.linkedin.com/jobs/view/2/']) {
      const { page, session, closed } = fakePageAndSession({
        urls: ['https://www.linkedin.com/jobs/view/1/'],
        targetsSequence: [[], [{ id: 'n', url }]],
      });
      const result = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 100, sleep: async () => {} });
      assert.deepEqual(result, { outcome: 'linkedin_target', url });
      assert.deepEqual(closed, ['n']);
    }
  });

  test('same-tab URL gaining the hint params resolves to hint, never new_target', async () => {
    const { page, session } = fakePageAndSession({
      urls: [
        'https://www.linkedin.com/jobs/view/1/',
        'https://www.linkedin.com/jobs/view/1/?applicantTrackingSystemName=workday&companyName=Acme',
      ],
      targetsSequence: [[], []],
    });
    const result = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 100, sleep: async () => {} });
    assert.deepEqual(result, { outcome: 'hint', hint: { applicantTrackingSystemName: 'workday', companyName: 'Acme' } });
  });

  test('a same-tab URL change with no hint params keeps polling instead of stopping', async () => {
    const { page, session } = fakePageAndSession({
      urls: ['https://www.linkedin.com/jobs/view/1/', 'https://www.linkedin.com/jobs/view/1/?trk=something-unrelated'],
      targetsSequence: [[], []],
    });
    const result = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.deepEqual(result, { outcome: 'timeout' });
  });

  test('neither a new target nor a hint within the deadline -> timeout', async () => {
    const { page, session } = fakePageAndSession({ urls: ['https://www.linkedin.com/jobs/view/1/'], targetsSequence: [[]] });
    const start = Date.now();
    const result = await probeLinkedInButtonApply(page, session, { control: CONTROL, pollIntervalMs: 2, timeoutMs: 10, sleep: async (ms) => new Promise((r) => setTimeout(r, ms)) });
    assert.deepEqual(result, { outcome: 'timeout' });
    assert.ok(Date.now() - start >= 8);
  });
});
