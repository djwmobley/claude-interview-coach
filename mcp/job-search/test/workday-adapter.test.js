// @ts-check
/**
 * Workday apply adapter (apply pipeline slice 6), against a fully SCRIPTED FAKE capability -- no real
 * Chrome, no network, no live DOM. Mirrors test/apply-adapters.test.js's fake-capability style (the
 * greenhouse/lever coverage from slice 5), extended for what is genuinely new here: per-tenant credential
 * read/write, self-registration (generate + write the password BEFORE any account-creation DOM call),
 * verify-email via a mocked ctx.gmailVerify, and a bounded multi-step wizard loop. See workday.js's own
 * doc comment for the honest caveat: the CSS/data-automation-id selectors this adapter targets are
 * unverified against a live *.myworkdayjobs.com tenant in this sandboxed environment -- this test verifies
 * the CONTROL FLOW is correct given whatever the capability reports, not that the real selectors match a
 * real Workday DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workday, SELECTORS, MAX_STEPS } from '../src/apply/adapters/workday.js';

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
 * @param {{ match?: Function, credential?: { username: string, password: string } | null, gmailVerify?: Function, sharedCalls?: any[] }} overrides
 */
function makeCtx(overrides = {}) {
  /** @type {any[]} */
  const events = [];
  // credCalls doubles as `sharedCalls` when the caller passes cap.calls in, so a test can assert real
  // ordering between a credential read/write and a capability DOM call on ONE combined timeline.
  const credCalls = overrides.sharedCalls ?? [];
  const sleeps = [];
  return {
    applicationId: 1,
    applyUrl: 'https://acme.wd5.myworkdayjobs.com/careers/job/12345',
    tenantHost: 'acme.wd5.myworkdayjobs.com',
    profile: { fullName: 'Jordan Reyes', email: 'jordan@example.com', phone: '555-0100' },
    documents: { resumePath: 'resumes/jordan-reyes.docx', coverletterPath: null },
    answers: { match: overrides.match ?? (() => ({ outcome: 'needs_human_no_match', tier: 'none' })) },
    log: (f) => events.push(f),
    recordSubmitRequestSent: async () => { events.push({ evt: 'submit_request_sent' }); },
    credentials: {
      target: 'ic-jobsearch/acme.wd5.myworkdayjobs.com',
      read: async () => { credCalls.push(['read']); return overrides.credential === undefined ? null : overrides.credential; },
      write: async (username, password) => { credCalls.push(['write', username, password]); },
      generatePassword: () => 'zz-generated-24-char-password-x',
    },
    gmailVerify: overrides.gmailVerify ?? (async () => ({ ok: true, code: null, link: null })),
    sleep: async (ms) => { sleeps.push(ms); },
    _events: events,
    _credCalls: credCalls,
    _sleeps: sleeps,
  };
}

/** A stepInfo/gate probe result shape (mirrors ApplyCapability.waitFor's ElementInfo). */
const EL = { tagName: 'div', text: '' };

describe('workday adapter', () => {
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
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.deepEqual(ctx._credCalls, [['read']], 'an existing credential is never regenerated or rewritten');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === SELECTORS.signInEmail && c[2] === 'jordan@example.com'));
    assert.ok(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.signInSubmit));
    assert.ok(cap.calls.some((c) => c[0] === 'upload'));
    assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'));
  });

  test('existing credential rejected at sign-in -> needs_human (credential), target/username set for the dashboard prompt', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.authError]: { tagName: 'div', text: 'Invalid email or password' },
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stale-pw' } });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'credential');
    assert.equal(result.pendingQuestion.target, 'ic-jobsearch/acme.wd5.myworkdayjobs.com');
    assert.equal(result.pendingQuestion.username, 'jordan@example.com');
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
  });

  test('no stored credential: generates and WRITES the password before any account-creation DOM call', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Application received' },
      },
    });
    const ctx = makeCtx({ credential: null, sharedCalls: cap.calls });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    const readIdx = cap.calls.findIndex((c) => c[0] === 'read');
    const writeIdx = cap.calls.findIndex((c) => c[0] === 'write');
    const firstCreateFillIdx = cap.calls.findIndex((c) => c[0] === 'fill' && c[1] === SELECTORS.createEmail);
    assert.ok(readIdx >= 0 && writeIdx >= 0 && firstCreateFillIdx >= 0);
    assert.ok(readIdx < writeIdx, 'the credential is read before it is (re-)generated');
    assert.ok(writeIdx < firstCreateFillIdx, 'the write must happen strictly before the first create-account DOM fill -- crash-safety: a crash mid-creation must never lose the password');
    const writeCall = cap.calls[writeIdx];
    assert.equal(writeCall[1], 'jordan@example.com');
    assert.equal(writeCall[2], 'zz-generated-24-char-password-x');
  });

  test('account creation rejected -> needs_human (credential), the already-written credential target/username still surfaced', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.authError]: { tagName: 'div', text: 'An account with this email already exists' },
      },
    });
    const ctx = makeCtx({ credential: null });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'credential');
    assert.equal(result.pendingQuestion.target, 'ic-jobsearch/acme.wd5.myworkdayjobs.com');
    assert.equal(ctx._credCalls.some((c) => c[0] === 'write'), true, 'the password is written before the create-account attempt regardless of outcome');
  });

  test('verify-email: a code arrives -> fills the code field and continues to the application form -> submitted', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' },
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
      },
    });
    let calls = 0;
    const gmailVerify = async () => { calls += 1; return { ok: true, code: '583920', link: null }; };
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.equal(calls, 1, 'the first poll already had the code, no retry needed');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === SELECTORS.verifyCodeInput && c[2] === '583920'));
    assert.ok(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.verifySubmit));
  });

  test('verify-email: code never arrives within the poll budget -> needs_human (email_verification), sleeps between attempts', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' } } });
    const gmailVerify = async () => ({ ok: true, code: null, link: null });
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'email_verification');
    assert.ok(ctx._sleeps.length >= 1, 'the adapter must wait between polls rather than busy-looping');
  });

  test('verify-email: Gmail auth unavailable -> needs_human (email_verification), never retried past the auth failure', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' } } });
    let calls = 0;
    const gmailVerify = async () => { calls += 1; return { ok: false, reason: 'gmail_auth_broken_no_refresh_token' }; };
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'email_verification');
    assert.match(result.pendingQuestion.label, /gmail_auth_broken_no_refresh_token/);
    assert.equal(calls, 1, 'an auth failure is not worth retrying -- it will not fix itself between polls');
  });

  test('verify-email: only a link is found (no code) -> needs_human (email_verification), never guesses a navigation', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' } } });
    const gmailVerify = async () => ({ ok: true, code: null, link: 'https://acme.wd5.myworkdayjobs.com/verify?token=abc' });
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'email_verification');
    assert.match(result.pendingQuestion.label, /link/);
  });

  test('no verify-code step shown after account creation -> proceeds straight to the application form (verification not required by this tenant)', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: EL,
        [SELECTORS.submit]: { tagName: 'button', text: 'Submit' },
        [SELECTORS.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
      },
    });
    let gmailCalls = 0;
    const ctx = makeCtx({ credential: null, gmailVerify: async () => { gmailCalls += 1; return { ok: true, code: null, link: null }; } });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.equal(gmailCalls, 0, 'gmail is never polled when the tenant never presented a code-entry step');
  });

  test('auth gate never found -> needs_human (unrecognized_page), never attempts to fill anything', async () => {
    const cap = makeFakeCap({});
    const ctx = makeCtx({ credential: null });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    assert.equal(cap.calls.some((c) => c[0] === 'fill'), false);
  });

  test('captcha at the auth gate -> needs_human (captcha), never solved, account creation never attempted', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.captcha]: { tagName: 'div', text: '' } } });
    const ctx = makeCtx({ credential: null });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'captcha');
    assert.equal(ctx._credCalls.some((c) => c[0] === 'write'), false, 'never generates/writes a password before even knowing there is no captcha wall');
  });

  test('multi-step wizard: step 1 has no fields (click Next), step 2 has a REQUIRED unmatched question -> parks, never reaches submit', async () => {
    let stepCall = 0;
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.stepProbe]: (() => { stepCall += 1; return EL; })(),
        [SELECTORS.next]: { tagName: 'button', text: 'Next' },
        [SELECTORS.customFields]: (o) => (o.all
          ? [{ tagName: 'input', type: 'text', id: 'q1', name: 'q1', text: 'Why Workday?', value: null, required: true, options: null }]
          : []),
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await workday.run(cap, ctx);
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
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'submitted');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === '#q1' && c[2] === 'Yes'));
  });

  test('an unconfirmed resume upload refuses to proceed to submit', async () => {
    const cap = makeFakeCap({
      waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.stepProbe]: EL, [SELECTORS.resumeUpload]: { tagName: 'input', text: '' } },
      uploadResult: null,
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.submit), false);
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
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    const stepProbeCount = cap.calls.filter((c) => c[0] === 'waitFor' && c[1] === SELECTORS.stepProbe).length;
    assert.equal(stepProbeCount, MAX_STEPS, `must probe exactly MAX_STEPS (${MAX_STEPS}) times, never more`);
  });

  test('submitted but no confirmation heading seen -> needs_human (post_submit_uncertain), after recording submit_request_sent', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.stepProbe]: EL, [SELECTORS.submit]: { tagName: 'button', text: 'Submit' } } });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await workday.run(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'post_submit_uncertain');
    assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'));
  });

  test('uploadHosts is empty (the tenant host itself already covers this ATS, per session.js route policy)', () => {
    assert.deepEqual(workday.uploadHosts, []);
  });

  test('requires declares a credential dependency', () => {
    assert.deepEqual(workday.requires, ['credential']);
  });
});
