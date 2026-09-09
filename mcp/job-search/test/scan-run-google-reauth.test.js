// @ts-check
/**
 * Unattended Google re-auth policy (spec A6) in src/core/scan-run.js: gmail reordered last, a detached
 * bin/google-reauth.js spawned once the run row exists, re-classification at gmail's own turn, and the
 * AUTH_REAUTH_PENDING / AUTH_REAUTH_FAILED warning-severity rows on the run. Real DB (mirrors
 * test/scan-run.test.js's own convention); gmail itself is never actually contacted -- it is always
 * intercepted before its adapter's search() ever runs, via deps.classifyGoogleTokenState. deps.spawn is
 * always injected so no real child process is ever launched.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, makeFixtureFetch, DEFAULT_MAP, FIXTURE_NOW } from './helpers/scan-fixtures.js';
import { getEnv } from '../src/core/config.js';

const PROFILE = `zz-test-scan-reauth-${process.pid}`;
/** @type {import('pg').Client} */
let client;

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  await upsertTestProfile(client, PROFILE, { sources: ['gmail', 'greenhouse'], keywords: ['Chief Technology Officer', 'Chief Information Officer', 'Vice President, Technology'], phrases: [], locations: ['Houston, TX'] });
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  } finally {
    await client.end();
  }
});

const ZZ_MAP = DEFAULT_MAP.filter((m) => m.prefix.includes('zztest') || m.prefix.includes('/gitlab/'));
const TOKEN_FILE = 'zz-test-google-token.json';

/** @param {'ok'|'broken'} kind */
function fakeClassify(kind, calls) {
  return async (tokenFile, need) => {
    calls.push({ tokenFile, need });
    return kind === 'ok' ? { state: 'ok', expiry: '2099-01-01T00:00:00' } : { state: 'broken_invalid_grant' };
  };
}

describe('unattended Google re-auth policy (scan-run.js, spec A6)', () => {
  test('gmail still broken at its own (last) turn: skipped, AUTH_REAUTH_PENDING warning row, run stays ok, greenhouse still completes', async () => {
    /** @type {any[]} */
    const classifyCalls = [];
    /** @type {any[]} */
    const spawnCalls = [];
    /** @type {any[]} */
    const logLines = [];
    const spawnImpl = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { unref() {} };
    };
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      env: { ...getEnv(), GOOGLE_TOKEN_FILE: TOKEN_FILE },
      classifyGoogleTokenState: fakeClassify('broken', classifyCalls),
      spawn: spawnImpl,
    });
    const r = await runScanWaiting(
      { profile: PROFILE, sources: ['gmail', 'greenhouse'], dryRun: false, wait: true },
      deps,
      { trigger: 'cli', log: (f) => logLines.push(f), now: FIXTURE_NOW },
    );

    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.equal(classifyCalls.length, 2, 'classified once before the loop and once again at gmail\'s own turn');
    for (const c of classifyCalls) {
      assert.equal(c.tokenFile, TOKEN_FILE);
      assert.equal(c.need.gmail, true);
      assert.equal(c.need.gmailRead, true);
    }
    assert.equal(spawnCalls.length, 1, 'the reauth CLI is spawned exactly once, fire-and-forget');
    assert.equal(spawnCalls[0].cmd, process.execPath);
    assert.ok(spawnCalls[0].args.some((a) => String(a).endsWith('bin/google-reauth.js') || String(a).endsWith('bin\\google-reauth.js')));
    assert.ok(spawnCalls[0].args.includes('--wait-ms'));
    assert.ok(spawnCalls[0].args.includes('7200000'));
    assert.ok(spawnCalls[0].args.includes('--token-file'));
    assert.ok(spawnCalls[0].args.includes(TOKEN_FILE));
    assert.deepEqual(spawnCalls[0].opts, { detached: true, windowsHide: true, stdio: 'ignore' });

    const pending = r.errors.find((e) => e.code === 'AUTH_REAUTH_PENDING');
    assert.ok(pending, JSON.stringify(r.errors));
    assert.equal(pending.source, 'gmail');
    assert.equal(pending.severity, 'warning');
    assert.match(pending.message, /consent tab is open/);

    // Ordering (spec A6): gmail's own log line must come AFTER every greenhouse log line -- proof gmail
    // ran (or, here, was skipped) at the END of the source loop, not at its original list position.
    const gmailLogIndex = logLines.findIndex((f) => f.source === 'gmail' && f.evt === 'adapter_warning');
    const lastGreenhouseIndex = logLines.reduce((last, f, i) => (f.source === 'greenhouse' ? i : last), -1);
    assert.ok(gmailLogIndex > -1, 'gmail logged its own skip');
    assert.ok(lastGreenhouseIndex > -1, 'greenhouse actually ran');
    assert.ok(gmailLogIndex > lastGreenhouseIndex, `gmail (index ${gmailLogIndex}) must be logged after greenhouse's last event (index ${lastGreenhouseIndex})`);

    // greenhouse rows still landed despite gmail's auth being broken all run.
    const rows = await client.query(`SELECT id FROM ic_job_listings WHERE company = 'ZZ-TEST-SCAN' AND search_profile = $1`, [PROFILE]);
    assert.ok(rows.rowCount > 0, 'greenhouse still wrote rows this run');
  });

  test('consent completes mid-run: re-classification at gmail\'s own turn is ok, gmail proceeds normally', async () => {
    /** @type {any[]} */
    const classifyCalls = [];
    let callN = 0;
    const classifyImpl = async (tokenFile, need) => {
      callN++;
      classifyCalls.push({ tokenFile, need, callN });
      // First call (pre-loop): still broken -> triggers the spawn. Second call (gmail's own turn): ok,
      // simulating a consent completed moments ago by a real bin/google-reauth.js process.
      return callN === 1 ? { state: 'broken_invalid_grant' } : { state: 'ok', expiry: '2099-01-01T00:00:00' };
    };
    const spawnImpl = () => ({ unref() {} });
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      env: { ...getEnv(), GOOGLE_TOKEN_FILE: TOKEN_FILE },
      classifyGoogleTokenState: classifyImpl,
      spawn: spawnImpl,
    });
    const r = await runScanWaiting(
      { profile: PROFILE, sources: ['gmail', 'greenhouse'], dryRun: false, wait: true },
      deps,
      { trigger: 'cli', log: () => {}, now: FIXTURE_NOW },
    );

    // Only scan-run.js's OWN re-classification decision is under test here: whether it lets gmail's
    // turn proceed instead of short-circuiting with a reauth-pending warning. What gmail's own adapter
    // then does (TOKEN_FILE is a made-up name, not a real token file on disk, so its own unmocked
    // classifyAndConnect will separately -- and correctly -- report broken_missing_file and mark the
    // run partial) is a different, already-covered concern; this test never asserts overall run status.
    assert.equal(classifyCalls.length, 2, 'classified once before the loop and once again at gmail\'s own turn');
    assert.ok(!r.errors.some((e) => e.code === 'AUTH_REAUTH_PENDING' || e.code === 'AUTH_REAUTH_FAILED'), 'no reauth-pending/failed warning once the token is ok again: scan-run.js let gmail\'s own turn proceed instead of short-circuiting it');
  });

  test('spawn itself fails: AUTH_REAUTH_FAILED (not PENDING), run never fails because of it', async () => {
    /** @type {any[]} */
    const classifyCalls = [];
    const spawnImpl = () => {
      throw new Error('spawn ENOENT: node not found');
    };
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      env: { ...getEnv(), GOOGLE_TOKEN_FILE: TOKEN_FILE },
      classifyGoogleTokenState: fakeClassify('broken', classifyCalls),
      spawn: spawnImpl,
    });
    const r = await runScanWaiting(
      { profile: PROFILE, sources: ['gmail', 'greenhouse'], dryRun: false, wait: true },
      deps,
      { trigger: 'cli', log: () => {}, now: FIXTURE_NOW },
    );

    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    const failed = r.errors.find((e) => e.code === 'AUTH_REAUTH_FAILED');
    assert.ok(failed, JSON.stringify(r.errors));
    assert.equal(failed.source, 'gmail');
    assert.equal(failed.severity, 'warning');
    assert.match(failed.message, /spawn ENOENT/);
    assert.ok(!r.errors.some((e) => e.code === 'AUTH_REAUTH_PENDING'), 'AUTH_REAUTH_FAILED replaces PENDING, never both');
  });

  test('interactive trigger (mcp/dashboard): the unattended policy never engages at all -- no spawn, no reorder-driven skip', async () => {
    /** @type {any[]} */
    const classifyCalls = [];
    const spawnImpl = () => {
      throw new Error('must never be called in an interactive run');
    };
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      env: { ...getEnv(), GOOGLE_TOKEN_FILE: TOKEN_FILE },
      classifyGoogleTokenState: fakeClassify('broken', classifyCalls),
      spawn: spawnImpl,
      // gmail's own adapter has no alert-senders configured to actually parse in this fixture run, so it
      // yields its ordinary "no GOOGLE_TOKEN_FILE"-shaped AUTH_UNAVAILABLE warning through its normal
      // (unmodified) preflight path once ctx.interactive is true and ctx.reauthGoogle's own attempt (via
      // the real reauthorizeGoogle, since deps.reauthorizeGoogle is not overridden here) cannot reach a
      // real Google -- this test only asserts the UNATTENDED-specific machinery (spawn, reorder-skip)
      // never engages for an interactive trigger, not what gmail's own outcome is.
    });
    const r = await runScanWaiting(
      { profile: PROFILE, sources: ['gmail', 'greenhouse'], dryRun: false, wait: true },
      deps,
      { trigger: 'mcp', log: () => {}, now: FIXTURE_NOW, interactive: true },
    );

    assert.equal(classifyCalls.length, 0, 'the unattended pre-loop classification never runs when interactive is true');
    assert.ok(!r.errors.some((e) => e.code === 'AUTH_REAUTH_PENDING' || e.code === 'AUTH_REAUTH_FAILED'), 'those two codes are unattended-only');
  });
});
