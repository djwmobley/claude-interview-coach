// @ts-check
/**
 * src/core/statuses.js (dashboard PR 1): the single source of truth for pipeline statuses. Pure, no DB.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_STATUSES, STATUS_GROUPS, STATUS_PRECEDENCE, REOPEN_REASONS, QUEUE_REASONS, UNTRIAGED, groupOf } from '../src/core/statuses.js';
import { STATUSES as MARK_JOBS_STATUSES } from '../src/tools/mark_jobs.js';
import { z } from 'zod';
import { schema as markJobsSchema } from '../src/tools/mark_jobs.js';

describe('PIPELINE_STATUSES', () => {
  test('exactly the twelve statuses from the plan, and UNTRIAGED is not one of them', () => {
    assert.deepEqual([...PIPELINE_STATUSES], [
      'new', 'maybe', 'shortlisted', 'applied', 'interviewing', 'offer', 'accepted', 'passed', 'lost', 'skip', 'dead', 'review',
    ]);
    assert.equal(UNTRIAGED, null);
    assert.ok(!PIPELINE_STATUSES.includes(/** @type {any} */ (UNTRIAGED)));
  });

  test('mark_jobs.js re-exports PIPELINE_STATUSES under STATUSES, and its zod enum matches', () => {
    assert.deepEqual([...MARK_JOBS_STATUSES], [...PIPELINE_STATUSES]);
    const itemSchema = /** @type {any} */ (markJobsSchema.items.element.shape.status);
    for (const s of PIPELINE_STATUSES) assert.doesNotThrow(() => itemSchema.parse(s), `${s} accepted by mark_jobs status enum`);
    assert.throws(() => itemSchema.parse('active'), z.ZodError, 'legacy active is not a valid mark_jobs status');
  });
});

describe('STATUS_GROUPS / groupOf: every PIPELINE_STATUSES member in exactly one group', () => {
  test('total classification, no overlaps, no gaps', () => {
    const seen = new Map();
    for (const [group, members] of Object.entries(STATUS_GROUPS)) {
      for (const m of members) {
        assert.ok(!seen.has(m), `${m} appears in both ${seen.get(m)} and ${group}`);
        seen.set(m, group);
      }
    }
    for (const s of PIPELINE_STATUSES) assert.ok(seen.has(s), `${s} is not in any STATUS_GROUPS entry`);
    assert.equal(seen.size, PIPELINE_STATUSES.length);
  });

  test('groupOf matches STATUS_GROUPS membership; null/undefined/unknown map to null', () => {
    for (const s of PIPELINE_STATUSES) {
      const expected = Object.entries(STATUS_GROUPS).find(([, members]) => /** @type {readonly string[]} */ (members).includes(s))?.[0];
      assert.equal(groupOf(s), expected);
    }
    assert.equal(groupOf(null), null);
    assert.equal(groupOf(undefined), null);
    assert.equal(groupOf('active'), null);
  });
});

describe('STATUS_PRECEDENCE', () => {
  test('every PIPELINE_STATUSES member appears exactly once, review ranks first', () => {
    assert.equal(STATUS_PRECEDENCE.length, PIPELINE_STATUSES.length);
    assert.equal(new Set(STATUS_PRECEDENCE).size, PIPELINE_STATUSES.length);
    for (const s of PIPELINE_STATUSES) assert.ok(STATUS_PRECEDENCE.includes(s));
    assert.equal(STATUS_PRECEDENCE[0], 'review');
  });
});

describe('REOPEN_REASONS / QUEUE_REASONS: closed lookups', () => {
  test('REOPEN_REASONS has exactly one entry per reopen-eligible status, no runtime string building needed', () => {
    const expectedKeys = ['applied', 'interviewing', 'offer', 'dead', 'skip', 'lost', 'passed'];
    assert.deepEqual(Object.keys(REOPEN_REASONS).sort(), expectedKeys.sort());
    for (const [status, reason] of Object.entries(REOPEN_REASONS)) assert.equal(reason, `reopened_${status}`);
  });

  test('QUEUE_REASONS is the full closed set: every REOPEN_REASONS value plus the two non-status reasons', () => {
    const expected = new Set([...Object.values(REOPEN_REASONS), 'concurrent_review', 'unrecognized_status']);
    assert.deepEqual(new Set(QUEUE_REASONS), expected);
  });
});
