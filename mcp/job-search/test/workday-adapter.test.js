// @ts-check
/**
 * Workday apply adapter (apply pipeline slice 6), against a fully SCRIPTED FAKE capability -- no real
 * Chrome, no network, no live DOM. Mirrors test/apply-adapters.test.js's fake-capability style (the
 * greenhouse/lever coverage from slice 5), extended for what is genuinely new here: per-tenant credential
 * read/write, self-registration (generate + write the password BEFORE any account-creation DOM call),
 * verify-email via a mocked ctx.gmailVerify, and (assisted Workday PR-2) a prepare() that stops at the
 * first wizard step: it never fills a wizard field, uploads, or clicks Next or Submit. See workday.js's own
 * doc comment for the honest caveat: the CSS/data-automation-id selectors this adapter targets are
 * unverified against a live *.myworkdayjobs.com tenant in this sandboxed environment -- this test verifies
 * the CONTROL FLOW is correct given whatever the capability reports, not that the real selectors match a
 * real Workday DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workday, SELECTORS } from '../src/apply/adapters/workday.js';

/** The adapter's two union probes, mapped to their member selectors for the fake capability. */
const UNIONS = {
  [SELECTORS.entryProbe]: [SELECTORS.authGate, SELECTORS.applyButton],
  [SELECTORS.postManualProbe]: [SELECTORS.authGate, SELECTORS.guestWizard],
};

/**
 * @param {{ waitFor?: Record<string, any> | ((cap: any) => Record<string, any>), uploadResult?: string|null }} responses
 */
function makeFakeCap(responses = {}) {
  /** @type {any[]} */
  const calls = [];
  const fake = {
    calls,
    async fill(sel, val) { calls.push(['fill', sel, val]); },
    async select(sel, val) { calls.push(['select', sel, val]); },
    async click(sel) { calls.push(['click', sel]); },
    async upload(sel, relPath) { calls.push(['upload', sel, relPath]); return 'uploadResult' in responses ? responses.uploadResult : 'resume.docx'; },
    async screenshot() { calls.push(['screenshot']); return { relPath: 'applications/1/shot.png', absPath: '/x/applications/1/shot.png' }; },
    async waitFor(sel, o = {}) {
      calls.push(['waitFor', sel, o]);
      // A factory form lets a scripted page react to earlier clicks recorded on this same fake.
      const table = typeof responses.waitFor === 'function' ? responses.waitFor(fake) : (responses.waitFor ?? {});
      // CSS-union probes resolve to the first scripted member that is present, like a real comma selector.
      const unionMembers = UNIONS[sel];
      if (unionMembers && table[sel] === undefined) {
        for (const member of unionMembers) {
          const e = table[member];
          const v = e === undefined ? null : (typeof e === 'function' ? e(o) : e);
          if (v) return v;
        }
        return null;
      }
      const entry = table[sel];
      if (entry === undefined) return o.all ? [] : null;
      return typeof entry === 'function' ? entry(o) : entry;
    },
  };
  return fake;
}

/**
 * @param {{ match?: Function, credential?: { username: string, password: string } | null, gmailVerify?: Function, sharedCalls?: any[], salaryFloor?: number|null }} overrides
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
    answers: {
      match: overrides.match ?? (() => ({ outcome: 'needs_human_no_match', tier: 'none' })),
      bank: { meta: { salary_floor: overrides.salaryFloor === undefined ? null : overrides.salaryFloor } },
    },
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
  test('existing credential: signs in and stops at the wizard -> ok (no field filled, nothing uploaded, nothing submitted)', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.wizardProbe]: EL,
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'ok');
    assert.deepEqual(ctx._credCalls, [['read']], 'an existing credential is never regenerated or rewritten');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === SELECTORS.signInEmail && c[2] === 'jordan@example.com'));
    assert.ok(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.signInSubmit));
  });

  test('existing credential rejected at sign-in -> needs_human (credential), target/username set for the dashboard prompt', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.authError]: { tagName: 'div', text: 'Invalid email or password' },
      },
    });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stale-pw' } });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'credential');
    assert.equal(result.pendingQuestion.target, 'ic-jobsearch/acme.wd5.myworkdayjobs.com');
    assert.equal(result.pendingQuestion.username, 'jordan@example.com');
    assert.equal(cap.calls.some((c) => c[0] === 'click' && /pageFooterNextButton|submit/i.test(c[1]) && c[1] !== SELECTORS.signInSubmit), false);
  });

  test('no stored credential: generates and WRITES the password before any account-creation DOM call', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.wizardProbe]: EL,
      },
    });
    const ctx = makeCtx({ credential: null, sharedCalls: cap.calls });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'ok');
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
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'credential');
    assert.equal(result.pendingQuestion.target, 'ic-jobsearch/acme.wd5.myworkdayjobs.com');
    assert.equal(ctx._credCalls.some((c) => c[0] === 'write'), true, 'the password is written before the create-account attempt regardless of outcome');
  });

  test('verify-email: a code arrives -> fills the code field and continues to the wizard -> ok', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' },
        [SELECTORS.wizardProbe]: EL,
      },
    });
    let calls = 0;
    const gmailVerify = async () => { calls += 1; return { ok: true, code: '583920', link: null }; };
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'ok');
    assert.equal(calls, 1, 'the first poll already had the code, no retry needed');
    assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === SELECTORS.verifyCodeInput && c[2] === '583920'));
    assert.ok(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.verifySubmit));
  });

  test('verify-email: code never arrives within the poll budget -> needs_human (email_verification), sleeps between attempts', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' } } });
    const gmailVerify = async () => ({ ok: true, code: null, link: null });
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'email_verification');
    assert.ok(ctx._sleeps.length >= 1, 'the adapter must wait between polls rather than busy-looping');
  });

  test('verify-email: Gmail auth unavailable -> needs_human (email_verification), never retried past the auth failure', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' } } });
    let calls = 0;
    const gmailVerify = async () => { calls += 1; return { ok: false, reason: 'gmail_auth_broken_no_refresh_token' }; };
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'email_verification');
    assert.match(result.pendingQuestion.label, /gmail_auth_broken_no_refresh_token/);
    assert.equal(calls, 1, 'an auth failure is not worth retrying -- it will not fix itself between polls');
  });

  test('verify-email: only a link is found (no code) -> needs_human (email_verification), never guesses a navigation', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.verifyCodeInput]: { tagName: 'input', text: '' } } });
    const gmailVerify = async () => ({ ok: true, code: null, link: 'https://acme.wd5.myworkdayjobs.com/verify?token=abc' });
    const ctx = makeCtx({ credential: null, gmailVerify });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'email_verification');
    assert.match(result.pendingQuestion.label, /link/);
  });

  test('no verify-code step shown after account creation -> proceeds straight to the application form (verification not required by this tenant)', async () => {
    const cap = makeFakeCap({
      waitFor: {
        [SELECTORS.authGate]: EL,
        [SELECTORS.wizardProbe]: EL,
      },
    });
    let gmailCalls = 0;
    const ctx = makeCtx({ credential: null, gmailVerify: async () => { gmailCalls += 1; return { ok: true, code: null, link: null }; } });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'ok');
    assert.equal(gmailCalls, 0, 'gmail is never polled when the tenant never presented a code-entry step');
  });

  test('auth gate never found -> needs_human (unrecognized_page), never attempts to fill anything', async () => {
    const cap = makeFakeCap({});
    const ctx = makeCtx({ credential: null });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
    assert.equal(cap.calls.some((c) => c[0] === 'fill'), false);
  });

  test('captcha at the auth gate -> needs_human (captcha), never solved, account creation never attempted', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.captcha]: { tagName: 'div', text: '' } } });
    const ctx = makeCtx({ credential: null });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.pendingQuestion.kind, 'captcha');
    assert.equal(ctx._credCalls.some((c) => c[0] === 'write'), false, 'never generates/writes a password before even knowing there is no captcha wall');
  });

  describe('entering the apply flow from the job-description page', () => {
    /**
     * A job-description page: the Apply button is present until clicked, the Apply Manually option appears
     * only after Apply is clicked, and the auth gate (or guest wizard) appears only after Apply Manually.
     * @param {any} cap
     * @param {{ manualOption?: boolean, after?: 'auth'|'guest'|'nothing' }} o
     */
    function jobPage(cap, o = {}) {
      const clicked = (sel) => cap.calls.some((c) => c[0] === 'click' && c[1] === sel);
      return {
        [SELECTORS.applyButton]: () => (clicked(SELECTORS.applyButton) ? null : { tagName: 'a', text: 'Apply' }),
        [SELECTORS.applyManually]: () => (o.manualOption !== false && clicked(SELECTORS.applyButton) ? { tagName: 'a', text: 'Apply Manually' } : null),
        [SELECTORS.authGate]: () => ((o.after ?? 'auth') === 'auth' && clicked(SELECTORS.applyManually) ? EL : null),
        [SELECTORS.guestWizard]: () => (o.after === 'guest' && clicked(SELECTORS.applyManually) ? EL : null),
      };
    }

    test('already on the auth gate: never clicks Apply or Apply Manually', async () => {
      const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.authError]: { tagName: 'div', text: 'Invalid' } } });
      const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'pw' } });
      const result = await workday.prepare(cap, ctx);
      assert.equal(result.pendingQuestion.kind, 'credential', 'reached authenticate()');
      assert.equal(cap.calls.some((c) => c[0] === 'click' && (c[1] === SELECTORS.applyButton || c[1] === SELECTORS.applyManually)), false);
    });

    test('Apply, then Apply Manually, then the auth gate: proceeds to account creation in that order', async () => {
      const shared = makeFakeCap({
        waitFor: (c) => ({
          ...jobPage(c),
          [SELECTORS.wizardProbe]: EL,
        }),
      });
      const ctx = makeCtx({ credential: null, sharedCalls: shared.calls });
      const result = await workday.prepare(shared, ctx);
      assert.equal(result.outcome, 'ok');
      const applyIdx = shared.calls.findIndex((c) => c[0] === 'click' && c[1] === SELECTORS.applyButton);
      const manualIdx = shared.calls.findIndex((c) => c[0] === 'click' && c[1] === SELECTORS.applyManually);
      const writeIdx = shared.calls.findIndex((c) => c[0] === 'write');
      const createIdx = shared.calls.findIndex((c) => c[0] === 'fill' && c[1] === SELECTORS.createEmail);
      assert.ok(applyIdx >= 0 && applyIdx < manualIdx, 'Apply is clicked before Apply Manually');
      assert.ok(manualIdx < writeIdx && writeIdx < createIdx, 'the credential write and account creation happen only after Apply Manually');
      assert.equal(shared.calls.some((c) => c[0] === 'click' && /autofillWithResume|useMyLastApplication|applyWithLinkedIn/.test(c[1])), false);
    });

    test('Apply button not found -> needs_human (unrecognized_page) naming that step, nothing clicked or filled', async () => {
      const cap = makeFakeCap({});
      const result = await workday.prepare(cap, makeCtx({ credential: null }));
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
      assert.match(result.pendingQuestion.label, /Apply button not found/);
      assert.equal(cap.calls.some((c) => c[0] === 'click' || c[0] === 'fill'), false);
    });

    test('Apply Manually option not found -> needs_human (unrecognized_page) naming that step, no credential written', async () => {
      const cap = makeFakeCap({ waitFor: (c) => jobPage(c, { manualOption: false }) });
      const calls = cap.calls;
      const ctx = makeCtx({ credential: null, sharedCalls: calls });
      const result = await workday.prepare(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
      assert.match(result.pendingQuestion.label, /Apply Manually option not found/);
      assert.ok(calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.applyButton));
      assert.equal(calls.some((c) => c[0] === 'write' || c[0] === 'fill'), false);
    });

    test('auth form not found after Apply Manually -> needs_human (unrecognized_page) naming that step, no credential written', async () => {
      const cap = makeFakeCap({ waitFor: (c) => jobPage(c, { after: 'nothing' }) });
      const calls = cap.calls;
      const ctx = makeCtx({ credential: null, sharedCalls: calls });
      const result = await workday.prepare(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
      assert.match(result.pendingQuestion.label, /auth form not found after Apply Manually/);
      assert.ok(calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.applyManually));
      assert.equal(calls.some((c) => c[0] === 'write' || c[0] === 'fill'), false);
    });

    test('Apply Manually lands directly on a guest wizard (no auth gate on this tenant): skips authentication, never reads or writes a credential', async () => {
      const cap = makeFakeCap({
        waitFor: (c) => ({
          ...jobPage(c, { after: 'guest' }),
          [SELECTORS.wizardProbe]: EL,
        }),
      });
      const calls = cap.calls;
      const ctx = makeCtx({ credential: null, sharedCalls: calls });
      const result = await workday.prepare(cap, ctx);
      assert.equal(result.outcome, 'ok');
      assert.equal(calls.some((c) => c[0] === 'read' || c[0] === 'write'), false, 'a guest flow never touches Credential Manager');
      assert.equal(calls.some((c) => c[0] === 'fill' && c[1] === SELECTORS.createEmail), false);
    });
  });

  test('selector contract includes the ids observed on live tenants (2026-10-05 read-only probe)', () => {
    assert.match(SELECTORS.applyButton, /adventureButton/);
    assert.match(SELECTORS.applyManually, /applyManually/);
    assert.match(SELECTORS.authGate, /signInContent/);
    assert.match(SELECTORS.authGate, /signInFormo/);
    assert.match(SELECTORS.guestWizard, /applyFlowMyInfoPage/);
    // The live create-account button is aria-hidden behind a click_filter overlay; the overlay takes the click.
    assert.match(SELECTORS.createAccountSubmit, /click_filter/);
    // applyFlowPage also renders on the auth gate page itself, so it must never count as a guest wizard.
    assert.doesNotMatch(SELECTORS.guestWizard, /applyFlowPage"/);
  });

  describe('stored-credential sign-in when the gate opens on Create Account (live att.wd1 default)', () => {
    test('clicks the Sign In link first, then fills and submits the Sign In form; never writes a credential', async () => {
      const cap = makeFakeCap({
        waitFor: (c) => {
          const toggled = c.calls.some((x) => x[0] === 'click' && x[1] === SELECTORS.signInToggle);
          return {
            [SELECTORS.authGate]: EL,
            [SELECTORS.signInToggle]: toggled ? null : { tagName: 'button', text: 'Sign In' },
            [SELECTORS.signInFormReady]: toggled ? { tagName: 'button', text: 'Sign In' } : null,
            [SELECTORS.authError]: { tagName: 'div', text: 'stop here' },
          };
        },
      });
      const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' }, sharedCalls: [] });
      await workday.prepare(cap, ctx);
      const toggleIdx = cap.calls.findIndex((c) => c[0] === 'click' && c[1] === SELECTORS.signInToggle);
      const emailIdx = cap.calls.findIndex((c) => c[0] === 'fill' && c[1] === SELECTORS.signInEmail);
      const submitIdx = cap.calls.findIndex((c) => c[0] === 'click' && c[1] === SELECTORS.signInSubmit);
      assert.ok(toggleIdx >= 0 && toggleIdx < emailIdx && emailIdx < submitIdx, 'Sign In link, then email fill, then Sign In submit');
      assert.equal(ctx._credCalls.some((c) => c[0] === 'write'), false);
      assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.createAccountSubmit), false);
    });

    test('Sign In form never appears after clicking the Sign In link -> needs_human (unrecognized_page), nothing filled', async () => {
      const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.signInToggle]: { tagName: 'button', text: 'Sign In' } } });
      const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
      const result = await workday.prepare(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
      assert.match(result.pendingQuestion.label, /Sign In form not found/);
      assert.equal(cap.calls.some((c) => c[0] === 'fill'), false);
    });

    test('no stored credential: the Sign In link is never clicked (account creation stays on the Create Account panel)', async () => {
      const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.signInToggle]: { tagName: 'button', text: 'Sign In' }, [SELECTORS.authError]: { tagName: 'div', text: 'x' } } });
      await workday.prepare(cap, makeCtx({ credential: null }));
      assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SELECTORS.signInToggle), false);
    });
  });

  test('selector contract includes the live wizard and Sign In ids (2026-10-05 read-only probe)', () => {
    assert.match(SELECTORS.wizardProbe, /applyFlowMyInfoPage/);
    assert.match(SELECTORS.wizardProbe, /pageFooterNextButton/);
    assert.doesNotMatch(SELECTORS.wizardProbe, /applyFlowPage"/, 'applyFlowPage also wraps the auth gate');
    assert.match(SELECTORS.signInToggle, /signInLink/);
    assert.match(SELECTORS.signInFormReady, /signInSubmitButton/);
    assert.match(SELECTORS.signInSubmit, /click_filter/);
  });

  test('uploadHosts is empty (the tenant host itself already covers this ATS, per session.js route policy)', () => {
    assert.deepEqual(workday.uploadHosts, []);
  });

  test('requires declares a credential dependency', () => {
    assert.deepEqual(workday.requires, ['credential']);
  });
});

describe('workday prepare stops at the wizard (assisted Workday PR-2, spec v1 clause 6, v2 A15)', () => {
  test('signed in, wizard present: the only fills are the sign-in fields, and nothing past sign-in is clicked', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL, [SELECTORS.wizardProbe]: EL } });
    const ctx = makeCtx({ credential: { username: 'jordan@example.com', password: 'stored-pw' } });
    const result = await workday.prepare(cap, ctx);
    assert.equal(result.outcome, 'ok');
    const fills = cap.calls.filter((c) => c[0] === 'fill').map((c) => c[1]);
    assert.deepEqual(fills, [SELECTORS.signInEmail, SELECTORS.signInPassword]);
    const clicks = cap.calls.filter((c) => c[0] === 'click').map((c) => c[1]);
    assert.deepEqual(clicks, [SELECTORS.signInSubmit]);
    assert.equal(cap.calls.some((c) => c[0] === 'upload' || c[0] === 'select'), false);
  });

  test('wizard never appears after sign-in -> needs_human (unrecognized_page)', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL } });
    const result = await workday.prepare(cap, makeCtx({ credential: { username: 'jordan@example.com', password: 'pw' } }));
    assert.equal(result.outcome, 'needs_human');
    assert.equal(/** @type {any} */ (result).pendingQuestion.kind, 'unrecognized_page');
  });

  test('a captcha on the wizard -> needs_human (captcha)', async () => {
    const cap = makeFakeCap({ waitFor: (c) => ({ [SELECTORS.authGate]: EL, [SELECTORS.wizardProbe]: EL, [SELECTORS.captcha]: c.calls.some((x) => x[0] === 'click') ? { tagName: 'div', text: '' } : null }) });
    const result = await workday.prepare(cap, makeCtx({ credential: { username: 'jordan@example.com', password: 'pw' } }));
    assert.equal(/** @type {any} */ (result).pendingQuestion.kind, 'captcha');
  });

  test('run() is the unreachable unattended entry: it parks and touches nothing', async () => {
    const cap = makeFakeCap({ waitFor: { [SELECTORS.authGate]: EL } });
    const result = await workday.run(cap, makeCtx());
    assert.equal(result.outcome, 'needs_human');
    assert.deepEqual(cap.calls, []);
    assert.equal(workday.assisted, true);
  });
});
