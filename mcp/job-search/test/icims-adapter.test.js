// @ts-check
/**
 * iCIMS apply adapter (apply pipeline slice 8), against a fully SCRIPTED FAKE capability -- no real
 * Chrome, no network, no live DOM. Mirrors test/apply-adapters.test.js's fake-capability style. See
 * icims.js's own doc comment for the honest caveat: the CSS selectors this adapter targets are unverified
 * against a live *.icims.com tenant in this sandboxed environment -- this test verifies the CONTROL FLOW is
 * correct given whatever the capability reports, not that the real selectors match a real iCIMS DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { icims, SELECTORS } from '../src/apply/adapters/icims.js';

/**
 * @param {{ waitFor?: Record<string, any>, uploadResult?: string|null }} responses
 */
function makeFakeCap(responses = {}) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    async fill(sel, val) { calls.push(['fill', sel, val]); },
    async select(sel, val) { calls.push(['select', sel, val]); },
    async click(sel) { calls.push(['click', sel]); },
    async upload(sel, relPath) { calls.push(['upload', sel, relPath]); return 'uploadResult' in responses ? responses.uploadResult : 'resume.docx'; },
    async screenshot() { calls.push(['screenshot']); return { relPath: 'applications/1/shot.png', absPath: '/x/applications/1/shot.png' }; },
    async waitFor(sel, o = {}) {
      calls.push(['waitFor', sel, o]);
      const entry = (responses.waitFor ?? {})[sel];
      if (entry === undefined) return o.all ? [] : null;
      return typeof entry === 'function' ? entry(o) : entry;
    },
  };
}

/** @param {{ match?: Function, salaryFloor?: number|null }} overrides */
function makeCtx(overrides = {}) {
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const credCalls = [];
  return {
    applicationId: 1,
    applyUrl: 'https://acme.icims.com/jobs/12345/job',
    profile: { fullName: 'Jordan Reyes', email: 'jordan@example.com', phone: '555-0100' },
    documents: { resumePath: 'resumes/jordan-reyes.docx', coverletterPath: null },
    answers: {
      match: overrides.match ?? (() => ({ outcome: 'needs_human_no_match', tier: 'none' })),
      bank: { meta: { salary_floor: overrides.salaryFloor === undefined ? null : overrides.salaryFloor } },
    },
    credentials: {
      target: 'ic-jobsearch/acme.icims.com',
      read: async () => { credCalls.push(['read']); return null; },
      write: async (username, password) => { credCalls.push(['write', username, password]); },
      generatePassword: () => { credCalls.push(['generatePassword']); return 'zz-generated'; },
    },
    log: (f) => events.push(f),
    recordSubmitRequestSent: async () => { events.push({ evt: 'submit_request_sent' }); },
    _events: events,
    _credCalls: credCalls,
  };
}

const EL = { tagName: 'div', text: '' };

describe('icims adapter', () => {
  test('happy path: fills profile, uploads, no custom fields, submits, confirms by heading -> submitted', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.pageProbe]: EL,
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
      },
    });
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.ok(cap.calls.some((c) => c[0] === 'upload'));
    assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'));
    assert.equal(ctx._credCalls.length, 0, 'this adapter never reads or writes credentials on a happy path');
  });

  test('page never found -> needs_human (unrecognized_page), never attempts to fill or submit', async () => {
    const cap = makeFakeCap({});
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    assert.equal(cap.calls.some((c) => c[0] === 'fill'), false);
  });

  test('captcha at the initial gate probe -> needs_human (captcha), with a screenshot, never solved/clicked past', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.pageProbe]: EL,
        [SELECTORS.captcha]: { tagName: 'div', text: '' },
      },
    });
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'captcha');
    assert.ok(result.pendingQuestion.screenshot);
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
  });

  test('a mandatory sign-in panel -> needs_human (credential), never reads or writes a credential, never generates a password', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.pageProbe]: EL,
        [SELECTORS.authGate]: { tagName: 'input', type: 'password', text: '' },
      },
    });
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'credential');
    assert.equal(result.pendingQuestion.target, 'ic-jobsearch/acme.icims.com');
    assert.equal(result.pendingQuestion.username, 'jordan@example.com');
    assert.equal(ctx._credCalls.length, 0, 'never call credential read/write/generatePassword for iCIMS -- there is no designed sign-in flow');
    assert.equal(cap.calls.some((c) => c[0] === 'fill'), false, 'never attempts to fill the form behind a mandatory sign-in panel');
  });

  test('an optional, dismissible "Sign In" header link does NOT match authGate and never parks the run', async () => {
    // The fake capability simply never responds to SELECTORS.authGate at all (default: null on a miss),
    // simulating a page that has a Sign In link elsewhere but no blocking password-input panel.
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.pageProbe]: EL,
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Application received' },
      },
    });
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
  });

  test('an unmatched REQUIRED custom question parks with a screenshot + pendingQuestion, never guesses', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.pageProbe]: EL,
        [SELECTORS.customFields]: [{ tagName: 'input', type: 'text', id: 'q1', name: 'q1', text: 'Why do you want to work here?', value: null, required: true, options: null }],
      },
    });
    const ctx = makeCtx({ match: () => ({ outcome: 'needs_human_no_match', tier: 'none', key: null }) });
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'question');
    assert.ok(result.pendingQuestion.screenshot);
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
  });

  test('an unconfirmed resume upload refuses to proceed to submit', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.pageProbe]: EL }, uploadResult: null });
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
  });

  test('a salary-shaped question parks (salary_floor unset) with no fill call carrying a number, before the generic bank matcher is even asked', async () => {
    let matchCalled = false;
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.pageProbe]: EL,
        [SELECTORS.customFields]: [{ tagName: 'input', type: 'text', id: 'salary', name: 'salary', text: 'What is your desired annual salary?', value: null, required: true, options: null }],
      },
    });
    const ctx = makeCtx({ match: () => { matchCalled = true; return { outcome: 'auto_answer', tier: 'learned', value: 999999, controlResult: { ok: true, text: '999999' } }; } });
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'question');
    assert.equal(matchCalled, false, 'a salary-shaped label must route through classifyCompensationLabel, never the generic bank matcher');
    assert.equal(cap.calls.some((c) => c[0] === 'fill' && /^\d+(\.\d+)?$/.test(String(c[2]))), false, 'no fill call may carry a bare number for an unresolved salary question');
  });

  test('a salary-shaped question with a configured salary_floor fills the resolved annual figure and never parks', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.pageProbe]: EL,
        [SELECTORS.customFields]: [{ tagName: 'input', type: 'text', id: 'salary', name: 'salary', text: 'Desired annual salary', value: null, required: true, options: null }],
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
      },
    });
    const ctx = makeCtx({ salaryFloor: 150000 });
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === '#salary' && c[2] === '150000'));
  });

  test('submitted but no confirmation heading seen -> needs_human (post_submit_uncertain), after recording submit_request_sent', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.pageProbe]: EL, [SELECTORS.submit]: { tagName: 'button', text: 'Submit' } } });
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'post_submit_uncertain');
    assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'));
  });

  test('no submit control found -> needs_human (unrecognized_page), never guesses a submit', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.pageProbe]: EL } });
    const ctx = makeCtx();
    const result = await icims.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
  });

  test('uploadHosts is empty and requires is empty (no account, no widened upload host)', () => {
    assert.deepEqual(icims.uploadHosts, []);
    assert.deepEqual(icims.requires, []);
  });
});
