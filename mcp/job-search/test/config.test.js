// @ts-check
/**
 * config/alert-senders.json schema (spec: gmail-adapter-brief.md item 12):
 * malformed addresses are rejected; every entry's `parser` must be one of
 * the closed enum of parser names that actually exist in gmail-parsers.js
 * (config.js validates against the same enum it exports, GMAIL_PARSER_NAMES,
 * which is kept in sync with src/adapters/gmail-parsers.js PARSERS by hand;
 * a cross-check test below catches the two ever drifting apart).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertSendersSchema, GMAIL_PARSER_NAMES, loadConfig } from '../src/core/config.js';
import { PARSERS } from '../src/adapters/gmail-parsers.js';
import { CONFIG_DIR } from './helpers/scan-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_CHILD = path.join(HERE, 'helpers', 'db-guard-child.mjs');

/**
 * Spawns test/helpers/db-guard-child.mjs as a real, separate `node` process. Starts from this test
 * process's own env (so PATH/SystemRoot/TEMP etc. are intact on every OS) but explicitly strips
 * NODE_TEST_CONTEXT, JOBSEARCH_TEST_GUARD, and PG_DSN first -- this test process is itself running
 * under `node --test` (possibly via bin/run-tests.js, which also sets JOBSEARCH_TEST_GUARD and a real
 * PG_DSN), and none of that should leak into the child uncontrolled. `overrides` then sets exactly the
 * variables each sub-test below cares about.
 * @param {Record<string, string>} overrides
 */
function runGuardChild(overrides) {
  const base = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  delete base.JOBSEARCH_TEST_GUARD;
  delete base.PG_DSN;
  return spawnSync(process.execPath, [GUARD_CHILD], { env: { ...base, ...overrides }, encoding: 'utf8' });
}

describe('alertSendersSchema', () => {
  test('the real config/alert-senders.json (via the test fixture config dir) validates and every parser name exists in gmail-parsers.js', () => {
    const cfg = loadConfig({ dir: CONFIG_DIR, fresh: true });
    assert.ok(Array.isArray(cfg.alertSenders) && cfg.alertSenders.length > 0);
    for (const s of cfg.alertSenders) {
      assert.ok(PARSERS[s.parser], `parser ${s.parser} for ${s.address} has no implementation`);
    }
  });

  test('GMAIL_PARSER_NAMES (the schema enum) matches PARSERS exactly (no drift)', () => {
    assert.deepEqual([...GMAIL_PARSER_NAMES].sort(), Object.keys(PARSERS).sort());
  });

  test('a well-formed sender list parses', () => {
    const r = alertSendersSchema.safeParse({ senders: [{ address: 'jobalerts-noreply@linkedin.com', parser: 'linkedin', enabled: true, comment: 'x' }] });
    assert.equal(r.success, true);
  });

  test('enabled defaults to true when omitted', () => {
    const r = alertSendersSchema.safeParse({ senders: [{ address: 'jobalerts-noreply@linkedin.com', parser: 'linkedin' }] });
    assert.equal(r.success, true);
    assert.equal(r.success && r.data.senders[0].enabled, true);
  });

  test('rejects a malformed address', () => {
    for (const bad of ['not-an-email', 'missing-domain@', '@missing-local.com', 'Uppercase@Linkedin.com', 'spaces in@address.com', '']) {
      const r = alertSendersSchema.safeParse({ senders: [{ address: bad, parser: 'linkedin' }] });
      assert.equal(r.success, false, `expected ${JSON.stringify(bad)} to be rejected`);
    }
  });

  test('rejects a parser name outside the closed enum (CONFIG_INVALID path, never a silent unknown parser)', () => {
    const r = alertSendersSchema.safeParse({ senders: [{ address: 'jobalerts-noreply@linkedin.com', parser: 'not-a-real-parser' }] });
    assert.equal(r.success, false);
  });

  test('rejects a missing senders key and a non-array senders value', () => {
    assert.equal(alertSendersSchema.safeParse({}).success, false);
    assert.equal(alertSendersSchema.safeParse({ senders: 'nope' }).success, false);
  });

  test('an empty senders array is valid (gmail with no configured senders yields zero listings, not a config error)', () => {
    assert.equal(alertSendersSchema.safeParse({ senders: [] }).success, true);
  });
});

describe('assertTestDbGuard (scan-report-fixes item: structural test-isolation guard)', () => {
  test('trips when NODE_TEST_CONTEXT is set and the DSN does not resolve to a "_test" database', () => {
    const r = runGuardChild({ NODE_TEST_CONTEXT: 'child-v8', PG_DSN: 'postgresql://postgres@localhost:5432/ic_context' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not end in "_test"/);
    assert.match(r.stderr, /bin\/run-tests\.js/);
  });

  test('trips when JOBSEARCH_TEST_GUARD=1 is set, even with NODE_TEST_CONTEXT absent', () => {
    const r = runGuardChild({ JOBSEARCH_TEST_GUARD: '1', PG_DSN: 'postgresql://postgres@localhost:5432/ic_context' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not end in "_test"/);
  });

  test('does NOT trip when the DSN resolves to a database ending in "_test", even under NODE_TEST_CONTEXT', () => {
    const r = runGuardChild({ NODE_TEST_CONTEXT: 'child-v8', PG_DSN: 'postgresql://postgres@localhost:5432/ic_context_test' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });

  test('does NOT trip when neither NODE_TEST_CONTEXT nor JOBSEARCH_TEST_GUARD is set (normal CLI/production usage is unaffected)', () => {
    const r = runGuardChild({ PG_DSN: 'postgresql://postgres@localhost:5432/ic_context' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });
});
