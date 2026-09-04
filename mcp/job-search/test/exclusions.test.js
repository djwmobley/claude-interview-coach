// @ts-check
/**
 * src/apply/exclusions.js (apply exclusion gate): never submit to a job already applied to, or to a
 * blocked employer. Pure tokenization/matching helpers are unit-tested directly; classifyExclusion's
 * DB-dependent branches (already_applied_listing, previously_withdrawn, already_applied_history) run
 * against the real test DB, matching the house pattern in test/applications.test.js: rows carry a
 * `ZZ-TEST-EXCLUSIONS-<pid>` company/source so cleanup can find everything this file created.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import { createApplication, transition } from '../src/core/applications.js';
import {
  BUILT_IN_BLOCKED, EXCLUSION_BRANCHES, HARD_BRANCHES, NEEDS_HUMAN_BRANCHES,
  companyTokens, isTokenSubset, tokensMatchBidirectional, containsWholePhrase, isUnknownCompany,
  loadExclusionConfig, exclusionConfigPath, walkDuplicateRoot, collectDuplicateTreeIds,
  classifyExclusion,
} from '../src/apply/exclusions.js';

const CO = `ZZ-TEST-EXCLUSIONS-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {number[]} */
const listingIds = [];

/** @param {Partial<{ company: string, companyNorm: string, title: string, titleNorm: string, duplicateOf: number|null, applyUrl: string|null, url: string|null, description: string|null }>} o */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, source, external_id, record_kind, company_norm, title_norm, location_norm, dedup_hash, last_seen, duplicate_of, apply_url, url, description)
     VALUES ($1, $2, $3, $4, 'listing', $5, $6, 'legacy-unknown', $7, now(), $8, $9, $10, $11) RETURNING id`,
    [
      o.title ?? 'Exclusions Test Role', o.company ?? CO, `zz-test-exclusions-${process.pid}`,
      `zz-test-exclusions-${process.pid}:${n}`, o.companyNorm ?? 'exclusions test co', o.titleNorm ?? 'exclusions test role',
      `zz-exclusions-hash-${n}`, o.duplicateOf ?? null, o.applyUrl ?? null, o.url ?? null, o.description ?? null,
    ],
  );
  const id = Number(r.rows[0].id);
  listingIds.push(id);
  return id;
}

/** @param {number} listingId @param {string} [state] */
async function insertApplication(listingId, state = 'drafting') {
  const app = await createApplication(client, { listingId, actor: 'mcp' });
  if (state !== 'drafting') {
    if (state === 'withdrawn') {
      await transition(client, app.id, 'withdrawn', { actor: 'mcp' });
    } else {
      await client.query(`UPDATE ic_job_applications SET state = $2 WHERE id = $1`, [app.id, state]);
    }
  }
  return app.id;
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
});

/** @param {Partial<{ blockedCompanies: string[], appliedHistory: any[] }>} o */
function cfg(o = {}) {
  return { blockedCompanies: [...BUILT_IN_BLOCKED, ...(o.blockedCompanies ?? [])], appliedHistory: o.appliedHistory ?? [] };
}

describe('EXCLUSION_BRANCHES: total, ordered, amendment applied', () => {
  test('order matches the spec (with previously_withdrawn between b and c)', () => {
    assert.deepEqual(EXCLUSION_BRANCHES, [
      'blocked_company', 'already_applied_listing', 'previously_withdrawn', 'already_applied_history',
      'applied_company_other_role', 'blocked_company_suspect', 'unknown_company', 'eligible',
    ]);
  });
  test('HARD_BRANCHES and NEEDS_HUMAN_BRANCHES partition every non-eligible branch, no overlap', () => {
    const nonEligible = EXCLUSION_BRANCHES.filter((b) => b !== 'eligible');
    assert.deepEqual([...HARD_BRANCHES].sort(), ['already_applied_history', 'already_applied_listing', 'blocked_company'].sort());
    assert.deepEqual([...NEEDS_HUMAN_BRANCHES].sort(), [...nonEligible].filter((b) => !HARD_BRANCHES.includes(b)).sort());
    for (const b of HARD_BRANCHES) assert.equal(NEEDS_HUMAN_BRANCHES.includes(b), false);
  });
});

describe('companyTokens / isTokenSubset / tokensMatchBidirectional: exact whole-token, never substring', () => {
  test('tokenizes via normalizeCompany, splitting on whitespace', () => {
    assert.deepEqual(companyTokens('Immunotec Research Ltd'), ['immunotec', 'research']);
    assert.deepEqual(companyTokens('IMMUNOTEC INC.'), ['immunotec']);
    assert.deepEqual(companyTokens('  Advisicon, Inc  '), ['advisicon']);
    assert.deepEqual(companyTokens('Advisicon LLC'), ['advisicon']);
  });
  test('isTokenSubset: exact token membership, not substring', () => {
    assert.equal(isTokenSubset(['immunotec'], ['immunotec', 'research']), true);
    assert.equal(isTokenSubset(['immunotec'], ['immunotechnology', 'partners']), false);
    assert.equal(isTokenSubset(['immunotec'], ['immuno', 'technologies']), false);
  });
  test('isTokenSubset: an empty subset never matches (a blank company is not "subset of everything")', () => {
    assert.equal(isTokenSubset([], ['immunotec']), false);
  });
  test('tokensMatchBidirectional: either direction, never both-empty', () => {
    assert.equal(tokensMatchBidirectional(['acme'], ['acme', 'corp']), true);
    assert.equal(tokensMatchBidirectional(['acme', 'corp'], ['acme']), true);
    assert.equal(tokensMatchBidirectional([], []), false);
    assert.equal(tokensMatchBidirectional(['acme'], ['other']), false);
  });
});

describe('containsWholePhrase: whole word/phrase, never a substring match', () => {
  test('matches a whole word inside a hyphen/dot separated host', () => {
    assert.equal(containsWholePhrase('apply.immunotec-staffing.com', ['immunotec']), true);
  });
  test('does not match a concatenated substring', () => {
    assert.equal(containsWholePhrase('immunotecstaffing.com', ['immunotec']), false);
  });
  test('null/empty text or entry never matches', () => {
    assert.equal(containsWholePhrase(null, ['immunotec']), false);
    assert.equal(containsWholePhrase('immunotec staffing', []), false);
  });
});

describe('isUnknownCompany: total classification (branch f)', () => {
  test('null/blank company is unknown', () => {
    assert.equal(isUnknownCompany(null, ''), true);
    assert.equal(isUnknownCompany('   ', ''), true);
  });
  test('stoplisted raw values are unknown', () => {
    for (const raw of ['N/A', 'na', 'TBD', 'none', 'Unknown', 'Confidential', 'Undisclosed']) {
      assert.equal(isUnknownCompany(raw, raw.toLowerCase()), true, raw);
    }
  });
  test('normalizeCompany\'s confidential:<slug> form is unknown', () => {
    assert.equal(isUnknownCompany('Confidential', 'confidential:acme'), true);
  });
  test('fewer than 2 alphabetic characters in company_norm is unknown', () => {
    assert.equal(isUnknownCompany('X', 'x'), true);
    assert.equal(isUnknownCompany('7', '7'), true);
  });
  test('a real company name is not unknown', () => {
    assert.equal(isUnknownCompany('Acme Corp', 'acme'), false);
  });
});

describe('loadExclusionConfig: missing/invalid = hard error, empty lists still block built-ins', () => {
  /** @type {string} */
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobsearch-exclusions-cfg-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('missing file throws CONFIG_INVALID naming the file', () => {
    assert.throws(() => loadExclusionConfig(dir), (err) => err.code === 'CONFIG_INVALID' && err.message.includes(exclusionConfigPath(dir)));
  });
  test('invalid JSON throws CONFIG_INVALID', () => {
    fs.writeFileSync(exclusionConfigPath(dir), '{ not json');
    assert.throws(() => loadExclusionConfig(dir), (err) => err.code === 'CONFIG_INVALID');
  });
  test('empty blocked_companies/applied_history is valid; built-ins still present', () => {
    fs.writeFileSync(exclusionConfigPath(dir), JSON.stringify({ blocked_companies: [], applied_history: [] }));
    const loaded = loadExclusionConfig(dir);
    assert.deepEqual(loaded.blockedCompanies, [...BUILT_IN_BLOCKED]);
    assert.deepEqual(loaded.appliedHistory, []);
  });
  test('built-ins can never be removed by config (config cannot omit them, only add to them)', () => {
    fs.writeFileSync(exclusionConfigPath(dir), JSON.stringify({ blocked_companies: ['Extra Co'] }));
    const loaded = loadExclusionConfig(dir);
    assert.deepEqual(loaded.blockedCompanies, [...BUILT_IN_BLOCKED, 'Extra Co']);
  });
  test('applied_history entry missing title is legal (company-only match)', () => {
    fs.writeFileSync(exclusionConfigPath(dir), JSON.stringify({ applied_history: [{ company: 'Acme' }] }));
    const loaded = loadExclusionConfig(dir);
    assert.equal(loaded.appliedHistory[0].title, null);
  });
  test('dashboard fresh reload after file edit: no process-lifetime cache', () => {
    fs.writeFileSync(exclusionConfigPath(dir), JSON.stringify({ blocked_companies: ['First Co'] }));
    assert.deepEqual(loadExclusionConfig(dir).blockedCompanies, [...BUILT_IN_BLOCKED, 'First Co']);
    fs.writeFileSync(exclusionConfigPath(dir), JSON.stringify({ blocked_companies: ['Second Co'] }));
    assert.deepEqual(loadExclusionConfig(dir).blockedCompanies, [...BUILT_IN_BLOCKED, 'Second Co']);
  });
});

describe('classifyExclusion: blocked_company (branch a)', () => {
  const ctx = () => ({ client, config: cfg() });
  test('Immunotec Research Ltd blocks', async () => {
    const id = await insertListing({ company: 'Immunotec Research Ltd', companyNorm: 'immunotec research' });
    const v = await classifyExclusion({ id, company: 'Immunotec Research Ltd', companyNorm: 'immunotec research', title: null, titleNorm: null }, ctx());
    assert.equal(v.branch, 'blocked_company');
  });
  test('IMMUNOTEC INC. blocks (suffix stripped, case-insensitive)', async () => {
    const id = await insertListing({ company: 'IMMUNOTEC INC.', companyNorm: 'immunotec' });
    const v = await classifyExclusion({ id, company: 'IMMUNOTEC INC.', companyNorm: 'immunotec', title: null, titleNorm: null }, ctx());
    assert.equal(v.branch, 'blocked_company');
  });
  test('Advisicon, Inc blocks', async () => {
    const id = await insertListing({ company: 'Advisicon, Inc', companyNorm: 'advisicon' });
    const v = await classifyExclusion({ id, company: 'Advisicon, Inc', companyNorm: 'advisicon', title: null, titleNorm: null }, ctx());
    assert.equal(v.branch, 'blocked_company');
  });
  test('Advisicon LLC with trailing whitespace blocks', async () => {
    const id = await insertListing({ company: 'Advisicon LLC  ', companyNorm: 'advisicon' });
    const v = await classifyExclusion({ id, company: 'Advisicon LLC  ', companyNorm: null, title: null, titleNorm: null }, ctx());
    assert.equal(v.branch, 'blocked_company');
  });
  test('Immunotechnology Partners does NOT block (no shared whole token)', async () => {
    const id = await insertListing({ company: 'Immunotechnology Partners', companyNorm: 'immunotechnology partners' });
    const v = await classifyExclusion({ id, company: 'Immunotechnology Partners', companyNorm: 'immunotechnology partners', title: 'Engineer', titleNorm: 'engineer' }, ctx());
    assert.notEqual(v.branch, 'blocked_company');
  });
  test('Immuno Technologies does NOT block', async () => {
    const id = await insertListing({ company: 'Immuno Technologies', companyNorm: 'immuno technologies' });
    const v = await classifyExclusion({ id, company: 'Immuno Technologies', companyNorm: 'immuno technologies', title: 'Engineer', titleNorm: 'engineer' }, ctx());
    assert.notEqual(v.branch, 'blocked_company');
  });
});

describe('walkDuplicateRoot / collectDuplicateTreeIds: multi-hop, cycle-safe', () => {
  test('walks a 3-hop chain to the true root', async () => {
    const root = await insertListing();
    const mid = await insertListing({ duplicateOf: root });
    const leaf = await insertListing({ duplicateOf: mid });
    assert.equal(await walkDuplicateRoot(client, leaf), root);
    const tree = await collectDuplicateTreeIds(client, root);
    assert.deepEqual([...tree].sort((a, b) => a - b), [root, mid, leaf].sort((a, b) => a - b));
  });
  test('a duplicate_of cycle never infinite-loops (stops at the cycle guard)', async () => {
    const a = await insertListing();
    const b = await insertListing({ duplicateOf: a });
    await client.query('UPDATE ic_job_listings SET duplicate_of = $1 WHERE id = $2', [b, a]);
    const root = await Promise.race([
      walkDuplicateRoot(client, a),
      new Promise((_, reject) => setTimeout(() => reject(new Error('walkDuplicateRoot did not terminate')), 5000)),
    ]);
    assert.ok(root === a || root === b);
  });
});

describe('classifyExclusion: already_applied_listing / previously_withdrawn (branches b/b2)', () => {
  const ctx = () => ({ client, config: cfg() });
  test('a non-withdrawn application on the listing itself blocks (HARD)', async () => {
    const id = await insertListing();
    await insertApplication(id, 'drafting');
    const v = await classifyExclusion({ id, company: CO, companyNorm: 'exclusions test co', title: null, titleNorm: null }, ctx());
    assert.equal(v.branch, 'already_applied_listing');
  });
  test('a non-withdrawn application 3 hops away in the dedup tree blocks', async () => {
    const root = await insertListing();
    const mid = await insertListing({ duplicateOf: root });
    const leaf = await insertListing({ duplicateOf: mid });
    await insertApplication(root, 'submitted');
    const v = await classifyExclusion({ id: leaf, company: CO, companyNorm: 'exclusions test co', title: null, titleNorm: null }, ctx());
    assert.equal(v.branch, 'already_applied_listing');
  });
  test('withdrawn-only row parks as previously_withdrawn (spec amendment), not eligible', async () => {
    const id = await insertListing();
    await insertApplication(id, 'withdrawn');
    const v = await classifyExclusion({ id, company: CO, companyNorm: 'exclusions test co', title: null, titleNorm: null }, ctx());
    assert.equal(v.branch, 'previously_withdrawn');
  });
  test('no application at all falls through past b/b2', async () => {
    const id = await insertListing();
    const v = await classifyExclusion({ id, company: CO, companyNorm: 'exclusions test co', title: null, titleNorm: null }, ctx());
    assert.notEqual(v.branch, 'already_applied_listing');
    assert.notEqual(v.branch, 'previously_withdrawn');
  });
  test('excludeApplicationId excludes that one row from the already-applied checks (one-click re-click)', async () => {
    const id = await insertListing();
    const appId = await insertApplication(id, 'drafting');
    const v = await classifyExclusion(
      { id, company: CO, companyNorm: 'exclusions test co', title: null, titleNorm: null },
      { client, config: cfg(), excludeApplicationId: appId },
    );
    assert.notEqual(v.branch, 'already_applied_listing');
  });
});

describe('classifyExclusion: already_applied_history / applied_company_other_role (branches c/d)', () => {
  test('config entry: company + similar title hits already_applied_history (HARD)', async () => {
    const id = await insertListing({ company: 'Example Corp', companyNorm: 'example corp' });
    const config = cfg({ appliedHistory: [{ company: 'Example Corp', title: 'Chief Technology Officer', applied_on: null, source: 'seed' }] });
    const v = await classifyExclusion(
      { id, company: 'Example Corp', companyNorm: 'example corp', title: 'Chief Technology Officer', titleNorm: 'chief technology officer' },
      { client, config },
    );
    assert.equal(v.branch, 'already_applied_history');
  });
  test('config entry: company matches, title similarity below threshold hits applied_company_other_role', async () => {
    const id = await insertListing({ company: 'Example Corp', companyNorm: 'example corp' });
    const config = cfg({ appliedHistory: [{ company: 'Example Corp', title: 'Chief Technology Officer', applied_on: null, source: 'seed' }] });
    const v = await classifyExclusion(
      { id, company: 'Example Corp', companyNorm: 'example corp', title: 'Warehouse Associate', titleNorm: 'warehouse associate' },
      { client, config },
    );
    assert.equal(v.branch, 'applied_company_other_role');
  });
  test('config entry with no title matches on company only -> applied_company_other_role, never already_applied_history', async () => {
    const id = await insertListing({ company: 'Example Corp', companyNorm: 'example corp' });
    const config = cfg({ appliedHistory: [{ company: 'Example Corp', title: null, applied_on: null, source: 'seed' }] });
    const v = await classifyExclusion(
      { id, company: 'Example Corp', companyNorm: 'example corp', title: 'Anything', titleNorm: 'anything' },
      { client, config },
    );
    assert.equal(v.branch, 'applied_company_other_role');
  });
  test('a DB listing with a non-withdrawn application, same company + similar title, hits already_applied_history', async () => {
    const other = await insertListing({ company: 'Beta Industries', companyNorm: 'beta industries', title: 'VP Engineering', titleNorm: 'vice president engineering' });
    await insertApplication(other, 'submitted');
    const id = await insertListing({ company: 'Beta Industries', companyNorm: 'beta industries' });
    const v = await classifyExclusion(
      { id, company: 'Beta Industries', companyNorm: 'beta industries', title: 'VP Engineering', titleNorm: 'vice president engineering' },
      { client, config: cfg() },
    );
    assert.equal(v.branch, 'already_applied_history');
  });
  test('company matches bidirectionally (listing is a superset of the history entry)', async () => {
    const id = await insertListing({ company: 'Gamma Holdings International', companyNorm: 'gamma holdings international' });
    const config = cfg({ appliedHistory: [{ company: 'Gamma Holdings', title: null, applied_on: null, source: 'seed' }] });
    const v = await classifyExclusion(
      { id, company: 'Gamma Holdings International', companyNorm: 'gamma holdings international', title: 'Anything', titleNorm: 'anything' },
      { client, config },
    );
    assert.equal(v.branch, 'applied_company_other_role');
  });
  test('no company match at all falls through past c/d', async () => {
    const id = await insertListing({ company: 'Totally Unrelated Co', companyNorm: 'totally unrelated co' });
    const v = await classifyExclusion(
      { id, company: 'Totally Unrelated Co', companyNorm: 'totally unrelated co', title: 'Engineer', titleNorm: 'engineer' },
      { client, config: cfg({ appliedHistory: [{ company: 'Example Corp', title: 'Engineer' }] }) },
    );
    assert.notEqual(v.branch, 'already_applied_history');
    assert.notEqual(v.branch, 'applied_company_other_role');
  });
});

describe('classifyExclusion: blocked_company_suspect (branch e, staffing-agency indirection)', () => {
  test('a blocked token as a whole word in the apply URL host hits blocked_company_suspect', async () => {
    const id = await insertListing({ company: 'Staffing Partners LLC', companyNorm: 'staffing partners', applyUrl: 'https://apply.immunotec-jobs.com/req/1' });
    const v = await classifyExclusion(
      { id, company: 'Staffing Partners LLC', companyNorm: 'staffing partners', title: 'Engineer', titleNorm: 'engineer', applyUrl: 'https://apply.immunotec-jobs.com/req/1' },
      { client, config: cfg() },
    );
    assert.equal(v.branch, 'blocked_company_suspect');
  });
  test('a blocked token as a whole word in the description hits blocked_company_suspect', async () => {
    const id = await insertListing({ company: 'Staffing Partners LLC', companyNorm: 'staffing partners' });
    const v = await classifyExclusion(
      { id, company: 'Staffing Partners LLC', companyNorm: 'staffing partners', title: 'Engineer', titleNorm: 'engineer', description: 'Our client, Advisicon, is hiring.' },
      { client, config: cfg() },
    );
    assert.equal(v.branch, 'blocked_company_suspect');
  });
  test('a concatenated substring in the host does NOT hit blocked_company_suspect (whole word only)', async () => {
    const id = await insertListing({ company: 'Staffing Partners LLC', companyNorm: 'staffing partners' });
    const v = await classifyExclusion(
      { id, company: 'Staffing Partners LLC', companyNorm: 'staffing partners', title: 'Engineer', titleNorm: 'engineer', applyUrl: 'https://immunotecstaffing.com/apply', sourceUrl: 'https://immunotecstaffing.com/apply' },
      { client, config: cfg() },
    );
    assert.notEqual(v.branch, 'blocked_company_suspect');
  });
});

describe('classifyExclusion: unknown_company (branch f) and eligible (branch g)', () => {
  test('"N/A" company hits unknown_company', async () => {
    const id = await insertListing({ company: 'N/A', companyNorm: 'n a' });
    const v = await classifyExclusion({ id, company: 'N/A', companyNorm: null, title: 'Engineer', titleNorm: 'engineer' }, { client, config: cfg() });
    assert.equal(v.branch, 'unknown_company');
  });
  test('a normal, unmatched listing is eligible', async () => {
    const id = await insertListing({ company: 'Wholly Unrelated Enterprises', companyNorm: 'wholly unrelated enterprises' });
    const v = await classifyExclusion(
      { id, company: 'Wholly Unrelated Enterprises', companyNorm: 'wholly unrelated enterprises', title: 'Software Engineer', titleNorm: 'software engineer' },
      { client, config: cfg() },
    );
    assert.equal(v.branch, 'eligible');
  });
});
