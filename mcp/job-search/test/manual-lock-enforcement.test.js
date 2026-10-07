// @ts-check
/**
 * Manual-only lockout enforcement (R8, A2, A4): the auto-apply select phase maps a locked row to
 * 'manual_only' (never eligible, never on the assisted Easy Apply list), and the click-time submit gate's
 * exclusion check refuses a locked listing (branch manual_only_lockout), against the real test DB.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { selectCandidates, classifyCandidate, CLOSED_REASONS, GATES } from '../src/core/auto-apply-select.js';
import { clickTimeExclusionCheck } from '../src/apply/unattended-submit.js';
import { lockSubjectFromRow } from '../src/core/manual-lock.js';
import { createApplication } from '../src/core/applications.js';
import { defaultMorningDeps } from '../src/apply/easy-apply-morning.js';

const FLOORS = { texas_or_remote: 225000, relocation: 275000 };

/** @param {Record<string, unknown>} o */
function cand(o) {
  return /** @type {any} */ ({
    listingId: 1, fitScore: 90, fitActor: 'auto', fitBasis: 'description', duplicateOf: null, locationNorm: 'state-tx', remoteMode: null, salaryMax: null,
    hasActiveApplication: false, description: 'x'.repeat(400), applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', applyAts: 'greenhouse', applyConfidence: 'exact',
    applyEasyOnly: false, source: 'greenhouse', company: 'Acme', companyNorm: 'acme', title: 'CTO', titleNorm: 'cto', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    ...o,
  });
}

describe('selectCandidates honors manual-only locks', () => {
  test('manual_only is a CLOSED_REASONS value claimed by a funnel gate', () => {
    assert.ok(CLOSED_REASONS.includes('manual_only'));
    assert.ok(GATES.some((g) => g.reasons.includes('manual_only')));
  });

  test('a locked eligible row and a locked Easy Apply row are manual_only; an unlocked row stays eligible', async () => {
    const rows = [
      cand({ listingId: 1 }),
      cand({ listingId: 2, company: 'Beta', companyNorm: 'beta', applyUrl: 'https://boards.greenhouse.io/beta/jobs/2', sourceUrl: 'https://boards.greenhouse.io/beta/jobs/2' }),
      cand({ listingId: 3, company: 'Gamma', companyNorm: 'gamma', applyEasyOnly: true, source: 'linkedin', applyUrl: null, applyAts: null, sourceUrl: 'https://www.linkedin.com/jobs/view/4000000003' }),
    ];
    const locks = [
      lockSubjectFromRow({ id: 99, company: 'Acme', company_norm: 'acme', title_norm: 'cto', urls: [] }),
      lockSubjectFromRow({ id: 98, company: 'Gamma', company_norm: 'gamma', title_norm: 'cto', urls: [] }),
    ];
    const res = await selectCandidates(/** @type {any} */ ({}), {
      fitFloor: 60, floors: FLOORS, atsAllow: ['greenhouse'], dailyCap: 5, now: new Date(), timezone: 'UTC',
      fetchCandidateRows: async () => rows, countAutoApprovedToday: async () => 0,
      classifyCandidateWithExclusions: async (c, r, ctx) => classifyCandidate(r, ctx),
      loadManualLocks: async () => locks,
    });
    const by = Object.fromEntries(res.results.map((r) => [r.listingId, r.reason]));
    assert.equal(by[1], 'manual_only');
    assert.equal(by[2], 'eligible');
    assert.equal(by[3], 'manual_only');
    assert.deepEqual(res.eligible.map((r) => r.listingId), [2]);
    assert.equal(res.easyApplyEligible.length, 0);
    assert.equal(res.funnel.eliminated.manual_only, 2);
  });
});

describe('click-time exclusion check and the morning draft step refuse a locked listing (real DB)', () => {
  const SRC = `zz-test-mlenf-${process.pid}`;
  /** @type {pg.Client} */
  let client;
  let listingId = 0;
  before(async () => {
    client = new pg.Client(pgConnectionConfig());
    await client.connect();
    const r = await client.query(
      `INSERT INTO ic_job_listings (source, external_id, url, title, title_norm, company, company_norm, location_norm) VALUES ($1, $2, $3, 'CTO', 'cto', $4, $5, 'state-tx') RETURNING id`,
      [SRC, `${SRC}-1`, `https://boards.greenhouse.io/mlenf${process.pid}/jobs/1`, `Mlenf${process.pid}`, `mlenf${process.pid}`],
    );
    listingId = Number(r.rows[0].id);
  });
  after(async () => {
    await client.query('DELETE FROM ic_job_listings WHERE source = $1', [SRC]);
    await client.end();
  });

  test('unlocked: eligible; locked: manual_only_lockout', async () => {
    const excl = { blockedCompanies: ['Immunotec'], appliedHistory: [] };
    const before1 = await clickTimeExclusionCheck(client, { id: -1, listing_id: listingId }, excl);
    assert.equal(before1.branch, 'eligible');
    await client.query(`INSERT INTO ic_manual_only_locks (listing_id, root_listing_id, company_norm, title_norm, bucket) VALUES ($1, $1, $2, 'cto', 'ready_to_apply')`, [listingId, `mlenf${process.pid}`]);
    const after1 = await clickTimeExclusionCheck(client, { id: -1, listing_id: listingId }, excl);
    assert.equal(after1.branch, 'manual_only_lockout');
  });

  test('the morning Easy Apply draft step refuses to create an application for a locked listing', async () => {
    const deps = defaultMorningDeps(/** @type {any} */ ({
      withClientFn: (/** @type {any} */ fn) => fn(client), resumeRunner: {}, reviewRunner: {}, runApplyWorker: async () => ({}), outputRoot: '.', env: {}, log: () => {},
      config: {}, timezone: 'UTC', liveCheck: async () => ({ branch: 'easy_apply' }),
    }));
    await assert.rejects(deps.createApplication(/** @type {any} */ ({ listingId, sourceUrl: null })), /manual_only_lockout/);
    const n = (await client.query('SELECT count(*)::int AS n FROM ic_job_applications WHERE listing_id = $1', [listingId])).rows[0].n;
    assert.equal(n, 0);
    void createApplication;
  });
});
