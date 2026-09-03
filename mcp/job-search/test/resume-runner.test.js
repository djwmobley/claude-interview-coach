// @ts-check
/**
 * src/dashboard/resume-runner.js (one-click apply PR A spec items 5, 10, 11): the precheck (no spawn on
 * a thin description), single-flight, database-only success verification (a matching resume_doc_id ->
 * listing_id), the listing-mismatch reset-and-fail path, HEADLESS_ABORT parsing, the model-asked
 * heuristic, and the hard-timeout taskkill backstop. Fake EventEmitter child process, matching
 * test/apply-runner.test.js's own pattern; real test DB for the application/listing/document rows
 * (src/core/applications.js has no fake-friendly seam).
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
import { createResumeRunner } from '../src/dashboard/resume-runner.js';

const CO = `ZZ-TEST-RESUMERUNNER-${process.pid}`;
const LONG_DESCRIPTION = 'A senior technology leadership role. '.repeat(20); // > 300 chars
/** @type {pg.Client} */
let client;
/** @type {string} */
let repoRoot;
/** @type {string} */
let logDir;
/** @type {number[]} */
const listingIds = [];

/** @param {Partial<{ description: string|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, description)
     VALUES ('Resume Runner Test', $1, $2, $3, 'listing', 'resume runner test co', 'resume runner test', 'legacy-unknown', $4, now(), $5) RETURNING id`,
    [CO, `zz-test-resumerunner-${process.pid}`, `zz-test-resumerunner-${process.pid}:${n}`, `zz-resumerunner-hash-${n}`, o.description === undefined ? LONG_DESCRIPTION : o.description],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {number} listingId @param {string} relPath */
async function insertDocument(listingId, relPath) {
  const r = await client.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp') RETURNING id`, [listingId, relPath]);
  return Number(r.rows[0].id);
}

async function cleanup() {
  if (listingIds.length === 0) return;
  await client.query('DELETE FROM ic_job_application_events WHERE application_id IN (SELECT id FROM ic_job_applications WHERE listing_id = ANY($1::int[]))', [listingIds]);
  await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [listingIds]);
  await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [listingIds]);
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
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-resumerunner-repo-'));
  fs.writeFileSync(path.join(repoRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'job-search': { command: 'node', args: ['x'] } } }));
  fs.mkdirSync(path.join(repoRoot, 'output', 'markdown'), { recursive: true });
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-resumerunner-log-'));
});

/**
 * @param {{ onSpawn?: (child: any) => void, delayMs?: number }} [opts]
 */
function makeFakeSpawn(opts = {}) {
  const delayMs = opts.delayMs ?? 20;
  const spawnFn = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    const t = setTimeout(() => {
      if (opts.onSpawn) opts.onSpawn(child);
    }, delayMs);
    t.unref?.();
    return child;
  };
  return spawnFn;
}

/** @param {any} child @param {{ result?: string, exitCode?: number }} [o] */
function finishChild(child, o = {}) {
  if (o.result !== undefined) child.stdout.emit('data', Buffer.from(JSON.stringify({ result: o.result, total_cost_usd: 0.1, num_turns: 5, is_error: false, session_id: 'sess-1' })));
  child.emit('exit', o.exitCode ?? 0);
}

function baseDeps(extra = {}) {
  return {
    env: /** @type {any} */ ({}),
    logDir,
    repoRoot,
    // The real pool, not a raw single client wrapper: a resume run's own precheck/verification queries
    // must never share ONE connection with a concurrently-running second call (see run()'s own LOCKED
    // ordering comment in resume-runner.js -- this was the actual bug the single-flight test below caught,
    // via a corrupted-transaction hang, before the LOCKED guard was fixed to close its race window).
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

describe('createResumeRunner: precheck (spec item 11)', () => {
  test('a missing description fails fast with no_description; spawn is never called', async () => {
    const listingId = await insertListing({ description: null });
    const app = await createApplication(client, { listingId });
    let spawnCalled = false;
    const runner = createResumeRunner(baseDeps({ spawn: () => { spawnCalled = true; throw new Error('must not spawn'); } }));
    const result = await runner.run(app.id, listingId);
    assert.deepEqual(result, { ok: false, reason: 'no_description' });
    assert.equal(spawnCalled, false);
    const events = await listApplicationEvents(client, app.id);
    assert.ok(events.some((e) => e.kind === 'error' && /no_description/.test(e.note ?? '')));
  });

  test('a description shorter than 300 characters fails fast with no_description; spawn is never called', async () => {
    const listingId = await insertListing({ description: 'too short' });
    const app = await createApplication(client, { listingId });
    let spawnCalled = false;
    const runner = createResumeRunner(baseDeps({ spawn: () => { spawnCalled = true; throw new Error('must not spawn'); } }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_description');
    assert.equal(spawnCalled, false);
  });

  test('a description at exactly 300 characters or more proceeds to spawn', async () => {
    const listingId = await insertListing({ description: 'x'.repeat(300) });
    const app = await createApplication(client, { listingId });
    let spawnCalled = false;
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: 'no draft happened' }) });
    const runner = createResumeRunner(baseDeps({ spawn: (...a) => { spawnCalled = true; return spawnFn(...a); } }));
    await runner.run(app.id, listingId);
    assert.equal(spawnCalled, true);
  });
});

describe('createResumeRunner: DB-only success verification (spec item 4/5)', () => {
  test('exit 0 without a DB flip to docs_ready is a failure (no_docs_ready)', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: 'I finished but did nothing recorded.', exitCode: 0 }) });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_docs_ready');
  });

  test('exit 1 is a failure', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: 'crashed', exitCode: 1 }) });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
  });

  test('a DB flip to docs_ready with a MATCHING listing is success and returns the newest output/markdown/*.md path', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const docId = await insertDocument(listingId, 'resumes/Jordan Reyes - CTO.docx');
    const spawnFn = makeFakeSpawn({
      onSpawn: async (child) => {
        fs.writeFileSync(path.join(repoRoot, 'output', 'markdown', '20260903-cto.md'), '# resume\n');
        await client.query('UPDATE ic_job_applications SET state = $2, resume_doc_id = $3, updated_at = now() WHERE id = $1', [app.id, 'docs_ready', docId]);
        finishChild(child, { result: 'Resume written.', exitCode: 0 });
      },
    });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, true);
    assert.equal(result.markdownPath, 'output/markdown/20260903-cto.md');
  });

  test('a DB flip to docs_ready with a MISMATCHED listing resets the link and fails (listing_mismatch)', async () => {
    const listingId = await insertListing();
    const otherListingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const wrongDocId = await insertDocument(otherListingId, 'resumes/wrong.docx');
    const spawnFn = makeFakeSpawn({
      onSpawn: async (child) => {
        await client.query('UPDATE ic_job_applications SET state = $2, resume_doc_id = $3, updated_at = now() WHERE id = $1', [app.id, 'docs_ready', wrongDocId]);
        finishChild(child, { result: 'Resume written.', exitCode: 0 });
      },
    });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'listing_mismatch');
    const row = await getApplication(client, app.id);
    assert.equal(row.resume_doc_id, null, 'the mismatched link is reset');
    assert.equal(row.state, 'drafting', 'the application is walked back to drafting');
  });
});

describe('createResumeRunner: HEADLESS_ABORT and model-asked parsing (spec items 10/11)', () => {
  test('a HEADLESS_ABORT line in the result is parsed verbatim as the failure reason', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: 'Some text.\nHEADLESS_ABORT: docx_locked\n', exitCode: 0 }) });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'docx_locked');
  });

  test('a question-shaped result with no DB flip and no HEADLESS_ABORT line fails as model_asked', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: 'The listing has no stored description. Want me to proceed anyway?', exitCode: 0 }) });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'model_asked');
  });

  test('a question-shaped result NEVER counts as success even though it is not the generic failure', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ onSpawn: (child) => finishChild(child, { result: 'Should I continue drafting this resume?', exitCode: 0 }) });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
  });
});

describe('createResumeRunner: single-flight and hard-timeout backstop', () => {
  test('a second run() while one is in progress is refused LOCKED', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    const spawnFn = makeFakeSpawn({ delayMs: 200, onSpawn: (child) => finishChild(child, { result: 'x', exitCode: 0 }) });
    const runner = createResumeRunner(baseDeps({ spawn: spawnFn }));
    const first = runner.run(app.id, listingId);
    await assert.rejects(() => runner.run(app.id, listingId), (err) => /** @type {any} */ (err).code === 'LOCKED');
    await first;
  });

  test('hard timeout kills the process (taskkill) and fails with reason "timeout"', async () => {
    const listingId = await insertListing();
    const app = await createApplication(client, { listingId });
    /** @type {any[]} */
    const killCalls = [];
    // Never emits 'exit' -- the runner's own hard timeout must fire.
    const spawnFn = makeFakeSpawn({ delayMs: 999999 });
    const runner = createResumeRunner(baseDeps({
      spawn: spawnFn, timeoutMs: 40,
      execFile: (cmd, args, cb) => { killCalls.push({ cmd, args }); cb(null, '', ''); },
    }));
    const result = await runner.run(app.id, listingId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
    assert.ok(killCalls.some((k) => k.cmd === 'taskkill'));
  });
});
