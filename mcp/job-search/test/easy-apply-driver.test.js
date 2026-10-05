// @ts-check
/**
 * src/apply/easy-apply-driver.js + src/browser/cdp-target.js against SYNTHETIC fixtures
 * (test/fixtures/easy-apply/*.html) in a throwaway headless Chrome: the full contact -> resume ->
 * questions -> Review flow ends at Review with Submit never clicked, every adversarial button label is
 * refused without a click, a step with no progress signal is treated as terminal, required-empty and
 * validation alerts block advance, stale refs are refused, text entry fires no key events and strips
 * CR/LF, the resume card check passes only for the uploaded file, a challenge page classifies as
 * 'challenge', the Applied badge is read, and detach leaves the tab open. Skips when no Chrome/Edge binary
 * exists on this machine.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from '../src/browser/cdp-target.js';
import { createEasyApplyDriver, PAGE_FUNCTION } from '../src/apply/easy-apply-driver.js';
import { verifyResumeCards } from '../src/apply/easy-apply-guard.js';
import { launchHeadlessChrome, findChromeBinary } from './helpers/headless-chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'easy-apply');
const SKIP = findChromeBinary() ? false : 'no Chrome/Edge binary on this machine';

/** @type {Awaited<ReturnType<typeof launchHeadlessChrome>>} */
let chrome = null;
/** @type {import('../src/browser/cdp-target.js').CdpClient} */
let cdp;

before(async () => {
  if (SKIP) return;
  chrome = await launchHeadlessChrome(FIXTURES);
  cdp = await connectCdp({ wsUrl: /** @type {any} */ (chrome).wsUrl });
});
after(async () => {
  if (cdp) cdp.close();
  if (chrome) await chrome.close();
});

/** @param {string} fixture */
async function openTab(fixture) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const driver = createEasyApplyDriver({ cdp, targetId, pacing: false, sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 50)); }) });
  await driver.attach();
  await driver.navigate(`${/** @type {any} */ (chrome).baseUrl}/${fixture}`, { pollMs: 50 });
  return { targetId, driver };
}

/** @param {any} driver @param {string} expr */
async function pageEval(driver, targetId, expr) {
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

describe('PAGE_FUNCTION', () => {
  test('is one self-contained function declaration carrying the guard source', () => {
    assert.match(PAGE_FUNCTION, /^function \(req\) \{/);
    assert.match(PAGE_FUNCTION, /function classifyAdvanceButton\(/);
    assert.doesNotMatch(PAGE_FUNCTION, /\bexport\b|\bimport\b/);
    assert.doesNotMatch(PAGE_FUNCTION, /KeyboardEvent|Input\.dispatchKeyEvent|insertText/);
  });
});

describe('easy apply driver against synthetic fixtures', { skip: SKIP }, () => {
  test('full flow reaches Review; Submit is never clicked; Follow company untouched; no key events', async () => {
    const { targetId, driver } = await openTab('flow.html');
    assert.equal((await driver.appliedBadge()).state, 'not_applied');
    const opened = await driver.openDialog();
    assert.equal(opened.clicked, true, JSON.stringify(opened));

    let snap = await driver.snapshot();
    assert.equal(snap.step.kind, 'form');
    assert.deepEqual(snap.progressValues, [0]);
    // Required-empty blocks advance (G8) before anything is filled.
    const next0 = button(snap, 'next');
    assert.equal((await driver.advance(next0.ref)).reason, 'required_empty');

    assert.equal((await driver.typeText(field(snap, /^last name/i).ref, 'Mob\r\nley')).readBack, 'Mob  ley'.replace('  ', ' '));
    await driver.typeText(field(snap, /^last name/i).ref, 'Mobley');
    await driver.chooseOption(field(snap, /phone country code/i).ref, 'United States (+1)');
    await driver.typeText(field(snap, /mobile phone/i).ref, '7135550100');
    await driver.chooseOption(field(snap, /email address/i).ref, 'owner@example.com');
    snap = await driver.snapshot();
    assert.equal(field(snap, /^last name/i).value, 'Mobley');
    const adv0 = await driver.advance(button(snap, 'next').ref);
    assert.equal(adv0.clicked, true, JSON.stringify(adv0));

    snap = await driver.snapshot();
    assert.deepEqual(snap.progressValues, [33]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-apply-upload-'));
    const docx = path.join(tmp, 'Damian Mobley - CTO.docx');
    fs.writeFileSync(docx, 'synthetic');
    const up = await driver.uploadFile(docx);
    assert.deepEqual(up, { ok: true, fileName: 'Damian Mobley - CTO.docx' });
    snap = await driver.snapshot();
    assert.deepEqual(verifyResumeCards(snap.resumeCards, 'Damian Mobley - CTO.docx'), { ok: true, reason: null });
    assert.equal((await driver.advance(button(snap, 'next').ref)).clicked, true);

    snap = await driver.snapshot();
    assert.deepEqual(snap.progressValues, [66]);
    const spons = field(snap, /sponsorship/i);
    assert.equal(spons.kind, 'radio');
    assert.deepEqual(spons.options, ['Yes', 'No']);
    assert.equal(spons.required, true);
    assert.equal((await driver.chooseRadio(spons.ref, 'No')).readBack, 'No');
    await driver.typeText(field(snap, /years of technology/i).ref, '20');
    await driver.chooseOption(field(snap, /legally authorized/i).ref, 'Yes');
    assert.equal(field(snap, /^website/i).required, false);
    const review = button(snap, 'review your application');
    assert.ok(review, JSON.stringify(snap.buttons));
    assert.equal((await driver.advance(review.ref)).clicked, true);

    snap = await driver.snapshot();
    assert.equal(snap.step.kind, 'review');
    const submit = button(snap, 'submit application');
    assert.ok(submit);
    const refused = await driver.advance(submit.ref);
    assert.equal(refused.clicked, false);
    assert.equal(refused.reason, 'denied_term');
    const back = button(snap, 'back to previous step');
    assert.equal((await driver.advance(back.ref)).clicked, false);
    assert.equal(await pageEval(driver, targetId, 'window.__submitClicked'), false);
    assert.equal(await pageEval(driver, targetId, 'document.getElementById("follow").checked'), true);
    assert.equal(await pageEval(driver, targetId, 'window.__keyEvents'), 0);
    assert.ok((await driver.screenshot()).length > 100);

    await driver.detach();
    const targets = await cdp.listPageTargets();
    assert.ok(targets.some((t) => t.targetId === targetId), 'detach must leave the tab open');
  });

  test('every adversarial label is refused without a click; only the plain Next is allowed', async () => {
    const { targetId, driver } = await openTab('adversarial.html');
    const snap = await driver.snapshot();
    const ids = ['hidden-span', 'sr-span', 'aria-mismatch', 'aria-submit', 'data-value', 'data-name', 'empty', 'linkedin-like', 'plain-next'];
    assert.equal(snap.buttons.length, ids.length, JSON.stringify(snap.buttons));
    const expected = {
      'hidden-span': 'denied_term', 'sr-span': 'denied_term', 'aria-mismatch': 'unknown_button', 'aria-submit': 'denied_term',
      'data-value': 'denied_term', 'data-name': 'denied_term', empty: 'unknown_button', 'linkedin-like': 'denied_term',
    };
    for (let i = 0; i < ids.length - 1; i++) {
      const r = await driver.advance(snap.buttons[i].ref);
      assert.equal(r.clicked, false, ids[i]);
      assert.equal(r.reason, /** @type {any} */ (expected)[ids[i]], ids[i]);
    }
    const inputSubmit = snap.fields.find((/** @type {any} */ f) => f.kind === 'unsupported');
    assert.equal((await driver.advance(inputSubmit.ref)).reason, 'not_button');
    const clicked = await pageEval(driver, targetId, 'JSON.stringify(window.__clicked)');
    assert.deepEqual(JSON.parse(clicked), {});
    // Even the plain Next is refused here: Submit-named buttons are visible in this step, so the step
    // itself is submit_visible (G3: no further clicks of any kind).
    const plain = await driver.advance(snap.buttons[ids.length - 1].ref);
    assert.deepEqual([plain.clicked, plain.reason], [false, 'step_submit_visible']);
    assert.deepEqual(JSON.parse(await pageEval(driver, targetId, 'JSON.stringify(window.__clicked)')), {});
    await driver.detach();
  });

  test('a stale or malformed ref is refused', async () => {
    const { driver } = await openTab('adversarial.html');
    const snap = await driver.snapshot();
    const ref = snap.buttons[snap.buttons.length - 1].ref;
    const forged = ref.replace(/-[0-9a-z]+$/, '-zzzz');
    assert.equal((await driver.advance(forged)).reason, 'stale_ref');
    assert.equal((await driver.advance('not-a-ref')).reason, 'bad_ref');
    assert.equal((await driver.typeText(forged, 'x')).reason, 'stale_ref');
    await driver.detach();
  });

  test('no progress signal: Next is treated as the last step and never clicked (G2)', async () => {
    const { targetId, driver } = await openTab('no-progress.html');
    const snap = await driver.snapshot();
    const r = await driver.advance(button(snap, 'next').ref);
    assert.deepEqual([r.clicked, r.reason], [false, 'uncertain_last_step']);
    assert.equal(await pageEval(driver, targetId, 'window.__clicked'), false);
    await driver.detach();
  });

  test('challenge page classifies as challenge (G11)', async () => {
    const { driver } = await openTab('challenge.html');
    assert.equal((await driver.snapshot()).step.kind, 'challenge');
    await driver.detach();
  });

  test('Applied badge is detected', async () => {
    const { driver } = await openTab('applied.html');
    const r = await driver.appliedBadge();
    assert.equal(r.state, 'applied');
    await driver.detach();
  });

  test('a validation alert blocks advance', async () => {
    const { targetId, driver } = await openTab('flow.html');
    await driver.openDialog();
    await pageEval(driver, targetId, `(() => { const a = document.createElement('div'); a.setAttribute('role','alert'); a.textContent = 'Please enter a valid answer'; document.querySelector('section[data-step="0"]').appendChild(a); for (const id of ['last','phone']) document.getElementById(id).value = 'x'; document.getElementById('cc').value = 'us'; document.getElementById('email').value = 'e1'; return 1; })()`);
    const snap = await driver.snapshot();
    const r = await driver.advance(button(snap, 'next').ref);
    assert.equal(r.reason, 'validation_alert');
    await driver.detach();
  });
});
