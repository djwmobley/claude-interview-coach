// @ts-check
/**
 * The assisted driver with the WORKDAY profile against SYNTHETIC Workday fixtures
 * (test/fixtures/assisted-workday/*.html) in a throwaway headless Chrome (spec v1 clauses 3, 5, 11; v2 A1,
 * A2, A4, A7, A12). Covers: footer scope and step-bar progress (Next allowed mid-wizard and clicked once),
 * unreadable progress (allowed only with a following label, otherwise uncertain_last_step), the listbox
 * open / list / pick ops with exact, zero, and duplicate matches and read-back, Submit-labeled, localized,
 * and data-automation-id-submit buttons all refused with no click, the single-page tenant refused, review
 * classified with no click, password fields scrubbed from the snapshot (their values never leave the page)
 * and classified as a stop, auth-gate, session-timeout, already-applied, and sent pages classified, two
 * apply-flow containers giving no scope, the uploaded-file item read back, and the attached tab's own
 * target id read through CDP. Skips when no Chrome/Edge binary exists on this machine.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from '../src/browser/cdp-target.js';
import { createAssistedDriver } from '../src/apply/assisted/driver.js';
import { WORKDAY_PROFILE } from '../src/apply/assisted/profiles/workday.js';
import { launchHeadlessChrome, findChromeBinary } from './helpers/headless-chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'assisted-workday');
const SKIP = findChromeBinary() ? false : 'no Chrome/Edge binary on this machine';

/** @type {any} */
let chrome = null;
/** @type {import('../src/browser/cdp-target.js').CdpClient} */
let cdp;

before(async () => {
  if (SKIP) return;
  chrome = await launchHeadlessChrome(FIXTURES);
  cdp = await connectCdp({ wsUrl: chrome.wsUrl });
});
after(async () => {
  if (cdp) cdp.close();
  if (chrome) await chrome.close();
});

/** @param {string} fixture */
async function openTab(fixture) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const driver = createAssistedDriver({ cdp, targetId, profile: WORKDAY_PROFILE, pacing: false, sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 50)); }) });
  await driver.attach();
  await driver.navigate(`${chrome.baseUrl}/${fixture}`, { pollMs: 50 });
  return { targetId, driver };
}

/** @param {string} targetId @param {string} expr */
async function pageEval(targetId, expr) {
  const sid = await cdp.attach(targetId);
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
    return r.result.value;
  } finally {
    await cdp.detach(sid);
  }
}

/** @param {any} snap @param {RegExp} re */
const field = (snap, re) => snap.fields.find((/** @type {any} */ f) => re.test(f.question));
/** @param {any} snap @param {string} name */
const button = (snap, name) => snap.buttons.find((/** @type {any} */ b) => b.name === name);

describe('assisted driver, Workday profile, synthetic fixtures', { skip: SKIP }, () => {
  test('mid-wizard step: footer in scope, step bar below 100, Save and Continue allowed and clicked once', async () => {
    const { targetId, driver } = await openTab('wd-steps.html');
    const snap = await driver.snapshot();
    assert.equal(snap.step.kind, 'form');
    assert.equal(snap.progressValues.length, 1);
    assert.ok(snap.progressValues[0] < 100);
    assert.equal(button(snap, 'save and continue').allowed, true);
    assert.equal(button(snap, 'back').allowed, false);
    const lb = field(snap, /How Did You Hear/);
    assert.equal(lb.kind, 'listbox');
    assert.equal(lb.required, true);
    assert.equal(lb.filled, false, 'the Select One placeholder reads as empty');
    // Fill the two required fields so the in-page required check passes.
    const phone = field(snap, /Phone Number/);
    assert.equal((await driver.typeText(phone.ref, '7135550100')).ok, true);
    assert.equal((await driver.openListbox(lb.ref)).ok, true);
    assert.equal((await driver.pickOption('LinkedIn')).ok, true);
    const rb = await driver.readField(lb.ref);
    assert.equal(rb.value, 'LinkedIn');
    const r = await driver.advance(button(await driver.snapshot(), 'save and continue').ref);
    assert.equal(r.clicked, true, JSON.stringify(r));
    assert.deepEqual(await pageEval(targetId, 'window.__clicks.filter((c) => c === "next")'), ['next']);
    assert.equal(await driver.currentTargetId(), targetId);
  });

  test('listbox exact match only: zero and duplicate matches are refused and nothing is picked (A4)', async () => {
    const { targetId, driver } = await openTab('wd-steps.html');
    const lb = field(await driver.snapshot(), /How Did You Hear/);
    await driver.openListbox(lb.ref);
    const listed = await driver.listOptions();
    assert.deepEqual(listed.options, ['LinkedIn', 'LinkedIn Ads', 'Indeed', 'Company Website']);
    assert.equal((await driver.pickOption('Glassdoor')).reason, 'no_exact_option');
    assert.equal((await driver.pickOption('linked')).reason, 'no_exact_option', 'no prefix matching');
    const dup = await openTab('wd-steps.html?mode=dup');
    const lb2 = field(await dup.driver.snapshot(), /How Did You Hear/);
    await dup.driver.openListbox(lb2.ref);
    assert.equal((await dup.driver.pickOption('Other')).reason, 'ambiguous_option');
    assert.deepEqual(await pageEval(dup.targetId, 'window.__clicks.filter((c) => c.startsWith("option:"))'), []);
    assert.deepEqual(await pageEval(targetId, 'window.__clicks.filter((c) => c.startsWith("option:"))'), []);
  });

  test('unreadable step bar: allowed only when the header names a step with a following step (A2)', async () => {
    const ok = await openTab('wd-steps.html?mode=unreadable');
    const s1 = await ok.driver.snapshot();
    assert.ok(s1.progressValues.length === 1 && s1.progressValues[0] < 100, JSON.stringify(s1.progressValues));
    const bad = await openTab('wd-steps.html?mode=unknown');
    const s2 = await bad.driver.snapshot();
    assert.deepEqual(s2.progressValues, []);
    const phone = field(s2, /Phone Number/);
    await bad.driver.typeText(phone.ref, '1');
    const r = await bad.driver.advance(button(s2, 'save and continue').ref);
    assert.equal(r.clicked, false);
    assert.equal(r.reason, 'uncertain_last_step');
    assert.deepEqual(await pageEval(bad.targetId, 'window.__clicks'), []);
  });

  test('Submit-labeled, localized, and data-automation-id-submit footer buttons: denied, Submit visible, no click (A1)', async () => {
    for (const mode of ['label', 'localized', 'data']) {
      const { targetId, driver } = await openTab(`wd-terminal.html?mode=${mode}`);
      const snap = await driver.snapshot();
      assert.equal(snap.submitVisible, true, mode);
      assert.equal(snap.step.kind, 'submit_visible', mode);
      assert.ok(snap.buttons.every((/** @type {any} */ b) => b.allowed === false), mode);
      const r = await driver.advance(snap.buttons[0].ref);
      assert.equal(r.clicked, false, mode);
      assert.equal(r.reason, 'denied_term', mode);
      assert.deepEqual(await pageEval(targetId, 'window.__clicks'), [], mode);
    }
  });

  test('a single-page tenant (no step bar) never clicks Next: uncertain_last_step', async () => {
    const { targetId, driver } = await openTab('wd-terminal.html?mode=single');
    const snap = await driver.snapshot();
    assert.deepEqual(snap.progressValues, []);
    const r = await driver.advance(button(snap, 'next').ref);
    assert.equal(r.clicked, false);
    assert.equal(r.reason, 'uncertain_last_step');
    assert.deepEqual(await pageEval(targetId, 'window.__clicks'), []);
  });

  test('the Review step classifies as review and its Submit is never clickable', async () => {
    const { targetId, driver } = await openTab('wd-terminal.html?mode=review');
    const snap = await driver.snapshot();
    assert.equal(snap.step.kind, 'review');
    assert.deepEqual(snap.progressValues, [100]);
    assert.equal((await driver.advance(snap.buttons[0].ref)).clicked, false);
    assert.deepEqual(await pageEval(targetId, 'window.__clicks'), []);
  });

  test('password fields are scrubbed from the snapshot and stop the session (A7)', async () => {
    const gate = await openTab('wd-terminal.html?mode=gate');
    const g = await gate.driver.snapshot();
    assert.equal(g.step.kind, 'auth_lost');
    assert.ok(!JSON.stringify(g).includes('hunter2-secret'));
    assert.ok(!g.fields.some((/** @type {any} */ f) => /password/i.test(f.question)));
    const pw = await openTab('wd-terminal.html?mode=password');
    const p = await pw.driver.snapshot();
    assert.equal(p.step.kind, 'password_field');
    assert.ok(!JSON.stringify(p).includes('pc-secret-123'));
    const ref = await pageEval(pw.targetId, 'document.getElementById("pc") ? "present" : "gone"');
    assert.equal(ref, 'present');
  });

  test('session-timeout, already-applied, and sent pages classify as stops', async () => {
    assert.equal((await (await openTab('wd-terminal.html?mode=timeout')).driver.snapshot()).step.kind, 'session_timeout');
    assert.equal((await (await openTab('wd-terminal.html?mode=already')).driver.snapshot()).step.kind, 'already_applied');
    assert.equal((await (await openTab('wd-terminal.html?mode=sent')).driver.snapshot()).step.kind, 'sent');
  });

  test('two apply-flow containers give no scope: no fields, no buttons, nothing clickable', async () => {
    const { driver } = await openTab('wd-steps.html?mode=two');
    const snap = await driver.snapshot();
    assert.equal(snap.step.kind, 'no_dialog');
    assert.equal(snap.fields.length, 0);
    assert.equal(snap.buttons.length, 0);
  });

  test('live-shaped My Information page (structure from the 2026-10-05 read-only probe)', async () => {
    const { driver } = await openTab('wd-live-myinfo.html');
    const snap = await driver.snapshot();
    assert.equal(snap.step.kind, 'form');
    assert.equal(snap.progressValues[0], 0, 'step 1 of 6 is readable and below 100');
    assert.deepEqual(snap.buttons.map((/** @type {any} */ b) => [b.name, b.allowed]), [['back to job posting', false], ['next', true]], 'cookie banner, language menu, and Sign In are out of scope');
    assert.deepEqual(snap.fields.map((/** @type {any} */ f) => [f.kind, f.question, f.required, f.filled]), [
      ['listbox', 'How Did You Hear About Us?', true, false],
      ['listbox', 'Country*', true, true],
      ['text', 'First Name*', true, false],
      ['checkbox', 'I have a preferred name', false, false],
      ['text', 'City*', true, false],
      ['multiselect', 'Country Phone Code*', true, true],
      ['text', 'Phone Number*', true, false],
    ]);
    assert.equal(snap.fields[5].value, 'United States of America (+1)');
    assert.ok(!snap.fields.some((/** @type {any} */ f) => f.question === ''), 'unlabeled hidden helper inputs are dropped');
  });

  test('upload read-back: the file input name and the uploaded-file item (clause 5)', async () => {
    const { driver } = await openTab('wd-steps.html');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-upload-'));
    const file = path.join(dir, 'Damian Mobley - CTO.docx');
    fs.writeFileSync(file, 'resume bytes');
    const up = await driver.uploadFile(file);
    assert.equal(up.ok, true);
    assert.equal(up.fileName, 'Damian Mobley - CTO.docx');
    const snap = await driver.snapshot();
    assert.deepEqual(snap.uploadedFiles, ['Damian Mobley - CTO.docx']);
  });
});
