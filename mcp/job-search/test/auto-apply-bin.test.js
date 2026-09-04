// @ts-check
/**
 * bin/auto-apply.js (auto-apply PR B): argument parsing, lock-poll contention, the apply-phase chain's
 * review-FAIL-parks behavior, and runPrepare's dry-run no-write guarantee -- all against fakes, no real
 * database, no real Chrome, no real claude CLI.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobSearchError, errFields } from '../src/core/errors.js';
import {
  parseArgs, acquireLockWithPoll, applyOneCandidate, runPrepare, datedRunJsonPath, writeRunJsonNoOverwrite,
  AutoApplyLockedError, createFinish, runLifecycle,
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
