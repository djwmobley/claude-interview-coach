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
import { alertSendersSchema, GMAIL_PARSER_NAMES, loadConfig } from '../src/core/config.js';
import { PARSERS } from '../src/adapters/gmail-parsers.js';
import { CONFIG_DIR } from './helpers/scan-fixtures.js';

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
