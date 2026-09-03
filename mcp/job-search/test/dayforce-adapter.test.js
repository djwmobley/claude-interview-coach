// @ts-check
/**
 * Dayforce apply adapter (apply pipeline slice 8), against a fully SCRIPTED FAKE capability -- no real
 * Chrome, no network, no live DOM. Mirrors test/workday-adapter.test.js's fake-capability style (the
 * account-holding, multi-step-wizard shape from slice 6), minus account creation and email verification --
 * Dayforce is sign-in only. See dayforce.js's own doc comment for the honest caveat: the CSS/data-automation
 * selectors this adapter targets are unverified against a live *.dayforcehcm.com tenant in this sandboxed
 * environment -- this test verifies the CONTROL FLOW is correct given whatever the capability reports, not
 * that the real selectors match a real Dayforce DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dayforce, SELECTORS, MAX_STEPS } from '../src/apply/adapters/dayforce.js';

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

/**
 * @param {{ match?: Function, credential?: { username: string, password: string } | null, salaryFloor?: number|null }} overrides
 */
function makeCtx(overrides = {}) {
  /** @type {any[]} */
  const events = [];
  /** @type {any[]} */
  const credCalls = [];
  return {
    applicationId: 1,
    applyUrl: 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/12345',
    profile: { fullName: 'Jordan Reyes', email: 'jordan@example.com', phone: '555-0100' },
    documents: { resumePath: 'resumes/jordan-reyes.docx', coverletterPath: null },
    answers: {
      match: overrides.match ?? (() => ({ outcome: 'needs_human_no_match', tier: 'none' })),
      bank: { meta: { salary_floor: overrides.salaryFloor === undefined ? null : overrides.salaryFloor } },
    },
    log: (f) => events.push(f),
    recordSubmitRequestSent: async () => { events.push({ evt: 'submit_request_sent' }); },
    credentials: {
      target: 'ic-jobsearch/acme.dayforcehcm.com',
      read: async () => { credCalls.push(['read']); return overrides.credential === undefined ? null : overrides.credential; },
      write: async (username, password) => { credCalls.push(['write', username, password]); },
      generatePassword: () => { credCalls.push(['generatePassword']); return 'zz-generated-24-char-password-x'; },
    },
    _events: events,
    _credCalls: credCalls,
  };
}

const EL = { tagName: 'div', text: '' };

describe('dayforce adapter', () => {
  test('existing credential: signs in, fills the single-step form, uploads, submits, confirms -> submitted', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.resumeUpload]: { tagName: 'input', text: '' },
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.deepEqual(ctx._credCalls, [['read']], 'an existing credential is never regenerated or rewritten; write/generatePassword are never called by this adapter');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === SELECTORS.signInEmail && c[2] === 'jordan@example.com'));
    assert.ok(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.signInSubmit));
    assert.ok(cap.calls.some((c) => c[0] === 'upload'));
    assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'));
  });

  test('no stored credential -> needs_human (credential), never registers an account, never calls write or generatePassword', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL } });
    const ctx = makeCtx({ credential: null });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'credential');
    assert.equal(result.pendingQuestion.target, 'ic-jobsearch/acme.dayforcehcm.com');
    assert.equal(result.pendingQuestion.username, 'jordan@example.com');
    assert.deepEqual(ctx._credCalls, [['read']], 'never write or generatePassword -- this adapter never creates a Dayforce account');
    assert.equal(cap.calls.some((c) => c[0] === 'fill' && c[1] === SELECTORS.signInEmail), false);
  });

  test('existing credential rejected at sign-in -> needs_human (credential), target/username set for the dashboard prompt', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.authError]: { tagName: 'div', text: 'Invalid email or password' },
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stale-pw' } });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'credential');
    assert.equal(result.pendingQuestion.username, 'jordan@example.com');
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
    assert.equal(ctx._credCalls.some((c) => c[0] === 'write'), false);
  });

  test('captcha at the auth gate -> needs_human (captcha), never solved, sign-in never attempted', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.captcha]: { tagName: 'div', text: '' } } });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'captcha');
    assert.ok(result.pendingQuestion.screenshot);
    assert.equal(ctx._credCalls.length, 0, 'never even reads the credential before knowing there is no captcha wall');
  });

  test('auth gate never found -> needs_human (unrecognized_page), never attempts to fill anything', async () => {
    const cap = makeFakeCap({});
    const ctx = makeCtx({ credential: null });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    assert.equal(cap.calls.some((c) => c[0] === 'fill'), false);
  });

  test('multi-step wizard: step 1 has no fields (click Next), step 2 has a REQUIRED unmatched question -> parks, never reaches submit', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.next]: { tagName: 'button', text: 'Next' },
        [SELECTORS.customFields]: (o) => (o.all
          ? [{ tagName: 'input', type: 'text', id: 'q1', name: 'q1', text: 'Why Dayforce?', value: null, required: true, options: null }]
          : []),
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'question');
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
  });

  test('a learned-tier auto-answer fills the field on its step and never parks', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.customFields]: [{ tagName: 'input', type: 'text', id: 'q1', name: 'q1', text: 'What is your work authorization status?', value: null, required: true, options: null }],
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
      },
    });
    const ctx = makeCtx({
      credential: { username: 'jordan@example.com', password: 'stored-pw' },
      match: () => ({ outcome: 'auto_answer', tier: 'learned', key: 'work_authorization', value: true, controlResult: { ok: true, text: 'Yes' } }),
    });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === '#q1' && c[2] === 'Yes'));
  });

  test('an unconfirmed resume upload refuses to proceed to submit', async () => {
    const cap = makeFakeCap({
      waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.stepProbe]: EL, [SELECTORS.resumeUpload]: { tagName: 'input', text: '' } },
      uploadResult: null,
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
  });

  test('a salary-shaped question parks (salary_floor unset) with no fill call carrying a number, before the generic bank matcher is even asked', async () => {
    let matchCalled = false;
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.customFields]: [{ tagName: 'input', type: 'text', id: 'salary', name: 'salary', text: 'Expected hourly rate', value: null, required: true, options: null }],
      },
    });
    const ctx = makeCtx({
      credential: { username: 'jordan@example.com', password: 'stored-pw' },
      match: () => { matchCalled = true; return { outcome: 'auto_answer', tier: 'learned', value: 999, controlResult: { ok: true, text: '999' } }; },
    });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'question');
    assert.equal(matchCalled, false, 'a salary-shaped label must route through resolveSalaryAnswer, never the generic bank matcher');
    assert.equal(cap.calls.some((c) => c[0] === 'fill' && /^\d+(\.\d+)?$/.test(String(c[2]))), false, 'no fill call may carry a bare number for an unresolved salary question');
  });

  test('a salary-shaped question with a configured salary_floor fills the resolved hourly figure (floor / 2080) and never parks', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.customFields]: [{ tagName: 'input', type: 'text', id: 'salary', name: 'salary', text: 'Desired hourly rate', value: null, required: true, options: null }],
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' }, salaryFloor: 150000 });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === '#salary' && c[2] === String(Math.round((150000 / 2080) * 100) / 100)));
  });

  test('wizard never reaches a submit step within MAX_STEPS -> needs_human, bounded (never an infinite loop)', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.next]: { tagName: 'button', text: 'Next' },
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    const stepProbeCount = cap.calls.filter((c) => c[0] === 'waitFor' && c[1] === SELECTORS.stepProbe).length;
    assert.equal(stepProbeCount, MAX_STEPS, `must probe exactly MAX_STEPS (${MAX_STEPS}) times, never more`);
  });

  test('submitted but no confirmation heading seen -> needs_human (post_submit_uncertain), after recording submit_request_sent', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.stepProbe]: EL, [SELECTORS.submit]: { tagName: 'button', text: 'Submit' } } });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await dayforce.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'post_submit_uncertain');
    assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'));
  });

  test('uploadHosts is empty (the tenant host itself already covers this ATS, per session.js route policy)', () => {
    assert.deepEqual(dayforce.uploadHosts, []);
  });

  test('requires declares a credential dependency', () => {
    assert.deepEqual(dayforce.requires, ['credential']);
  });
});
