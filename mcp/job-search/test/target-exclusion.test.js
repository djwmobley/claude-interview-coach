// @ts-check
/**
 * src/core/target-exclusion.js: the signal-specific exclusion wrapper and the blocked_affiliates loader.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeName, strippedForm, SIGNAL_EXCLUSION_MAP, MAPPED_BRANCHES, mapExclusionBranch, classifySignalExclusion,
  loadBlockedAffiliates, seedBlockedAffiliates, blockedAffiliatesPath,
} from '../src/core/target-exclusion.js';
import { EXCLUSION_BRANCHES, BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { loadTargetRules } from '../src/core/target-classify.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(HERE, '..', 'config');
const RULES = loadTargetRules(CONFIG_DIR);

/** @param {string} prefix */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

describe('normalization', () => {
  test('NFKC, zero-width, soft hyphen, and whitespace', () => {
    assert.equal(normalizeName('Ａdvisicon'), 'Advisicon');
    assert.equal(normalizeName('Adv​‌‍﻿isi­con'), 'Advisicon');
    assert.equal(normalizeName('  Acme \n\t Corp  '), 'Acme Corp');
    assert.equal(normalizeName(null), '');
    assert.equal(normalizeName({}), '');
    assert.equal(normalizeName(42), '42');
  });
  test('strippedForm folds spacing, punctuation, case, and accents', () => {
    assert.equal(strippedForm('Ad-vis icon'), 'advisicon');
    assert.equal(strippedForm('Advisicón'), 'advisicon');
  });
});

describe('SIGNAL_EXCLUSION_MAP: every classifyExclusion branch is mapped, none falls through to target', () => {
  test('the map keys are exactly the EXCLUSION_BRANCHES enum', () => {
    assert.deepEqual([...MAPPED_BRANCHES].sort(), [...EXCLUSION_BRANCHES].sort());
    assert.equal(EXCLUSION_BRANCHES.length, 8);
  });
  test('each branch maps to a registered rule with the same class, or is the single eligible pass', () => {
    const registry = new Map(RULES.verdict_rules.map((r) => [r.rule, r.class]));
    for (const b of EXCLUSION_BRANCHES) {
      const m = SIGNAL_EXCLUSION_MAP[b];
      if (b === 'eligible') {
        assert.deepEqual(m, { class: null, rule: null });
        continue;
      }
      assert.ok(m.class === 'not-target' || m.class === 'needs-review', `${b} must not map to target`);
      assert.equal(registry.get(/** @type {string} */ (m.rule)), m.class, b);
    }
  });
  test('only blocked_company is not-target; everything else is needs-review', () => {
    const notTarget = EXCLUSION_BRANCHES.filter((b) => SIGNAL_EXCLUSION_MAP[b].class === 'not-target');
    assert.deepEqual(notTarget, ['blocked_company']);
  });
  test('an unknown or prototype-poking branch name is needs-review, never a pass', () => {
    for (const b of ['', 'nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.deepEqual(mapExclusionBranch(b), { class: 'needs-review', rule: 'excl_unmapped_branch' }, b);
    }
  });
});

describe('classifySignalExclusion', () => {
  const ctx = { blocked: [...BUILT_IN_BLOCKED, 'Zenith Parent Group'] };
  test('eligible company', () => {
    assert.equal(classifySignalExclusion({ company: 'Northwind Logistics' }, ctx).branch, 'eligible');
  });
  test('whole-token subset on the company: Advisicon Holdings, Immunotec Research', () => {
    assert.equal(classifySignalExclusion({ company: 'Advisicon Holdings' }, ctx).branch, 'blocked_company');
    assert.equal(classifySignalExclusion({ company: 'Immunotec Research Inc' }, ctx).branch, 'blocked_company');
  });
  test('a substring of a longer word is only suspect (space-stripped), never blocked_company', () => {
    const r = classifySignalExclusion({ company: 'Immunotechnology Partners' }, ctx);
    assert.equal(r.branch, 'blocked_company_suspect');
    assert.equal(/** @type {any} */ (r.detail.matched).via, 'stripped');
  });
  test('blocked party in other parties and in texts', () => {
    assert.equal(classifySignalExclusion({ company: 'Northwind', otherParties: ['Zenith Parent Group LLC'] }, ctx).branch, 'blocked_company_suspect');
    assert.equal(classifySignalExclusion({ company: 'Northwind', texts: ['a client of Zenith Parent Group'] }, ctx).branch, 'blocked_company_suspect');
    assert.equal(classifySignalExclusion({ company: 'Northwind', texts: ['https://apply.advisicon.com/x'] }, ctx).branch, 'blocked_company_suspect');
  });
  test('short blocked entries are not substring-matched on the stripped form', () => {
    const r = classifySignalExclusion({ company: 'Northwind Logistics', texts: ['the xabcx group'] }, { blocked: ['ABC'] });
    assert.equal(r.branch, 'eligible');
    // but the whole-token match still blocks the company itself
    assert.equal(classifySignalExclusion({ company: 'ABC Corp' }, { blocked: ['ABC'] }).branch, 'blocked_company');
  });
  test('blocked_company beats suspect beats unknown', () => {
    const r = classifySignalExclusion({ company: 'Advisicon', otherParties: ['Zenith Parent Group'] }, ctx);
    assert.equal(r.branch, 'blocked_company');
    const r2 = classifySignalExclusion({ company: 'Confidential', otherParties: ['Zenith Parent Group'] }, ctx);
    assert.equal(r2.branch, 'blocked_company_suspect');
  });
  test('garbage inputs never throw and never pass an unknown company', () => {
    for (const company of [undefined, null, 5, {}, [], '']) {
      const r = classifySignalExclusion({ company, aliases: [null, 7, {}], otherParties: [undefined], texts: [{}, []] }, ctx);
      assert.equal(r.branch, 'unknown_company');
    }
  });
  test('an empty or whitespace blocked entry matches nothing', () => {
    assert.equal(classifySignalExclusion({ company: 'Northwind Logistics', texts: ['anything'] }, { blocked: ['', '   '] }).branch, 'eligible');
  });
});

describe('blocked_affiliates config', () => {
  test('the tracked example is valid JSON with an empty list', () => {
    const ex = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'blocked-affiliates.example.json'), 'utf8'));
    assert.deepEqual(ex.blocked_affiliates, []);
  });
  test('missing file: built-ins only, status missing', () => {
    const dir = tmpDir('ba-missing');
    const r = loadBlockedAffiliates(dir);
    assert.equal(r.status, 'missing');
    assert.deepEqual(r.entries, [...BUILT_IN_BLOCKED]);
  });
  test('invalid JSON, wrong shape, and bad entries: built-ins only, status invalid', () => {
    for (const body of ['{not json', '[]', '{"blocked_affiliates": "x"}', '{"blocked_affiliates": [1]}', '{"blocked_affiliates": ["  "]}', '{}']) {
      const dir = tmpDir('ba-invalid');
      fs.writeFileSync(blockedAffiliatesPath(dir), body);
      const r = loadBlockedAffiliates(dir);
      assert.equal(r.status, 'invalid', body);
      assert.deepEqual(r.entries, [...BUILT_IN_BLOCKED], body);
    }
  });
  test('valid file: built-ins first, then the configured entries; built-ins cannot be removed', () => {
    const dir = tmpDir('ba-ok');
    fs.writeFileSync(blockedAffiliatesPath(dir), JSON.stringify({ blocked_affiliates: ['Zenith Parent Group'] }));
    const r = loadBlockedAffiliates(dir);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.entries, [...BUILT_IN_BLOCKED, 'Zenith Parent Group']);
  });
  test('seed copies the empty example once and never overwrites', () => {
    const dir = tmpDir('ba-seed');
    assert.equal(seedBlockedAffiliates(dir), 'no_example');
    fs.copyFileSync(path.join(CONFIG_DIR, 'blocked-affiliates.example.json'), path.join(dir, 'blocked-affiliates.example.json'));
    assert.equal(seedBlockedAffiliates(dir), 'seeded');
    assert.equal(loadBlockedAffiliates(dir).status, 'ok');
    fs.writeFileSync(blockedAffiliatesPath(dir), JSON.stringify({ blocked_affiliates: ['Keep Me'] }));
    assert.equal(seedBlockedAffiliates(dir), 'exists');
    assert.deepEqual(loadBlockedAffiliates(dir).entries.slice(-1), ['Keep Me']);
  });
  test('the real blocked-affiliates.json is gitignored and the example is tracked', () => {
    const gi = fs.readFileSync(path.join(HERE, '..', '..', '..', '.gitignore'), 'utf8');
    assert.ok(gi.split('\n').includes('mcp/job-search/config/blocked-affiliates.json'));
    assert.ok(!gi.split('\n').includes('mcp/job-search/config/blocked-affiliates.example.json'));
  });
});
