// @ts-check
/**
 * PR5b fix 1: the stage deadline starts before the connect, and the connect is bounded inside it. A database
 * connect that never answers becomes the closed code connect_timeout (not a stalled scan), and the report is still
 * built with the code rendered. No network, no shell, no browser, no real model: every connect and model is a stub.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runTargetsStage } from '../src/targets/stage.js';
import { runDraftStage } from '../src/targets/draft-stage.js';
import { connectBounded, stageConnect } from '../src/targets/stage-time.js';
import { buildScanReport, buildReportSubject, renderReportText, renderReportMarkdown, renderReportHtml } from '../src/core/report.js';
import { newClient, upsertTestProfile, cleanupScan, offlineDeps, runScanWaiting, makeFixtureFetch, DEFAULT_MAP, FIXTURE_NOW } from './helpers/scan-fixtures.js';

const PID = process.pid;
const PROFILE = `zz-test-tgconn-${PID}`;
/** Wednesday 2026-10-14 10:00 ET. */
const WEEKDAY = new Date('2026-10-14T14:00:00Z');
const never = () => new Promise(() => {});

/** @type {import('pg').Client} */
let client;
before(async () => {
  client = await newClient();
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  await upsertTestProfile(client, PROFILE, { sources: ['greenhouse'], keywords: ['Chief Technology Officer'], phrases: [], locations: ['Houston, TX'] });
});
after(async () => {
  await cleanupScan(client, { profile: PROFILE, companies: ['ZZ-TEST-SCAN'] });
  await client.end();
});

describe('the bounded connect helpers', () => {
  test('stageConnect: a timeout is connect_timeout, any other failure is stage_failed, success returns the client', async () => {
    assert.deepEqual(await stageConnect(/** @type {any} */ (never), 20), { ok: false, error: 'connect_timeout' });
    assert.deepEqual(await stageConnect(async () => { throw new Error('refused'); }, 1000), { ok: false, error: 'stage_failed' });
    const conn = { end: async () => {} };
    assert.deepEqual(await stageConnect(async () => conn, 1000), { ok: true, client: conn });
  });
  test('a connection that arrives after the timeout is closed, not leaked', async () => {
    let ended = 0;
    const late = new Promise((resolve) => setTimeout(() => resolve({ end: async () => { ended += 1; } }), 60));
    await assert.rejects(connectBounded(() => /** @type {any} */ (late), 15), /connect timeout/);
    await late;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ended, 1);
  });
});

describe('the stages with a connect that never answers', () => {
  test('the targets stage returns connect_timeout well inside the stage deadline', async () => {
    const t0 = Date.now();
    const out = await runTargetsStage(/** @type {any} */ ({
      connect: never, now: WEEKDAY, runId: 1, scanStartMs: 1_000_000, scanTimeoutMs: 45 * 60_000, nowMs: 1_060_000,
      fetch: async () => new Response(''), connectTimeoutMs: 30,
    }));
    assert.deepEqual(out, { ran: false, error: 'connect_timeout' });
    assert.ok(Date.now() - t0 < 5000);
  });
  test('the targets stage: with no time left the connect (only to record no_time) is still bounded', async () => {
    const out = await runTargetsStage(/** @type {any} */ ({
      connect: never, now: WEEKDAY, runId: 1, scanStartMs: 0, scanTimeoutMs: 45 * 60_000, nowMs: 41 * 60_000,
      fetch: async () => new Response(''), connectTimeoutMs: 30,
    }));
    assert.deepEqual(out, { ran: false, error: 'connect_timeout' });
  });
  test('the targets stage: the hard deadline covers the connect too, when the connect bound is longer than the stage', async () => {
    const out = await runTargetsStage(/** @type {any} */ ({
      connect: never, now: WEEKDAY, runId: 1, scanStartMs: 1_000_000, scanTimeoutMs: 45 * 60_000, nowMs: 1_060_000,
      fetch: async () => new Response(''), connectTimeoutMs: 60_000, maxStageMs: 40, graceMs: 20,
    }));
    assert.ok(out.error === 'connect_timeout' || out.error === 'stage_timeout', JSON.stringify(out));
    assert.equal(out.ran, false);
  });
  test('the draft stage returns connect_timeout', async () => {
    const out = await runDraftStage(/** @type {any} */ ({
      connect: never, now: WEEKDAY, scanStartMs: Date.now(), scanTimeoutMs: 40 * 60_000, configDir: '', nowMs: Date.now(),
      callModel: async () => { throw new Error('must not run'); }, connectTimeoutMs: 30,
    }));
    assert.deepEqual(out, { ran: false, error: 'connect_timeout' });
  });
  test('a throwing connect is still stage_failed in both stages', async () => {
    const connect = async () => { throw new Error('db down'); };
    assert.deepEqual(await runTargetsStage(/** @type {any} */ ({ connect, now: WEEKDAY, runId: 1, scanStartMs: 1_000_000, scanTimeoutMs: 45 * 60_000, nowMs: 1_060_000, fetch: async () => new Response('') })), { ran: false, error: 'stage_failed' });
    assert.deepEqual(await runDraftStage(/** @type {any} */ ({ connect, now: WEEKDAY, scanStartMs: Date.now(), scanTimeoutMs: 40 * 60_000, configDir: '', nowMs: Date.now(), callModel: async () => ({}) })), { ran: false, error: 'stage_failed' });
  });
});

describe('the scan with both stages stuck on connect', () => {
  const ZZ_MAP = DEFAULT_MAP.filter((m) => m.prefix.includes('zztest') || m.prefix.includes('/gitlab/'));
  test('the scan finishes ok, the report is built, and both stages render connect_timeout', async () => {
    const deps = offlineDeps({
      fetch: makeFixtureFetch(ZZ_MAP),
      runTargetsStage: /** @type {any} */ ((/** @type {any} */ p) => runTargetsStage({
        ...p, connect: never, fetch: async () => new Response(''), connectTimeoutMs: 30, nowMs: p.scanStartMs + 1000,
      })),
      runTargetDraftStage: /** @type {any} */ ((/** @type {any} */ p) => runDraftStage({
        ...p, connect: never, callModel: async () => { throw new Error('must not run'); }, connectTimeoutMs: 30, nowMs: p.scanStartMs + 1000,
      })),
    });
    const t0 = Date.now();
    const r = await runScanWaiting({ profile: PROFILE, sources: ['greenhouse'], dryRun: false, wait: true }, deps, { trigger: 'cli', log: () => {}, now: FIXTURE_NOW });
    assert.ok(Date.now() - t0 < 60_000);
    assert.equal(r.status, 'ok', JSON.stringify(r.errors));
    assert.deepEqual(r.stats.targets, { ran: false, error: 'connect_timeout' });
    assert.deepEqual(/** @type {any} */ (r.stats).target_drafts, { ran: false, error: 'connect_timeout' });

    await client.query(`UPDATE ic_scan_runs SET started_at = $2, finished_at = now() WHERE id = $1`, [r.run_id, WEEKDAY]);
    const data = await buildScanReport(client, { now: WEEKDAY, timezone: 'America/Chicago', sinceOverride: null });
    assert.equal(data.runs.at(-1)?.run_id, r.run_id);
    assert.match(buildReportSubject(data), /^\[NO TARGETS RUN\] /);
    for (const text of [renderReportText(data), renderReportMarkdown(data), renderReportHtml(data)]) {
      assert.match(text, /targets: \[NO TARGETS RUN\] \(connect_timeout\)/);
    }
  });
});
