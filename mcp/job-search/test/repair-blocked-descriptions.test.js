// @ts-check
/**
 * bin/repair-blocked-descriptions.js: dry run vs apply, skip-applied, backup before change, limit.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { runRepair, parseArgs } from '../bin/repair-blocked-descriptions.js';

const TAG = `zz-test-repair-${process.pid}`;
const JUNK = 'Additional Verification Required Your Ray ID for this request is a401b81afaf76bd8 Return home -> Troubleshooting Cloudflare Errors';
const SENT = 'The Chief Information Security Officer will own the security program, report to the CEO, and lead a team across cloud, identity and governance. ';
const GOOD = `About the role. Responsibilities include strategy and delivery. Requirements: ten years of experience. ${SENT.repeat(8)}`;

describe('bin/repair-blocked-descriptions.js', () => {
  /** @type {pg.Client} */
  let client;
  /** @type {number[]} */
  const ids = [];
  let logDir = '';

  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-test-'));
  });
  after(async () => {
    if (ids.length) {
      await client.query('DELETE FROM ic_job_applications WHERE listing_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM ic_job_documents WHERE listing_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM ic_job_events WHERE listing_id = ANY($1::int[])', [ids]);
      await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
    }
    await client.end();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** @param {{ description: string, detail_outcome?: string }} o */
  async function seed(o) {
    const n = Math.floor(Math.random() * 1e9);
    const r = await client.query(
      `INSERT INTO ic_job_listings
         (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash,
          last_seen, status, url, url_normalized, prescore, remote_mode, remote_declared, description, description_hash, detail_outcome, fit_score, fit_basis)
       VALUES ('Repair Role', $1, 'indeed', $2, 'listing', $3, 'repair role', 'legacy-unknown', $4,
          now(), 'new', $5, $5, 50, 'onsite', false, $6, 'hash', $7, 81, 'description')
       RETURNING id`,
      [`${TAG}-${n}`, `zz-rp-${n}`, `zz-rp-cn-${n}`, `zz-rp-hash-${n}`, `https://www.indeed.com/viewjob?jk=zzr${n}`, o.description, o.detail_outcome ?? 'empty'],
    );
    const id = Number(r.rows[0].id);
    ids.push(id);
    return id;
  }
  const row = async (/** @type {number} */ id) => (await client.query('SELECT description, description_hash, detail_outcome, fit_score, fit_basis FROM ic_job_listings WHERE id = $1', [id])).rows[0];
  const quiet = () => {};

  test('parseArgs', () => {
    assert.deepEqual(parseArgs([]), { apply: false, limit: Infinity, includeApplied: false, includeUnverified: false, help: false });
    const a = parseArgs(['--apply', '--limit', '5', '--include-applied']);
    assert.equal(a.apply, true);
    assert.equal(a.limit, 5);
    assert.equal(a.includeApplied, true);
    assert.throws(() => parseArgs(['--bogus']));
  });

  test('dry run changes nothing and writes no backup, but reports counts and ids', async () => {
    const junk = await seed({ description: JUNK });
    const good = await seed({ description: GOOD, detail_outcome: 'fetched' });
    const out = [];
    const dir = path.join(logDir, 'dry');
    const res = await runRepair(client, { apply: false, limit: Infinity, includeApplied: false }, { logDir: dir, write: (s) => out.push(s) });
    assert.equal(res.changed, 0);
    assert.equal(res.backupFile, null);
    assert.ok(!fs.existsSync(dir));
    assert.ok(res.repaired['blocked:cloudflare_challenge'].includes(junk) || Object.values(res.repaired).some((l) => l.includes(junk)));
    assert.ok(!Object.values(res.repaired).some((l) => l.includes(good)));
    assert.equal((await row(junk)).description, JUNK);
    assert.equal((await row(junk)).fit_score, 81);
    assert.match(out.join(''), /DRY RUN/);
    assert.match(out.join(''), new RegExp(String(junk)));
  });

  test('apply writes the backup first, nulls description, hash and fit, sets the new outcome, spares good rows', async () => {
    const junk = await seed({ description: JUNK });
    const good = await seed({ description: GOOD, detail_outcome: 'fetched' });
    const dir = path.join(logDir, 'apply');
    const res = await runRepair(client, { apply: true, limit: Infinity, includeApplied: false }, { logDir: dir, write: quiet });
    assert.ok(res.changed >= 1);
    assert.ok(res.backupFile && fs.existsSync(res.backupFile));
    const backup = JSON.parse(fs.readFileSync(res.backupFile, 'utf8'));
    const saved = backup.rows.find((/** @type {any} */ x) => x.id === junk);
    assert.equal(saved.description, JUNK);
    assert.equal(saved.fit_score, 81);
    const r = await row(junk);
    assert.equal(r.description, null);
    assert.equal(r.description_hash, null);
    assert.equal(r.fit_score, null);
    assert.equal(r.fit_basis, null);
    assert.match(r.detail_outcome, /^blocked:/);
    const g = await row(good);
    assert.equal(g.description, GOOD);
    assert.equal(g.fit_score, 81);
    const ev = await client.query(`SELECT note FROM ic_job_events WHERE listing_id = $1`, [junk]);
    assert.equal(ev.rowCount, 1);
  });

  test('rows with an application or a linked resume are skipped unless --include-applied', async () => {
    const withApp = await seed({ description: JUNK });
    await client.query(`INSERT INTO ic_job_applications (listing_id) VALUES ($1)`, [withApp]);
    const withResume = await seed({ description: JUNK });
    await client.query(`INSERT INTO ic_job_documents (listing_id, kind, rel_path, actor) VALUES ($1, 'resume', $2, 'cli')`, [withResume, `zz/${TAG}-${withResume}.docx`]);
    const dir = path.join(logDir, 'skip');
    const res = await runRepair(client, { apply: true, limit: Infinity, includeApplied: false }, { logDir: dir, write: quiet });
    const skipped = Object.values(res.skippedApplied).flat();
    assert.ok(skipped.includes(withApp));
    assert.ok(skipped.includes(withResume));
    assert.equal((await row(withApp)).description, JUNK);
    assert.equal((await row(withResume)).description, JUNK);
    const res2 = await runRepair(client, { apply: true, limit: Infinity, includeApplied: true }, { logDir: dir, write: quiet });
    assert.ok(Object.values(res2.repaired).flat().includes(withApp));
    assert.equal((await row(withApp)).description, null);
    assert.equal((await row(withResume)).description, null);
  });

  test('unverified rows are reported but left alone unless --include-unverified', async () => {
    const plain = 'The team keeps the lights on for the plant and this posting names no particular section headings. '.repeat(6);
    const id = await seed({ description: plain, detail_outcome: 'fetched' });
    const res = await runRepair(client, { apply: true, limit: Infinity, includeApplied: false }, { logDir: path.join(logDir, 'unv'), write: quiet });
    assert.ok(res.reportedOnly.unverified.includes(id));
    assert.equal((await row(id)).description, plain);
    const res2 = await runRepair(client, { apply: true, limit: Infinity, includeApplied: false, includeUnverified: true }, { logDir: path.join(logDir, 'unv'), write: quiet });
    assert.ok(res2.repaired.unverified.includes(id));
    assert.equal((await row(id)).description, null);
    assert.equal((await row(id)).detail_outcome, 'unverified');
  });

  test('--limit caps the repairable rows', async () => {
    await seed({ description: JUNK });
    await seed({ description: JUNK });
    const res = await runRepair(client, { apply: false, limit: 1, includeApplied: false }, { logDir: path.join(logDir, 'limit'), write: quiet });
    assert.equal(Object.values(res.repaired).flat().length, 1);
  });
});
