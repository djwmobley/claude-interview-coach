// @ts-check
/**
 * src/core/resume-leak-gate.js: deterministic private-data check on generated resume markdown. Fixture
 * profile with FAKE values only (test/helpers/fixture-profile.js); nothing personal appears here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePrivateFields, scanResume, loadPrivateFields, checkResumeFile, amountsIn } from '../src/core/resume-leak-gate.js';
import { FIXTURE_PROFILE, FAKE, writeFixtureProfile } from './helpers/fixture-profile.js';

const fields = parsePrivateFields(FIXTURE_PROFILE);
const LEGIT = `${FAKE.name}\nHouston, TX | ${FAKE.phone} | ${FAKE.email} | https://www.linkedin.com/in/pat-example\n\nManaged a $20M technology budget and led 450 people since 2019. Grew revenue 35%.\n`;

describe('scanResume', () => {
  test('legitimate contact line, city, LinkedIn, $20M budget, years: passes', () => {
    assert.deepEqual(scanResume(LEGIT, fields), { ok: true });
  });
  test('street line leaks, even with changed case and punctuation', () => {
    assert.equal(scanResume(`x\n${FAKE.street.toUpperCase()}.\n`, fields).ok, false);
  });
  test('ZIP leaks, including ZIP+4, but a longer number containing it does not', () => {
    assert.equal(scanResume(`Nowhereville TX ${FAKE.zip}`, fields).ok, false);
    assert.equal(scanResume(`Nowhereville TX ${FAKE.zip}-1234`, fields).ok, false);
    assert.equal(scanResume(`Order ${FAKE.zip}7 units`, fields).ok, true);
  });
  test('date of birth and a field marked private leak', () => {
    assert.equal(scanResume(`Born ${FAKE.dob}`, fields).ok, false);
    assert.equal(scanResume(`note ${FAKE.secret}`, fields).ok, false);
  });
  test('profile compensation figure leaks in any spelling', () => {
    for (const t of [FAKE.salaryA, FAKE.salaryDigits, '777k', '$777K', '777,000', FAKE.bonus]) assert.equal(scanResume(`ask: ${t}`, fields).ok, false, t);
  });
  test('any compensation pattern leaks even when not in the profile', () => {
    for (const t of ['$185K', '$185k base', '$185,000', '$1500000', '$2,500,000']) {
      const r = scanResume(`salary ${t}`, fields);
      assert.equal(r.ok, false, t);
      assert.equal(/** @type {any} */ (r).reason, 'private_data_leak');
    }
  });
  test('achievement bullets with dollar amounts pass; compensation lines with them fail', () => {
    for (const t of ['Cut technology spend by $450K', '$250,000 cost savings', 'Saved $1,200,000 in cloud licensing', 'Reduced licensing cost by $75K a year']) {
      assert.deepEqual(scanResume(`- ${t}\n`, fields), { ok: true }, t);
    }
    for (const t of ['Expected salary: $225K', 'Base compensation $225,000', 'Target OTE $300,000', 'Desired rate $185K']) {
      assert.equal(scanResume(`Cut spend by $450K\n${t}\n`, fields).ok, false, t);
    }
  });
  test('a profile compensation value fails even without a context word', () => {
    for (const t of ['777k', '$777K', '777,000', '777000']) assert.equal(scanResume(`- Cut spend to ${t}\n`, fields).ok, false, t);
  });
  test('the detail names a kind, never a value', () => {
    const r = /** @type {any} */ (scanResume(`${FAKE.street}`, fields));
    assert.ok(!JSON.stringify(r).includes(FAKE.street));
  });
});

describe('parsePrivateFields: total classification, fail closed', () => {
  test('field order and blank lines do not matter', () => {
    const shuffled = FIXTURE_PROFILE.split('\n').reverse().join('\n\n');
    assert.equal(scanResume(`${FAKE.street}`, parsePrivateFields(shuffled)).ok, false);
  });
  test('a profile with no address line throws', () => {
    assert.throws(() => parsePrivateFields('# Profile\n\n- **Name:** Someone\n'));
  });
  test('a profile with no field lines throws', () => {
    assert.throws(() => parsePrivateFields('just prose, no fields'));
  });
  test('missing file is reported as private_data_profile_unreadable', () => {
    const r = loadPrivateFields(path.join(os.tmpdir(), 'zz-no-such-profile.md'));
    assert.equal(r.ok, false);
    assert.equal(/** @type {any} */ (r).reason, 'private_data_profile_unreadable');
  });
});

describe('checkResumeFile', () => {
  test('reads profile and markdown from disk; an unreadable markdown blocks too', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-gate-'));
    writeFixtureProfile(root);
    fs.mkdirSync(path.join(root, 'output', 'markdown'), { recursive: true });
    fs.writeFileSync(path.join(root, 'output', 'markdown', 'a.md'), LEGIT);
    fs.writeFileSync(path.join(root, 'output', 'markdown', 'b.md'), `${LEGIT}${FAKE.street}\n`);
    assert.equal(checkResumeFile({ repoRoot: root, markdownPath: 'output/markdown/a.md' }).ok, true);
    assert.equal(checkResumeFile({ repoRoot: root, markdownPath: 'output/markdown/b.md' }).ok, false);
    assert.equal(checkResumeFile({ repoRoot: root, markdownPath: 'output/markdown/none.md' }).ok, false);
  });
});

describe('amountsIn', () => {
  test('normalizes K, M, commas', () => {
    assert.deepEqual([...amountsIn('$225K and 1.5M and 90,000 and 2019')].sort(), ['1500000', '225000', '90000']);
  });
});
