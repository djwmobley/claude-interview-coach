// @ts-check
/**
 * bin/stale-resume-audit.js (read-only): lists linked resumes that fail the content gate against the
 * current project index. Uses the isolated test DB and a temp repo root; asserts no rows or files change.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { auditStaleResumes } from '../bin/stale-resume-audit.js';
import { setGateHooksForTests } from '../src/core/resume-content-gate.js';

/** @type {pg.Client} */
let client;
/** @type {string} */
let root;
/** @type {number[]} */
const ids = [];

before(async () => {
  // Fixtures are fake bytes: the stand-in gate fails files containing STALE and passes the rest. The real
  // gate is covered in resume-content-gate.test.js.
  setGateHooksForTests({
    resumeGate: (abs) => (fs.readFileSync(abs, 'utf8').includes('STALE') ? { ok: false, missing: ['Advisicon'], reason: 'missing employers: Advisicon' } : { ok: true, missing: [], reason: null }),
  });
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-audit-'));
  fs.mkdirSync(path.join(root, 'output', 'resumes'), { recursive: true });
});
after(async () => {
  if (ids.length) {
    await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await client.end();
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string} title */
async function insertListing(title) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen)
     VALUES ($1, 'ZZ-AUDIT-CO', $2, $3, 'listing', 'zz audit co', 'audit', 'legacy-unknown', $4, now()) RETURNING id`,
    [title, `zz-test-audit-${process.pid}`, `zz-test-audit-${process.pid}:${n}`, `zz-audit-hash-${n}`],
  );
  ids.push(Number(r.rows[0].id));
  return Number(r.rows[0].id);
}

describe('auditStaleResumes', () => {
  test('lists only failing linked resumes with listing, title, company, path, missing employers; writes nothing', async () => {
    const goodListing = await insertListing('Audit Good Role');
    const badListing = await insertListing('Audit Stale Role');
    const missingListing = await insertListing('Audit Missing File Role');
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'good.docx'), 'fine');
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'bad.docx'), 'STALE');
    fs.writeFileSync(path.join(root, 'output', 'resumes', 'gone.docx'), 'STALE');
    // Insert rows directly (the link path would refuse the stale file), then remove one file.
    for (const [lid, rel] of [[goodListing, 'resumes/good.docx'], [badListing, 'resumes/bad.docx'], [missingListing, 'resumes/gone.docx']]) {
      await client.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'mcp')`, [lid, rel]);
    }
    fs.rmSync(path.join(root, 'output', 'resumes', 'gone.docx'));

    const before = await client.query('SELECT count(*)::int AS n FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [ids]);
    const res = await auditStaleResumes(client, { outputRoot: path.join(root, 'output'), indexPath: path.join(root, 'data', 'project-index.md') });
    const mine = res.failing.filter((f) => ids.includes(f.listing_id));

    assert.deepEqual(mine.map((f) => f.listing_id).sort(), [badListing, missingListing].sort());
    const bad = mine.find((f) => f.listing_id === badListing);
    assert.equal(bad?.title, 'Audit Stale Role');
    assert.equal(bad?.company, 'ZZ-AUDIT-CO');
    assert.equal(bad?.rel_path, 'resumes/bad.docx');
    assert.deepEqual(bad?.missing, ['Advisicon']);
    assert.equal(bad?.application_status, null);
    assert.ok(!mine.some((f) => f.listing_id === goodListing));

    // Read-only: no row changes, files untouched.
    const after = await client.query('SELECT count(*)::int AS n FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [ids]);
    assert.equal(after.rows[0].n, before.rows[0].n);
    assert.equal(fs.readFileSync(path.join(root, 'output', 'resumes', 'bad.docx'), 'utf8'), 'STALE');
  });
});
