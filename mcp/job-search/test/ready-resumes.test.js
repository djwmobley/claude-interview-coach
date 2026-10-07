// @ts-check
/**
 * src/core/ready-resumes.js (Ready list section 9 with R4, R6, A5, A10) against the real test DB, with a fake
 * listing-mode runner and fake locks: highest fit first; reuse takes no cap slot; a PASS review makes the
 * resume ready; a FAIL review is not ready and is retried at most maxAttempts times (then gave_up); the
 * daily cap leaves the rest queued; a busy spawn lock stops the run and refunds the slot; a thin
 * description is skipped and refunded; a second concurrent run exits 'locked' (T11); the dashboard start
 * refuses over the cap with no override and refuses while the spawn lock is held.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { runReadyResumes, startReadyResumeForListing } from '../src/core/ready-resumes.js';

const SRC = `zz-test-readyres-${process.pid}`;
const BUDGET = `zz-ready-resume-${process.pid}`;
const NOW = new Date('2026-10-07T15:00:00Z');
/** @type {pg.Client} */
let client;
/** @type {string} */
let outputRoot;

/** @param {number} fit */
async function seed(fit, o = { status: 'none', attempts: 0 }) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (source, external_id, url, title, company, description, fit_score) VALUES ($1, $2, 'https://x.example.com/1', 'CTO', 'Acme', $3, $4) RETURNING id`,
    [SRC, `${SRC}-${n}`, 'x'.repeat(400), fit],
  );
  const id = Number(r.rows[0].id);
  await client.query(`INSERT INTO ic_ready_to_apply (listing_id, bucket, last_classified_at, resume_status, resume_attempts) VALUES ($1, 'ready_to_apply', now(), $2, $3)`, [id, o.status, o.attempts]);
  return id;
}
/** @param {number} id */
const led = async (id) => (await client.query('SELECT * FROM ic_ready_to_apply WHERE listing_id = $1', [id])).rows[0];
const capUsed = async () => Number((await client.query('SELECT coalesce(sum(pages), 0)::int AS n FROM ic_scan_budget WHERE source = $1', [BUDGET])).rows[0].n);

/** @param {number[]} ids */
const result = (ids, eligible = true) => ({ ready: ids.map((listingId) => ({ listingId, resumeEligible: eligible, bucket: 'ready_to_apply' })) });

/** @param {{ gen?: (id: number) => any, rev?: (id: number) => any }} [o] */
function fakeRunner(o = {}) {
  const calls = { gen: /** @type {number[]} */ ([]), rev: /** @type {number[]} */ ([]) };
  return {
    calls,
    runner: {
      generate: async (/** @type {number} */ id) => { calls.gen.push(id); return o.gen ? o.gen(id) : { ok: true, docId: null, relPath: 'resumes/x.docx', markdownPath: 'output/markdown/ready/r/x.md' }; },
      review: async (/** @type {number} */ id) => { calls.rev.push(id); return o.rev ? o.rev(id) : { ok: true, verdict: 'PASS', findings: { findings: [] } }; },
    },
  };
}
const freeLock = { acquire: async () => ({ release: async () => {} }), tryAcquire: async () => ({ release: async () => {} }) };

/** @param {any} extra */
function deps(extra) {
  return {
    withClient: (/** @type {any} */ fn) => fn(client), config: { autoApply: { readyToApply: { resume: { dailyCap: 10, maxAttempts: 2 } } } }, now: () => NOW,
    log: () => {}, spawnLock: freeLock, runLock: freeLock, outputRoot, budgetSource: BUDGET, timezone: 'America/Chicago', ...extra,
  };
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
});
after(async () => {
  await client.query('DELETE FROM ic_scan_budget WHERE source = $1', [BUDGET]);
  await client.query('DELETE FROM ic_job_listings WHERE source = $1', [SRC]);
  await client.end();
});
beforeEach(async () => {
  await client.query('DELETE FROM ic_scan_budget WHERE source = $1', [BUDGET]);
  outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-resumes-out-'));
  fs.mkdirSync(path.join(outputRoot, 'resumes'), { recursive: true });
});

describe('runReadyResumes', () => {
  test('generate then PASS review: ready, generated, verdict stored, one cap slot', async () => {
    const id = await seed(90);
    const f = fakeRunner();
    const r = await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([id]) }));
    assert.equal(r.status, 'ok');
    const l = await led(id);
    assert.deepEqual([l.resume_status, l.resume_source, l.review_verdict, l.resume_attempts], ['ready', 'generated', 'PASS', 1]);
    assert.equal(await capUsed(), 1);
  });

  test('reuse: an existing resume document with its file on disk takes no cap slot and no model call', async () => {
    const id = await seed(85);
    fs.writeFileSync(path.join(outputRoot, 'resumes', `Reuse ${id}.docx`), 'docx');
    await client.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp')`, [id, `resumes/Reuse ${id}.docx`]);
    const f = fakeRunner();
    await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([id]) }));
    const l = await led(id);
    assert.deepEqual([l.resume_status, l.resume_source], ['ready', 'reused']);
    assert.equal(f.calls.gen.length, 0);
    assert.equal(await capUsed(), 0);
  });

  test('A10: a FAIL review is not ready; it is retried once more, then gave_up', async () => {
    const id = await seed(80);
    const f = fakeRunner({ rev: () => ({ ok: true, verdict: 'FAIL', findings: { findings: ['x'] } }) });
    await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([id]) }));
    let l = await led(id);
    assert.deepEqual([l.resume_status, l.review_verdict, l.resume_attempts], ['failed', 'FAIL', 1]);
    await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([id]) }));
    l = await led(id);
    assert.deepEqual([l.resume_status, l.resume_attempts], ['gave_up', 2]);
    await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([id]) }));
    assert.equal(f.calls.gen.length, 2, 'gave_up is never retried');
  });

  test('the daily cap stops the run highest-fit-first and leaves the rest queued', async () => {
    const hi = await seed(95);
    const lo = await seed(70);
    const f = fakeRunner();
    const r = await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([hi, lo]), config: { autoApply: { readyToApply: { resume: { dailyCap: 1 } } } } }));
    assert.equal(r.stopReason, 'daily_cap');
    assert.deepEqual(f.calls.gen, [hi]);
    assert.equal((await led(lo)).resume_status, 'queued');
  });

  test('a spawn lock that never frees stops the run and refunds the slot', async () => {
    const id = await seed(75);
    const f = fakeRunner();
    const r = await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([id]), spawnLock: { acquire: async () => null } }));
    assert.equal(r.stopReason, 'spawn_busy');
    assert.equal(await capUsed(), 0);
    assert.equal(f.calls.gen.length, 0);
  });

  test('a thin description is skipped and its slot refunded', async () => {
    const id = await seed(74);
    const f = fakeRunner({ gen: () => ({ ok: false, reason: 'no_description', refund: true }) });
    await runReadyResumes(deps({ runner: f.runner, classifyAndRefresh: async () => result([id]) }));
    assert.equal((await led(id)).resume_status, 'skipped_no_description');
    assert.equal(await capUsed(), 0);
  });

  test('T11: a second concurrent run exits locked; disabled config exits disabled', async () => {
    const r = await runReadyResumes(deps({ runner: fakeRunner().runner, classifyAndRefresh: async () => result([]), runLock: { tryAcquire: async () => null } }));
    assert.equal(r.status, 'locked');
    const d = await runReadyResumes(deps({ runner: fakeRunner().runner, config: { autoApply: { readyToApply: { resume: { enabled: false } } } } }));
    assert.equal(d.status, 'disabled');
  });
});

describe('startReadyResumeForListing (dashboard button)', () => {
  test('starts a ready row (202) and refuses while the spawn lock is held (409 READY_RESUME_BUSY)', async () => {
    const id = await seed(88);
    const f = fakeRunner();
    const busy = await startReadyResumeForListing(deps({ runner: f.runner, spawnLock: { tryAcquire: async () => null } }), id);
    assert.deepEqual([busy.status, busy.code], [409, 'READY_RESUME_BUSY']);
    assert.equal(await capUsed(), 0, 'busy refunds the slot');
    const ok = await startReadyResumeForListing(deps({ runner: f.runner }), id);
    assert.equal(ok.status, 202);
    await ok.done;
    assert.equal((await led(id)).resume_status, 'ready');
  });

  test('A10: over the daily cap the button is refused; there is no override', async () => {
    const id = await seed(87);
    await client.query(`INSERT INTO ic_scan_budget (source, day, pages, details) VALUES ($1, '2026-10-07', 10, 0)`, [BUDGET]);
    const r = await startReadyResumeForListing(deps({ runner: fakeRunner().runner, config: { autoApply: { readyToApply: { resume: { dailyCap: 10 } } } } }), id);
    assert.deepEqual([r.status, r.code], [409, 'READY_RESUME_CAP']);
  });

  test('a row that is not on the ready list, already ready, or gave_up is refused', async () => {
    const id = await seed(86, { status: 'gave_up', attempts: 2 });
    const r = await startReadyResumeForListing(deps({ runner: fakeRunner().runner }), id);
    assert.equal(r.status, 409);
    assert.equal(r.code, 'READY_RESUME_NOT_ELIGIBLE');
  });
});
