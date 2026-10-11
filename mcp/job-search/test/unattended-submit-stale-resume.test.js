// @ts-check
/**
 * Stale or foreign resume guard at submit time (S3): runGuardedSubmit parks with reason stale_resume when
 * the content gate fails on the file about to be uploaded, even when the resume hash matches, and never
 * clicks. Uses a fake capability (no browser) against the isolated test database; the park happens before
 * the marker is reserved, so nothing is written.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { runGuardedSubmit } from '../src/apply/unattended-submit.js';
import { hasSubmitRequestSentEver } from '../src/core/applications.js';

/** @type {pg.Client} */
let db;

before(async () => {
  db = new pg.Client(pgConnectionConfig());
  await db.connect();
  await ensureAuxSchema(db);
});
after(async () => {
  await db.end();
});

const CONFIG = {
  autoApply: {
    atsAllow: ['greenhouse'],
    unattendedSubmit: { enabled: true, ats: { greenhouse: true }, dailySubmitCap: 5 },
  },
};

/** @param {Record<string, any>} [extra] */
function run(extra = {}) {
  let clicks = 0;
  const cap = {
    pageState: async () => ({}),
    clickSingle: async () => { clicks++; return { clicked: true, count: 1 }; },
  };
  const logs = /** @type {any[]} */ ([]);
  const promise = runGuardedSubmit({
    client: db,
    app: { id: 2147480001, listing_id: 1, apply_url: 'https://example.com/apply', ats_type: 'greenhouse', resume_hash: 'abc' },
    cap, mode: 'form', submitSelector: '#submit', scopeSelector: '#form', ledger: [],
    loadConfig: () => CONFIG,
    exclusionCheck: async () => ({ branch: 'eligible' }),
    resumeHash: () => 'abc', // the hash MATCHES: the content gate must still run
    resumeContent: () => ({ ok: true }),
    sleep: async () => {}, log: (/** @type {any} */ f) => logs.push(f),
    ...extra,
  });
  return { promise, clicks: () => clicks, logs };
}

describe('submit-time stale_resume park', () => {
  test('a failing content verdict parks with stale_resume, no click, no marker, even though the hash matches', async () => {
    const r = run({ resumeContent: () => ({ ok: false, reason: 'missing employers: Advisicon', missing: ['Advisicon'] }) });
    const out = /** @type {any} */ (await r.promise);
    assert.equal(out.outcome, 'needs_human');
    assert.equal(out.clicked, false);
    assert.equal(out.gate.reason, 'stale_resume');
    assert.equal(out.gate.soft, false);
    assert.equal(out.pendingQuestion.kind, 'submit_gate');
    assert.equal(out.pendingQuestion.gate_reason, 'stale_resume');
    assert.match(out.pendingQuestion.label, /Advisicon/);
    assert.equal(r.clicks(), 0);
    assert.equal(await hasSubmitRequestSentEver(db, 2147480001), false);
  });

  test('a missing content check parks too (fail closed)', async () => {
    const r = run({ resumeContent: undefined });
    const out = /** @type {any} */ (await r.promise);
    assert.equal(out.gate.reason, 'stale_resume');
    assert.equal(r.clicks(), 0);
  });

  test('a content check that throws parks too', async () => {
    const r = run({ resumeContent: () => { throw new Error('boom'); } });
    const out = /** @type {any} */ (await r.promise);
    assert.equal(out.gate.reason, 'stale_resume');
    assert.equal(r.clicks(), 0);
  });

  test('a passing verdict is not what parks: the run moves on to the next check (review), never stale_resume', async () => {
    const r = run();
    const out = /** @type {any} */ (await r.promise);
    assert.equal(out.outcome, 'needs_human');
    assert.notEqual(out.gate.reason, 'stale_resume');
    assert.equal(r.clicks(), 0);
  });
});
