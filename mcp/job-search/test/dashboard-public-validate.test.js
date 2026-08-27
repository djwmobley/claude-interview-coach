// @ts-check
/**
 * Pure, DOM-free validation tests for the Add opportunity and New follow-up drawers (independent review
 * comment on PR #6, second re-review: "node:test coverage for the drawers' pure validation (required
 * fields, null/empty -> refused, the 409-candidates branch)"). The 409-candidates branch itself is a
 * client/server round trip (component logic driven by a fetch response, not a pure function), so it is
 * covered here only at the level of lib/api.js's own classify() (see the "duplicate_candidate" case in
 * test/dashboard-public-api.test.js) and end to end by the Playwright script; this file covers the
 * synchronous validators the drawers call before ever making that round trip.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateManualListing, validateFollowup, CHANNELS, MANUAL_STATUS_OPTIONS } from '../src/dashboard/public/lib/validate.js';
import { CHANNELS as REAL_CHANNELS } from '../src/core/followups.js';

describe('validateManualListing(): required fields, mirrors createManualListing (src/core/manual.js)', () => {
  test('title and company are both required; empty/whitespace-only is refused', () => {
    assert.equal(validateManualListing({}).ok, false);
    assert.equal(validateManualListing({ title: '', company: '' }).ok, false);
    assert.equal(validateManualListing({ title: '   ', company: '   ' }).ok, false);
    assert.equal(validateManualListing({ title: 'Role', company: '' }).ok, false);
    assert.equal(validateManualListing({ title: '', company: 'Acme' }).ok, false);
  });

  test('null/undefined values are treated the same as empty, never throw', () => {
    assert.doesNotThrow(() => validateManualListing({ title: null, company: undefined }));
    assert.equal(validateManualListing({ title: null, company: undefined }).ok, false);
  });

  test('field-level error messages name the missing field', () => {
    const r = validateManualListing({ title: '', company: '' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.title);
      assert.ok(r.errors.company);
    }
  });

  test('a valid minimal submission trims strings and defaults status to new, url/location/via to null', () => {
    const r = validateManualListing({ title: '  Role  ', company: '  Acme  ' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value, { title: 'Role', company: 'Acme', url: null, location: null, status: 'new', via: null });
    }
  });

  test('a fully populated submission passes every field through trimmed', () => {
    const r = validateManualListing({ title: 'Role', company: 'Acme', url: ' https://example.com ', location: ' Austin, TX ', status: 'maybe', via: ' Jane Recruiter ' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.url, 'https://example.com');
      assert.equal(r.value.location, 'Austin, TX');
      assert.equal(r.value.status, 'maybe');
      assert.equal(r.value.via, 'Jane Recruiter');
    }
  });

  test('MANUAL_STATUS_OPTIONS is a non-empty closed list usable to populate a <select>', () => {
    assert.ok(Array.isArray(MANUAL_STATUS_OPTIONS));
    assert.ok(MANUAL_STATUS_OPTIONS.length > 0);
  });
});

describe('validateFollowup(): required fields, mirrors createFollowup (src/core/followups.js)', () => {
  test('contact, action_text, channel, and due_at are all required', () => {
    assert.equal(validateFollowup({}).ok, false);
    assert.equal(validateFollowup({ contact: '', action_text: '', channel: undefined, due_at: '' }).ok, false);
  });

  test('null/empty individually still refuse, one field at a time', () => {
    const base = { contact: 'Jane', action_text: 'Call', channel: 'phone', due_at: '2026-09-01T09:00' };
    assert.equal(validateFollowup({ ...base, contact: '' }).ok, false);
    assert.equal(validateFollowup({ ...base, contact: '   ' }).ok, false);
    assert.equal(validateFollowup({ ...base, action_text: '' }).ok, false);
    assert.equal(validateFollowup({ ...base, channel: '' }).ok, false);
    assert.equal(validateFollowup({ ...base, channel: 'carrier-pigeon' }).ok, false);
    assert.equal(validateFollowup({ ...base, due_at: '' }).ok, false);
  });

  test('channel must be one of the real CHANNELS values (cross-checked against src/core/followups.js)', () => {
    assert.deepEqual([...CHANNELS], [...REAL_CHANNELS]);
    for (const channel of REAL_CHANNELS) {
      assert.equal(validateFollowup({ contact: 'Jane', action_text: 'Call', channel, due_at: '2026-09-01T09:00' }).ok, true);
    }
  });

  test('a valid submission trims contact/org/action_text and passes listing_id through as a number', () => {
    const r = validateFollowup({ contact: ' Jane ', org: ' Acme ', action_text: ' Call back ', channel: 'phone', due_at: '2026-09-01T09:00', listing_id: '42' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.contact, 'Jane');
      assert.equal(r.value.org, 'Acme');
      assert.equal(r.value.action_text, 'Call back');
      assert.equal(r.value.listing_id, 42);
    }
  });

  test('org and listing_id are optional and default to null', () => {
    const r = validateFollowup({ contact: 'Jane', action_text: 'Call', channel: 'phone', due_at: '2026-09-01T09:00' });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.org, null);
      assert.equal(r.value.listing_id, null);
    }
  });

  test('never throws on unexpected input shapes', () => {
    assert.doesNotThrow(() => validateFollowup(/** @type {any} */ ({ contact: 42, channel: {}, due_at: [] })));
  });
});
