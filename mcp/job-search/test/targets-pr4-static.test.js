// @ts-check
/**
 * Static guarantees for the PR4 files (plan 18.9): the effective-state rule has one definition; only the
 * decisions module writes decision columns and the audit table, and only by INSERT or the one row update; the
 * runner never writes a decision column; the routes register nothing but GET and the three POST actions; and the
 * new files carry no em dash.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (/** @type {string} */ p) => fs.readFileSync(path.join(ROOT, ...p.split('/')), 'utf8');
const strip = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PR4_FILES = [
  'sql/026_target_decisions.sql', 'src/targets/effective.js', 'src/targets/decisions.js', 'src/targets/leak-guard.js',
  'src/dashboard/routes/targets.js', 'src/dashboard/public/pages/targets.js', 'src/dashboard/public/components/targets-tile.js',
  'test/helpers/targets-pr4.js', 'test/targets-decisions.test.js', 'test/dashboard-targets-route.test.js', 'test/targets-runner-pr4.test.js',
  'test/dashboard-public-targets.test.js', 'test/migration-026.test.js', 'test/targets-pr4-static.test.js', 'test/targets-leak-guard.test.js',
  'src/tools/targets.js', 'src/targets/runner.js', 'src/targets/stage.js', 'src/core/report.js', 'src/core/scan-run.js',
];

describe('one definition of the effective state', () => {
  test('the blocked rule lives in effective.js; no route, tool or decision code spells it out again', () => {
    for (const f of ['src/dashboard/routes/targets.js', 'src/tools/targets.js', 'src/targets/decisions.js', 'src/targets/leak-guard.js', 'src/dashboard/public/pages/targets.js']) {
      const src = strip(read(f));
      assert.ok(!/excl_blocked|dedup_blocked_sibling|blocked_hint/.test(src), `${f} must use effective.js`);
    }
    assert.match(read('src/targets/effective.js'), /excl_blocked/);
  });

  test('every consumer imports the shared fragments', () => {
    for (const f of ['src/dashboard/routes/targets.js', 'src/tools/targets.js', 'src/targets/runner.js']) assert.match(read(f), /effective\.js/, f);
    assert.match(read('src/targets/decisions.js'), /effective\.js/);
  });
});

describe('who writes decisions', () => {
  test('the runner never writes a decision column or the version (it only reads decision, and sets new_evidence_at / stale_evidence_at)', () => {
    const src = strip(read('src/targets/runner.js'));
    assert.ok(!/decision_class|decision_version|decision_reason|decided_by|decided_at/.test(src));
    for (const m of src.matchAll(/\bdecision\b[^\n]*/g)) assert.match(m[0], /decision IS NOT NULL|IS DISTINCT FROM 'discarded'/, m[0]);
    assert.ok(!/ic_target_decisions/.test(src));
  });

  test('only decisions.js writes ic_target_decisions, by INSERT only', () => {
    for (const f of ['src/dashboard/routes/targets.js', 'src/targets/runner.js', 'src/targets/stage.js', 'src/tools/targets.js']) {
      assert.ok(!/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+ic_target_decisions/i.test(strip(read(f))), f);
    }
    const dec = strip(read('src/targets/decisions.js'));
    assert.ok(!/(?:UPDATE|DELETE\s+FROM)\s+ic_target_decisions/i.test(dec));
    assert.match(dec, /INSERT INTO ic_target_decisions/);
  });

  test('the actor is a literal in SQL; no request field is read for it', () => {
    const dec = strip(read('src/targets/decisions.js'));
    assert.match(dec, /'damian'/);
    assert.ok(!/\.actor\b|body\.actor|b\.actor/.test(dec + strip(read('src/dashboard/routes/targets.js'))));
  });

  test('the routes register GET and exactly the three POST actions; no PUT, PATCH or DELETE', () => {
    const src = strip(read('src/dashboard/routes/targets.js'));
    assert.ok(!/router\.register\(\s*'(?:PUT|PATCH|DELETE)'/.test(src));
    const posts = [...src.matchAll(/router\.register\(\s*'POST'/g)].length;
    assert.equal(posts, 1, 'one POST registration helper, instantiated for the three actions');
    for (const a of ['reclassify', 'discard', 'restore']) assert.match(src, new RegExp(`actionRoute\\('${a}'\\)`));
    assert.ok(!/\bapprove\b|\bdraft\b|sendmail|mailto|nodemailer|smtp/i.test(src), 'no send, approve or draft path');
  });
});

describe('hygiene', () => {
  test('no em dash (U+2014) and no en dash in any PR4 file', () => {
    const bad = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
    for (const f of PR4_FILES) for (const ch of bad) assert.ok(!read(f).includes(ch), `${f}: dash U+${ch.charCodeAt(0).toString(16)}`);
  });
});
