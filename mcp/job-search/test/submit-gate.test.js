// @ts-check
/**
 * src/apply/submit-gate.js (unattended submit spec items 1-3, v2 C1, C4-C6, C10): the pure decision tables.
 * classifyPreSubmit's every branch (hard before soft, unknown input parks), the post-fill audits (required
 * signals, drift, sources, placeholders, sensitive fields, consent and signature fields), the review checks
 * (single form: exactly one submit control; Workday: classifyStep review, resume item, consent, signature,
 * exactly one Submit control), and the confirmation classifier's adversarial cases (a pre-existing thank-you
 * heading, a stale thanks URL, an iframe-only confirmation, a toast then an error, a substring thanks URL).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPreSubmit, unattendedSubmitConfig, auditForm, auditReview, reviewSingleForm, reviewWorkday, thanksUrlMatches,
  confirmationSignal, classifyConfirmation, sourceAllowed, isPlaceholder, PRE_SUBMIT_REASONS, UNATTENDED_ATS,
} from '../src/apply/submit-gate.js';

const CONFIG_ON = {
  enabled: true,
  ats: { greenhouse: true, lever: true, smartrecruiters: true, icims: true, dayforce: true, workday: true },
  dailySubmitCap: 5, atsAllow: ['greenhouse', 'lever', 'smartrecruiters', 'icims', 'dayforce', 'workday'], workdaySubmitMode: 'unattended',
};

/** @param {Record<string, any>} [patch] */
function okState(patch = {}) {
  return {
    ats: 'greenhouse', config: CONFIG_ON, markerEver: false, exclusion: { branch: 'eligible' },
    resume: { expected: 'abc', actual: 'abc' }, prefilledUnledgered: [], review: { ok: true }, audit: { ok: true, problems: [] },
    count: { used: 0, cap: 5 }, ...patch,
  };
}

describe('classifyPreSubmit', () => {
  test('every check holding submits', () => {
    assert.deepEqual(classifyPreSubmit(okState()), { action: 'submit' });
    assert.deepEqual(classifyPreSubmit(okState({ ats: 'workday' })), { action: 'submit' });
  });

  test('unrecognized input parks (null, non-object, missing parts, unknown ATS, a non-integer count)', () => {
    for (const s of [null, undefined, 'x', 42]) assert.equal(classifyPreSubmit(/** @type {any} */ (s)).action, 'park');
    assert.equal(/** @type {any} */ (classifyPreSubmit(/** @type {any} */ ({ ats: 'greenhouse' }))).reason, 'unrecognized_state');
    assert.equal(/** @type {any} */ (classifyPreSubmit(okState({ ats: 'linkedin_easy' }))).reason, 'ats_disabled');
    assert.equal(/** @type {any} */ (classifyPreSubmit(okState({ ats: 'indeed_easy' }))).reason, 'ats_disabled');
    assert.equal(/** @type {any} */ (classifyPreSubmit(okState({ count: { used: '0', cap: 5 } }))).reason, 'unrecognized_state');
  });

  /** @type {Array<[string, Record<string, any>, string]>} */
  const cases = [
    ['marker from an earlier attempt', { markerEver: true }, 'marker_exists'],
    ['marker unknown', { markerEver: undefined }, 'marker_exists'],
    ['excluded company at click time', { exclusion: { branch: 'blocked_company', reason: 'blocked' } }, 'exclusion'],
    ['duplicate on the same listing', { exclusion: { branch: 'already_applied_listing' } }, 'exclusion'],
    ['same company, similar title', { exclusion: { branch: 'already_applied_history' } }, 'exclusion'],
    ['exclusion check failed', { exclusion: { branch: 'check_failed' } }, 'exclusion'],
    ['no approved hash', { resume: { expected: null, actual: null } }, 'resume_hash_missing'],
    ['hash drift', { resume: { expected: 'abc', actual: 'def' } }, 'resume_hash_mismatch'],
    ['review page unrecognized', { review: { ok: false, reason: 'step_form' } }, 'review_unverified'],
    ['missing required answer', { audit: { ok: false, problems: ['required_empty:Why us'] } }, 'audit_failed'],
    ['audit ok but problems listed', { audit: { ok: true, problems: ['x'] } }, 'audit_failed'],
    ['kill switch off', { config: { ...CONFIG_ON, enabled: false } }, 'kill_switch'],
    ['ATS switched off', { config: { ...CONFIG_ON, ats: { ...CONFIG_ON.ats, greenhouse: false } } }, 'ats_disabled'],
    ['ATS not in atsAllow', { config: { ...CONFIG_ON, atsAllow: ['lever'] } }, 'ats_not_allowed'],
    ['cap exhausted', { count: { used: 5, cap: 5 } }, 'cap_exhausted'],
    ['cap invalid', { count: { used: 0, cap: 0 } }, 'cap_invalid'],
  ];
  for (const [name, patch, reason] of cases) {
    test(`parks: ${name} -> ${reason}`, () => {
      const v = /** @type {any} */ (classifyPreSubmit(okState(patch)));
      assert.equal(v.action, 'park');
      assert.equal(v.reason, reason);
      assert.equal(v.soft, PRE_SUBMIT_REASONS[reason].soft);
    });
  }

  test('Workday: prefilled unledgered answers park, and submitMode assisted is a soft park', () => {
    assert.equal(/** @type {any} */ (classifyPreSubmit(okState({ ats: 'workday', prefilledUnledgered: ['Phone Extension'] }))).reason, 'prefilled_unledgered');
    assert.equal(/** @type {any} */ (classifyPreSubmit(okState({ ats: 'workday', prefilledUnledgered: null }))).reason, 'prefilled_unledgered');
    const v = /** @type {any} */ (classifyPreSubmit(okState({ ats: 'workday', config: { ...CONFIG_ON, workdaySubmitMode: 'assisted' } })));
    assert.equal(v.reason, 'submit_mode_assisted');
    assert.equal(v.soft, true);
  });

  test('hard reasons win over soft ones (a kill switch never hides an exclusion)', () => {
    const v = /** @type {any} */ (classifyPreSubmit(okState({ config: { ...CONFIG_ON, enabled: false }, exclusion: { branch: 'blocked_company' } })));
    assert.equal(v.reason, 'exclusion');
    assert.equal(v.soft, false);
  });

  test('unattendedSubmitConfig: a missing or malformed block is off', () => {
    assert.equal(unattendedSubmitConfig(null).enabled, false);
    assert.equal(unattendedSubmitConfig({ autoApply: {} }).enabled, false);
    const c = unattendedSubmitConfig({ autoApply: { unattendedSubmit: { enabled: 'yes', ats: { greenhouse: 1 } } } });
    assert.equal(c.enabled, false);
    assert.equal(c.ats.greenhouse, false);
    assert.deepEqual(Object.keys(c.ats).sort(), [...UNATTENDED_ATS].sort());
  });
});

/** @param {Record<string, any>} f */
function field(f) {
  return {
    idx: 0, tag: 'input', type: 'text', id: '', name: '', label: '', required: false, ariaRequired: null, asterisk: false, optionalMarker: false,
    value: '', checked: false, selectedText: '', fileName: '', visible: true, disabled: false, automationId: '', ...f,
  };
}

describe('auditForm', () => {
  const base = { scopeFound: true, errors: [] };
  test('a filled, ledgered required field passes', () => {
    const snap = { ...base, fields: [field({ idx: 0, name: 'email', label: 'Email *', required: true, value: 'a@b.co' })], probes: { email: { found: true, fieldIdx: 0, value: 'a@b.co' } } };
    const r = auditForm(snap, [{ key: 'email', label: 'Email', value: 'a@b.co', source: 'contact', controlType: 'text' }]);
    assert.deepEqual(r, { ok: true, problems: [] });
  });

  test('a required empty field, a drifted value, a placeholder, and a disallowed source all park', () => {
    const snap = {
      ...base,
      fields: [
        field({ idx: 0, name: 'why', label: 'Why us *', required: true }),
        field({ idx: 1, name: 'email', label: 'Email', required: true, value: 'changed@x.co' }),
        field({ idx: 2, name: 'city', label: 'City', required: true, value: 'N/A' }),
      ],
      probes: { email: { found: true, fieldIdx: 1, value: 'changed@x.co' }, city: { found: true, fieldIdx: 2, value: 'N/A' } },
    };
    const r = auditForm(snap, [
      { key: 'email', label: 'Email', value: 'a@b.co', source: 'contact', controlType: 'text' },
      { key: 'city', label: 'City', value: 'N/A', source: 'guess', controlType: 'text' },
    ]);
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('required_empty:Why us *'));
    assert.ok(r.problems.includes('fill_drift:Email'));
    assert.ok(r.problems.includes('placeholder_value:City'));
    assert.ok(r.problems.includes('source_not_allowed:City'));
  });

  test('an unlabeled required field and an id-less required field are never counted as answered (D3)', () => {
    const snap = { ...base, fields: [field({ idx: 0, label: '', required: true }), field({ idx: 1, name: 'q2', label: 'Years of experience', ariaRequired: 'true', value: '' })], probes: {} };
    const r = auditForm(snap, []);
    assert.equal(r.ok, false);
    assert.equal(r.problems.filter((p) => p.startsWith('required_empty')).length, 2);
  });

  test('a prefilled required value nobody ledgered parks (required_unledgered)', () => {
    const snap = { ...base, fields: [field({ idx: 0, tag: 'select', type: 'select', name: 'country', label: 'Country *', required: true, value: 'US', selectedText: 'United States' })], probes: {} };
    assert.ok(auditForm(snap, []).problems.includes('required_unledgered:Country *'));
  });

  test('C5: a visible empty input with no required signal anywhere on the form parks; a form that marks required fields makes unmarked ones optional', () => {
    const noSignal = { ...base, fields: [field({ idx: 0, name: 'linkedin', label: 'LinkedIn profile' })], probes: {} };
    assert.ok(auditForm(noSignal, []).problems.includes('required_signal_missing:LinkedIn profile'));
    const convention = { ...base, fields: [field({ idx: 0, name: 'linkedin', label: 'LinkedIn profile' }), field({ idx: 1, name: 'email', label: 'Email *', asterisk: true, value: 'a@b.co' })], probes: { email: { found: true, fieldIdx: 1, value: 'a@b.co' } } };
    assert.deepEqual(auditForm(convention, [{ key: 'email', label: 'Email', value: 'a@b.co', source: 'contact', controlType: 'text' }]).problems, []);
    const explicitOptional = { ...base, fields: [field({ idx: 0, name: 'web', label: 'Website (optional)', optionalMarker: true })], probes: {} };
    assert.deepEqual(auditForm(explicitOptional, []).problems, []);
  });

  test('a consent checkbox left unchecked, a signature field, and a visible validation error park', () => {
    const snap = {
      scopeFound: true, errors: ['This field is required'],
      fields: [field({ idx: 0, type: 'checkbox', name: 'consent', label: 'I agree to the privacy policy' }), field({ idx: 1, name: 'sig', label: 'Signature', value: '' })], probes: {},
    };
    const r = auditForm(snap, []);
    assert.ok(r.problems.includes('validation_error_visible'));
    assert.ok(r.problems.includes('consent_unchecked:I agree to the privacy policy'));
    assert.ok(r.problems.some((p) => p.startsWith('signature_field')));
  });

  test('a radio group counts as filled and ledgered when any member is', () => {
    const snap = {
      ...base,
      fields: [field({ idx: 0, type: 'radio', name: 'auth', label: 'Authorized? Yes', required: true, checked: true }), field({ idx: 1, type: 'radio', name: 'auth', label: 'Authorized? No', required: true })],
      probes: { q1: { found: true, fieldIdx: 0, checked: true } },
    };
    assert.deepEqual(auditForm(snap, [{ key: 'q1', label: 'Are you authorized to work?', value: 'checked', source: 'learned', bankKey: 'work_auth', controlType: 'check' }]).problems, []);
  });

  test('an unreadable snapshot parks', () => {
    assert.equal(auditForm(null, []).ok, false);
    assert.equal(auditForm({ fields: 'x' }, []).ok, false);
  });
});

describe('sources and placeholders (C10)', () => {
  test('sensitive labels need the learned tier, a recorded ranked fallback, or (pay only) the salary floor', () => {
    assert.equal(sourceAllowed({ source: 'contact' }, 'Are you authorized to work in the US?'), false);
    assert.equal(sourceAllowed({ source: 'learned' }, 'Are you authorized to work in the US?'), true);
    assert.equal(sourceAllowed({ source: 'contact', fallback_used: true, bank_key: 'work_auth' }, 'Will you require sponsorship?'), true);
    assert.equal(sourceAllowed({ source: 'contact', fallback_used: true }, 'Will you require sponsorship?'), false);
    assert.equal(sourceAllowed({ source: 'salary_floor' }, 'Desired salary'), true);
    assert.equal(sourceAllowed({ source: 'salary_floor' }, 'Veteran status'), false);
    assert.equal(sourceAllowed({ source: 'default' }, 'Gender'), false);
    assert.equal(sourceAllowed({ source: 'account_email' }, 'Email'), true);
    assert.equal(sourceAllowed({ source: 'contact', controlType: 'file' }, 'Resume'), false);
    assert.equal(sourceAllowed({ source: 'document', controlType: 'file' }, 'Resume'), true);
  });
  test('placeholder values never count; 0 only for a pay field', () => {
    for (const v of ['', 'N/A', 'tbd', '-', 'none', 'Select one', ' NA ']) assert.equal(isPlaceholder(v, 'City'), true, v);
    assert.equal(isPlaceholder('0', 'Desired salary'), true);
    assert.equal(isPlaceholder('0', 'Years of experience'), false);
    assert.equal(isPlaceholder('Houston', 'City'), false);
  });
});

describe('reviewSingleForm', () => {
  test('exactly one visible, enabled submit control passes; zero or two park', () => {
    assert.equal(reviewSingleForm({ scopeFound: true, submitMatches: [{ visible: true, enabled: true }] }).ok, true);
    assert.equal(reviewSingleForm({ scopeFound: true, submitMatches: [] }).reason, 'submit_controls_0');
    assert.equal(reviewSingleForm({ scopeFound: true, submitMatches: [{ visible: true, enabled: true }, { visible: true, enabled: true }] }).reason, 'submit_controls_2');
    assert.equal(reviewSingleForm({ scopeFound: true, submitMatches: [{ visible: true, enabled: true }, { visible: false, enabled: true }] }).ok, true);
    assert.equal(reviewSingleForm({ scopeFound: false, submitMatches: [{ visible: true, enabled: true }] }).reason, 'form_missing');
  });
});

/** @param {Record<string, any>} [patch] */
function workdaySnap(patch = {}) {
  return {
    url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/X/apply', scopeFound: true, scopeHeadings: ['Review'], scopeText: 'Review Jordan Reyes Houston resume.docx',
    text: 'Review Jordan Reyes Houston', errors: [], fields: [], dataMarked: false,
    buttons: [{ tag: 'button', name: 'Submit', ariaLabel: '', labelledByText: '', visibleText: 'Submit', textContent: 'Submit', title: '', value: '', dataAttrs: [['data-automation-id', 'pageFooterNextButton']], automationId: 'pageFooterNextButton', visible: true, enabled: true }],
    extras: { authGate: { count: 0, texts: [] }, password: { count: 0, texts: [] }, uploads: { count: 1, texts: ['resume.docx'] } },
    ...patch,
  };
}

describe('reviewWorkday (C4)', () => {
  test('a verified Review page with one Submit control passes', () => {
    assert.deepEqual(reviewWorkday(workdaySnap(), { expectedResume: 'resume.docx' }), { ok: true, reason: null });
  });
  test('not the Review step, a wrong resume item, an unchecked consent box, a signature field, or a second Submit control parks', () => {
    assert.equal(reviewWorkday(workdaySnap({ scopeHeadings: ['My Information'] }), { expectedResume: 'resume.docx' }).ok, false);
    assert.equal(reviewWorkday(workdaySnap(), { expectedResume: 'other.docx' }).reason, 'resume_uploaded_not_found');
    assert.equal(reviewWorkday(workdaySnap({ fields: [field({ type: 'checkbox', label: 'I certify that the information is true' })] }), { expectedResume: 'resume.docx' }).reason, 'consent_unchecked');
    assert.equal(reviewWorkday(workdaySnap({ fields: [field({ label: 'Electronic Signature' })] }), { expectedResume: 'resume.docx' }).reason, 'signature_field');
    const two = workdaySnap();
    two.buttons = [...two.buttons, { ...two.buttons[0], automationId: '', dataAttrs: [] }];
    assert.match(String(reviewWorkday(two, { expectedResume: 'resume.docx' }).reason), /^submit_controls_2/);
    assert.equal(reviewWorkday(workdaySnap({ extras: { authGate: { count: 1, texts: [] }, password: { count: 0, texts: [] }, uploads: { count: 1, texts: ['resume.docx'] } } }), { expectedResume: 'resume.docx' }).reason, 'step_auth_lost');
  });
  test('Save and Continue Later next to Submit is fine: it is never the target', () => {
    const s = workdaySnap();
    s.buttons = [...s.buttons, { ...s.buttons[0], name: 'Save and Continue Later', visibleText: 'Save and Continue Later', textContent: 'Save and Continue Later', automationId: 'saveForLater', dataAttrs: [['data-automation-id', 'saveForLater']] }];
    assert.equal(reviewWorkday(s, { expectedResume: 'resume.docx' }).ok, true);
  });
});

describe('confirmation (C6)', () => {
  const baseline = { url: 'https://boards.greenhouse.io/acme/jobs/123', text: 'Apply for this job', errors: [] };
  test('sent text that appeared after the click and held on a settled page confirms', () => {
    const after = { url: baseline.url, text: 'Thank you for applying to Acme!', errors: [] };
    assert.equal(confirmationSignal('greenhouse', baseline, after), 'candidate');
    assert.equal(classifyConfirmation({ ats: 'greenhouse', baseline, after, settled: after }), 'confirmed');
  });
  test('a pre-existing thank-you heading never confirms', () => {
    const b = { ...baseline, text: 'Thank you for applying! Apply for this job' };
    const after = { ...b };
    assert.equal(confirmationSignal('greenhouse', b, after), 'none');
    assert.equal(classifyConfirmation({ ats: 'greenhouse', baseline: b, after, settled: after }), 'unconfirmed');
  });
  test('a stale applyUrl containing thanks never confirms (the URL must change and be the current one)', () => {
    const b = { url: 'https://jobs.lever.co/acme/1234/thanks', text: 'Apply', errors: [] };
    assert.equal(confirmationSignal('lever', b, { ...b }), 'none');
    assert.equal(classifyConfirmation({ ats: 'lever', baseline: b, after: b, settled: b }), 'unconfirmed');
  });
  test('a thanks URL is a whole path segment, never a substring, and never carries an error marker', () => {
    assert.equal(thanksUrlMatches('lever', 'https://jobs.lever.co/acme/1234/thanks'), true);
    assert.equal(thanksUrlMatches('lever', 'https://jobs.lever.co/acme/thanksgiving-role'), false);
    assert.equal(thanksUrlMatches('lever', 'https://jobs.lever.co/acme/1234/thanks?error=1'), false);
    assert.equal(thanksUrlMatches('greenhouse', 'https://boards.greenhouse.io/acme/jobs/1/confirmation'), true);
    assert.equal(thanksUrlMatches('icims', 'https://x.icims.com/jobs/1/thanks'), false, 'iCIMS has no URL confirmation');
    assert.equal(thanksUrlMatches('greenhouse', 'not a url'), false);
  });
  test('a toast then an error is an error', () => {
    const after = { url: baseline.url, text: 'Application submitted', errors: [] };
    const settled = { url: baseline.url, text: 'Application submitted', errors: ['Something went wrong'] };
    assert.equal(classifyConfirmation({ ats: 'greenhouse', baseline, after, settled }), 'error');
  });
  test('a signal that did not survive settling is unconfirmed', () => {
    const after = { url: baseline.url, text: 'Thank you for applying', errors: [] };
    assert.equal(classifyConfirmation({ ats: 'greenhouse', baseline, after, settled: { url: baseline.url, text: 'Apply for this job', errors: [] } }), 'unconfirmed');
    assert.equal(classifyConfirmation({ ats: 'greenhouse', baseline, after, settled: null }), 'unconfirmed');
  });
  test('a confirmation only inside an iframe is unconfirmed (frames are never read for the sent text)', () => {
    const after = { url: baseline.url, text: 'Apply for this job', errors: [], frames: [{ url: 'https://x', text: 'Thank you for applying' }] };
    assert.equal(confirmationSignal('greenhouse', baseline, after), 'none');
    assert.equal(classifyConfirmation({ ats: 'greenhouse', baseline, after, settled: after }), 'unconfirmed');
  });
  test('"thank you for your interest" is not a confirmation', () => {
    const after = { url: baseline.url, text: 'Thank you for your interest in Acme', errors: [] };
    assert.equal(confirmationSignal('greenhouse', baseline, after), 'none');
  });
});

describe('auditReview (Workday)', () => {
  test('every ledger value must still be on the Review page, from an allowed source', () => {
    const snap = { scopeText: 'Review City Houston Phone 713 555 0100', errors: [], fields: [] };
    const ok = auditReview(snap, [{ question: 'City', value: 'Houston', kind: 'text', source: 'contact' }, { question: 'Phone', value: '(713) 555-0100', kind: 'text', source: 'contact' }]);
    assert.deepEqual(ok, { ok: true, problems: [] });
    const bad = auditReview(snap, [{ question: 'State', value: 'Texas', kind: 'text', source: 'contact' }, { question: 'Gender', value: 'Male', kind: 'select', source: 'contact' }]);
    assert.ok(bad.problems.includes('review_missing_value:State'));
    assert.ok(bad.problems.includes('source_not_allowed:Gender'));
    assert.ok(auditReview({ ...snap, errors: ['Error'] }, []).problems.includes('validation_error_visible'));
  });
});
