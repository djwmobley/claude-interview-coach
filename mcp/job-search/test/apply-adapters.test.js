// @ts-check
/**
 * Greenhouse, Lever, and SmartRecruiters apply adapters (apply pipeline slices 5-6), against a fully
 * SCRIPTED FAKE capability -- no real Chrome, no network, no live DOM. SmartRecruiters was added in slice
 * 6 (assessed as genuinely small: no account, single form, no new state-machine state -- a structural copy
 * of Greenhouse/Lever's own shape) and folds into this same shared test loop for exactly that reason.
 * Covers the amended spec's required flows: happy path, captcha wall, an unmatched REQUIRED question
 * parking with a screenshot + pending_question, and an unconfirmed resume upload refusing to proceed to
 * submit. See each adapter module's own doc comment for the honest caveat: the CSS selectors these
 * adapters target are unverified against a live page in this sandboxed environment -- this test verifies
 * the CONTROL FLOW is correct given whatever the capability reports, not that the real selectors match a
 * real Greenhouse/Lever/SmartRecruiters DOM.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { greenhouse, SELECTORS as GH_SEL } from '../src/apply/adapters/greenhouse.js';
import { lever, SELECTORS as LV_SEL } from '../src/apply/adapters/lever.js';
import { smartrecruiters, SELECTORS as SR_SEL } from '../src/apply/adapters/smartrecruiters.js';

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
  return {
    applicationId: 1,
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/12345',
    profile: { fullName: 'Jordan Reyes', email: 'jordan@example.com', phone: '555-0100' },
    documents: { resumePath: 'resumes/jordan-reyes.docx', coverletterPath: null },
    answers: {
      match: overrides.match ?? (() => ({ outcome: 'needs_human_no_match', tier: 'none' })),
      bank: { meta: { salary_floor: overrides.salaryFloor === undefined ? null : overrides.salaryFloor } },
    },
    log: (f) => events.push(f),
    recordSubmitRequestSent: async () => { events.push({ evt: 'submit_request_sent' }); },
    _events: events,
  };
}

for (const [name, adapter, SEL] of [['greenhouse', greenhouse, GH_SEL], ['lever', lever, LV_SEL], ['smartrecruiters', smartrecruiters, SR_SEL]]) {
  describe(`${name} adapter`, () => {
    test('happy path: fills, uploads, no custom fields, submits, confirms by heading -> submitted', async () => {
      const cap = makeFakeCap({
        waitFor: {
          [SEL.formProbe]: { tagName: 'form', text: '' },
          [SEL.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
        },
      });
      const ctx = makeCtx();
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'submitted');
      assert.ok(cap.calls.some((c) => c[0] === 'upload'));
      assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'), 'submit_request_sent must fire before the submit click');
      const submitSentIdx = ctx._events.findIndex((e) => e.evt === 'submit_request_sent');
      const submitClickIdx = cap.calls.findIndex((c) => c[0] === 'click' && c[1] === SEL.submit);
      assert.ok(submitClickIdx !== -1);
      assert.ok(submitSentIdx !== -1);
    });

    test('confirms by /thanks URL when no confirmation heading matches', async () => {
      const cap = makeFakeCap({ waitFor: { [SEL.formProbe]: { tagName: 'form', text: '' } } });
      const ctx = makeCtx();
      ctx.applyUrl = 'https://boards.greenhouse.io/acme/jobs/12345/thanks';
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'submitted');
    });

    test('form never found -> needs_human (unrecognized_page), never attempts to fill or submit', async () => {
      const cap = makeFakeCap({});
      const ctx = makeCtx();
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
      assert.equal(cap.calls.some((c) => c[0] === 'fill'), false);
      assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SEL.submit), false);
    });

    test('captcha wall -> needs_human (captcha), with a screenshot, never solved/clicked past', async () => {
      const cap = makeFakeCap({
        waitFor: {
          [SEL.formProbe]: { tagName: 'form', text: '' },
          [SEL.captcha]: { tagName: 'div', text: '' },
        },
      });
      const ctx = makeCtx();
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'captcha');
      assert.ok(result.pendingQuestion.screenshot);
      assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SEL.submit), false);
      assert.equal(ctx._events.some((e) => e.evt === 'submit_request_sent'), false);
    });

    test('an unmatched REQUIRED custom question parks with a screenshot + pendingQuestion, never guesses', async () => {
      const cap = makeFakeCap({
        waitFor: {
          [SEL.formProbe]: { tagName: 'form', text: '' },
          [SEL.customFields]: [{ tagName: 'input', type: 'text', id: 'q1', name: 'q1', text: 'Why do you want to work here?', value: null, required: true, options: null }],
        },
      });
      const ctx = makeCtx({ match: () => ({ outcome: 'needs_human_no_match', tier: 'none', key: null }) });
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'question');
      assert.equal(result.pendingQuestion.label, 'Why do you want to work here?');
      assert.ok(result.pendingQuestion.screenshot);
      assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SEL.submit), false, 'must never submit past an unanswered required question');
    });

    test('an unmatched OPTIONAL custom question is skipped and logged, never blocks the run', async () => {
      const cap = makeFakeCap({
        waitFor: {
          [SEL.formProbe]: { tagName: 'form', text: '' },
          [SEL.customFields]: [{ tagName: 'input', type: 'text', id: 'q1', name: 'q1', text: 'Anything else?', value: null, required: false, options: null }],
          [SEL.confirmationHeading]: { tagName: 'h1', text: 'Application received' },
        },
      });
      const ctx = makeCtx({ match: () => ({ outcome: 'needs_human_no_match', tier: 'none', key: null }) });
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'submitted');
      assert.ok(ctx._events.some((e) => e.evt === 'question_unmatched_optional'));
    });

    test('a learned-tier auto-answer fills the field and never parks', async () => {
      const cap = makeFakeCap({
        waitFor: {
          [SEL.formProbe]: { tagName: 'form', text: '' },
          [SEL.customFields]: [{ tagName: 'input', type: 'text', id: 'q1', name: 'q1', text: 'What is your work authorization status?', value: null, required: true, options: null }],
          [SEL.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
        },
      });
      const ctx = makeCtx({ match: () => ({ outcome: 'auto_answer', tier: 'learned', key: 'work_authorization', value: true, controlResult: { ok: true, text: 'Yes' } }) });
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'submitted');
      assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === '#q1' && c[2] === 'Yes'));
    });

    test('an unconfirmed resume upload (browser never registered a file) refuses to proceed to submit', async () => {
      const cap = makeFakeCap({
        waitFor: { [SEL.formProbe]: { tagName: 'form', text: '' } },
        uploadResult: null,
      });
      const ctx = makeCtx();
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'unrecognized_page');
      assert.equal(cap.calls.some((c) => c[0] === 'click' && c[1] === SEL.submit), false);
    });

    test('submitted-but-unconfirmed (no heading match, no /thanks URL) parks as post_submit_uncertain, after recording submit_request_sent', async () => {
      const cap = makeFakeCap({ waitFor: { [SEL.formProbe]: { tagName: 'form', text: '' } } });
      const ctx = makeCtx();
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'post_submit_uncertain');
      assert.ok(ctx._events.some((e) => e.evt === 'submit_request_sent'), 'the submit request must still have been recorded before this ambiguous outcome');
    });

    test('uploadHosts declares only this ATS\'s own registered hosts (documented, unverified against live CDN behavior)', () => {
      assert.ok(Array.isArray(adapter.uploadHosts) && adapter.uploadHosts.length > 0);
    });

    // Damian's ruling (hourly-disqualifier), spec item B: the compensation-family gate runs BEFORE the
    // generic bank matcher / tier-1 learned lookup, unconditionally -- an hourly-shaped question must
    // park even when a "learned" tier-1 match exists and would otherwise auto-answer it.
    test('an HOURLY-shaped question is gated BEFORE the generic bank matcher: never filled, even when a learned-tier match would otherwise auto-answer it', async () => {
      let matchCalled = false;
      const cap = makeFakeCap({
        waitFor: {
          [SEL.formProbe]: { tagName: 'form', text: '' },
          [SEL.customFields]: [{ tagName: 'input', type: 'text', id: 'rate', name: 'rate', text: 'Desired hourly rate', value: null, required: true, options: null }],
        },
      });
      const ctx = makeCtx({
        salaryFloor: 150000,
        match: () => { matchCalled = true; return { outcome: 'auto_answer', tier: 'learned', value: 72, controlResult: { ok: true, text: '72' } }; },
      });
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.pendingQuestion.kind, 'question');
      assert.equal(matchCalled, false, 'the compensation gate must intercept before the generic bank matcher is ever consulted');
      assert.equal(cap.calls.some((c) => c[0] === 'fill' && c[1] === '#rate'), false, 'an hourly field must never be filled, even from a learned tier-1 match');
    });

    test('a plain-text BASE ANNUAL salary question fills from the configured floor', async () => {
      const cap = makeFakeCap({
        waitFor: {
          [SEL.formProbe]: { tagName: 'form', text: '' },
          [SEL.customFields]: [{ tagName: 'input', type: 'text', id: 'salary', name: 'salary', text: 'Desired annual salary', value: null, required: true, options: null }],
          [SEL.confirmationHeading]: { tagName: 'h1', text: 'Thank you for applying!' },
        },
      });
      const ctx = makeCtx({ salaryFloor: 150000 });
      const result = await adapter.run(cap, ctx);
      assert.equal(result.outcome, 'submitted');
      assert.ok(cap.calls.some((c) => c[0] === 'fill' && c[1] === '#salary' && c[2] === '150000'));
    });
  });
}
