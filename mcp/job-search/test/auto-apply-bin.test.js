// @ts-check
/**
 * bin/auto-apply.js (auto-apply PR B): argument parsing, lock-poll contention, the apply-phase chain's
 * review-FAIL-parks behavior, and runPrepare's dry-run no-write guarantee -- all against fakes, no real
 * database, no real Chrome, no real claude CLI.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, acquireLockWithPoll, applyOneCandidate, runPrepare } from '../bin/auto-apply.js';

describe('parseArgs', () => {
  test('defaults', () => {
    const out = parseArgs([]);
    assert.equal(out.dryRun, false);
    assert.equal(out.json, undefined);
    assert.equal(out.help, false);
  });
  test('--dry-run sets dryRun', () => assert.equal(parseArgs(['--dry-run']).dryRun, true));
  test('bare --json sets json to null', () => assert.equal(parseArgs(['--json']).json, null));
  test('--json <file>', () => assert.equal(parseArgs(['--json', 'out.json']).json, 'out.json'));
  test('--help sets help', () => assert.equal(parseArgs(['--help']).help, true));
});

describe('acquireLockWithPoll: contention', () => {
  test('acquires immediately when the lock is free', async () => {
    const client = { query: async () => ({ rows: [{ ok: true }] }) };
    const got = await acquireLockWithPoll(client, { lockMinutes: 40, pollSeconds: 30, log: () => {} });
    assert.equal(got, true);
  });

  test('polls and eventually acquires', async () => {
    let calls = 0;
    const client = { query: async () => { calls++; return { rows: [{ ok: calls >= 3 }] }; } };
    const sleeps = [];
    const got = await acquireLockWithPoll(client, {
      lockMinutes: 40, pollSeconds: 30, log: () => {}, sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(got, true);
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
    assert.equal(sleeps[0], 30000);
  });

  test('exits the poll loop (LOCKED) once the deadline passes, never acquiring', async () => {
    const client = { query: async () => ({ rows: [{ ok: false }] }) };
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const got = await acquireLockWithPoll(client, {
        lockMinutes: 1, pollSeconds: 30, log: () => {},
        sleep: async (ms) => { now += ms; },
      });
      assert.equal(got, false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('runPrepare: dry-run makes zero writes', () => {
  test('a dry run never issues an UPDATE, even for a resolvable candidate', async () => {
    /** @type {any[]} */
    const queries = [];
    const client = {
      async query(text, params) {
        queries.push({ text, params });
        if (/SELECT id, url, url_normalized/.test(text)) {
          return {
            rows: [{ id: 1, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/1', apply_probed_at: null, probe_attempts: 0 }],
          };
        }
        return { rows: [] };
      },
    };
    const config = {
      atsApply: {
        greenhouse: { hosts: ['boards.greenhouse.io'] }, lever: { hosts: [] }, smartrecruiters: { hosts: [] },
        icims: { hostSuffix: 'icims.com' }, dayforce: { hostSuffix: 'dayforcehcm.com' },
      },
      autoApply: { reprobeAfterHours: 48, probeRowCap: 3 },
    };
    const stats = await runPrepare(client, config, { now: new Date(), dryRun: true, log: () => {} });
    assert.equal(stats.attempted, 1);
    assert.equal(stats.skipped, 1); // persistApplyTargetForListing's own dryRun-first check, before any write
    // The only query issued is the candidate SELECT itself -- no UPDATE.
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /^\s*SELECT/);
  });
});

describe('applyOneCandidate: review FAIL parks without approving', () => {
  function makeRow(overrides = {}) {
    return { listingId: 1, applyAts: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', ...overrides };
  }

  test('a FAIL verdict never calls approve, never calls the worker', async () => {
    /** @type {string[]} */
    const calls = [];
    const deps = {
      withClientFn: async (fn) => fn({}),
      resumeRunner: { run: async () => { calls.push('resume'); return { ok: true, markdownPath: 'output/markdown/x.md' }; } },
      reviewRunner: { run: async () => { calls.push('review'); return { ok: true, verdict: 'FAIL', reason: 'review_failed' }; } },
      runWorker: async () => { calls.push('worker'); return { ok: true, status: 'submitted' }; },
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    // Stub createApplication indirectly via withClientFn -- applyOneCandidate calls
    // deps.withClientFn((c) => createApplication(c, ...)), so withClientFn must invoke the real
    // createApplication against something -- instead we short-circuit by making withClientFn's callback
    // never actually run createApplication: we replace withClientFn to return a canned app row on the
    // FIRST call (createApplication) and otherwise track calls; approve() would be the second withClientFn
    // call, which must never happen here.
    let withClientCalls = 0;
    deps.withClientFn = async (fn) => {
      withClientCalls++;
      if (withClientCalls === 1) return { id: 99, listing_id: 1 }; // stands in for createApplication's row
      calls.push('approve_or_other_db_call');
      return fn({});
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'review_failed');
    assert.equal(r.applicationId, 99);
    assert.deepEqual(calls, ['resume', 'review']);
    assert.equal(withClientCalls, 1); // only createApplication -- approve() was never reached
  });

  test('an ok:false resume result parks with resume_failed, never reaches review or approve', async () => {
    /** @type {string[]} */
    const calls = [];
    let withClientCalls = 0;
    const deps = {
      withClientFn: async () => { withClientCalls++; return { id: 5, listing_id: 1 }; },
      resumeRunner: { run: async () => { calls.push('resume'); return { ok: false, reason: 'no_description' }; } },
      reviewRunner: { run: async () => { calls.push('review'); return { ok: true, verdict: 'PASS' }; } },
      runWorker: async () => { calls.push('worker'); return { ok: true, status: 'submitted' }; },
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'resume_failed');
    assert.equal(r.reason, 'no_description');
    assert.deepEqual(calls, ['resume']);
    assert.equal(withClientCalls, 1);
  });

  test('a PASS verdict proceeds through approve and the worker', async () => {
    /** @type {string[]} */
    const calls = [];
    let withClientCalls = 0;
    const deps = {
      withClientFn: async () => { withClientCalls++; return { id: 5, listing_id: 1 }; },
      resumeRunner: { run: async () => { calls.push('resume'); return { ok: true, markdownPath: 'output/markdown/x.md' }; } },
      reviewRunner: { run: async () => { calls.push('review'); return { ok: true, verdict: 'PASS' }; } },
      runWorker: async () => { calls.push('worker'); return { ok: true, status: 'submitted' }; },
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'applied');
    assert.deepEqual(calls, ['resume', 'review', 'worker']);
    assert.equal(withClientCalls, 2); // createApplication + approve
  });

  test('createApplication throwing never reaches resume/review/approve/worker', async () => {
    /** @type {string[]} */
    const calls = [];
    const deps = {
      withClientFn: async () => { throw new Error('duplicate application'); },
      resumeRunner: { run: async () => { calls.push('resume'); return { ok: true, markdownPath: 'x.md' }; } },
      reviewRunner: { run: async () => { calls.push('review'); return { ok: true, verdict: 'PASS' }; } },
      runWorker: async () => { calls.push('worker'); return { ok: true, status: 'submitted' }; },
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'create_failed');
    assert.deepEqual(calls, []);
  });
});
