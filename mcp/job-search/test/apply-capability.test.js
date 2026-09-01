// @ts-check
/**
 * src/apply/apply-capability.js (apply pipeline slice 5): the frozen {fill, select, click, upload,
 * screenshot, waitFor} capability, against a fake Playwright Page (no real Chrome). Upload-path
 * confinement (must resolve under output/) and the abort-signal guard are covered here too.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeApplyCapability } from '../src/apply/apply-capability.js';

/** @type {string} */
let outputRoot;
test.beforeEach(() => {
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-apply-cap-'));
  fs.mkdirSync(path.join(outputRoot, 'resumes'), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'resumes', 'jordan-reyes-cto.docx'), 'fake docx bytes');
});
test.afterEach(() => {
  fs.rmSync(outputRoot, { recursive: true, force: true });
});

/** Fake Playwright Page: just enough surface for makeApplyCapability's own calls. */
function makeFakePage(opts = {}) {
  const calls = [];
  return {
    calls,
    async fill(selector, value) { calls.push(['fill', selector, value]); },
    async selectOption(selector, value) { calls.push(['selectOption', selector, value]); },
    async click(selector) { calls.push(['click', selector]); },
    async setInputFiles(selector, absPath) { calls.push(['setInputFiles', selector, absPath]); },
    async screenshot(o) { calls.push(['screenshot', o]); return Buffer.from([9, 9, 9]); },
    async waitForSelector(selector, o) {
      calls.push(['waitForSelector', selector, o]);
      if (opts.waitForSelectorThrows) throw new Error('timeout');
      return {};
    },
    async $eval(selector, fn) {
      calls.push(['$eval', selector]);
      if (opts.$evalResult) return typeof opts.$evalResult === 'function' ? opts.$evalResult(selector) : opts.$evalResult;
      return null;
    },
    async $$eval(selector, fn) {
      calls.push(['$$eval', selector]);
      return opts.$$evalResult ?? [];
    },
  };
}

describe('makeApplyCapability: fill/select/click', () => {
  test('delegate directly to the page', async () => {
    const page = makeFakePage();
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    await cap.fill('#a', 'x');
    await cap.select('#b', 'y');
    await cap.click('#c');
    assert.deepEqual(page.calls, [['fill', '#a', 'x'], ['selectOption', '#b', 'y'], ['click', '#c']]);
  });

  test('every method throws once the abort signal fires', async () => {
    const controller = new AbortController();
    const page = makeFakePage();
    const cap = makeApplyCapability(page, { signal: controller.signal, applicationId: 1, outputRoot });
    controller.abort();
    await assert.rejects(() => cap.fill('#a', 'x'));
    await assert.rejects(() => cap.click('#a'));
    await assert.rejects(() => cap.select('#a', 'x'));
    await assert.rejects(() => cap.upload('#a', 'resumes/jordan-reyes-cto.docx'));
    await assert.rejects(() => cap.screenshot());
    await assert.rejects(() => cap.waitFor('#a'));
  });
});

describe('makeApplyCapability.upload: resolves under output/ only', () => {
  test('a real file under output/ uploads and returns the browser-reported filename', async () => {
    const page = makeFakePage({ $evalResult: 'jordan-reyes-cto.docx' });
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    const name = await cap.upload('#resume', 'resumes/jordan-reyes-cto.docx');
    assert.equal(name, 'jordan-reyes-cto.docx');
    const setCall = page.calls.find((c) => c[0] === 'setInputFiles');
    assert.ok(setCall[2].startsWith(outputRoot));
  });

  test('a path traversal attempt is rejected before touching the page', async () => {
    const page = makeFakePage();
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    await assert.rejects(() => cap.upload('#resume', '../../etc/passwd'), /cannot upload/);
    assert.equal(page.calls.length, 0);
  });

  test('a nonexistent file under a valid dir is rejected', async () => {
    const page = makeFakePage();
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    await assert.rejects(() => cap.upload('#resume', 'resumes/does-not-exist.docx'), /cannot upload/);
  });

  test('a file outside the allowed DOCUMENT_DIRS is rejected', async () => {
    fs.writeFileSync(path.join(outputRoot, 'secret.docx'), 'x');
    const page = makeFakePage();
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    await assert.rejects(() => cap.upload('#resume', 'secret.docx'), /cannot upload/);
  });
});

describe('makeApplyCapability.screenshot: delegates to the confinement helper', () => {
  test('captures page bytes and writes them under output/applications/<id>/', async () => {
    const page = makeFakePage();
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 55, outputRoot });
    const { relPath, absPath } = await cap.screenshot();
    assert.match(relPath, /^applications\/55\//);
    assert.equal(fs.readFileSync(absPath).equals(Buffer.from([9, 9, 9])), true);
  });
});

describe('makeApplyCapability.waitFor', () => {
  test('single-match mode returns the element shape on success', async () => {
    const page = makeFakePage({ $evalResult: { tagName: 'input', text: '', value: 'x' } });
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    const info = await cap.waitFor('#a');
    assert.equal(info.tagName, 'input');
  });

  test('single-match mode throws UNRECOGNIZED_PAGE on timeout by default', async () => {
    const page = makeFakePage({ waitForSelectorThrows: true });
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    await assert.rejects(() => cap.waitFor('#missing'), /UNRECOGNIZED_PAGE|waitFor timed out/);
  });

  test('single-match mode with optional:true returns null on timeout instead of throwing', async () => {
    const page = makeFakePage({ waitForSelectorThrows: true });
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    const info = await cap.waitFor('#missing', { optional: true });
    assert.equal(info, null);
  });

  test('all:true returns an array on success, [] on timeout (never throws)', async () => {
    const page = makeFakePage({ $$evalResult: [{ tagName: 'input' }, { tagName: 'select' }] });
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    const infos = await cap.waitFor('.field', { all: true });
    assert.equal(infos.length, 2);

    const page2 = makeFakePage({ waitForSelectorThrows: true });
    const cap2 = makeApplyCapability(page2, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    const empty = await cap2.waitFor('.field', { all: true });
    assert.deepEqual(empty, []);
  });
});

describe('makeApplyCapability is frozen', () => {
  test('cannot be mutated at runtime', async () => {
    const page = makeFakePage();
    const cap = makeApplyCapability(page, { signal: new AbortController().signal, applicationId: 1, outputRoot });
    assert.throws(() => { /** @type {any} */ (cap).fill = async () => {}; }, TypeError);
  });
});
