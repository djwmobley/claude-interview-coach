// @ts-check
/**
 * "Never target" versus "never mention" (PR5b). TARGET_EXCLUDE keeps Immunotec (a former employer must never be a
 * target); MENTION_FORBIDDEN lifts it (a fact or draft may name a past role) but keeps the current employer and every
 * blocked affiliate. Total classification: a built-in with any role other than former_employer, or no role, is
 * mention-forbidden. No database, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILT_IN_BLOCKED, BUILT_IN_ROLES } from '../src/apply/exclusions.js';
import { mentionForbiddenFrom, builtInMentionForbidden, roleIsMentionForbidden } from '../src/core/mention-forbidden.js';
import { loadBlockedAffiliates, classifySignalExclusion } from '../src/core/target-exclusion.js';
import { loadDraftConfig } from '../src/targets/draft-context.js';
import { validatePitchFacts } from '../src/targets/pitch-facts.js';
import { runGates } from '../src/targets/draft-gates.js';
import { goldenCtx, goldenInput, makeConfigDir, FACTS, GOLDEN_FIELDS } from './helpers/targets-pr5.js';

const U = (/** @type {number} */ cp) => String.fromCodePoint(cp);
/** @param {ReturnType<typeof runGates>} r */
const blockedOk = (r) => /** @type {any} */ (r.results.find((x) => x.gate === 'blocked_names')).ok;

/** @param {string} dir @param {string} text */
function writeFacts(dir, text) {
  fs.writeFileSync(path.join(dir, 'target-pitch-facts.json'), JSON.stringify({
    facts: [{ id: 'c1', text, tags: ['leadership'] }, FACTS[1]], signoff: 'Best,\nPat Candidate', candidate_names: ['Pat Candidate'], denylist: [],
  }));
}

describe('roles and the two lists', () => {
  test('every built-in has an explicit role; Immunotec is former, Advisicon is current', () => {
    assert.deepEqual([...BUILT_IN_BLOCKED].sort(), Object.keys(BUILT_IN_ROLES).sort());
    assert.equal(BUILT_IN_ROLES.Immunotec, 'former_employer');
    assert.equal(BUILT_IN_ROLES.Advisicon, 'current_employer');
  });
  test('TARGET_EXCLUDE is unchanged: built-ins first, then affiliates', () => {
    const dir = makeConfigDir({ blocked: ['Zorbco Holdings'] });
    assert.deepEqual(loadBlockedAffiliates(dir).entries, ['Immunotec', 'Advisicon', 'Zorbco Holdings']);
  });
  test('MENTION_FORBIDDEN is the current employer plus affiliates, not the former employer', () => {
    assert.deepEqual(mentionForbiddenFrom(['Immunotec', 'Advisicon', 'Zorbco Holdings']), ['Advisicon', 'Zorbco Holdings']);
    assert.deepEqual(builtInMentionForbidden(), ['Advisicon']);
  });
  test('an unknown role, a missing role, or a non-string role is mention-forbidden', () => {
    assert.equal(roleIsMentionForbidden('former_employer'), false);
    for (const r of ['current_employer', 'parent', '', 'FORMER_EMPLOYER', undefined, null, 7]) assert.equal(roleIsMentionForbidden(r), true, String(r));
    assert.deepEqual(builtInMentionForbidden({ Immunotec: 'consultant', Advisicon: 'current_employer' }), ['Immunotec', 'Advisicon']);
    assert.deepEqual(builtInMentionForbidden({ Advisicon: 'current_employer' }), ['Immunotec', 'Advisicon']);
    assert.deepEqual(builtInMentionForbidden({}), ['Immunotec', 'Advisicon']);
  });
  test('an affiliate entry repeating the former employer stays forbidden; a list without the built-in prefix lifts nothing', () => {
    assert.deepEqual(mentionForbiddenFrom(['Immunotec', 'Advisicon', 'Immunotec']), ['Advisicon', 'Immunotec']);
    assert.deepEqual(mentionForbiddenFrom(['Advisicon', 'Immunotec']), ['Advisicon', 'Immunotec']);
    assert.deepEqual(mentionForbiddenFrom(['Zorbco']), ['Zorbco']);
    assert.deepEqual(mentionForbiddenFrom(/** @type {any} */ (null)), []);
  });
});

describe('targets still exclude the former employer', () => {
  test('a target whose company is Immunotec is blocked_company; so is Advisicon', () => {
    const blocked = loadBlockedAffiliates(makeConfigDir()).entries;
    assert.equal(classifySignalExclusion({ company: 'Immunotec' }, { blocked }).branch, 'blocked_company');
    assert.equal(classifySignalExclusion({ company: 'Advisicon' }, { blocked }).branch, 'blocked_company');
  });
});

describe('pitch facts', () => {
  const dir0 = makeConfigDir();
  const mention = loadDraftConfig(dir0);
  test('loadDraftConfig hands the loader and the gates the mention list', () => {
    assert.equal(mention.ok, true);
    assert.deepEqual(/** @type {any} */ (mention).blockedEntries, ['Advisicon', 'Zorbco Holdings']);
  });
  test('a fact naming Immunotec as a past role loads', () => {
    const dir = makeConfigDir();
    writeFacts(dir, 'I was CTO at Immunotec and ran platform and product teams.');
    const c = loadDraftConfig(dir);
    assert.equal(c.ok, true, JSON.stringify(c));
  });
  test('facts naming Advisicon (plain, confusable, split), or an affiliate, are rejected', () => {
    for (const text of ['I work with Advisicon on platforms.', `I work with ${U(0x410)}dvisicon on platforms.`, 'I work with Adv1sicon on platforms.', 'I work with Advi sicon on platforms.', 'I worked with Zorbco Holdings on platforms.']) {
      const dir = makeConfigDir();
      writeFacts(dir, text);
      const c = loadDraftConfig(dir);
      assert.equal(c.ok, false, text);
      assert.equal(/** @type {any} */ (c).reason, 'facts_invalid', text);
    }
  });
  test('validatePitchFacts with an entry that has no role in the list is still rejected', () => {
    const raw = { facts: [{ id: 'c1', text: 'I advised Orbital Dynamics on platforms.' }] };
    const forbidden = mentionForbiddenFrom(['Immunotec', 'Advisicon', 'Orbital Dynamics']);
    assert.equal(validatePitchFacts(raw, forbidden).status, 'invalid');
  });
});

describe('draft gates', () => {
  const ctx = goldenCtx({ blockedEntries: mentionForbiddenFrom(['Immunotec', 'Advisicon', 'Zorbco Holdings']) });
  /** @param {string} text */
  const withBridge = (text) => {
    const bridge = `${GOLDEN_FIELDS.bridge} ${text}`;
    return goldenInput({ bridge }, (s) => { s[1].text = bridge; return s; }, ctx);
  };
  test('a draft naming Immunotec as a past role passes the blocked-name gate', () => {
    assert.equal(blockedOk(runGates(withBridge('I was CTO at Immunotec.'))), true);
  });
  test('Advisicon, its confusable forms, and an affiliate still fail', () => {
    for (const form of ['Advisicon', 'ADVISICON', `${U(0x410)}dvisicon`, `Advis${U(0x3b9)}con`, 'Adv1sicon', 'Advi sicon', `Advi${U(0x200b)}sicon`, 'Zorbco Holdings', 'zorbco-holdings']) {
      assert.equal(blockedOk(runGates(withBridge(`We know ${form} well.`))), false, form);
    }
  });
});
