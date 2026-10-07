// @ts-check
/**
 * src/core/ready-to-apply.js against the real isolated test DB: classifyReadyList runs the real exclusion
 * gate (T4: blocked employer, an application already submitted, a withdrawn application, applied history,
 * an applied listing outside the universe), and refreshReadyLedger stores the ledger, sets left_at, and
 * writes the manual-only lock only when displaying (A1) and never for held_markup_drift (A9).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { classifyReadyList, refreshReadyLedger } from '../src/core/ready-to-apply.js';

const P = process.pid;
const SRC = `zz-test-readydb-${P}`;
const NOW = new Date('2026-10-07T15:00:00Z');
const DESC = 'A real description. '.repeat(30);
const CONFIG = {
  autoApply: { fitFloor: 60, floors: { texas_or_remote: 225000, relocation: 275000 }, atsAllow: ['greenhouse'], readyToApply: {} },
  adapters: { run: { timezone: 'America/Chicago' } },
  configDir: 'unused',
};
const EXCL = { blockedCompanies: ['Immunotec', 'Advisicon'], appliedHistory: [{ company: `Histco${P}`, title: 'Chief Technology Officer', applied_on: null, source: 'test' }] };
/** @type {pg.Client} */
let client;
/** @type {Record<string, number>} */
const ids = {};

/** @param {string} key @param {Record<string, unknown>} o */
async function seed(key, o) {
  const v = {
    company: `Readyco${P}${key}`, title: 'Chief Technology Officer', status: 'new', manual: null, fit: 80, ...o,
  };
  const r = await client.query(
    `INSERT INTO ic_job_listings (source, external_id, url, url_normalized, title, title_norm, company, company_norm, location_norm, fit_score, description, status,
       manual_apply_url, first_seen, apply_probed_at, probe_attempts, record_kind)
     VALUES ($1, $2, $3, $3, $4, lower($4), $5, lower($5), 'state-tx', $6, $7, $8, $9, $10, $10, 1, 'listing') RETURNING id`,
    [SRC, `${SRC}-${key}`, `https://jobs.example.com/${P}/${key}`, v.title, v.company, v.fit, DESC, v.status, v.manual, NOW],
  );
  ids[key] = Number(r.rows[0].id);
  return ids[key];
}

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await seed('blocked', { company: 'Immunotec Research' });
  await seed('submitted', {});
  await client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'submitted')`, [ids.submitted]);
  await seed('withdrawn', {});
  await client.query(`INSERT INTO ic_job_applications (listing_id, state) VALUES ($1, 'withdrawn')`, [ids.withdrawn]);
  await seed('history', { company: `Histco${P}` });
  await seed('applied', { status: 'applied' });
  await seed('ready', { manual: `https://careers.readyco${P}.com/jobs/1` });
});
after(async () => {
  await client.query('DELETE FROM ic_job_listings WHERE source = $1', [SRC]);
  await client.end();
});

/** @param {any} res @param {string} key */
const bucketOf = (res, key) => res.rows.find((/** @type {any} */ r) => r.listingId === ids[key])?.bucket ?? null;

describe('classifyReadyList (real exclusion gate)', () => {
  test('T4: blocked employer, submitted, withdrawn, applied history stay off the list; an applied listing is outside the universe', async () => {
    const res = await classifyReadyList(client, { config: CONFIG, exclusionConfig: EXCL, now: NOW });
    assert.equal(bucketOf(res, 'blocked'), 'excluded_blocked_company');
    assert.equal(bucketOf(res, 'submitted'), 'excluded_already_applied');
    assert.equal(bucketOf(res, 'withdrawn'), 'excluded_withdrawn');
    assert.equal(bucketOf(res, 'history'), 'excluded_already_applied');
    assert.equal(bucketOf(res, 'applied'), null);
    assert.equal(bucketOf(res, 'ready'), 'ready_to_apply');
    const sum = Object.values(res.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, res.total);
  });
});

describe('refreshReadyLedger', () => {
  test('a non-display refresh stores the ledger but writes no lock', async () => {
    const res = await classifyReadyList(client, { config: CONFIG, exclusionConfig: EXCL, now: NOW });
    await refreshReadyLedger(client, res, NOW, { display: false });
    const led = (await client.query('SELECT * FROM ic_ready_to_apply WHERE listing_id = $1', [ids.ready])).rows[0];
    assert.equal(led.bucket, 'ready_to_apply');
    assert.equal(led.channel, 'external_manual');
    assert.equal(new Date(led.first_listed_at).toISOString(), NOW.toISOString());
    assert.equal(led.first_displayed_at, null);
    const locks = await client.query('SELECT 1 FROM ic_manual_only_locks WHERE listing_id = $1', [ids.ready]);
    assert.equal(locks.rowCount, 0);
  });

  test('a display refresh stamps first_displayed_at and writes the lock (A1); first_listed_at is stable', async () => {
    const later = new Date(NOW.getTime() + 3600000);
    const res = await classifyReadyList(client, { config: CONFIG, exclusionConfig: EXCL, now: later });
    await refreshReadyLedger(client, res, later, { display: true });
    const led = (await client.query('SELECT * FROM ic_ready_to_apply WHERE listing_id = $1', [ids.ready])).rows[0];
    assert.equal(new Date(led.first_listed_at).toISOString(), NOW.toISOString());
    assert.equal(new Date(led.first_displayed_at).toISOString(), later.toISOString());
    const locks = await client.query('SELECT bucket FROM ic_manual_only_locks WHERE listing_id = $1 AND released_at IS NULL', [ids.ready]);
    assert.equal(locks.rowCount, 1);
    assert.equal(locks.rows[0].bucket, 'ready_to_apply');
  });

  test('A9: a held_markup_drift row is never locked on display; a row that leaves gets left_at', async () => {
    const id = await seed('drift', { manual: null });
    const fake = {
      rows: [{ listingId: id, bucket: 'held_markup_drift', reason: 'markup_drift', channel: null, link: null, host: null, flags: [], alsoOn: [], applicationId: null, resumeEligible: true, row: { listingUrl: null, company: 'x', companyNorm: 'x', titleNorm: 'y' } }],
    };
    await refreshReadyLedger(client, /** @type {any} */ (fake), NOW, { display: true });
    assert.equal((await client.query('SELECT 1 FROM ic_manual_only_locks WHERE listing_id = $1', [id])).rowCount, 0);
    const led = (await client.query('SELECT bucket, left_at FROM ic_ready_to_apply WHERE listing_id = $1', [ids.ready])).rows[0];
    assert.ok(led.left_at, 'the ready row was absent from this result, so it left');
  });
});
