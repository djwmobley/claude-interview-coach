// @ts-check
/**
 * src/dashboard/ready-resume-runner.js (Ready list section 9.3 with A5): listing-mode generation succeeds
 * ONLY when this run's own markdown exists under output/markdown/ready/<runId>/ AND a resume document row
 * for the SAME listing, created or rewritten during this run, points at a file on disk. A document for
 * another listing is a failure; a thin description never spawns; nothing writes ic_job_applications
 * (T10). Review mode parses the existing VERDICT contract. Fake child process, real test DB.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { withClient, closePool } from '../src/core/db.js';
import { createReadyResumeRunner } from '../src/dashboard/ready-resume-runner.js';

const SRC = `zz-test-readyrunner-${process.pid}`;
const LONG = 'A senior technology leadership role. '.repeat(20);
/** @type {pg.Client} */
let client;
/** @type {string} */
let repoRoot;

async function listing(description = LONG) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (source, external_id, url, title, company, description) VALUES ($1, $2, 'https://x.example.com/1', 'CTO', 'Acme', $3) RETURNING id`,
    [SRC, `${SRC}-${n}`, description],
  );
  return Number(r.rows[0].id);
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
});
after(async () => {
  await client.query('DELETE FROM ic_job_listings WHERE source = $1', [SRC]);
  await client.end();
  await closePool();
});
beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-runner-repo-'));
  fs.writeFileSync(path.join(repoRoot, '.mcp.json'), '{}');
  fs.mkdirSync(path.join(repoRoot, 'output', 'resumes'), { recursive: true });
});

/** @param {(child: any, argv: string[]) => Promise<void>|void} onSpawn */
function fakeSpawn(onSpawn) {
  /** @type {string[][]} */
  const calls = [];
  const fn = (/** @type {string} */ _bin, /** @type {string[]} */ argv) => {
    calls.push(argv);
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 99;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(async () => { await onSpawn(child, argv); }, 5);
    return child;
  };
  return { fn, calls };
}
/** @param {any} child @param {string} result */
const finish = (child, result) => {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ result, total_cost_usd: 0.1, num_turns: 3 })));
  child.emit('exit', 0);
};

/** @param {any} spawn */
function runner(spawn) {
  return createReadyResumeRunner({
    env: /** @type {any} */ ({}), logDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ready-runner-log-')), repoRoot, withClient, spawn,
    claudeBin: 'fake', model: 'sonnet', reviewModel: 'sonnet', maxTurns: 10, budgetUsd: 1, timeoutMs: 60000, execFile: (/** @type {any} */ c, /** @type {any} */ a, /** @type {any} */ cb) => cb(null), log: () => {},
  });
}

/** Simulate the skill: write the run's markdown and the DOCX, link a document row. @param {number} docListingId */
function skillWrites(docListingId, opts = { markdown: true }) {
  return async (/** @type {any} */ child, /** @type {string[]} */ argv) => {
    const prompt = argv[argv.indexOf('-p') + 1];
    const runId = /run:([a-z0-9-]+)/.exec(prompt)?.[1] ?? 'none';
    if (opts.markdown) {
      const dir = path.join(repoRoot, 'output', 'markdown', 'ready', runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'resume.md'), '# r');
    }
    const name = `Damian Mobley - CTO ${docListingId}.docx`;
    fs.writeFileSync(path.join(repoRoot, 'output', 'resumes', name), 'docx');
    await client.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp')`, [docListingId, `resumes/${name}`]);
    finish(child, 'done');
  };
}

describe('generate (listing mode)', () => {
  test('success: run-dir markdown plus a new resume document for this listing with its file on disk', async () => {
    const id = await listing();
    const apps0 = (await client.query('SELECT count(*)::int AS n FROM ic_job_applications')).rows[0].n;
    const s = fakeSpawn(skillWrites(id));
    const r = await runner(s.fn).generate(id, 'run-abc1');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(String(r.markdownPath), /output\/markdown\/ready\/run-abc1\/resume\.md$/);
    assert.ok(r.docId);
    const prompt = s.calls[0][s.calls[0].indexOf('-p') + 1];
    assert.match(prompt, new RegExp(`/write-resume skill with argument ${id} headless:listing run:run-abc1`));
    const apps1 = (await client.query('SELECT count(*)::int AS n FROM ic_job_applications')).rows[0].n;
    assert.equal(apps1, apps0, 'listing mode never writes ic_job_applications');
  });

  test('a document linked to ANOTHER listing is a failure (no_document)', async () => {
    const id = await listing();
    const other = await listing();
    const r = await runner(fakeSpawn(skillWrites(other)).fn).generate(id, 'run-abc2');
    assert.deepEqual([r.ok, r.reason], [false, 'no_document']);
  });

  test('no markdown in this run directory is a failure even with a document (success tied to the run id)', async () => {
    const id = await listing();
    const r = await runner(fakeSpawn(skillWrites(id, { markdown: false })).fn).generate(id, 'run-abc3');
    assert.deepEqual([r.ok, r.reason], [false, 'markdown_not_found']);
  });

  test('a thin description never spawns and asks for a refund', async () => {
    const id = await listing('short');
    const s = fakeSpawn(() => { throw new Error('must not spawn'); });
    const r = await runner(s.fn).generate(id, 'run-abc4');
    assert.deepEqual([r.ok, r.reason, r.refund], [false, 'no_description', true]);
    assert.equal(s.calls.length, 0);
  });

  test('HEADLESS_ABORT reason is reported verbatim', async () => {
    const id = await listing();
    const r = await runner(fakeSpawn((child) => finish(child, 'HEADLESS_ABORT: docx_locked')).fn).generate(id, 'run-abc5');
    assert.deepEqual([r.ok, r.reason], [false, 'docx_locked']);
  });
});

describe('review (listing mode)', () => {
  test('PASS and FAIL verdicts parse; garbage is review_unparseable / no_verdict', async () => {
    const id = await listing();
    const pass = await runner(fakeSpawn((child) => finish(child, 'VERDICT: PASS\n```json\n{"findings":[]}\n```')).fn).review(id, 'output/markdown/ready/r/x.md');
    assert.deepEqual([pass.ok, pass.verdict], [true, 'PASS']);
    const fail = await runner(fakeSpawn((child) => finish(child, 'VERDICT: FAIL\n```json\n{"findings":["x"]}\n```')).fn).review(id, 'x.md');
    assert.deepEqual([fail.ok, fail.verdict], [true, 'FAIL']);
    const junk = await runner(fakeSpawn((child) => finish(child, 'no idea')).fn).review(id, 'x.md');
    assert.deepEqual([junk.ok, junk.reason], [false, 'no_verdict']);
  });
});
