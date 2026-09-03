// @ts-check
/**
 * src/core/review-bulk.js: classifyForBulkSeparate() is a pure, total classification, so this file needs
 * no database at all -- every case is exercised with hand-built item/candidate/match objects.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyForBulkSeparate, BULK_LEAVE_REASONS, BULK_SEPARATE_RULE } from '../src/core/review-bulk.js';

const OPEN_ITEM = Object.freeze({ resolution: null, reason: 'title_similar_same_company', matches: [42] });
const CAND = Object.freeze({ status: 'review', company_norm: 'acme corp', title_norm: 'senior director of engineering', location_norm: 'houston-tx' });
const MATCH = Object.freeze({ status: 'review', company_norm: 'acme corp', title_norm: 'senior director of engineering', location_norm: 'dallas-tx' });

describe('classifyForBulkSeparate: separate branch', () => {
  test('identical company + identical title token key + both eligible + different, non-remote locations -> separate', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, CAND, MATCH);
    assert.deepEqual(r, { decision: 'separate', rule: BULK_SEPARATE_RULE });
  });
});

describe('classifyForBulkSeparate: each leave reason, one test apiece, precedence order', () => {
  test('not_open: item.resolution already set', () => {
    const r = classifyForBulkSeparate({ ...OPEN_ITEM, resolution: 'separate' }, CAND, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'not_open' });
  });

  test('wrong_reason: any reason other than title_similar_same_company', () => {
    const r = classifyForBulkSeparate({ ...OPEN_ITEM, reason: 'company_similar_same_title' }, CAND, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'wrong_reason' });
  });

  test('multi_match: more than one match id', () => {
    const r = classifyForBulkSeparate({ ...OPEN_ITEM, matches: [42, 43] }, CAND, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'multi_match' });
  });

  test('multi_match: zero match ids', () => {
    const r = classifyForBulkSeparate({ ...OPEN_ITEM, matches: [] }, CAND, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'multi_match' });
  });

  test('missing match row (deleted since queuing) -> leave multi_match, never throws', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, CAND, null);
    assert.deepEqual(r, { decision: 'leave', reason: 'multi_match' });
  });

  test('missing candidate row -> leave status_changed, never throws', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, null, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'status_changed' });
  });

  test('status_changed: candidate status is no longer review', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, { ...CAND, status: 'applied' }, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'status_changed' });
  });

  test('company_differs: company_norm values differ', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, CAND, { ...MATCH, company_norm: 'other corp' });
    assert.deepEqual(r, { decision: 'leave', reason: 'company_differs' });
  });

  test('title_key_differs: "senior director" vs "director" is not an identical token key (deliberately stricter than the trigram-similarity creator)', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, CAND, { ...MATCH, title_norm: 'director of engineering' });
    assert.deepEqual(r, { decision: 'leave', reason: 'title_key_differs' });
  });

  test('location_unknown: candidate location_norm is unknown:*', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, { ...CAND, location_norm: 'unknown:abc' }, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'location_unknown' });
  });

  test('location_unknown: match location_norm is absent', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, CAND, { ...MATCH, location_norm: 'absent' });
    assert.deepEqual(r, { decision: 'leave', reason: 'location_unknown' });
  });

  test('location_unknown: match location_norm is legacy-unknown', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, CAND, { ...MATCH, location_norm: 'legacy-unknown' });
    assert.deepEqual(r, { decision: 'leave', reason: 'location_unknown' });
  });

  test('location_same: identical location_norm on both sides (same city)', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, CAND, { ...MATCH, location_norm: 'houston-tx' });
    assert.deepEqual(r, { decision: 'leave', reason: 'location_same' });
  });

  test('remote_involved: remote-us on the candidate side vs a Texas city on the match side', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, { ...CAND, location_norm: 'remote-us' }, { ...MATCH, location_norm: 'houston-tx' });
    assert.deepEqual(r, { decision: 'leave', reason: 'remote_involved' });
  });

  test('remote_involved: remote-us-tx vs houston-tx (both eligible, one remote) never separates', () => {
    const r = classifyForBulkSeparate(OPEN_ITEM, { ...CAND, location_norm: 'remote-us-tx' }, { ...MATCH, location_norm: 'houston-tx' });
    assert.deepEqual(r, { decision: 'leave', reason: 'remote_involved' });
  });
});

describe('classifyForBulkSeparate: precedence order (BULK_LEAVE_REASONS documents it)', () => {
  test('BULK_LEAVE_REASONS lists the nine reasons in the exact precedence order the function checks them', () => {
    assert.deepEqual(BULK_LEAVE_REASONS, [
      'not_open', 'wrong_reason', 'multi_match', 'status_changed',
      'company_differs', 'title_key_differs', 'location_unknown', 'location_same', 'remote_involved',
    ]);
  });

  test('an already-resolved item wins over every other defect (not_open checked first)', () => {
    const r = classifyForBulkSeparate({ resolution: 'merge', reason: 'x', matches: [1, 2] }, null, null);
    assert.deepEqual(r, { decision: 'leave', reason: 'not_open' });
  });

  test('wrong_reason wins over a multi-match defect (checked second)', () => {
    const r = classifyForBulkSeparate({ resolution: null, reason: 'branch1_conflict', matches: [1, 2] }, CAND, MATCH);
    assert.deepEqual(r, { decision: 'leave', reason: 'wrong_reason' });
  });
});
