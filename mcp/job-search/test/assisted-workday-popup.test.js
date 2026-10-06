// @ts-check
/**
 * Workday listbox popup association (popup association spec v2, P1-P5) against fixtures in a throwaway
 * headless Chrome: test/fixtures/assisted-workday/wd-live-source.html reproduces the live "How Did You
 * Hear About Us?" prompt from a 2026-10-05 read-only probe of application 5's tenant (the second visible
 * listbox is the Country Phone Code selected-pill list), and wd-popup-cases.html holds the synthetic
 * cases: stale popup still mounted, shared container via aria-controls, late popup, chain and non-chain
 * nesting, category and leaf with the same text, two expanded categories, an unclassifiable row, an
 * aria-label embedding a previous value, a truncated display, a multiselect with a prefilled pill, and a
 * virtualized list with an off-screen duplicate. The LinkedIn side is covered by
 * test/assisted-apply-golden.test.js, which this change does not touch. Skips with no Chrome/Edge binary.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from '../src/browser/cdp-target.js';
import { createAssistedDriver } from '../src/apply/assisted/driver.js';
import { WORKDAY_PROFILE } from '../src/apply/assisted/profiles/workday.js';
import { LINKEDIN_PROFILE } from '../src/apply/assisted/profiles/linkedin.js';
import { matchCandidates } from '../src/apply/answers.js';
import { launchHeadlessChrome, findChromeBinary } from './helpers/headless-chrome.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'assisted-workday');
const SKIP = findChromeBinary() ? false : 'no Chrome/Edge binary on this machine';
/** The bank's how_did_you_hear value and its ranked fallback (application 5). */
const BANK_CANDIDATES = [{ value: 'Job Board', rank: 1 }, { value: 'Internet Search', rank: 2 }];

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

/** @param {any} driver @param {RegExp} re */
async function fieldRef(driver, re) {
  const snap = await driver.snapshot();
  const f = snap.fields.find((/** @type {any} */ x) => re.test(x.question));
  assert.ok(f, `field ${re} present: ${JSON.stringify(snap.fields.map((/** @type {any} */ x) => x.question))}`);
  return f.ref;
}

/** @param {string} targetId */
const optionClicks = (targetId) => pageEval(targetId, 'window.__clicks.filter((c) => c.startsWith("option:") || c.startsWith("cat:"))');

/** Open the source prompt of a wd-popup-cases mode and return the tab. @param {string} mode */
async function openCase(mode) {
  const t = await openTab(`wd-popup-cases.html?mode=${mode}`);
  const ref = await fieldRef(t.driver, /How Did You Hear/);
  const op = await t.driver.openListbox(ref);
  assert.equal(op.ok, true, JSON.stringify(op));
  return { ...t, ref };
}

describe('Workday popup association, live-shaped Optimal Blue prompt', { skip: SKIP }, () => {
  test('two visible listboxes (the phone-code pill list and the prompt popup): the linked popup is the one read', async () => {
    const { targetId, driver } = await openTab('wd-live-source.html');
    const ref = await fieldRef(driver, /How Did You Hear/);
    assert.equal(await pageEval(targetId, 'document.querySelectorAll(\'[role="listbox"]\').length'), 1, 'one listbox before opening');
    assert.equal((await driver.openListbox(ref)).ok, true);
    assert.equal(await pageEval(targetId, 'Array.from(document.querySelectorAll(\'[role="listbox"]\')).filter((l) => l.getClientRects().length > 0).length'), 2, 'two visible listboxes after opening');
    const lo = await driver.listOptions();
    assert.equal(lo.ok, true, JSON.stringify(lo));
    assert.deepEqual(lo.options, ['Campus Event', 'Corporate Website', 'Current Employee', 'Employee Referral', 'Indeed', 'Invited by Company Recruiter', 'Linkedin', 'Other'], 'disabled Select One dropped; the pill is not an option');
    // The bank's how_did_you_hear value and its fallback are not offered by this tenant: the shared
    // matcher finds nothing, so the field parks with these options captured instead of guessing.
    assert.deepEqual(matchCandidates(BANK_CANDIDATES, lo.options ?? [], 'how_did_you_hear'), { ok: false, reason: 'zero_candidates' });
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('with a Job Board option present, the shared matcher picks it and the commit is read back (fake click)', async () => {
    const { targetId, driver } = await openTab('wd-live-source.html?with=jobboard');
    const ref = await fieldRef(driver, /How Did You Hear/);
    await driver.openListbox(ref);
    const lo = await driver.listOptions();
    const m = matchCandidates(BANK_CANDIDATES, lo.options ?? [], 'how_did_you_hear');
    assert.deepEqual(m, { ok: true, selectedOption: 'Job Board', rank: 1 }, JSON.stringify(lo));
    const r = await driver.pickOption(/** @type {any} */ (m).selectedOption);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.verified, true);
    assert.deepEqual(await optionClicks(targetId), ['option:Job Board']);
    assert.equal(await pageEval(targetId, 'document.getElementById("source--source").value'), 'synthetic-job-board');
  });
});

describe('Workday popup association, observed live commit (P3)', { skip: SKIP }, () => {
  test('picking Other replays the observed commit: value and helper input = data-value, aria-expanded and aria-controls removed after a delay', async () => {
    const { targetId, driver } = await openTab('wd-live-source.html');
    const ref = await fieldRef(driver, /How Did You Hear/);
    await driver.openListbox(ref);
    const r = await driver.pickOption('Other');
    assert.deepEqual([r.ok, r.verified], [true, true], JSON.stringify(r));
    const state = await pageEval(targetId, `(() => { const b = document.getElementById('source--source'); return [b.getAttribute('value'), b.parentElement.querySelector('input').value, b.hasAttribute('aria-expanded'), b.hasAttribute('aria-controls'), Boolean(document.getElementById('nehy5'))]; })()`);
    assert.deepEqual(state, ['d5fdc7782a551001a246697edb2f0000', 'd5fdc7782a551001a246697edb2f0000', false, false, false]);
    assert.deepEqual(await optionClicks(targetId), ['option:Other']);
  });

  test('a helper input left behind the value attribute is readback_mismatch', async () => {
    const { driver } = await openCase('helperstale');
    assert.equal((await driver.pickOption('Indeed')).reason, 'readback_mismatch');
  });
});

describe('Workday popup association, synthetic cases (P1-P5)', { skip: SKIP }, () => {
  test('linked default: options from the aria-controls popup, pick commits and verifies', async () => {
    const { targetId, driver } = await openCase('linked');
    assert.deepEqual((await driver.listOptions()).options, ['Campus Event', 'Indeed', 'Invited by Company Recruiter', 'LinkedIn', 'Other']);
    const r = await driver.pickOption('Indeed');
    assert.deepEqual([r.ok, r.verified], [true, true], JSON.stringify(r));
    assert.deepEqual(await optionClicks(targetId), ['option:Indeed']);
  });

  test('stale popup from a prior field still mounted: linked and diff modes both ignore it', async () => {
    for (const mode of ['stale', 'stale-nolink']) {
      const { targetId, driver } = await openCase(mode);
      const lo = await driver.listOptions();
      assert.deepEqual(lo.options, ['Campus Event', 'Indeed', 'Invited by Company Recruiter', 'LinkedIn', 'Other'], mode);
      const r = await driver.pickOption('Indeed');
      assert.equal(r.ok, true, `${mode}: ${JSON.stringify(r)}`);
      assert.deepEqual(await optionClicks(targetId), ['option:Indeed'], mode);
    }
  });

  test('shared container via aria-controls: another expanded owner or a foreign label parks popup_unlinked; a relabelled one passes', async () => {
    for (const mode of ['shared-expanded', 'shared-label']) {
      const { targetId, driver } = await openCase(mode);
      assert.equal((await driver.listOptions()).reason, 'popup_unlinked', mode);
      assert.equal((await driver.pickOption('Indeed')).reason, 'popup_unlinked', mode);
      assert.deepEqual(await optionClicks(targetId), [], mode);
    }
    const ok = await openCase('shared-ok');
    assert.equal((await ok.driver.pickOption('Indeed')).ok, true);
  });

  test('late popup: found by the bounded poll, not a fixed sleep', async () => {
    const { targetId, driver } = await openCase('late');
    const lo = await driver.listOptions();
    assert.equal(lo.ok, true, JSON.stringify(lo));
    assert.equal((await driver.pickOption('Other')).ok, true);
    assert.deepEqual(await optionClicks(targetId), ['option:Other']);
  });

  test('a second, unrelated new popup alongside the linked one parks multiple_popups', async () => {
    const { targetId, driver } = await openCase('conflict');
    assert.equal((await driver.listOptions()).reason, 'multiple_popups');
    assert.equal((await driver.pickOption('Indeed')).reason, 'multiple_popups');
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('diff fallback: an unlinked popup is accepted only when geometrically anchored to the trigger', async () => {
    const near = await openCase('nolink-anchored');
    assert.equal((await near.driver.listOptions()).ok, true);
    const far = await openCase('nolink-far');
    assert.equal((await far.driver.listOptions()).reason, 'popup_unlinked');
    assert.equal((await far.driver.pickOption('Indeed')).reason, 'popup_unlinked');
    assert.deepEqual(await optionClicks(far.targetId), []);
  });

  test('nesting: a strict chain reads the innermost labelled listbox; non-chain nesting parks nesting_ambiguous', async () => {
    const chain = await openCase('chain');
    assert.deepEqual((await chain.driver.listOptions()).options, ['Campus Event', 'Indeed', 'Invited by Company Recruiter', 'LinkedIn', 'Other']);
    const non = await openCase('nonchain');
    assert.equal((await non.driver.listOptions()).reason, 'nesting_ambiguous');
    assert.equal((await non.driver.pickOption('Indeed')).reason, 'nesting_ambiguous');
    assert.deepEqual(await optionClicks(non.targetId), []);
  });

  test('category and leaf with the same text: only the leaf is clickable; categories are listed apart', async () => {
    const { targetId, driver } = await openCase('samecat');
    const lo = await driver.listOptions();
    assert.deepEqual(lo.categories, ['Job Board', 'Social Media']);
    assert.ok(lo.options?.includes('Job Board') && lo.options.includes('Other'));
    const r = await driver.pickOption('Job Board');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(await optionClicks(targetId), ['option:Job Board'], 'the leaf, never the category');
  });

  test('a category is never picked as a value: a category-only match is no_exact_option', async () => {
    const { targetId, driver } = await openCase('samecat');
    assert.equal((await driver.pickOption('Social Media')).reason, 'no_exact_option');
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('a leaf outside the one expanded category parks expansion_ambiguous', async () => {
    // Social Media is collapsed (its group hidden), so LinkedIn is not even rendered: no_exact_option.
    const a = await openCase('samecat');
    assert.equal((await a.driver.pickOption('LinkedIn')).reason, 'no_exact_option');
    // Other is a top-level leaf outside the expanded Job Board group.
    const b = await openCase('samecat');
    assert.equal((await b.driver.pickOption('Other')).reason, 'expansion_ambiguous');
    assert.deepEqual(await optionClicks(b.targetId), []);
  });

  test('expandCategory clicks only an exact, classified, unexpanded category', async () => {
    const { targetId, driver } = await openCase('samecat');
    assert.equal((await driver.expandCategory('social')).reason, 'no_exact_category');
    assert.equal((await driver.expandCategory('Social Media')).reason, 'expansion_ambiguous', 'Job Board is already expanded');
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('two expanded categories park expansion_ambiguous', async () => {
    const { targetId, driver } = await openCase('twoexp');
    assert.equal((await driver.pickOption('Indeed')).reason, 'expansion_ambiguous');
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('a row with conflicting category signals parks category_unclassified', async () => {
    const { targetId, driver } = await openCase('unclassified');
    assert.equal((await driver.listOptions()).reason, 'category_unclassified');
    assert.equal((await driver.pickOption('Indeed')).reason, 'category_unclassified');
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('aria-label embedding a previous value: the committed value is read, so an uncommitted pick is readback_mismatch', async () => {
    const { driver } = await openCase('nocommit');
    const r = await driver.pickOption('Indeed');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'readback_mismatch');
    const pl = await openCase('prevlabel');
    const r2 = await pl.driver.pickOption('Indeed');
    assert.deepEqual([r2.ok, r2.verified], [true, true], JSON.stringify(r2));
  });

  test('truncated display: verified from the committed value, not the visible label', async () => {
    const { targetId, driver } = await openCase('truncated');
    const r = await driver.pickOption('Invited by Company Recruiter');
    assert.deepEqual([r.ok, r.verified], [true, true], JSON.stringify(r));
    assert.notEqual(await pageEval(targetId, 'document.getElementById("source-btn").textContent'), 'Invited by Company Recruiter');
  });

  test('a popup that stays open after the pick is readback_mismatch', async () => {
    const { driver } = await openCase('staysopen');
    assert.equal((await driver.pickOption('Indeed')).reason, 'readback_mismatch');
  });

  test('multiselect with a prefilled pill: the pill set is not exactly {chosen}, multiselect_extra_pill', async () => {
    const { driver } = await openCase('multi');
    assert.equal((await driver.pickOption('Indeed')).reason, 'multiselect_extra_pill');
  });

  test('virtualized list: enumerated by bounded scrolling; an off-screen duplicate is ambiguous; a far option is picked', async () => {
    const { targetId, driver } = await openCase('virtual');
    const lo = await driver.listOptions();
    assert.equal(lo.ok, true, JSON.stringify(lo));
    assert.equal(lo.options?.length, 40);
    assert.equal((await driver.pickOption('Indeed')).reason, 'ambiguous_option');
    assert.deepEqual(await optionClicks(targetId), []);
    const r = await driver.pickOption('Source 30');
    assert.deepEqual([r.ok, r.verified], [true, true], JSON.stringify(r));
    assert.deepEqual(await optionClicks(targetId), ['option:Source 30']);
  });

  test('virtualized list that never renders past its first window: list_incomplete', async () => {
    const { targetId, driver } = await openCase('virtual-stuck');
    assert.equal((await driver.listOptions()).reason, 'list_incomplete');
    assert.equal((await driver.pickOption('Source 30')).reason, 'list_incomplete');
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('pickOption without an open prompt parks no_popup', async () => {
    const { driver } = await openTab('wd-popup-cases.html');
    assert.equal((await driver.pickOption('Indeed')).reason, 'no_popup');
  });

  test('scope gate: the LinkedIn profile carries no strict association flag', () => {
    assert.ok(WORKDAY_PROFILE.rules.listbox.strictAssociation === true);
    assert.ok(!(/** @type {any} */ (LINKEDIN_PROFILE.rules).listbox && /** @type {any} */ (LINKEDIN_PROFILE.rules).listbox.strictAssociation));
  });
});
