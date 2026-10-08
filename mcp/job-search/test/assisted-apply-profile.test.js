// @ts-check
/**
 * Assisted apply scaffolding (spec v1 clauses 1, 2, 4; v2 A14): the profile object, rules passed as data,
 * the assisted_apply tool name with easy_apply kept as a one-release alias, and fail-closed behavior when a
 * page function receives no usable rules. LinkedIn is the only profile in this PR.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINKEDIN_PROFILE } from '../src/apply/assisted/profiles/linkedin.js';
import { profileForAts, PROFILES } from '../src/apply/assisted/profiles/index.js';
import { classifyAdvanceButton, isSubmitMarked, classifyStep, PAGE_GUARD_FUNCTIONS } from '../src/apply/assisted/guard.js';
import { resolveFieldAnswer } from '../src/apply/assisted/answers.js';
import { parseAnswerBank } from '../src/apply/answers.js';
import { PAGE_FUNCTION, createAssistedDriver } from '../src/apply/assisted/driver.js';
import { makeAssistedApplyTool, tool as assistedTool } from '../src/tools/assisted_apply.js';
import { tool as easyApplyTool, schema as easySchema } from '../src/tools/easy_apply.js';
import { toolsForEnv, TOOLS } from '../src/server.js';
import { LEASE_ENV, ASSISTED_LEASE_ENV, EASY_APPLY_BUDGET_SOURCE } from '../src/core/easy-apply-state.js';
import { EASY_APPLY_PROMPT } from '../src/apply/easy-apply-runner.js';
import { createAssistedRunner } from '../src/apply/assisted/runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

const btn = (/** @type {any} */ o = {}) => ({ tag: 'button', inDialog: true, disabled: false, ariaLabel: '', labelledByText: '', visibleText: 'Next', textContent: 'Next', title: '', value: '', dataAttrs: [], ...o });

describe('profile registry (total classification over ats_type)', () => {
  test('linkedin_easy maps to the LinkedIn profile', () => {
    assert.equal(profileForAts('linkedin_easy'), LINKEDIN_PROFILE);
  });
  test('every other ats_type, including junk, has no profile (workday has its own since PR-2)', () => {
    for (const ats of ['WORKDAY', 'greenhouse', 'unknown', '', null, undefined, 42, 'LINKEDIN_EASY', '__proto__', 'constructor']) {
      assert.equal(profileForAts(/** @type {any} */ (ats)), null, String(ats));
    }
  });
  test('LinkedIn and Workday are the profiles', () => {
    assert.deepEqual(Object.keys(PROFILES), ['linkedin_easy', 'workday']);
  });
  test('the LinkedIn profile carries its budget source, breaker key, timeout, prompt, and contact labels', () => {
    assert.equal(LINKEDIN_PROFILE.budgetSource, EASY_APPLY_BUDGET_SOURCE);
    assert.equal(LINKEDIN_PROFILE.leaseEnv, LEASE_ENV);
    assert.equal(LINKEDIN_PROFILE.breakerKey, 'linkedin_easy');
    assert.equal(LINKEDIN_PROFILE.runTimeoutMinutes, 15);
    assert.equal(LINKEDIN_PROFILE.prompt, EASY_APPLY_PROMPT);
    assert.equal(LINKEDIN_PROFILE.contactLabels['first name'], 'first_name');
    assert.ok(Object.isFrozen(LINKEDIN_PROFILE) && Object.isFrozen(LINKEDIN_PROFILE.rules) && Object.isFrozen(LINKEDIN_PROFILE.rules.advanceKinds.next));
  });
});

describe('page guards fail closed without usable rules', () => {
  test('a rule each function depends on, when broken, fails that function closed', () => {
    const L = LINKEDIN_PROFILE.rules;
    assert.equal(classifyAdvanceButton(btn(), { ...L, advanceKinds: null }).ok, false);
    assert.equal(classifyAdvanceButton(btn(), { ...L, nameDeny: { source: 7 } }).ok, false);
    assert.equal(classifyAdvanceButton(btn(), { ...L, dataDeny: { source: '(' } }).ok, false);
    assert.equal(isSubmitMarked(btn(), { ...L, dataDeny: null }), true);
    const review = { dialogPresent: true, headerTexts: ['Review your application'], submitVisible: true, dialogText: '', pageText: '', url: 'https://www.linkedin.com/jobs/view/1/' };
    for (const key of ['sent', 'challengeText', 'challengeUrl', 'reviewHeader']) {
      assert.equal(classifyStep(review, { ...L, [key]: { source: '' } }).kind, 'submit_visible', key);
    }
  });
  const broken = Object.fromEntries(['nameDeny', 'dataDeny', 'sent', 'challengeText', 'challengeUrl', 'reviewHeader'].map((k) => [k, { source: 7 }]));
  for (const [name, R] of /** @type {Array<[string, any]>} */ ([['undefined', undefined], ['null', null], ['empty object', {}], ['every regex spec malformed', { ...LINKEDIN_PROFILE.rules, ...broken }], ['a string', 'rules']])) {
    test(`classifyAdvanceButton refuses a plain Next with ${name} rules`, () => {
      assert.equal(classifyAdvanceButton(btn(), R).ok, false);
    });
    test(`isSubmitMarked treats everything as marked with ${name} rules`, () => {
      assert.equal(isSubmitMarked(btn(), R), true);
    });
    test(`classifyStep never yields form or review with ${name} rules`, () => {
      const k = classifyStep({ dialogPresent: true, headerTexts: ['Review your application'], submitVisible: true, dialogText: '', pageText: '', url: 'https://www.linkedin.com/jobs/view/1/' }, R).kind;
      assert.ok(k !== 'form' && k !== 'review', k);
    });
  }
  test('the guard functions stay self-contained (no import, require)', () => {
    for (const fn of PAGE_GUARD_FUNCTIONS) assert.doesNotMatch(fn.toString(), /\bimport\b|\brequire\(/, fn.name);
  });
});

describe('contact labels come from the profile', () => {
  const bank = parseAnswerBank(['## first_name', 'type: text', 'value: Damian'].join('\n'));
  test('a label absent from the given contact map is not a contact field', () => {
    const f = { question: 'First name', kind: 'text', required: true, options: [] };
    assert.equal(resolveFieldAnswer(f, { bank, accountEmail: null, contactLabels: LINKEDIN_PROFILE.contactLabels }).action, 'fill');
    assert.deepEqual(resolveFieldAnswer(f, { bank, accountEmail: null, contactLabels: {} }), { action: 'park', reason: 'no_exact_match', bankKey: null });
    assert.deepEqual(resolveFieldAnswer(f, { bank, accountEmail: null }), { action: 'park', reason: 'no_exact_match', bankKey: null });
  });
  test('inherited object keys are never contact labels', () => {
    const f = { question: 'constructor', kind: 'text', required: true, options: [] };
    assert.equal(resolveFieldAnswer(f, { bank, accountEmail: null, contactLabels: LINKEDIN_PROFILE.contactLabels }).reason, 'no_exact_match');
  });
});

describe('driver passes the profile rules into the one page function', () => {
  test('the guards are called with req.rules inside PAGE_FUNCTION', () => {
    assert.match(PAGE_FUNCTION, /G\.classifyAdvanceButton\([^)]*, R\)/);
    assert.match(PAGE_FUNCTION, /G\.classifyStep\(\{[\s\S]*?\}, R\)/);
    assert.match(PAGE_FUNCTION, /const R = req\.rules/);
  });
  test('every call sends the profile rules as data', async () => {
    /** @type {any[]} */
    const sent = [];
    const cdp = /** @type {any} */ ({
      attach: async () => 'S1',
      detach: async () => {},
      send: async (/** @type {string} */ method, /** @type {any} */ params) => {
        if (method === 'Runtime.evaluate') return { result: { objectId: 'G1' } };
        if (method === 'Runtime.callFunctionOn') { sent.push(params.arguments[0].value); return { result: { value: { ok: true } } }; }
        return {};
      },
    });
    const d = createAssistedDriver({ cdp, targetId: 'T1', profile: LINKEDIN_PROFILE, pacing: false });
    await d.attach();
    await d.snapshot();
    await d.readField('e1-abc');
    assert.equal(sent.length, 2);
    for (const req of sent) assert.deepEqual(req.rules, JSON.parse(JSON.stringify(LINKEDIN_PROFILE.rules)));
  });
  test('a driver without a profile refuses to be created', () => {
    assert.throws(() => createAssistedDriver(/** @type {any} */ ({ cdp: {}, targetId: 'T1' })), /profile/);
  });
});

describe('assisted_apply tool, easy_apply alias (A14)', () => {
  test('canonical name is assisted_apply; easy_apply is the alias with the identical schema', () => {
    assert.equal(assistedTool.name, 'assisted_apply');
    assert.equal(easyApplyTool.name, 'easy_apply');
    assert.equal(assistedTool.schema, easySchema);
    assert.deepEqual(Object.keys(assistedTool.schema).sort(), ['action', 'label', 'ref']);
  });
  test('the assisted lease env exposes ONLY assisted_apply; the legacy env exposes ONLY easy_apply; neither leaks into normal mode', () => {
    assert.notEqual(ASSISTED_LEASE_ENV, LEASE_ENV);
    assert.deepEqual(toolsForEnv({ [ASSISTED_LEASE_ENV]: '1.abc' }).map((t) => t.name), ['assisted_apply']);
    assert.deepEqual(toolsForEnv({ [LEASE_ENV]: '1.abc' }).map((t) => t.name), ['easy_apply']);
    assert.deepEqual(toolsForEnv({ [ASSISTED_LEASE_ENV]: '1.abc', [LEASE_ENV]: '1.abc' }).map((t) => t.name), ['assisted_apply']);
    assert.equal(toolsForEnv({ [ASSISTED_LEASE_ENV]: '' }), TOOLS);
    assert.ok(!TOOLS.some((t) => t.name === 'assisted_apply' || t.name === 'easy_apply'));
  });
  test('an application whose ats_type has no profile is stopped before any driver opens', async () => {
    let opened = 0;
    /** @type {any[]} */
    const closed = [];
    const t = makeAssistedApplyTool({
      leaseToken: () => `5.${'a'.repeat(32)}`,
      openDriver: async () => { opened++; return { driver: {}, close: async () => {} }; },
      bank: parseAnswerBank(''),
    });
    const fakeClient = {
      query: async (/** @type {string} */ sql, /** @type {any[]} */ params) => {
        if (/FROM ic_easy_apply_leases l JOIN/.test(sql)) return { rowCount: 1, rows: [{ id: 9, application_id: 5, nonce_hash: '', expires_at: new Date(Date.now() + 60000), closed_at: null, application_state: 'submitting', target_id: 'T' }] };
        if (/FROM ic_job_applications/.test(sql)) return { rowCount: 1, rows: [{ id: 5, ats_type: 'greenhouse' }] };
        if (/UPDATE ic_easy_apply_leases SET closed_at/.test(sql)) { closed.push(params); return { rowCount: 1, rows: [] }; }
        return { rowCount: 0, rows: [] };
      },
    };
    const res = await t.handler({ action: 'snapshot' }, /** @type {any} */ ({ withClient: async (/** @type {any} */ fn) => fn(fakeClient) }));
    assert.equal(opened, 0);
    assert.equal(closed.length, 1);
    assert.equal(closed[0][1], 'unsupported_ats');
    assert.equal(res.stopped, true);
    assert.equal(res.stop_reason, 'unsupported_ats');
  });
});

describe('dashboard routes: /assisted-apply/ with /easy-apply/ kept as alias', () => {
  test('each easy-apply route resolves to the same handler at both paths', async () => {
    const { createRouter } = await import('../src/dashboard/router.js');
    const { register } = await import('../src/dashboard/routes/easy-apply.js');
    const router = createRouter();
    register(router, /** @type {any} */ ({ env: {}, withClient: async () => null }));
    for (const [method, oldPath] of [['GET', '/api/easy-apply/status'], ['POST', '/api/applications/7/easy-apply/submitted'], ['POST', '/api/applications/7/easy-apply/abandon']]) {
      const a = /** @type {any} */ (router.dispatch(oldPath, method));
      const b = /** @type {any} */ (router.dispatch(oldPath.replace('/easy-apply/', '/assisted-apply/'), method));
      assert.ok(a && a.route && b && b.route, oldPath);
      assert.equal(a.route.handler, b.route.handler, oldPath);
    }
    assert.equal(router.dispatch('/api/applications/7/assisted-apply/focus-tab', 'POST'), null);
  });
});

describe('runner (profile-driven)', () => {
  test('a runner without a profile refuses to be created', () => {
    assert.throws(() => createAssistedRunner(/** @type {any} */ ({ env: {}, logDir: '.', repoRoot: '.', spawn: () => {} })), /profile/);
  });
});

describe('lint: the new assisted modules hold no page action primitives', () => {
  const code = (/** @type {string} */ t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const files = [
    path.join('apply', 'assisted', 'guard.js'),
    path.join('apply', 'assisted', 'answers.js'),
    path.join('apply', 'assisted', 'runner.js'),
    path.join('apply', 'assisted', 'driver.js'),
    path.join('apply', 'assisted', 'profiles', 'linkedin.js'),
    path.join('apply', 'assisted', 'profiles', 'index.js'),
    path.join('tools', 'assisted_apply.js'),
  ];
  const ACTION_RE = /\.click\(|dispatchEvent\(|Input\.dispatch|Input\.insertText|insertText|setInputFiles|DOM\.setFileInputFiles|\.fill\(|\.press\(|keyboard\.|mouse\.|Runtime\.callFunctionOn/;
  test('no click/type/select/upload primitive or callFunctionOn', () => {
    assert.deepEqual(files.filter((f) => ACTION_RE.test(code(fs.readFileSync(path.join(SRC, f), 'utf8')))), []);
  });
  test('no network interception or bypassPermissions', () => {
    assert.deepEqual(files.filter((f) => /bypassPermissions|\.route\(|Fetch\.enable|Network\.setRequestInterception|Network\.enable/.test(code(fs.readFileSync(path.join(SRC, f), 'utf8')))), []);
  });
  test('no model-reachable assisted module imports core/credentials.js', () => {
    assert.deepEqual(files.filter((f) => /credentials\.js['"]/.test(code(fs.readFileSync(path.join(SRC, f), 'utf8')))), []);
  });
});
