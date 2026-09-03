// @ts-check
/**
 * src/apply/linkedin-button-probe.js (auto-apply GAP 1): extractApplyHint + probeLinkedInButtonApply,
 * against fully scripted fake page/session objects -- no real browser.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractApplyHint, probeLinkedInButtonApply, DEFAULT_APPLY_BUTTON_SELECTOR } from '../src/apply/linkedin-button-probe.js';

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

/** @param {{ urls: string[], targetsSequence: Array<Array<{ id: unknown, url: string }>> }} script */
function fakePageAndSession(script) {
  let urlIdx = 0;
  let targetsIdx = 0;
  const closed = [];
  const clicks = [];
  const page = {
    url: async () => script.urls[Math.min(urlIdx, script.urls.length - 1)],
    click: async (selector) => { clicks.push(selector); urlIdx++; },
  };
  const session = {
    listTargets: async () => {
      const t = script.targetsSequence[Math.min(targetsIdx, script.targetsSequence.length - 1)];
      targetsIdx++;
      return t;
    },
    closeTarget: async (id) => { closed.push(id); },
  };
  return { page, session, closed, clicks };
}

describe('probeLinkedInButtonApply', () => {
  test('clicks exactly once using the default selector', async () => {
    const { page, session, clicks } = fakePageAndSession({
      urls: ['https://www.linkedin.com/jobs/view/1/'],
      targetsSequence: [[], []],
    });
    await probeLinkedInButtonApply(page, session, { pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.deepEqual(clicks, [DEFAULT_APPLY_BUTTON_SELECTOR]);
  });

  test('a new target opening resolves to new_target and is closed', async () => {
    const newTarget = { id: 'target-2', url: 'https://boards.greenhouse.io/acme/jobs/123' };
    const { page, session, closed } = fakePageAndSession({
      urls: ['https://www.linkedin.com/jobs/view/1/'],
      targetsSequence: [
        [{ id: 'target-1', url: 'https://www.linkedin.com/jobs/view/1/' }], // before click (listed once before click too, but click happens between calls)
        [{ id: 'target-1', url: 'https://www.linkedin.com/jobs/view/1/' }, newTarget], // after click: new target present
      ],
    });
    const result = await probeLinkedInButtonApply(page, session, { pollIntervalMs: 1, timeoutMs: 100, sleep: async () => {} });
    assert.deepEqual(result, { outcome: 'new_target', url: 'https://boards.greenhouse.io/acme/jobs/123' });
    assert.deepEqual(closed, ['target-2']);
  });

  test('same-tab URL gaining the hint params resolves to hint, never new_target', async () => {
    const { page, session } = fakePageAndSession({
      urls: [
        'https://www.linkedin.com/jobs/view/1/',
        'https://www.linkedin.com/jobs/view/1/?applicantTrackingSystemName=workday&companyName=Acme',
      ],
      targetsSequence: [[], []], // no new target ever appears
    });
    const result = await probeLinkedInButtonApply(page, session, { pollIntervalMs: 1, timeoutMs: 100, sleep: async () => {} });
    assert.deepEqual(result, { outcome: 'hint', hint: { applicantTrackingSystemName: 'workday', companyName: 'Acme' } });
  });

  test('a same-tab URL change with no hint params keeps polling instead of stopping', async () => {
    const { page, session } = fakePageAndSession({
      urls: [
        'https://www.linkedin.com/jobs/view/1/',
        'https://www.linkedin.com/jobs/view/1/?trk=something-unrelated',
      ],
      targetsSequence: [[], []],
    });
    const result = await probeLinkedInButtonApply(page, session, { pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.deepEqual(result, { outcome: 'timeout' });
  });

  test('neither a new target nor a hint within the deadline -> timeout', async () => {
    const { page, session } = fakePageAndSession({
      urls: ['https://www.linkedin.com/jobs/view/1/'],
      targetsSequence: [[]],
    });
    const start = Date.now();
    const result = await probeLinkedInButtonApply(page, session, { pollIntervalMs: 2, timeoutMs: 10, sleep: async (ms) => new Promise((r) => setTimeout(r, ms)) });
    assert.deepEqual(result, { outcome: 'timeout' });
    assert.ok(Date.now() - start >= 8); // roughly honored the timeout, allowing for scheduler slack
  });

  test('a custom selector is used when given', async () => {
    const { page, session, clicks } = fakePageAndSession({ urls: ['https://x/'], targetsSequence: [[]] });
    await probeLinkedInButtonApply(page, session, { selector: 'button.custom-apply', pollIntervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    assert.deepEqual(clicks, ['button.custom-apply']);
  });
});
