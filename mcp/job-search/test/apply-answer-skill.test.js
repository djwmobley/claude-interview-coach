// @ts-check
/**
 * .claude/skills/apply-answer/SKILL.md (apply pipeline slice 8): grep-based structural checks, same style
 * as test/apply-lint.test.js. SKILL.md is markdown a model reads, not code this suite can execute, so this
 * is not a live-fire test of the skill's own behavior -- it only proves the file's frontmatter, its
 * referenced dashboard endpoints, and its two mandatory behavioral guarantees (the pending-question-kind
 * check, and the never-post-before-explicit-approval rule) are actually present in the text a model will
 * read, so a future edit that silently drops one of them fails this test instead of shipping quietly.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// test/ -> mcp/job-search -> mcp -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, '.claude', 'skills', 'apply-answer', 'SKILL.md');
const ROUTES_PATH = path.join(HERE, '..', 'src', 'dashboard', 'routes', 'applications.js');

const skillText = fs.readFileSync(SKILL_PATH, 'utf8');
const routesText = fs.readFileSync(ROUTES_PATH, 'utf8');

describe('apply-answer SKILL.md (apply pipeline slice 8)', () => {
  test('frontmatter carries every required field, including name: apply-answer', () => {
    const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, 'SKILL.md must start with a --- frontmatter block');
    const block = fm[1];
    for (const field of ['name:', 'description:', 'argument-hint:', 'user-invocable:', 'allowed-tools:']) {
      assert.match(block, new RegExp(`^${field}`, 'm'), `frontmatter must declare ${field}`);
    }
    assert.match(block, /^name:\s*apply-answer\s*$/m);
  });

  test('every /api endpoint the skill names exists as a registered route in routes/applications.js', () => {
    /** @type {Set<string>} */
    const endpoints = new Set();
    const re = /\$BASE(\/api\/[^\s'"\\]+)/g;
    let m;
    while ((m = re.exec(skillText)) !== null) {
      endpoints.add(m[1].replace(/<[^>]+>/g, ':id'));
    }
    assert.ok(endpoints.size >= 3, 'expected at least the fetch, screenshot, and answer endpoints to be named');
    for (const ep of endpoints) {
      const escaped = ep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const registeredRe = new RegExp(`router\\.register\\('(?:GET|POST)',\\s*'${escaped}'`);
      assert.match(routesText, registeredRe, `SKILL.md references ${ep}, which must be a real registered route in routes/applications.js`);
    }
  });

  test('the pending_question.kind check is present -- this skill only handles the "question" kind', () => {
    assert.ok(skillText.includes("pending_question.kind` is not `'question'"), 'SKILL.md must state the kind check that gates every other action');
  });

  test('the approval-wait text is present -- never posts before an explicit approval', () => {
    assert.ok(skillText.includes('STOP and wait for explicit user approval'), 'SKILL.md must state the approval-wait rule verbatim');
  });

  test('--dry-run is documented as always stopping before any post', () => {
    assert.match(skillText, /--dry-run.{0,80}(always stops|never post)/is);
  });

  test('the skill states it never fills the application form itself', () => {
    assert.match(skillText, /never fills? (a|the application) form itself/i);
  });

  test('the skill states it never invents an answer not already recorded in data/', () => {
    assert.match(skillText, /never invents? an answer/i);
  });
});
