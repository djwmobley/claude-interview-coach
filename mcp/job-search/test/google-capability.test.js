// @ts-check
/**
 * Per-capability Google health (sql/029): the banner text (send-only loss, "never", all three, nothing),
 * the per-capability outcomes of a token classification, and the table writes.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { SCOPE_GMAIL_READONLY, SCOPE_GMAIL_SEND, SCOPE_CALENDAR_EVENTS } from '../src/core/google.js';
import { REAUTH_REQUIRED_SCOPES } from '../src/core/google-reauth.js';
import {
  capabilityBannerLine, outcomesFromTokenState, recordCapabilityOutcomes, collectGoogleCapability, CAPABILITIES, CAPABILITY_REQUIRED_SCOPES,
} from '../src/core/google-capability.js';

const NOW = new Date('2026-10-24T12:00:00Z');

describe('capabilityBannerLine', () => {
  test('send-only loss: read OK, last good send named, re-authorize pointer', () => {
    const line = capabilityBannerLine([
      { capability: 'read', last_good_at: '2026-10-24T11:00:00.000Z', broken_since: null },
      { capability: 'send', last_good_at: '2026-10-19T23:00:00.000Z', broken_since: '2026-10-20T06:00:00.000Z' },
      { capability: 'calendar', last_good_at: '2026-10-24T11:00:00.000Z', broken_since: null },
    ], NOW);
    assert.equal(line, 'Gmail send BROKEN since 2026-10-20 (4 days): read OK, calendar OK, last good send 2026-10-19T23:00:00.000Z. Re-authorize on dashboard.');
  });

  test('the spec example shape when only read is known OK', () => {
    const line = capabilityBannerLine([
      { capability: 'read', last_good_at: '2026-10-24T11:00:00.000Z', broken_since: null },
      { capability: 'send', last_good_at: '2026-10-19T23:00:00.000Z', broken_since: '2026-10-20T06:00:00.000Z' },
    ], NOW);
    assert.equal(line, 'Gmail send BROKEN since 2026-10-20 (4 days): read OK, last good send 2026-10-19T23:00:00.000Z. Re-authorize on dashboard.');
  });

  test('"never" is a defined branch: a broken capability that was never good', () => {
    const line = capabilityBannerLine([{ capability: 'send', last_good_at: null, broken_since: '2026-10-23T06:00:00.000Z' }], NOW);
    assert.equal(line, 'Gmail send BROKEN since 2026-10-23 (1 day): last good send never. Re-authorize on dashboard.');
  });

  test('all three broken, with missing scopes from REAUTH_REQUIRED_SCOPES', () => {
    const line = capabilityBannerLine([
      { capability: 'read', last_good_at: null, broken_since: '2026-10-24T01:00:00.000Z', missing_scopes: [SCOPE_GMAIL_READONLY] },
      { capability: 'send', last_good_at: null, broken_since: '2026-10-22T01:00:00.000Z', missing_scopes: [SCOPE_GMAIL_SEND] },
      { capability: 'calendar', last_good_at: '2026-10-01T00:00:00.000Z', broken_since: '2026-10-24T01:00:00.000Z', missing_scopes: [SCOPE_CALENDAR_EVENTS] },
    ], NOW);
    assert.match(line ?? '', /^Gmail read, Gmail send, Google calendar BROKEN since 2026-10-22 \(2 days\): /);
    assert.match(line ?? '', /last good read never, last good send never, last good calendar 2026-10-01T00:00:00\.000Z/);
    for (const s of [SCOPE_GMAIL_READONLY, SCOPE_GMAIL_SEND, SCOPE_CALENDAR_EVENTS]) assert.ok((line ?? '').includes(s), s);
    assert.match(line ?? '', /Re-authorize on dashboard\.$/);
  });

  test('a scope that is not in REAUTH_REQUIRED_SCOPES is never listed', () => {
    const line = capabilityBannerLine([{ capability: 'send', last_good_at: null, broken_since: '2026-10-24T01:00:00.000Z', missing_scopes: ['https://example.test/not-a-reauth-scope'] }], NOW);
    assert.doesNotMatch(line ?? '', /Missing scopes/);
  });

  test('nothing broken, or nothing known, is no line', () => {
    assert.equal(capabilityBannerLine([], NOW), null);
    assert.equal(capabilityBannerLine(null, NOW), null);
    assert.equal(capabilityBannerLine([{ capability: 'read', last_good_at: '2026-10-24T00:00:00.000Z', broken_since: null }], NOW), null);
  });

  test('the day count never goes negative', () => {
    const line = capabilityBannerLine([{ capability: 'send', last_good_at: null, broken_since: '2026-10-25T00:00:00.000Z' }], NOW);
    assert.match(line ?? '', /\(0 days\)/);
  });

  test('every capability scope is in REAUTH_REQUIRED_SCOPES', () => {
    assert.equal(CAPABILITY_REQUIRED_SCOPES.length, CAPABILITIES.length);
    for (const s of CAPABILITY_REQUIRED_SCOPES) assert.ok(REAUTH_REQUIRED_SCOPES.includes(s));
  });
});

describe('outcomesFromTokenState (total over GoogleTokenState)', () => {
  const flags = (/** @type {boolean} */ r, /** @type {boolean} */ s, /** @type {boolean} */ c) => ({ gmail_read_ok: r, gmail_send_ok: s, calendar_ok: c });
  const byCap = (/** @type {ReturnType<typeof outcomesFromTokenState>} */ list) => Object.fromEntries(list.map((o) => [o.capability, o]));

  test('ok with every scope: all three good', () => {
    const o = byCap(outcomesFromTokenState({ state: 'ok', expiry: null }, flags(true, true, true)));
    assert.deepEqual(CAPABILITIES.map((c) => o[c].ok), [true, true, true]);
  });

  test('ok but the token lacks the send scope: send is broken with that scope listed, the others are good', () => {
    const o = byCap(outcomesFromTokenState({ state: 'ok', expiry: null }, flags(true, false, true)));
    assert.equal(o.send.ok, false);
    assert.equal(o.send.state, 'broken_missing_scopes');
    assert.deepEqual(o.send.missing, [SCOPE_GMAIL_SEND]);
    assert.equal(o.read.ok, true);
  });

  test('a partial info object (flag absent) is not evidence of a missing scope', () => {
    const o = byCap(outcomesFromTokenState({ state: 'ok', expiry: null }, /** @type {any} */ ({ gmail_send_ok: true })));
    assert.deepEqual(CAPABILITIES.map((c) => o[c].ok), [true, true, true]);
  });

  test('broken_missing_scopes writes only the capabilities whose scope is missing', () => {
    const list = outcomesFromTokenState({ state: 'broken_missing_scopes', missing: [SCOPE_GMAIL_SEND] });
    assert.deepEqual(list.map((o) => o.capability), ['send']);
  });

  test('every other broken state breaks all three with the state recorded', () => {
    for (const state of /** @type {const} */ (['broken_invalid_grant', 'broken_missing_file', 'broken_malformed', 'broken_no_refresh_token'])) {
      const list = outcomesFromTokenState({ state });
      assert.equal(list.length, 3, state);
      assert.ok(list.every((o) => !o.ok && o.state === state));
    }
    const refresh = outcomesFromTokenState({ state: 'broken_refresh_error', code: 'ECONNRESET' });
    assert.equal(refresh.length, 3);
    assert.equal(refresh[0].state, 'broken_refresh_error');
  });
});

describe('recordCapabilityOutcomes (database)', () => {
  /** @type {pg.Client} */
  let client;
  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await ensureAuxSchema(client);
  });
  beforeEach(async () => { await client.query('DELETE FROM ic_google_capability'); });
  after(async () => {
    await client.query('DELETE FROM ic_google_capability');
    await client.end();
  });

  const t = (/** @type {string} */ iso) => new Date(iso);

  test('a failure keeps the EARLIEST broken_since across repeated failures; a good outcome clears it and stamps last_good_at', async () => {
    await recordCapabilityOutcomes(client, [{ capability: 'send', ok: true, state: 'ok', missing: [] }], t('2026-10-19T23:00:00Z'));
    await recordCapabilityOutcomes(client, [{ capability: 'send', ok: false, state: 'broken_invalid_grant', missing: [] }], t('2026-10-20T06:00:00Z'));
    await recordCapabilityOutcomes(client, [{ capability: 'send', ok: false, state: 'broken_invalid_grant', missing: [] }], t('2026-10-22T06:00:00Z'));
    let rows = await collectGoogleCapability(client);
    assert.equal(rows[0].broken_since, '2026-10-20T06:00:00.000Z');
    assert.equal(rows[0].last_good_at, '2026-10-19T23:00:00.000Z');
    assert.equal(rows[0].last_fail_at, '2026-10-22T06:00:00.000Z');
    assert.equal(capabilityBannerLine(rows, NOW), 'Gmail send BROKEN since 2026-10-20 (4 days): last good send 2026-10-19T23:00:00.000Z. Re-authorize on dashboard.');
    await recordCapabilityOutcomes(client, [{ capability: 'send', ok: true, state: 'ok', missing: [] }], t('2026-10-24T08:00:00Z'));
    rows = await collectGoogleCapability(client);
    assert.equal(rows[0].broken_since, null);
    assert.equal(rows[0].last_good_at, '2026-10-24T08:00:00.000Z');
    assert.equal(capabilityBannerLine(rows, NOW), null);
  });

  test('capabilities are independent: send breaks while read stays good', async () => {
    await recordCapabilityOutcomes(client, [
      { capability: 'read', ok: true, state: 'ok', missing: [] },
      { capability: 'send', ok: false, state: 'broken_missing_scopes', missing: [SCOPE_GMAIL_SEND] },
    ], t('2026-10-24T08:00:00Z'));
    const rows = await collectGoogleCapability(client);
    const line = capabilityBannerLine(rows, NOW);
    assert.match(line ?? '', /^Gmail send BROKEN since 2026-10-24 \(0 days\): read OK, last good send never\. Missing scopes: /);
    assert.ok((line ?? '').includes(SCOPE_GMAIL_SEND));
  });

  test('the capability vocabulary is closed', async () => {
    await assert.rejects(client.query(`INSERT INTO ic_google_capability (capability) VALUES ('fax')`), /check/i);
  });
});
