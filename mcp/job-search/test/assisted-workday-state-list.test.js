// @ts-check
/**
 * Workday State prompt (popup association spec v2, P4) against test/fixtures/assisted-workday/wd-live-state.html,
 * a sanitized copy of a 2026-10-06 read-only probe of application 5's tenant: one ul[role=listbox] that is
 * itself the scroll container (clientHeight 200, scrollHeight 1952), all 61 rows rendered at once with
 * id == data-value, no aria-setsize, and a widget that resets the list's scrollTop to 0 shortly after
 * opening (which made the old enumeration read a backward jump as a stalled scroller: list_incomplete).
 * Also: a windowed (virtualized) variant, one that never renders past its first window, and duplicate
 * identity keys in both. The bank's state fact is type text; a text fact is placed on a listbox by the same
 * exact matcher as an enum (assisted/answers.js finishValue). Skips with no Chrome/Edge binary.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from '../src/browser/cdp-target.js';
import { createAssistedDriver } from '../src/apply/assisted/driver.js';
import { WORKDAY_PROFILE } from '../src/apply/assisted/profiles/workday.js';
import { parseAnswerBank } from '../src/apply/answers.js';
import { resolveFieldAnswer } from '../src/apply/assisted/answers.js';
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

/** Open the State prompt of a wd-live-state mode. @param {string} query */
async function openState(query = '') {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const driver = createAssistedDriver({ cdp, targetId, profile: WORKDAY_PROFILE, pacing: false, sleep: (ms) => new Promise((r) => { setTimeout(r, Math.min(ms, 50)); }) });
  await driver.attach();
  await driver.navigate(`${chrome.baseUrl}/wd-live-state.html${query}`, { pollMs: 50 });
  const snap = await driver.snapshot();
  const f = snap.fields.find((/** @type {any} */ x) => /^State\b/.test(x.question));
  assert.ok(f, `State field present: ${JSON.stringify(snap.fields.map((/** @type {any} */ x) => x.question))}`);
  assert.equal(f.kind, 'listbox');
  const op = await driver.openListbox(f.ref);
  assert.equal(op.ok, true, JSON.stringify(op));
  return { targetId, driver };
}

/** @param {string} targetId */
const optionClicks = (targetId) => pageEval(targetId, 'window.__clicks.filter((c) => c.startsWith("option:"))');

/** The bank's state fact as stored (type text), resolved the way the assisted tool resolves a listbox. */
const STATE_BANK = (/** @type {string} */ v) => parseAnswerBank(['## state', 'type: text', `value: ${v}`].join('\n'));
const ctxFor = (/** @type {string} */ v) => ({ bank: STATE_BANK(v), accountEmail: null, contactLabels: WORKDAY_PROFILE.contactLabels });

describe('Workday State prompt, live-shaped (all rows rendered, scroll reset after open)', { skip: SKIP }, () => {
  test('full enumeration finds Texas exactly once; the text fact resolves to it; the pick is committed and read back', async () => {
    const { targetId, driver } = await openState();
    const lo = await driver.listOptions();
    assert.equal(lo.ok, true, JSON.stringify(lo));
    assert.equal(lo.options?.length, 60, 'Select One (disabled) is not an option');
    assert.deepEqual(lo.options?.filter((o) => o === 'Texas'), ['Texas']);
    assert.equal(lo.options?.[0], 'Alabama');
    assert.equal(lo.options?.[59], 'Wyoming');
    const decision = resolveFieldAnswer({ question: 'State', kind: 'select', required: true, options: lo.options ?? [] }, ctxFor('Texas'));
    assert.deepEqual(decision, { action: 'fill', value: 'Texas', bankKey: 'state', source: 'contact' });
    const r = await driver.pickOption(/** @type {any} */ (decision).value);
    assert.deepEqual([r.ok, r.verified], [true, true], JSON.stringify(r));
    assert.deepEqual(await optionClicks(targetId), ['option:Texas']);
    assert.equal(await pageEval(targetId, 'document.getElementById("address--countryRegion").getAttribute("value")'), 'synthetic-state-51');
  });

  test('the reset lands mid-enumeration on a late widget too: still complete', async () => {
    const { driver } = await openState('?reset=150');
    const lo = await driver.listOptions();
    assert.equal(lo.ok, true, JSON.stringify(lo));
    assert.equal(lo.options?.length, 60);
  });

  test('a duplicate Texas row reusing the same id/data-value is not hidden: ambiguous, nothing clicked', async () => {
    const { targetId, driver } = await openState('?mode=dupkey');
    const lo = await driver.listOptions();
    assert.equal(lo.ok, true, JSON.stringify(lo));
    assert.deepEqual(lo.options?.filter((o) => o === 'Texas'), ['Texas', 'Texas']);
    assert.equal((await driver.pickOption('Texas')).reason, 'ambiguous_option');
    assert.deepEqual(await optionClicks(targetId), []);
  });
});

describe('Workday State prompt, windowed (virtualized) variants', { skip: SKIP }, () => {
  test('a windowed list is enumerated by bounded scrolling despite the scroll reset; Texas is picked', async () => {
    const { targetId, driver } = await openState('?mode=virtual');
    const lo = await driver.listOptions();
    assert.equal(lo.ok, true, JSON.stringify(lo));
    assert.equal(lo.options?.length, 60);
    assert.deepEqual(lo.options?.filter((o) => o === 'Texas'), ['Texas']);
    const r = await driver.pickOption('Texas');
    assert.deepEqual([r.ok, r.verified], [true, true], JSON.stringify(r));
    assert.deepEqual(await optionClicks(targetId), ['option:Texas']);
  });

  test('truncated enumeration (never renders past its first window) still parks list_incomplete', async () => {
    const { targetId, driver } = await openState('?mode=stuck');
    assert.equal((await driver.listOptions()).reason, 'list_incomplete');
    assert.equal((await driver.pickOption('Texas')).reason, 'list_incomplete');
    assert.deepEqual(await optionClicks(targetId), []);
  });

  test('a duplicate identity key in a windowed list does not merge away the second row: list_incomplete, nothing clicked', async () => {
    const { targetId, driver } = await openState('?mode=dupkey-virtual');
    const r = await driver.pickOption('Texas');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'list_incomplete');
    assert.deepEqual(await optionClicks(targetId), []);
  });
});

describe('text-type bank fact on a listbox control', () => {
  const OPTIONS = ['Tennessee', 'Texas', 'Utah'];
  test('a text fact is matched by the same exact matcher as an enum: Texas -> Texas', () => {
    assert.deepEqual(resolveFieldAnswer({ question: 'State', kind: 'select', required: true, options: OPTIONS }, ctxFor('Texas')), { action: 'fill', value: 'Texas', bankKey: 'state', source: 'contact' });
  });
  test('no abbreviation or partial match: TX and Tex park no_exact_option', () => {
    for (const v of ['TX', 'Tex']) {
      assert.deepEqual(resolveFieldAnswer({ question: 'State', kind: 'select', required: true, options: OPTIONS }, ctxFor(v)), { action: 'park', reason: 'no_exact_option', bankKey: 'state' });
    }
  });
});
