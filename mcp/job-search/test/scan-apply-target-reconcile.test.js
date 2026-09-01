// @ts-check
/**
 * Orchestrator review fix (apply pipeline slice 5): src/core/scan-run.js's getSession() now calls
 * session.reconcileTargets(applyTargetMarkerPath(env.JOBSEARCH_LOG_DIR)) before session.reconcile(), so a
 * crashed apply run's leftover page in the SHARED scan Chrome is closed at the start of the next scan run
 * too, not only the next apply run. This test drives a real runScan() (indeed source, dry run, fixture
 * transport, no real network) with a fake session built on top of test/helpers/scan-fixtures.js's own
 * makeFakeSession, extended with a reconcileTargets() that behaves like the real one (reads the marker
 * file's target_ids, "closes" exactly those, clears the file) but without needing a real CDP connection --
 * session.js's OWN reconcileTargets/writeTargetMarker implementation is already exercised end to end
 * against a real fake CDP session in test/apply-route-policy.test.js; this file is about the WIRING (the
 * correct marker path, called at the right time, swallowed on failure), not re-proving that mechanism.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, makeFakeSession } from './helpers/scan-fixtures.js';
import { applyTargetMarkerPath } from '../src/browser/session.js';

const PROFILE = `zz-test-scan-target-reconcile-${process.pid}`;
/** @type {import('pg').Client} */
let client;
/** @type {string} */
let logDir;

before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN-TARGET-RECONCILE'] });
  await client.query(`DELETE FROM ic_source_state WHERE source = 'indeed'`);
  await upsertTestProfile(client, PROFILE, { sources: ['indeed'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-scan-target-reconcile-'));
});
after(async () => {
  try {
    await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN-TARGET-RECONCILE'] });
  } finally {
    await client.end();
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

const TEST_ENV = () => ({
  PG_DSN: null, SCAN_CDP_URL: 'http://127.0.0.1:1', DAILY_CDP_URL: 'http://127.0.0.1:2',
  SCAN_PROFILE_DIR: logDir, CHROME_EXECUTABLE: null, OLLAMA_URL: 'http://127.0.0.1:1', OLLAMA_MODEL: 'test-model',
  JOBSEARCH_LOG_DIR: logDir, JOBSEARCH_CONFIG_DIR: logDir, GOOGLE_TOKEN_FILE: '', REMINDER_TO: '',
  LOG_LEVEL: 'silent', DASHBOARD_PORT: undefined,
});

/**
 * Wraps test/helpers/scan-fixtures.js's makeFakeSession with a reconcileTargets() that behaves like the
 * real contract: reads `{target_ids:[...]}` from the marker file, "closes" (records) exactly those ids,
 * clears the file to `{target_ids:[]}`, and returns `{attempted, closed}`. A missing file, or one whose
 * reconcileTargets call is configured to throw, is handled by the two options below.
 * @param {{ indeedCards?: any[], throwOnReconcile?: boolean }} o
 */
function makeFakeSessionWithTargetReconcile(o = {}) {
  const base = makeFakeSession({ indeedCards: o.indeedCards ?? [] });
  /** @type {string[]} */
  const reconcileCalls = [];
  /** @type {string[]} */
  const closedIds = [];
  const connectSession = async (opts) => {
    const session = await base.connectSession(opts);
    return {
      ...session,
      async reconcileTargets(markerPath) {
        reconcileCalls.push(markerPath);
        if (o.throwOnReconcile) throw new Error('simulated reconcileTargets failure');
        /** @type {string[]} */
        let ids = [];
        try {
          const raw = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
          if (raw && Array.isArray(raw.target_ids)) ids = raw.target_ids;
        } catch {
          return { attempted: 0, closed: 0 };
        }
        if (ids.length === 0) return { attempted: 0, closed: 0 };
        closedIds.push(...ids);
        fs.writeFileSync(markerPath, JSON.stringify({ target_ids: [] }));
        return { attempted: ids.length, closed: ids.length };
      },
      async writeTargetMarker() { /* not exercised by the scan side */ },
    };
  };
  return { connectSession, reconcileCalls, closedIds, state: base.state };
}

describe('scan-run.js getSession(): CDP target-id reconcile wiring', () => {
  test('a scan run with a stale apply marker calls reconcileTargets with the correct shared path and closes exactly those targets', async () => {
    const markerFile = applyTargetMarkerPath(logDir);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ target_ids: ['stale-target-1', 'stale-target-2'] }));

    const fake = makeFakeSessionWithTargetReconcile({
      indeedCards: [{ jobkey: 'a1b2c3d4e5f60718', title: 'Chief Technology Officer', company: 'ZZ-TEST-SCAN-TARGET-RECONCILE', location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: null }],
    });
    const deps = offlineDeps({ connectSession: fake.connectSession, env: TEST_ENV() });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: true, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
    }

    assert.deepEqual(fake.reconcileCalls, [markerFile], 'getSession() must call reconcileTargets exactly once, with the shared applyTargetMarkerPath');
    assert.deepEqual(fake.closedIds, ['stale-target-1', 'stale-target-2'], 'exactly the marker-recorded target ids must be closed, nothing else');
    const remaining = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.deepEqual(remaining.target_ids, [], 'the marker file must be cleared after reconciling');
  });

  test('a scan run with no marker file touches nothing (reconcileTargets is called, closes zero, scan proceeds normally)', async () => {
    const markerFile = applyTargetMarkerPath(logDir);
    fs.rmSync(markerFile, { force: true });

    const fake = makeFakeSessionWithTargetReconcile({
      indeedCards: [{ jobkey: 'b2c3d4e5f6071829', title: 'Chief Technology Officer', company: 'ZZ-TEST-SCAN-TARGET-RECONCILE', location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: null }],
    });
    const deps = offlineDeps({ connectSession: fake.connectSession, env: TEST_ENV() });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: true, wait: true }, deps, { trigger: 'mcp', log: () => {} });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
    }

    assert.deepEqual(fake.reconcileCalls, [markerFile]);
    assert.deepEqual(fake.closedIds, [], 'no marker file must mean nothing is closed');
  });

  test('a reconcileTargets failure is swallowed and logged, never fails the scan', async () => {
    const fake = makeFakeSessionWithTargetReconcile({
      throwOnReconcile: true,
      indeedCards: [{ jobkey: 'c3d4e5f607182930', title: 'Chief Technology Officer', company: 'ZZ-TEST-SCAN-TARGET-RECONCILE', location: 'Houston, TX', remote: false, postedMs: Date.now(), salaryText: null }],
    });
    /** @type {any[]} */
    const logs = [];
    const deps = offlineDeps({ connectSession: fake.connectSession, env: TEST_ENV() });
    await client.query(`INSERT INTO ic_source_state (source, manual_disable) VALUES ('indeed', false) ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0`);
    try {
      const r = await runScanWaiting({ profile: PROFILE, sources: ['indeed'], dryRun: true, wait: true }, deps, { trigger: 'mcp', log: (f) => logs.push(f) });
      assert.ok(['ok', 'partial'].includes(r.status), JSON.stringify(r.errors));
      assert.ok(!r.errors.some((e) => /reconcile/i.test(e.message ?? '')), 'a target-reconcile failure must never surface as a run error');
    } finally {
      await client.query(`UPDATE ic_source_state SET manual_disable = false, disabled_until = NULL, consecutive_walls = 0 WHERE source = 'indeed'`);
    }
    assert.ok(logs.some((f) => f.evt === 'scan_target_reconcile_failed'), 'the failure must still be logged');
  });
});
