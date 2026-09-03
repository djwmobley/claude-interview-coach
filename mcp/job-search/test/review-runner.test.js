// @ts-check
/**
 * src/dashboard/review-runner.js (one-click apply PR A spec item 6): the independent headless review's
 * machine-block parsing (parseReviewResult, a pure function tested directly), the runner's own
 * single-flight/timeout shape, and how a parsed PASS/FAIL/unparseable result flows into review_verdict/
 * review_findings and the runner's return value. Fake EventEmitter child process, matching
 * test/resume-runner.test.js's own pattern; real test DB for the application row.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { withClient, closePool } from '../src/core/db.js';
import { createApplication, getApplication, listApplicationEvents } from '../src/core/applications.js';
import { createReviewRunner, parseReviewResult } from '../src/dashboard/review-runner.js';

const CO = `ZZ-TEST-REVIEWRUNNER-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {string} */
let repoRoot;
/** @type {string} */
let logDir;
/** @type {number[]} */
const listingIds = [];

async function insertListing() {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ('Review Runner Test', $1, $2, $3, 'listing', 'review runner test co', 'review runner test', 'legacy-unknown', $4, now()) RETURNING id`,
    [CO, `zz-test-reviewrunner-${process.pid}`, `zz-test-reviewrunner-${process.pid}:${n}`, `zz-reviewrunner-hash-${n}`],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [listingIds]);
  listingIds.length = 0;
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  await cleanup();
});
after(async () => {
  await cleanup();
  await client.end();
  await closePool();
});

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-reviewrunner-repo-'));
  fs.writeFileSync(path.join(repoRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'job-search': { command: 'node', args: ['x'] } } }));
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-reviewrunner-log-'));
});

/** @param {{ onSpawn?: (child: any) => void, delayMs?: number }} [opts] */
function makeFakeSpawn(opts = {}) {
  const delayMs = opts.delayMs ?? 20;
  return () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 5151;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    const t = setTimeout(() => { if (opts.onSpawn) opts.onSpawn(child); }, delayMs);
    t.unref?.();
    return child;
  };
}

/** @param {any} child @param {{ result?: string, exitCode?: number }} [o] */
function finishChild(child, o = {}) {
  if (o.result !== undefined) child.stdout.emit('data', Buffer.from(JSON.stringify({ result: o.result, total_cost_usd: 0.05, num_turns: 3, is_error: false, session_id: 'sess-2' })));
  child.emit('exit', o.exitCode ?? 0);
}

function baseDeps(extra = {}) {
  return {
    env: /** @type {any} */ ({}),
    logDir,
    repoRoot,
    withClient,
    claudeBin: 'fake-claude',
    model: 'sonnet',
    maxTurns: 80,
    budgetUsd: 5,
    timeoutMs: 60000,
    execFile: (cmd, args, cb) => cb(null, '', ''),
    log: () => {},
    ...extra,
  };
}

const PASS_BLOCK = `## CV Quality Gate report\n\nOverall: PASS\n\nVERDICT: PASS\n\`\`\`json\n${JSON.stringify({ verdict: 'PASS', critical_count: 0, important_count: 1, minor_count: 0, findings: [{ severity: 'IMPORTANT', text: 'x' }] })}\n\`\`\`\n`;
const FAIL_BLOCK = `## CV Quality Gate report\n\nOverall: FAIL\n\nVERDICT: FAIL\n\`\`\`json\n${JSON.stringify({ verdict: 'FAIL', critical_count: 1, important_count: 0, minor_count: 0, findings: [{ severity: 'CRITICAL', text: 'missing keyword' }] })}\n\`\`\`\n`;

describe('parseReviewResult: total classification over the machine block (pure function)', () => {
  test('a well-formed VERDICT: PASS block parses', () => {
    const r = parseReviewResult(PASS_BLOCK);
    assert.equal(r.ok, true);
    assert.equal(/** @type {any} */ (r).verdict, 'PASS');
    assert.equal(/** @type {any} */ (r).findings.critical_count, 0);
  });

  test('a well-formed VERDICT: FAIL block parses', () => {
    const r = parseReviewResult(FAIL_BLOCK);
    assert.equal(r.ok, true);
    assert.equal(/** @type {any} */ (r).verdict, 'FAIL');
  });

  test('no VERDICT line at all -> review_unparseable', () => {
    const r = parseReviewResult('Just a report, no machine block.');
    assert.deepEqual(r, { ok: false, reason: 'review_unparseable' });
  });

  test('a VERDICT line with no following json block -> review_unparseable', () => {
    const r = parseReviewResult('Report\n\nVERDICT: PASS\n\nNo json here.');
    assert.deepEqual(r, { ok: false, reason: 'review_unparseable' });
  });

  test('a VERDICT line followed by malformed json -> review_unparseable (never "trust the VERDICT line alone")', () => {
    const r = parseReviewResult('VERDICT: PASS\n```json\n{not valid json\n```\n');
    assert.deepEqual(r, { ok: false, reason: 'review_unparseable' });
  });

  test('a json block whose top level is an array, not an object -> review_unparseable', () => {
    const r = parseReviewResult('VERDICT: PASS\n```json\n[1,2,3]\n```\n');
    assert.deepEqual(r, { ok: false, reason: 'review_unparseable' });
  });

  test('VERDICT is case-insensitive on the label but the captured value is normalized to uppercase', () => {
    const r = parseReviewResult('verdict: pass\n```json\n{"verdict":"PASS"}\n```\n');
    assert.equal(r.ok, true);
    assert.equal(/** @type {any} */ (r).verdict, 'PASS');
  });
});

describe('createReviewRunner: DB storage and runner return value', () => {
  test('VERDICT: PASS stores review_verdict=PASS and review_findings, returns ok:true', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: PASS_BLOCK, exitCode: 0 }) });
    const runner = createReviewRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, 'output/markdown/x.md', listingId);
    assert.deepEqual(result, { ok: true, verdict: 'PASS' });
    const row = await getApplication(client, app.id);
    assert.equal(row.review_verdict, 'PASS');
    assert.equal(row.review_findings.critical_count, 0);
  });

  test('VERDICT: FAIL stores review_verdict=FAIL and review_findings, returns ok:false with reason review_failed -- never approved', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: FAIL_BLOCK, exitCode: 0 }) });
    const runner = createReviewRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, 'output/markdown/x.md', listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'review_failed');
    const row = await getApplication(client, app.id);
    assert.equal(row.review_verdict, 'FAIL');
    assert.equal(row.review_findings.findings[0].severity, 'CRITICAL');
  });

  test('a missing machine block parks with review_unparseable, review_verdict left NULL', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: 'No machine block here.', exitCode: 0 }) });
    const runner = createReviewRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, 'output/markdown/x.md', listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'review_unparseable');
    const row = await getApplication(client, app.id);
    assert.equal(row.review_verdict, null);
    const events = await listApplicationEvents(client, app.id);
    assert.ok(events.some((e) => e.kind === 'error' && /review_unparseable/.test(e.note ?? '')));
  });
});

describe('createReviewRunner: single-flight and hard-timeout backstop', () => {
  test('a second run() while one is in progress is refused LOCKED', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ delayMs: 200, onSpawn: (child) => finishChild(child, { result: PASS_BLOCK, exitCode: 0 }) });
    const runner = createReviewRunner(baseDeps({ spawn: spawnFn }));
    const first = runner.run(app.id, 'output/markdown/x.md', listingId);
    await assert.rejects(() => runner.run(app.id, 'output/markdown/x.md', listingId), (err) => /** @type {any} */ (err).code === 'LOCKED');
    await first;
  });

  test('hard timeout kills the process and fails with reason "timeout"', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    /** @type {any[]} */
    const killCalls = [];
    const spawnFn = makeFakeSpawn({ delayMs: 999999 });
    const runner = createReviewRunner(baseDeps({
      spawn: spawnFn, timeoutMs: 40,
      execFile: (cmd, args, cb) => { killCalls.push({ cmd, args }); cb(null, '', ''); },
    }));
    const result = await runner.run(app.id, 'output/markdown/x.md', listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
    assert.ok(killCalls.some((k) => k.cmd === 'taskkill'));
  });
});
