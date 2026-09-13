// @ts-check
/**
 * bin/auto-apply.js (auto-apply PR B): argument parsing, lock-poll contention, the apply-phase chain's
 * advisory-review behavior, and runPrepare's dry-run no-write guarantee -- against fakes, no real
 * database, no real Chrome, no real claude CLI.
 *
 * runSingleApplication (submit-on-resume spec section 4) is the one exception: its gate reuses the real
 * applications.js state machine (getApplication/transition/approve/checkApplicationBlockers) and the real
 * auto-apply-select.js classification, so its own describe block below uses a real test database
 * (matching test/resume-runner.test.js's own convention) while still faking resumeRunner/reviewRunner/
 * runWorker -- no real claude CLI, no real Chrome, exactly like the rest of this file.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { JobSearchError, errFields } from '../src/core/errors.js';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { getApplication } from '../src/core/applications.js';
import { BUILT_IN_BLOCKED } from '../src/apply/exclusions.js';
import { EventEmitter } from 'node:events';
import {
  parseArgs, acquireLockWithPoll, applyOneCandidate, runPrepare, datedRunJsonPath, writeRunJsonNoOverwrite,
  AutoApplyLockedError, createFinish, runLifecycle, runSingleApplication, installLoopDrainedGuard,
} from '../bin/auto-apply.js';

/** A candidate row from runPrepare's own SELECT, with every field the new pre-filters/caps need. */
function prepareRow(overrides = {}) {
  return {
    id: 1, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/1', apply_probed_at: null,
    probe_attempts: 0, fit_score: 80, location_norm: 'country-us', source: 'exec:board',
    company: 'Acme', company_norm: 'acme', title: 'CTO', title_norm: 'cto', description: 'A role.',
    salary_period: null, salary_raw: null, source_url: 'https://execboard.example.com/jobs/1',
    ...overrides,
  };
}

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
  test('--application <n> sets applicationId', () => assert.equal(parseArgs(['--application', '42']).applicationId, 42));
  test('--application with no value throws', () => assert.throws(() => parseArgs(['--application']), /positive integer/));
  test('--application with a non-numeric value throws', () => assert.throws(() => parseArgs(['--application', 'abc']), /positive integer/));
  test('--application with zero or a negative value throws', () => {
    assert.throws(() => parseArgs(['--application', '0']), /positive integer/);
    assert.throws(() => parseArgs(['--application', '-5']), /positive integer/);
  });
  test('--application combines with other flags', () => {
    const out = parseArgs(['--application', '7', '--dry-run']);
    assert.equal(out.applicationId, 7);
    assert.equal(out.dryRun, true);
  });
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
            rows: [{
              id: 1, url: null, url_normalized: 'https://boards.greenhouse.io/acme/jobs/1', apply_probed_at: null,
              probe_attempts: 0, fit_score: 80, location_norm: 'country-us', source: 'exec:board',
            }],
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
      autoApply: { reprobeAfterHours: 48, probeRowCap: 3, probeRowCapWithBrowser: 40, probeFitFloor: 0 },
    };
    // classifyExclusion is stubbed here (spec amendment A4's pre-filter) so this test never touches
    // config/apply-exclusions.json or issues an extra DB query -- it is exercising runPrepare's dry-run
    // write guarantee only, not the exclusion gate.
    const stats = await runPrepare(client, config, {
      now: new Date(), dryRun: true, log: () => {}, classifyExclusion: async () => ({ branch: 'eligible' }),
    });
    assert.equal(stats.attempted, 1);
    assert.equal(stats.skipped, 1); // persistApplyTargetForListing's own dryRun-first check, before any write
    // The only query issued is the candidate SELECT itself -- no UPDATE.
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /^\s*SELECT/);
  });
});

describe('applyOneCandidate: advisory review (submit-on-resume spec section 1) -- any produced resume is submitted', () => {
  function makeRow(overrides = {}) {
    return { listingId: 1, applyAts: 'greenhouse', applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', ...overrides };
  }

  test('a FAIL verdict still calls approve and the worker (advisory only), and consumes a cap slot', async () => {
    /** @type {string[]} */
    const calls = [];
    const deps = {
      resumeRunner: { run: async () => { calls.push('resume'); return { ok: true, markdownPath: 'output/markdown/x.md' }; } },
      reviewRunner: { run: async () => { calls.push('review'); return { ok: true, verdict: 'FAIL', reason: 'review_failed' }; } },
      runWorker: async () => { calls.push('worker'); return { ok: true, status: 'submitted' }; },
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    let withClientCalls = 0;
    deps.withClientFn = async () => {
      withClientCalls++;
      if (withClientCalls === 1) return { id: 99, listing_id: 1 }; // stands in for createApplication's row
      calls.push('approve_or_other_db_call');
      return { id: 99, state: 'approved' }; // stands in for approve()'s row -- fn is never actually invoked
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'applied');
    assert.equal(r.applicationId, 99);
    assert.equal(r.review_verdict, 'FAIL');
    assert.equal(r.review_reason, 'review_failed');
    assert.deepEqual(calls, ['resume', 'review', 'approve_or_other_db_call', 'worker']);
    assert.equal(withClientCalls, 2); // createApplication + approve -- a cap slot IS consumed
  });

  test('a review-runner throw is advisory, never a review_failed outcome -- the chain still proceeds with review_verdict null', async () => {
    /** @type {string[]} */
    const calls = [];
    let withClientCalls = 0;
    const deps = {
      withClientFn: async () => { withClientCalls++; return withClientCalls === 1 ? { id: 7, listing_id: 1 } : { id: 7, state: 'approved' }; },
      resumeRunner: { run: async () => { calls.push('resume'); return { ok: true, markdownPath: 'output/markdown/x.md' }; } },
      reviewRunner: { run: async () => { calls.push('review'); throw new Error('review-cv skill crashed'); } },
      runWorker: async () => { calls.push('worker'); return { ok: true, status: 'submitted' }; },
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'applied');
    assert.equal(r.review_verdict, null);
    assert.equal(r.review_reason, null);
    assert.deepEqual(calls, ['resume', 'review', 'worker']);
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
    assert.equal(r.review_verdict, null);
    assert.equal(r.review_reason, null);
    assert.deepEqual(calls, ['resume']);
    assert.equal(withClientCalls, 1);
  });

  test('a PASS verdict proceeds through approve and the worker, review_verdict/review_reason recorded', async () => {
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
    assert.equal(r.review_verdict, 'PASS');
    assert.equal(r.review_reason, null);
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
    assert.equal(r.review_verdict, null);
    assert.equal(r.review_reason, null);
    assert.deepEqual(calls, []);
  });

  test('approve() throwing after an advisory review still reports the review verdict on approve_failed', async () => {
    let withClientCalls = 0;
    const deps = {
      withClientFn: async () => {
        withClientCalls++;
        if (withClientCalls === 1) return { id: 11, listing_id: 1 }; // createApplication's row
        throw new Error('approve boom'); // second call is approve()
      },
      resumeRunner: { run: async () => ({ ok: true, markdownPath: 'output/markdown/x.md' }) },
      reviewRunner: { run: async () => ({ ok: true, verdict: 'FAIL', reason: 'review_failed' }) },
      runWorker: async () => ({ ok: true, status: 'submitted' }),
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'approve_failed');
    assert.equal(r.review_verdict, 'FAIL');
    assert.equal(r.review_reason, 'review_failed');
    assert.equal(withClientCalls, 2);
  });

  test('reports the new application id via onApplicationStarted right after createApplication, before resume runs', async () => {
    /** @type {number[]} */
    const reported = [];
    /** @type {string[]} */
    const calls = [];
    const deps = {
      withClientFn: async () => ({ id: 42, listing_id: 1 }),
      resumeRunner: { run: async () => { calls.push('resume'); return { ok: false, reason: 'no_description' }; } },
      reviewRunner: { run: async () => { calls.push('review'); return { ok: true, verdict: 'PASS' }; } },
      runWorker: async () => { calls.push('worker'); return { ok: true, status: 'submitted' }; },
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
      onApplicationStarted: (id) => reported.push(id),
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'resume_failed');
    assert.deepEqual(reported, [42], 'the application id must be reported exactly once, as soon as it exists');
    assert.deepEqual(calls, ['resume']);
  });

  test('omitting onApplicationStarted is a no-op -- existing callers are unaffected', async () => {
    const deps = {
      withClientFn: async () => ({ id: 43, listing_id: 1 }),
      resumeRunner: { run: async () => ({ ok: true, markdownPath: 'output/markdown/x.md' }) },
      reviewRunner: { run: async () => ({ ok: true, verdict: 'PASS' }) },
      runWorker: async () => ({ ok: true, status: 'submitted' }),
      outputRoot: '/tmp/output',
      env: {},
      log: () => {},
    };
    const r = await applyOneCandidate(makeRow(), deps);
    assert.equal(r.outcome, 'applied');
  });
});

describe('installLoopDrainedGuard: catches a mid-run event-loop drain (resume-runner/review-runner keep-alive bug, second line of defense)', () => {
  /** A fake process -- a plain EventEmitter, never the real `process` object (spec requirement: unit-test
   * the guard with an injected process emitter, not real process exit). */
  function fakeProc() {
    return new EventEmitter();
  }

  test('a beforeExit before finish() logs auto_apply_loop_drained, marks the summary failed, parks a drafting application, and exits 1', async () => {
    const proc = fakeProc();
    /** @type {any[]} */
    const logs = [];
    const summary = { phase: 'applying', ok: null, outcome: null };
    let summaryWritten = null;
    /** @type {number[]} */
    const exitCodes = [];
    let getApplicationCalls = 0;
    let transitionArgs = null;
    const uninstall = installLoopDrainedGuard(proc, {
      isFinished: () => false,
      getInFlight: () => ({ applicationId: 99, phase: 'applying' }),
      log: (f) => logs.push(f),
      summary,
      summaryFile: '/fake/auto-apply-latest.json',
      writeSummaryFn: (file, s) => { summaryWritten = { file, s: { ...s } }; },
      withClientFn: async (fn) => fn({}),
      getApplicationFn: async () => { getApplicationCalls++; return { id: 99, state: 'drafting' }; },
      transitionFn: async (c, id, state, opts) => { transitionArgs = { id, state, opts }; },
      exitFn: (code) => exitCodes.push(code),
    });
    proc.emit('beforeExit');
    // The handler's own park-and-exit work is async (it awaits withClientFn/getApplicationFn/transitionFn)
    // -- give the microtask/macrotask queue a turn to let it settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    uninstall();

    assert.ok(logs.some((l) => l.evt === 'auto_apply_loop_drained' && l.phase === 'applying' && l.application_id === 99));
    assert.equal(summary.phase, 'failed');
    assert.equal(summary.ok, false);
    assert.equal(summary.outcome, 'loop_drained');
    assert.ok(summaryWritten, 'the latest.json summary must be persisted before parking/exiting');
    assert.equal(summaryWritten.s.outcome, 'loop_drained');
    assert.equal(getApplicationCalls, 1);
    assert.equal(transitionArgs.id, 99);
    assert.equal(transitionArgs.state, 'needs_human');
    assert.equal(transitionArgs.opts.pending_question.kind, 'resume_failed');
    assert.match(transitionArgs.opts.pending_question.label, /process loop drained/);
    assert.deepEqual(exitCodes, [1]);
  });

  test('no application in flight: still logs and exits 1, but never calls getApplication/transition', async () => {
    const proc = fakeProc();
    const summary = { phase: 'preparing', ok: null, outcome: null };
    /** @type {number[]} */
    const exitCodes = [];
    let dbCalls = 0;
    const uninstall = installLoopDrainedGuard(proc, {
      isFinished: () => false,
      getInFlight: () => null,
      log: () => {},
      summary,
      summaryFile: '/fake/auto-apply-latest.json',
      writeSummaryFn: () => {},
      withClientFn: async (fn) => { dbCalls++; return fn({}); },
      exitFn: (code) => exitCodes.push(code),
    });
    proc.emit('beforeExit');
    await new Promise((resolve) => setTimeout(resolve, 20));
    uninstall();
    assert.equal(dbCalls, 0, 'never touches the DB when nothing is in flight');
    assert.deepEqual(exitCodes, [1]);
  });

  test('an application already past drafting (a race with a normal finish) is left untouched, never parked', async () => {
    const proc = fakeProc();
    const summary = { phase: 'applying', ok: null, outcome: null };
    let transitionCalled = false;
    const uninstall = installLoopDrainedGuard(proc, {
      isFinished: () => false,
      getInFlight: () => ({ applicationId: 7, phase: 'applying' }),
      log: () => {},
      summary,
      summaryFile: '/fake/auto-apply-latest.json',
      writeSummaryFn: () => {},
      withClientFn: async (fn) => fn({}),
      getApplicationFn: async () => ({ id: 7, state: 'docs_ready' }),
      transitionFn: async () => { transitionCalled = true; },
      exitFn: () => {},
    });
    proc.emit('beforeExit');
    await new Promise((resolve) => setTimeout(resolve, 20));
    uninstall();
    assert.equal(transitionCalled, false, 'a state other than drafting must never be force-parked');
  });

  test('isFinished() true means a normal exit already happened -- beforeExit is a no-op, nothing fires', () => {
    const proc = fakeProc();
    /** @type {any[]} */
    const logs = [];
    const exitCodes = [];
    const uninstall = installLoopDrainedGuard(proc, {
      isFinished: () => true,
      getInFlight: () => ({ applicationId: 1, phase: 'applying' }),
      log: (f) => logs.push(f),
      summary: { phase: 'done', ok: true, outcome: 'ok' },
      summaryFile: '/fake/auto-apply-latest.json',
      withClientFn: async (fn) => fn({}),
      exitFn: (code) => exitCodes.push(code),
    });
    proc.emit('beforeExit');
    uninstall();
    assert.deepEqual(logs, []);
    assert.deepEqual(exitCodes, []);
  });

  test('a second beforeExit emission while the first is still parking is a no-op (fired guard)', async () => {
    const proc = fakeProc();
    /** @type {any[]} */
    const logs = [];
    const exitCodes = [];
    let getApplicationCalls = 0;
    const uninstall = installLoopDrainedGuard(proc, {
      isFinished: () => false,
      getInFlight: () => ({ applicationId: 5, phase: 'applying' }),
      log: (f) => logs.push(f),
      summary: { phase: 'applying', ok: null, outcome: null },
      summaryFile: '/fake/auto-apply-latest.json',
      writeSummaryFn: () => {},
      withClientFn: async (fn) => fn({}),
      getApplicationFn: async () => { getApplicationCalls++; return { id: 5, state: 'drafting' }; },
      transitionFn: async () => {},
      exitFn: (code) => exitCodes.push(code),
    });
    proc.emit('beforeExit');
    proc.emit('beforeExit'); // re-entrant emission (beforeExit's own documented behavior) while async work is in flight
    await new Promise((resolve) => setTimeout(resolve, 20));
    uninstall();
    assert.equal(getApplicationCalls, 1, 'only the FIRST emission does real work');
    assert.equal(logs.filter((l) => l.evt === 'auto_apply_loop_drained').length, 1);
    assert.deepEqual(exitCodes, [1]);
  });

  test('uninstall() removes the listener -- a beforeExit emitted afterward does nothing', async () => {
    const proc = fakeProc();
    /** @type {any[]} */
    const logs = [];
    const uninstall = installLoopDrainedGuard(proc, {
      isFinished: () => false,
      getInFlight: () => null,
      log: (f) => logs.push(f),
      summary: { phase: 'applying', ok: null, outcome: null },
      summaryFile: '/fake/auto-apply-latest.json',
      writeSummaryFn: () => {},
      withClientFn: async (fn) => fn({}),
      exitFn: () => {},
    });
    uninstall();
    proc.emit('beforeExit');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(logs.length, 0);
  });
});

describe('runPrepare: no-browser fallback caps ONLY the LinkedIn subset (spec amendment A1)', () => {
  test('prepare_without_browser_still_probes_non_linkedin_rows_up_to_cap', async () => {
    const linkedinRows = Array.from({ length: 10 }, (_, i) => prepareRow({ id: 100 + i, source: 'linkedin', fit_score: 90 - i }));
    const nonLinkedinRows = Array.from({ length: 10 }, (_, i) => prepareRow({ id: 200 + i, source: 'exec:board', fit_score: 85 - i }));
    const client = {
      async query(text) {
        if (/^\s*SELECT id, url, url_normalized/.test(text)) return { rows: [...linkedinRows, ...nonLinkedinRows] };
        return { rows: [] };
      },
    };
    const config = {
      atsApply: {
        greenhouse: { hosts: ['boards.greenhouse.io'] }, lever: { hosts: [] }, smartrecruiters: { hosts: [] },
        icims: { hostSuffix: 'icims.com' }, dayforce: { hostSuffix: 'dayforcehcm.com' },
      },
      autoApply: { reprobeAfterHours: 48, probeRowCap: 3, probeRowCapWithBrowser: 5, probeFitFloor: 0 },
      adapters: { adapters: {} },
    };
    const stats = await runPrepare(client, config, {
      now: new Date(), dryRun: true, log: () => {}, linkedInBrowser: null,
      classifyExclusion: async () => ({ branch: 'eligible' }),
    });
    // No browser: every LinkedIn row that was even considered (capped at probeRowCap=3) is skipped, never
    // attempted -- but the non-LinkedIn subset is UNAFFECTED by the missing browser and still gets probed
    // all the way up to its own, much larger cap (probeRowCapWithBrowser=5).
    assert.equal(stats.attempted, 5);
    assert.equal(stats.skippedByReason.no_browser, 3);
    assert.equal(stats.skippedByReason.skipped_dry_run, 5);
  });

  test('the LinkedIn cap itself never changes just because a row order/mix changes', async () => {
    const linkedinRows = Array.from({ length: 10 }, (_, i) => prepareRow({ id: 100 + i, source: 'linkedin', fit_score: 90 - i }));
    const nonLinkedinRows = Array.from({ length: 10 }, (_, i) => prepareRow({ id: 200 + i, source: 'exec:board', fit_score: 85 - i }));
    const client = {
      async query(text) {
        if (/^\s*SELECT id, url, url_normalized/.test(text)) return { rows: [...linkedinRows, ...nonLinkedinRows] };
        return { rows: [] };
      },
    };
    const config = {
      atsApply: {
        greenhouse: { hosts: ['boards.greenhouse.io'] }, lever: { hosts: [] }, smartrecruiters: { hosts: [] },
        icims: { hostSuffix: 'icims.com' }, dayforce: { hostSuffix: 'dayforcehcm.com' },
      },
      autoApply: { reprobeAfterHours: 48, probeRowCap: 3, probeRowCapWithBrowser: 5, probeFitFloor: 0 },
      adapters: { adapters: {} },
    };
    const stats = await runPrepare(client, config, {
      now: new Date(), dryRun: true, log: () => {}, linkedInBrowser: null,
      classifyExclusion: async () => ({ branch: 'eligible' }),
    });
    assert.equal(stats.skippedByReason.no_browser, 3); // still 3 -- the linkedin CAP itself never changes
  });
});

describe('runPrepare: exclusion/hourly pre-filters never consume a probe attempt or the time budget (spec amendment A4)', () => {
  test('an excluded row and an hourly row are both skipped with their own reason, real probe never called', async () => {
    const rows = [
      prepareRow({ id: 1, company: 'Immunotec', company_norm: 'immunotec' }),
      prepareRow({ id: 2, salary_period: 'hour' }),
      prepareRow({ id: 3 }), // eligible, reaches the real probe
    ];
    const client = {
      async query(text) {
        if (/^\s*SELECT id, url, url_normalized/.test(text)) return { rows };
        return { rows: [] };
      },
    };
    const config = {
      atsApply: {
        greenhouse: { hosts: ['boards.greenhouse.io'] }, lever: { hosts: [] }, smartrecruiters: { hosts: [] },
        icims: { hostSuffix: 'icims.com' }, dayforce: { hostSuffix: 'dayforcehcm.com' },
      },
      autoApply: { reprobeAfterHours: 48, probeRowCap: 3, probeRowCapWithBrowser: 40, probeFitFloor: 0 },
      adapters: { adapters: {} },
    };
    const stats = await runPrepare(client, config, {
      now: new Date(), dryRun: true, log: () => {},
      classifyExclusion: async (listing) => (listing.id === 1 ? { branch: 'blocked_company' } : { branch: 'eligible' }),
    });
    assert.equal(stats.attempted, 1); // only row 3 -- rows 1 and 2 never reached a real probe attempt
    assert.equal(stats.skippedByReason.exclusion_blocked_company, 1);
    assert.equal(stats.skippedByReason.hourly_pay, 1);
  });

  test('a pre-filtered row never counts against the time budget: even a budget of 0ms lets it through', async () => {
    const rows = [prepareRow({ id: 1, company: 'Immunotec', company_norm: 'immunotec' })];
    const client = {
      async query(text) {
        if (/^\s*SELECT id, url, url_normalized/.test(text)) return { rows };
        return { rows: [] };
      },
    };
    const config = {
      atsApply: {
        greenhouse: { hosts: ['boards.greenhouse.io'] }, lever: { hosts: [] }, smartrecruiters: { hosts: [] },
        icims: { hostSuffix: 'icims.com' }, dayforce: { hostSuffix: 'dayforcehcm.com' },
      },
      autoApply: { reprobeAfterHours: 48, probeRowCap: 3, probeRowCapWithBrowser: 40, probeFitFloor: 0, probeTimeBudgetMs: 0 },
      adapters: { adapters: {} },
    };
    const stats = await runPrepare(client, config, {
      now: new Date(), dryRun: true, log: () => {}, classifyExclusion: async () => ({ branch: 'blocked_company' }),
    });
    assert.equal(stats.stoppedBy, null); // the pre-filtered row never even reached the budget check
    assert.equal(stats.skippedByReason.exclusion_blocked_company, 1);
  });
});

describe('runPrepare: time budget is checked between rows, never mid-row (base plan fix 2)', () => {
  test('the loop stops once elapsed time exceeds probeTimeBudgetMs, recording stopped_by and remaining', async () => {
    const rows = [prepareRow({ id: 1 }), prepareRow({ id: 2 }), prepareRow({ id: 3 })];
    const client = {
      async query(text) {
        if (/^\s*SELECT id, url, url_normalized/.test(text)) return { rows };
        return { rows: [] };
      },
    };
    const config = {
      atsApply: {
        greenhouse: { hosts: ['boards.greenhouse.io'] }, lever: { hosts: [] }, smartrecruiters: { hosts: [] },
        icims: { hostSuffix: 'icims.com' }, dayforce: { hostSuffix: 'dayforcehcm.com' },
      },
      autoApply: { reprobeAfterHours: 48, probeRowCap: 3, probeRowCapWithBrowser: 40, probeFitFloor: 0, probeTimeBudgetMs: 100 },
      adapters: { adapters: {} },
    };
    let calls = 0;
    // Call 1 captures startTs (0). Call 2 is the between-rows check before row 1: still within budget (10ms
    // elapsed), so row 1 is attempted. Call 3 is the check before row 2: well past the 100ms budget, so the
    // loop stops there -- proving the budget is a between-rows guard (row 1 got through) that still bites
    // promptly (row 2 never starts), never mid-row.
    const clock = () => { calls++; if (calls === 1) return 0; if (calls === 2) return 10; return 1000; };
    const stats = await runPrepare(client, config, {
      now: new Date(), dryRun: true, log: () => {}, clock, classifyExclusion: async () => ({ branch: 'eligible' }),
    });
    assert.equal(stats.stoppedBy, 'time_budget');
    assert.equal(stats.attempted, 1);
    assert.equal(stats.remaining, 2);
  });
});

describe('datedRunJsonPath / writeRunJsonNoOverwrite (spec amendment A6)', () => {
  test('the dated path uses America/Chicago local time, HHMM fixed from `now`', () => {
    const now = new Date('2026-09-04T12:07:00.000Z'); // 07:07 America/Chicago (CDT, UTC-5)
    const p = datedRunJsonPath('/logs', now, 'America/Chicago');
    assert.equal(path.basename(p), 'auto-apply-2026-09-04-0707.json');
  });

  test('a fresh path is written as-is', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-json-test-'));
    try {
      const base = path.join(dir, 'auto-apply-2026-09-04-0707.json');
      const written = writeRunJsonNoOverwrite(base, { ok: true });
      assert.equal(written, base);
      assert.deepEqual(JSON.parse(fs.readFileSync(written, 'utf8')), { ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a same-minute collision never overwrites the earlier file -- gets a -2 suffix instead', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-json-test-'));
    try {
      const base = path.join(dir, 'auto-apply-2026-09-04-0707.json');
      writeRunJsonNoOverwrite(base, { run: 1 });
      const second = writeRunJsonNoOverwrite(base, { run: 2 });
      assert.equal(second, path.join(dir, 'auto-apply-2026-09-04-0707-2.json'));
      assert.deepEqual(JSON.parse(fs.readFileSync(base, 'utf8')), { run: 1 }); // untouched
      assert.deepEqual(JSON.parse(fs.readFileSync(second, 'utf8')), { run: 2 });
      const third = writeRunJsonNoOverwrite(base, { run: 3 });
      assert.equal(third, path.join(dir, 'auto-apply-2026-09-04-0707-3.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runLifecycle + createFinish: every terminal exit writes a phase:"done" summary (spec-adversary fix)', () => {
  /** A createFinish() wired to a temp directory, with process.exit and closePool both stubbed out so the
   * test process is never actually terminated. Returns { finish, latestFile, logDir, exitCodes }. */
  function makeFinishHarness(dir) {
    const summary = { ok: null, phase: 'preparing', started_at: '2026-09-04T11:55:00.000Z', dry_run: false, warnings: [], prepare: null, select: null, applied: [] };
    const latestFile = path.join(dir, 'auto-apply-latest.json');
    const exitCodes = [];
    const finish = createFinish({
      summary, summaryFile: latestFile, logDir: dir, now: new Date('2026-09-04T12:07:00.000Z'),
      timezone: 'America/Chicago', jsonArg: undefined, log: () => {},
      closePoolFn: async () => {}, exitFn: (code) => { exitCodes.push(code); },
    });
    return { summary, finish, latestFile, dir, exitCodes };
  }

  test('locked_exit_writes_terminal_latest_and_dated_json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-lifecycle-test-'));
    try {
      const { summary, finish, latestFile, exitCodes } = makeFinishHarness(dir);
      await runLifecycle(async () => {
        throw new AutoApplyLockedError('could not acquire the advisory lock before the deadline');
      }, { summary, finish, log: () => {} });

      assert.deepEqual(exitCodes, [2]);
      assert.equal(summary.phase, 'done');
      assert.equal(summary.outcome, 'locked');
      assert.equal(summary.ok, false);

      const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      assert.equal(latest.phase, 'done');
      assert.equal(latest.outcome, 'locked');

      const datedFiles = fs.readdirSync(dir).filter((f) => f.startsWith('auto-apply-2026-09-04-'));
      assert.equal(datedFiles.length, 1);
      const dated = JSON.parse(fs.readFileSync(path.join(dir, datedFiles[0]), 'utf8'));
      assert.equal(dated.phase, 'done');
      assert.equal(dated.outcome, 'locked');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uncaught_error_writes_terminal_state_with_outcome_error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-lifecycle-test-'));
    try {
      const { summary, finish, latestFile, exitCodes } = makeFinishHarness(dir);
      await runLifecycle(async () => {
        throw new Error('boom: something in prepare/select/apply threw');
      }, { summary, finish, log: () => {} });

      assert.deepEqual(exitCodes, [1]);
      assert.equal(summary.phase, 'done');
      assert.equal(summary.outcome, 'error');
      assert.equal(summary.ok, false);
      assert.match(summary.error.message, /boom: something in prepare\/select\/apply threw/);

      const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      assert.equal(latest.phase, 'done');
      assert.equal(latest.outcome, 'error');
      assert.match(latest.error.message, /boom/);

      const datedFiles = fs.readdirSync(dir).filter((f) => f.startsWith('auto-apply-2026-09-04-'));
      assert.equal(datedFiles.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normal completion (body calls finish itself) is untouched by runLifecycle -- no outcome is forced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-lifecycle-test-'));
    try {
      const { summary, finish, latestFile, exitCodes } = makeFinishHarness(dir);
      await runLifecycle(async () => {
        summary.ok = true;
        summary.outcome = 'ok';
        await finish(0);
      }, { summary, finish, log: () => {} });

      assert.deepEqual(exitCodes, [0]);
      assert.equal(summary.outcome, 'ok');
      const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      assert.equal(latest.outcome, 'ok');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a same-minute collision on the dated file still succeeds (a -2 file appears), never throws out of runLifecycle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-lifecycle-test-'));
    try {
      // Pre-seed the dated file this run's own createFinish() will target (America/Chicago local time,
      // 07:07 for the 12:07 UTC `now` makeFinishHarness uses), forcing a -2 collision.
      fs.writeFileSync(path.join(dir, 'auto-apply-2026-09-04-0707.json'), '{}\n');
      const { summary, finish, exitCodes } = makeFinishHarness(dir);
      await runLifecycle(async () => {
        throw new AutoApplyLockedError('locked');
      }, { summary, finish, log: () => {} });
      assert.deepEqual(exitCodes, [2]);
      assert.ok(fs.existsSync(path.join(dir, 'auto-apply-2026-09-04-0707-2.json')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Residual gap fixed here (spec-adversary finding on the follow-up PR): the apply exclusion gate config
  // load used to run BEFORE runLifecycle was ever entered, in its own try/catch that only handled
  // CONFIG_INVALID and bare-rethrew anything else -- that bare rethrow escaped runLifecycle entirely and
  // fell to main().catch() at the bottom of bin/auto-apply.js, which never calls finish(), leaving
  // latest.json stuck at a non-'done' phase and skipping the dated run JSON. These two tests replicate the
  // exact try/catch bin/auto-apply.js now runs as the FIRST statements inside runLifecycle's own body (a
  // fake loadExclusionConfig stands in for the real one, since it is not itself an injectable seam) to
  // prove both outcomes now reach a terminal, phase:'done' summary either way.
  test('exclusion_config_load_error_writes_terminal_state_with_outcome_error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-lifecycle-test-'));
    try {
      const { summary, finish, latestFile, exitCodes } = makeFinishHarness(dir);
      // Simulates loadExclusionConfig() throwing something OTHER than CONFIG_INVALID -- e.g. a filesystem
      // permission error, or any other unexpected failure reading config/apply-exclusions.json.
      const loadExclusionConfigFn = () => { throw new JobSearchError('DB_UNAVAILABLE', 'disk read failed'); };
      await runLifecycle(async () => {
        let exclusionConfig;
        try {
          exclusionConfig = loadExclusionConfigFn();
        } catch (err) {
          const f = errFields(err);
          if (f.err_code !== 'CONFIG_INVALID') throw err;
          Object.assign(summary, { ok: false, no_apply: { file: 'config/apply-exclusions.json', message: f.err_message } });
          await finish(1);
          return;
        }
        void exclusionConfig;
        await finish(0); // unreached in this test -- the fake always throws
      }, { summary, finish, log: () => {} });

      assert.deepEqual(exitCodes, [1]);
      assert.equal(summary.phase, 'done');
      assert.equal(summary.outcome, 'error');
      assert.equal(summary.ok, false);
      assert.equal(summary.no_apply, undefined); // never conflated with the CONFIG_INVALID outcome
      assert.match(summary.error.message, /disk read failed/);

      const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      assert.equal(latest.phase, 'done');
      assert.equal(latest.outcome, 'error');

      const datedFiles = fs.readdirSync(dir).filter((f) => f.startsWith('auto-apply-2026-09-04-'));
      assert.equal(datedFiles.length, 1);
      const dated = JSON.parse(fs.readFileSync(path.join(dir, datedFiles[0]), 'utf8'));
      assert.equal(dated.phase, 'done');
      assert.equal(dated.outcome, 'error');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('config_invalid_still_writes_terminal_state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-apply-lifecycle-test-'));
    try {
      const { summary, finish, latestFile, exitCodes } = makeFinishHarness(dir);
      const loadExclusionConfigFn = () => { throw new JobSearchError('CONFIG_INVALID', 'apply-exclusions.json missing or unreadable: config/apply-exclusions.json'); };
      await runLifecycle(async () => {
        let exclusionConfig;
        try {
          exclusionConfig = loadExclusionConfigFn();
        } catch (err) {
          const f = errFields(err);
          if (f.err_code !== 'CONFIG_INVALID') throw err;
          Object.assign(summary, { ok: false, no_apply: { file: 'config/apply-exclusions.json', message: f.err_message } });
          await finish(1);
          return;
        }
        void exclusionConfig;
        await finish(0); // unreached in this test -- the fake always throws
      }, { summary, finish, log: () => {} });

      // Behavior identical to before this fix: exit 1, no_apply set with the file/message, outcome/error
      // NEVER set (CONFIG_INVALID stays its own distinct path, never conflated with the generic 'error'
      // outcome) -- but it now ALSO reaches a terminal record, which is the actual point of this test.
      assert.deepEqual(exitCodes, [1]);
      assert.equal(summary.phase, 'done');
      assert.equal(summary.ok, false);
      assert.equal(summary.outcome, undefined);
      assert.equal(summary.error, undefined);
      assert.match(summary.no_apply.message, /apply-exclusions\.json missing or unreadable/);
      assert.equal(summary.no_apply.file, 'config/apply-exclusions.json');

      const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      assert.equal(latest.phase, 'done');
      assert.equal(latest.ok, false);
      assert.ok(latest.no_apply);

      const datedFiles = fs.readdirSync(dir).filter((f) => f.startsWith('auto-apply-2026-09-04-'));
      assert.equal(datedFiles.length, 1);
      const dated = JSON.parse(fs.readFileSync(path.join(dir, datedFiles[0]), 'utf8'));
      assert.equal(dated.phase, 'done');
      assert.ok(dated.no_apply);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSingleApplication: --application re-drive (submit-on-resume spec section 4, amendments A1-A3)', () => {
  const CO = `ZZ-TEST-AUTOAPPLYSINGLE-${process.pid}`;
  const LONG_DESCRIPTION = 'A senior technology leadership role. '.repeat(20);
  const FLOORS = { texas_or_remote: 225000, relocation: 275000 };
  /** @type {pg.Client} */
  let client;
  /** @type {string} */
  let outputRoot;
  /** @type {number[]} */
  const listingIds = [];

  /** @param {Partial<{ company: string, companyNorm: string, locationNorm: string, fitScore: number|null, salaryMax: number|null, salaryPeriod: string|null, salaryRaw: string|null, applyAts: string, applyConfidence: string, applyEasyOnly: boolean, status: string|null, description: string|null }>} o */
  async function insertListing(o = {}) {
    const n = Math.floor(Math.random() * 1e9);
    const r = await client.query(
      `INSERT INTO ic_job_listings (
         title, company, source, external_id, record_kind, company_norm, title_norm, location_norm,
         dedup_hash, last_seen, description, fit_score, salary_max, salary_period, salary_raw,
         apply_url, apply_ats, apply_ats_confidence, apply_easy_only, status
       ) VALUES (
         'AutoApply Single Test', $1, $2, $3, 'listing', $4, $5, $6, $7, now(), $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17
       ) RETURNING id`,
      [
        o.company ?? CO, `zz-test-autoapplysingle-${process.pid}`, `zz-test-autoapplysingle-${process.pid}:${n}`,
        o.companyNorm ?? `zzautoapplysingleco${n}`, `zzautoapplysinglerole${n}`, o.locationNorm ?? 'country-us',
        `zz-autoapplysingle-hash-${n}`, o.description === undefined ? LONG_DESCRIPTION : o.description,
        o.fitScore === undefined ? 90 : o.fitScore, o.salaryMax ?? null, o.salaryPeriod ?? null, o.salaryRaw ?? null,
        'https://boards.greenhouse.io/acme/jobs/1', o.applyAts ?? 'greenhouse', o.applyConfidence ?? 'exact',
        o.applyEasyOnly ?? false, o.status ?? null,
      ],
    );
    const id = Number(r.rows[0].id);
    listingIds.push(id);
    return id;
  }

  /** @param {number} listingId @param {{ state?: string, pendingQuestion?: unknown, resumeDocId?: number|null }} [o] */
  async function seedApplication(listingId, o = {}) {
    const cols = ['listing_id', 'state'];
    const vals = [listingId, o.state ?? 'drafting'];
    const placeholders = ['$1', '$2'];
    let i = 2;
    if (o.pendingQuestion !== undefined) { i += 1; cols.push('pending_question'); vals.push(JSON.stringify(o.pendingQuestion)); placeholders.push(`$${i}::jsonb`); }
    if (o.resumeDocId !== undefined) { i += 1; cols.push('resume_doc_id'); vals.push(o.resumeDocId); placeholders.push(`$${i}`); }
    const r = await client.query(`INSERT INTO ic_job_applications (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`, vals);
    return Number(r.rows[0].id);
  }

  /** @param {number} listingId @param {string} relPath */
  async function insertDocument(listingId, relPath) {
    const r = await client.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`, [listingId, relPath]);
    return Number(r.rows[0].id);
  }

  function writeResumeFile(relPath, bytes = 'fake-resume-bytes') {
    const abs = path.join(outputRoot, 'output', relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }

  async function cleanup() {
    if (listingIds.length === 0) return;
    await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
    await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
    await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
    await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
    await client.query('DELETE FROM ic_followups WHERE listing_id = ANY($1::int[])', [listingIds]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
    listingIds.length = 0;
  }

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    await ensureAuxSchema(client);
    await cleanup();
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-autoapplysingle-'));
    fs.mkdirSync(path.join(outputRoot, 'output', 'resumes'), { recursive: true });
  });
  after(async () => {
    await cleanup();
    await client.end();
    await closePool();
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  /** A fake resumeRunner that mimics the real one's DB side effect (link a resume doc, flip docs_ready)
   * so approve() downstream has something real to hash -- never spawns a claude CLI. */
  function fakeResumeRunnerSucceeds() {
    return {
      run: async (applicationId, listingId) => {
        const relPath = `resumes/App ${applicationId}.docx`;
        writeResumeFile(relPath);
        const docId = await insertDocument(listingId, relPath);
        await client.query(`UPDATE ic_job_applications SET state = 'docs_ready', resume_doc_id = $2, updated_at = now() WHERE id = $1`, [applicationId, docId]);
        return { ok: true, markdownPath: 'output/markdown/fake.md' };
      },
    };
  }

  function baseSingleDeps(overrides = {}) {
    return {
      withClientFn: withClient,
      resumeRunner: fakeResumeRunnerSucceeds(),
      reviewRunner: { run: async () => ({ ok: true, verdict: 'PASS' }) },
      runWorker: async () => ({ ok: true, status: 'submitted' }),
      outputRoot: path.join(outputRoot, 'output'),
      env: {},
      log: () => {},
      config: {
        autoApply: { fitFloor: 60, floors: FLOORS, atsAllow: ['greenhouse'], dailyCap: 5 },
        adapters: { run: { timezone: 'America/Chicago' } },
        configDir: outputRoot,
      },
      now: new Date(),
      exclusionConfig: { blockedCompanies: [...BUILT_IN_BLOCKED], appliedHistory: [] },
      ...overrides,
    };
  }

  test('a state outside drafting/needs_human/docs_ready is refused with state_<state>, no gate checks run', async () => {
    const listingId = await insertListing();
    const appId = await seedApplication(listingId, { state: 'submitted' });
    const r = await runSingleApplication(appId, baseSingleDeps());
    assert.equal(r.outcome, 'refused');
    assert.equal(r.reason, 'state_submitted');
  });

  test('needs_human with a non-resume_failed kind is refused pointing at /apply-answer, never re-runs the resume runner', async () => {
    const listingId = await insertListing();
    const appId = await seedApplication(listingId, { state: 'needs_human', pendingQuestion: { kind: 'question', label: 'What is your notice period?' } });
    let resumeCalled = false;
    const r = await runSingleApplication(appId, baseSingleDeps({ resumeRunner: { run: async () => { resumeCalled = true; return { ok: true }; } } }));
    assert.equal(r.outcome, 'refused');
    assert.equal(r.reason, 'needs_human_not_resume_failed');
    assert.match(r.message, /apply-answer/);
    assert.equal(resumeCalled, false);
    const row = await getApplication(client, appId);
    assert.equal(row.state, 'needs_human', 'never transitioned when refused');
  });

  test('the apply exclusion gate refuses a blocked-employer listing (amendment A1), excludeApplicationId set so it is never "already applied" against itself', async () => {
    const listingId = await insertListing({ company: 'Immunotec Research', companyNorm: 'immunotec research' });
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps());
    assert.equal(r.outcome, 'refused');
    assert.equal(r.reason, 'exclusion_blocked_company');
  });

  test('the same salary/hourly classification auto-apply-select.js uses refuses hourly pay (amendment A1)', async () => {
    const listingId = await insertListing({ salaryPeriod: 'hour' });
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps());
    assert.equal(r.outcome, 'refused');
    assert.equal(r.reason, 'hourly_pay');
  });

  test('the same classification refuses salary below the resolved floor', async () => {
    const listingId = await insertListing({ locationNorm: 'country-us', salaryMax: 100000 });
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps());
    assert.equal(r.outcome, 'refused');
    assert.equal(r.reason, 'salary_below_floor');
  });

  test('checkApplicationBlockers refuses a closed listing status', async () => {
    const listingId = await insertListing({ status: 'lost' });
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps());
    assert.equal(r.outcome, 'refused');
    assert.match(r.reason, /"lost"/);
  });

  test('the daily cap refuses when already exhausted, exit-code-0-shaped outcome (never a throw)', async () => {
    const listingId = await insertListing();
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps({
      config: { autoApply: { fitFloor: 60, floors: FLOORS, atsAllow: ['greenhouse'], dailyCap: 2 }, adapters: { run: { timezone: 'America/Chicago' } }, configDir: outputRoot },
      countAutoApprovedTodayFn: async () => 2,
    }));
    assert.equal(r.outcome, 'refused');
    assert.equal(r.reason, 'daily_cap');
  });

  test('re-drive from drafting: runs the resume runner, review (advisory), approve, worker -> applied', async () => {
    const listingId = await insertListing();
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps());
    assert.equal(r.outcome, 'applied');
    assert.equal(r.review_verdict, 'PASS');
    const row = await getApplication(client, appId);
    assert.equal(row.state, 'approved');
  });

  test('re-drive from needs_human (kind resume_failed): transitions to drafting first (actor cli), then runs normally -> applied', async () => {
    const listingId = await insertListing();
    const appId = await seedApplication(listingId, {
      state: 'needs_human', pendingQuestion: { kind: 'resume_failed', label: 'Resume drafting failed: timeout' },
    });
    const r = await runSingleApplication(appId, baseSingleDeps());
    assert.equal(r.outcome, 'applied');
    const events = await client.query(`SELECT from_state, to_state, actor FROM ic_job_application_events WHERE application_id = $1 ORDER BY id ASC`, [appId]);
    const parkClearEvent = events.rows.find((e) => e.from_state === 'needs_human' && e.to_state === 'drafting');
    assert.ok(parkClearEvent, 'needs_human -> drafting transition recorded');
    assert.equal(parkClearEvent.actor, 'cli');
  });

  test('re-drive from needs_human (resume_failed) with a document ALREADY linked: shortcuts straight to docs_ready, never re-runs the resume runner', async () => {
    const listingId = await insertListing();
    const relPath = 'resumes/Already Linked.docx';
    writeResumeFile(relPath);
    const docId = await insertDocument(listingId, relPath);
    const appId = await seedApplication(listingId, {
      state: 'needs_human', pendingQuestion: { kind: 'resume_failed', label: 'Resume drafting failed: approve_failed' }, resumeDocId: docId,
    });
    let resumeCalled = false;
    const r = await runSingleApplication(appId, baseSingleDeps({ resumeRunner: { run: async () => { resumeCalled = true; return { ok: false }; } } }));
    assert.equal(resumeCalled, false, 'the resume runner is never invoked when a document is already linked');
    assert.equal(r.outcome, 'applied');
    // No fresh markdown from this run -- review must never have been asked to run.
    assert.equal(r.review_verdict, null);
  });

  test('re-drive from docs_ready: skips the resume runner AND review entirely, still approves and submits', async () => {
    const listingId = await insertListing();
    const relPath = 'resumes/Already Docs Ready.docx';
    writeResumeFile(relPath);
    const docId = await insertDocument(listingId, relPath);
    const appId = await seedApplication(listingId, { state: 'docs_ready', resumeDocId: docId });
    let resumeCalled = false;
    let reviewCalled = false;
    const r = await runSingleApplication(appId, baseSingleDeps({
      resumeRunner: { run: async () => { resumeCalled = true; return { ok: false }; } },
      reviewRunner: { run: async () => { reviewCalled = true; return { ok: true, verdict: 'PASS' }; } },
    }));
    assert.equal(resumeCalled, false);
    assert.equal(reviewCalled, false);
    assert.equal(r.outcome, 'applied');
    assert.equal(r.review_verdict, null);
  });

  test('a resume-runner failure on re-drive is reported as resume_failed with review fields null', async () => {
    const listingId = await insertListing();
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps({
      resumeRunner: { run: async () => ({ ok: false, reason: 'no_description' }) },
    }));
    assert.equal(r.outcome, 'resume_failed');
    assert.equal(r.reason, 'no_description');
    assert.equal(r.review_verdict, null);
    assert.equal(r.review_reason, null);
  });

  test('a review-runner throw during re-drive is advisory only -- the chain still reaches applied', async () => {
    const listingId = await insertListing();
    const appId = await seedApplication(listingId, { state: 'drafting' });
    const r = await runSingleApplication(appId, baseSingleDeps({
      reviewRunner: { run: async () => { throw new Error('review-cv crashed'); } },
    }));
    assert.equal(r.outcome, 'applied');
    assert.equal(r.review_verdict, null);
  });

  test('a nonexistent application id is refused, never throws', async () => {
    const r = await runSingleApplication(999999999, baseSingleDeps());
    assert.equal(r.outcome, 'refused');
    assert.equal(r.reason, 'not_found');
  });
});

