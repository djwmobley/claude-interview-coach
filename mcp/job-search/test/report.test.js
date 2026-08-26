// @ts-check
/**
 * Daily scan report (spec R1) against the real DB: run summaries, "Look at these" (noise excluded),
 * "Houston / Texas", review queue, disabled sources, the marker (spec R1.1, decisions 23/24/25/26), and
 * the scan_report MCP tool (spec R1.4), which must never write the marker.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import { ensureAuxSchema } from '../src/core/schema.js';
import {
  buildScanReport, buildReportSubject, renderReportText, renderReportHtml, renderReportMarkdown,
  dayKeyInTz, isWeekdayInTz, escapeHtml, urlPassesRegistry, getReportState, stampReportSent,
  collectSuspectAndUnclassified,
} from '../src/core/report.js';
import { tool as scanReport } from '../src/tools/scan_report.js';
import { registryFrom } from '../src/core/urlguard.js';

const SRC = `zz-test-report-${process.pid}`;
const CO = `ZZ-TEST-REPORT-${process.pid}`;
/** @type {pg.Client} */
let client;

/**
 * @param {Partial<{ title: string, prescore: number|null, noise: string|null, location: string, location_norm: string, url: string }>} o
 */
async function insertListing(o = {}) {
  const n = Math.floor(Math.random() * 1e9);
  const url = o.url ?? `https://boards.greenhouse.io/zztestreport/jobs/${n}`;
  const r = await client.query(
    `INSERT INTO ic_job_listings (title, company, url, url_normalized, source, external_id, record_kind, company_norm, title_norm, location, location_norm, dedup_hash, prescore, noise_class, first_seen, last_seen)
     VALUES ($1,$2,$3,$3,$4,$5,'listing',lower($2),lower($1),$6,$7,md5($3),$8,$9,now(),now()) RETURNING id`,
    [o.title ?? 'CTO', CO, url, SRC, `${SRC}:${n}`, o.location ?? 'Houston, TX', o.location_norm ?? 'houston-tx', o.prescore ?? 50, o.noise ?? null],
  );
  return Number(r.rows[0].id);
}

async function cleanup() {
  const ids = (await client.query('SELECT id FROM ic_job_listings WHERE company = $1', [CO])).rows.map((r) => r.id);
  if (ids.length) {
    await client.query('DELETE FROM ic_job_review_queue WHERE candidate_id = ANY($1::int[])', [ids]);
    await client.query('DELETE FROM ic_job_listings WHERE id = ANY($1::int[])', [ids]);
  }
  await client.query(`DELETE FROM ic_scan_runs WHERE profile = $1`, [`zz-test-report-profile-${process.pid}`]);
}

// ic_report_state (spec R1) is a real singleton row, but by this point in the suite it lives in the
// throwaway, per-run "_test" database bin/run-tests.js pointed PG_DSN at; no snapshot/restore is
// needed since the whole database is recreated from scratch on the next `npm test` run.
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

describe('dayKeyInTz / isWeekdayInTz (decision 25: explicit IANA zone, never naive UTC ::date)', () => {
  test('a UTC evening rolls to the next calendar day in Chicago only near midnight UTC, not generally', () => {
    // 2026-08-26T03:00:00Z is 2026-08-25 22:00 in Chicago (CDT, UTC-5): the DAY differs from a naive UTC ::date.
    assert.equal(dayKeyInTz(new Date('2026-08-26T03:00:00Z'), 'America/Chicago'), '2026-08-25');
    assert.equal(dayKeyInTz(new Date('2026-08-26T18:00:00Z'), 'America/Chicago'), '2026-08-26');
  });
  test('weekday/weekend classification', () => {
    assert.equal(isWeekdayInTz(new Date('2026-08-26T18:00:00Z'), 'America/Chicago'), true, 'Wednesday');
    assert.equal(isWeekdayInTz(new Date('2000-01-02T06:00:00Z'), 'America/Chicago'), false, 'Sunday midnight Chicago');
  });
});

describe('escapeHtml / urlPassesRegistry (spec R1.5)', () => {
  test('escapes the five HTML-significant characters', () => {
    assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
  });
  test('a registered host+path passes; an unregistered host or path does not', () => {
    const registry = registryFrom([{ source: 'greenhouse', domains: ['boards.greenhouse.io'], pathPatterns: ['^/[a-z0-9-]+/jobs/\\d+/?$'] }]);
    assert.equal(urlPassesRegistry('https://boards.greenhouse.io/acme/jobs/123', registry), true);
    assert.equal(urlPassesRegistry('https://evil.example.com/acme/jobs/123', registry), false);
    assert.equal(urlPassesRegistry('https://boards.greenhouse.io/not-a-job-path', registry), false);
    assert.equal(urlPassesRegistry(null, registry), false);
    assert.equal(urlPassesRegistry('not a url', registry), false);
  });
});

describe('buildScanReport: noise exclusion, home locations, review queue, disabled sources', () => {
  test('"Look at these" excludes noise rows and counts them; "Houston / Texas" ignores the noise filter but applies the prescore floor', async () => {
    const since = new Date(Date.now() - 5000);
    const ok = await insertListing({ title: 'Chief Technology Officer', prescore: 80, noise: 'ok' });
    const noisy = await insertListing({ title: 'Fractional CTO', prescore: 90, noise: 'fractional_or_founder' });
    // At-or-above the default floor (40) and noise-classified: still included -- R1.2c's "no noise
    // filter" holds; only the floor is new (scan-report-fixes item 5).
    const homeAboveFloor = await insertListing({ title: 'Head of Technology', prescore: 45, noise: 'staffing_generic', location: 'Houston, TX', location_norm: 'houston-tx' });
    // Below the default floor: excluded (this is the actual bug the floor fixes -- an RN Clinical
    // Director-style very-low-relevance row no longer appears in the Houston/Texas section).
    const homeBelowFloor = await insertListing({ title: 'RN Clinical Director', prescore: 5, noise: 'ok', location: 'Houston, TX', location_norm: 'houston-tx' });
    const report = await buildScanReport(client, { sinceOverride: since, homeLocationNorms: ['houston-tx'] });
    const lookIds = report.lookAtThese.rows.map((r) => r.id);
    assert.ok(lookIds.includes(ok), 'ok row included');
    assert.ok(!lookIds.includes(noisy), 'noise row excluded from Look at these');
    assert.ok(report.lookAtThese.excludedCount >= 1);
    const homeIds = report.homeLocations.rows.map((r) => r.id);
    assert.ok(homeIds.includes(homeAboveFloor), 'a noise-classified row at/above the prescore floor still appears in Houston / Texas (R1.2c: no noise filter)');
    assert.ok(!homeIds.includes(homeBelowFloor), 'a row below the prescore floor is excluded from Houston / Texas (item 5 fix)');
    assert.ok(report.homeLocations.excludedCount >= 1, 'the below-floor exclusion is counted, not silently dropped');
  });

  test('reportHomeMinPrescore option controls the floor directly', async () => {
    const since = new Date(Date.now() - 5000);
    const midScore = await insertListing({ title: 'Director of IT', prescore: 30, noise: 'ok', location: 'Houston, TX', location_norm: 'houston-tx' });
    const belowDefault = await buildScanReport(client, { sinceOverride: since, homeLocationNorms: ['houston-tx'] });
    assert.ok(!belowDefault.homeLocations.rows.map((r) => r.id).includes(midScore), 'prescore 30 is below the default floor of 40');
    const withLowerFloor = await buildScanReport(client, { sinceOverride: since, homeLocationNorms: ['houston-tx'], homeMinPrescore: 20 });
    assert.ok(withLowerFloor.homeLocations.rows.map((r) => r.id).includes(midScore), 'prescore 30 clears an explicitly lowered floor of 20');
  });

  test('"also posted" annotation includes the ROOT row\'s own state, not just its merged children (regression: the real Gartner AR/OK/TX row initially printed "also posted: OK, TX" with AR silently missing, because the root query did not select location_norm)', async () => {
    const since = new Date(Date.now() - 5000);
    const root = await insertListing({ title: 'Executive Partner - CIO Advisory', prescore: 57, noise: 'ok', location: 'Arkansas, United States', location_norm: 'remote-us-ar' });
    const childOk = await insertListing({ title: 'Executive Partner - CIO Advisory', prescore: 57, noise: 'ok', location: 'Oklahoma, United States', location_norm: 'remote-us-ok' });
    const childTx = await insertListing({ title: 'Executive Partner - CIO Advisory', prescore: 57, noise: 'ok', location: 'Texas, United States', location_norm: 'remote-us-tx' });
    await client.query('UPDATE ic_job_listings SET duplicate_of = $1 WHERE id = ANY($2::int[])', [root, [childOk, childTx]]);
    const report = await buildScanReport(client, { sinceOverride: since, homeLocationNorms: [] });
    const rootRow = report.lookAtThese.rows.find((r) => r.id === root);
    assert.ok(rootRow, 'the root row (duplicate_of IS NULL) appears in Look at these');
    assert.deepEqual(rootRow.also_posted_states, ['AR', 'OK', 'TX'], 'the root\'s own state (AR) must appear alongside its merged children\'s states');
  });

  test('a NULL noise_class is treated as not-ok (independent review fix): excluded from "Look at these", surfaced in "Suspect / unclassified"', async () => {
    const since = new Date(Date.now() - 5000);
    const unclassified = await insertListing({ title: 'Some Unclassified Row', prescore: 95, noise: null });
    const report = await buildScanReport(client, { sinceOverride: since, homeLocationNorms: [] });
    const lookIds = report.lookAtThese.rows.map((r) => r.id);
    assert.ok(!lookIds.includes(unclassified), 'a NULL-noise_class row, even at a very high prescore, must never appear in Look at these');
    assert.ok(report.lookAtThese.excludedCount >= 1, 'a NULL row counts toward the excluded count too');
    const suspectIds = report.suspectUnclassified.map((r) => r.id);
    assert.ok(suspectIds.includes(unclassified), 'a NULL-noise_class row is surfaced in the suspect/unclassified list instead of being silently dropped');
    const row = report.suspectUnclassified.find((r) => r.id === unclassified);
    assert.equal(row.noise_class, 'unclassified', 'a NULL db value renders as the readable label "unclassified"');
  });

  test('collectSuspectAndUnclassified: a suspect row and a NULL row both appear; an ok row never does', async () => {
    const since = new Date(Date.now() - 5000);
    const suspect = await insertListing({ title: 'Virtual CTO', prescore: 40, noise: 'suspect' });
    const nullRow = await insertListing({ title: 'No Class Yet', prescore: 40, noise: null });
    const ok = await insertListing({ title: 'Chief Technology Officer', prescore: 40, noise: 'ok' });
    const rows = await collectSuspectAndUnclassified(client, since, 25);
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(suspect) && ids.includes(nullRow), 'both suspect and NULL rows appear');
    assert.ok(!ids.includes(ok), 'an ok row never appears in the suspect/unclassified list');
  });

  test('run summaries only include runs finished since the marker', async () => {
    const profile = `zz-test-report-profile-${process.pid}`;
    const t0 = Date.now();
    const old = await client.query(`INSERT INTO ic_scan_runs (profile, trigger, status, started_at, finished_at, stats) VALUES ($1,'cli','ok', now() - interval '2 hours', now() - interval '2 hours', '{"fetched":1}'::jsonb) RETURNING id`, [profile]);
    await new Promise((r) => setTimeout(r, 5));
    const since = new Date();
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await client.query(`INSERT INTO ic_scan_runs (profile, trigger, status, started_at, finished_at, stats) VALUES ($1,'cli','partial', now(), now(), '{"fetched":3,"new":2}'::jsonb) RETURNING id`, [profile]);
    const report = await buildScanReport(client, { sinceOverride: since });
    const ids = report.runs.map((r) => r.run_id);
    assert.ok(ids.includes(Number(fresh.rows[0].id)));
    assert.ok(!ids.includes(Number(old.rows[0].id)));
    assert.equal(report.worstStatus, 'partial');
    assert.ok(t0 <= since.getTime());
  });

  test('buildReportSubject: [SCAN PARTIAL] / [SCAN FAILED] prefix when any run is not ok (decision 27)', async () => {
    const dataOk = { dayKey: '2026-08-26', worstStatus: 'ok', noScan: false, lookAtThese: { rows: [] }, reviewQueue: { total: 0 } };
    const dataPartial = { ...dataOk, worstStatus: 'partial' };
    assert.doesNotMatch(buildReportSubject(dataOk), /^\[SCAN/);
    assert.match(buildReportSubject(dataPartial), /^\[SCAN PARTIAL\]/);
  });

  test('buildReportSubject: [NO SCAN] prefix when noScan is true (decision 26)', () => {
    const data = { dayKey: '2026-08-26', worstStatus: 'ok', noScan: true, lookAtThese: { rows: [] }, reviewQueue: { total: 0 } };
    assert.match(buildReportSubject(data), /^\[NO SCAN\]/);
  });

  test('disabled sources and review queue reasons are surfaced', async () => {
    await client.query(`INSERT INTO ic_source_state (source, manual_disable, disabled_until) VALUES ($1, true, NULL) ON CONFLICT (source) DO UPDATE SET manual_disable = true, disabled_until = NULL`, [`${SRC}-disabled`]);
    try {
      const report = await buildScanReport(client, { sinceOverride: new Date(Date.now() - 1000) });
      assert.ok(report.disabledSources.some((s) => s.source === `${SRC}-disabled` && s.manual === true));
    } finally {
      await client.query(`DELETE FROM ic_source_state WHERE source = $1`, [`${SRC}-disabled`]);
    }
  });

  test('a source disabled_until a future timestamp (manual_disable false) is also surfaced (scan-report-fixes item 4 regression): buildScanReport, and collectDisabledSources directly', async () => {
    // Reproduces the exact shape the coordinator observed: `scans status` showing a real future
    // disabled_until while the report printed "(none)". No functional bug was found in
    // collectDisabledSources()'s query itself (verified separately end to end against the real DB); this
    // is a regression test guarding the query's actual, correct behavior against a future change, per the
    // task's explicit "test it" instruction.
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    await client.query(
      `INSERT INTO ic_source_state (source, manual_disable, disabled_until) VALUES ($1, false, $2)
       ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = $2`,
      [`${SRC}-wall-disabled`, future],
    );
    try {
      const report = await buildScanReport(client, { sinceOverride: new Date(Date.now() - 1000) });
      const entry = report.disabledSources.find((s) => s.source === `${SRC}-wall-disabled`);
      assert.ok(entry, 'a source with a future disabled_until (and manual_disable=false) must appear in disabledSources');
      assert.equal(entry.manual, false);
      assert.ok(entry.until, 'the until timestamp is carried through');
    } finally {
      await client.query(`DELETE FROM ic_source_state WHERE source = $1`, [`${SRC}-wall-disabled`]);
    }
  });

  test('a source whose disabled_until is in the PAST and manual_disable is false is NOT surfaced (the query must compare, not just check IS NOT NULL)', async () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000);
    await client.query(
      `INSERT INTO ic_source_state (source, manual_disable, disabled_until) VALUES ($1, false, $2)
       ON CONFLICT (source) DO UPDATE SET manual_disable = false, disabled_until = $2`,
      [`${SRC}-expired-disable`, past],
    );
    try {
      const report = await buildScanReport(client, { sinceOverride: new Date(Date.now() - 1000) });
      assert.ok(!report.disabledSources.some((s) => s.source === `${SRC}-expired-disable`), 'an expired disabled_until must not be reported as currently disabled');
    } finally {
      await client.query(`DELETE FROM ic_source_state WHERE source = $1`, [`${SRC}-expired-disable`]);
    }
  });
});

describe('renderReportText / Html / Markdown: no em-dashes, listing text present', () => {
  test('all three renderers include the same listing and never contain an em-dash', async () => {
    const since = new Date(Date.now() - 5000);
    await insertListing({ title: 'Chief Technology Officer', prescore: 80, noise: 'ok' });
    const report = await buildScanReport(client, { sinceOverride: since, homeLocationNorms: [] });
    const text = renderReportText(report);
    const html = renderReportHtml(report);
    const md = renderReportMarkdown(report);
    for (const s of [text, html, md]) {
      assert.ok(s.includes('Chief Technology Officer'));
      assert.ok(!s.includes(String.fromCharCode(8212)), 'no em-dash in rendered report');
    }
  });
});

describe('report marker (spec R1.1, decisions 23/24)', () => {
  test('stampReportSent advances the marker; getReportState reads it back', async () => {
    const now = new Date('2026-08-26T13:00:00Z');
    await stampReportSent(client, now, 42);
    const state = await getReportState(client);
    assert.equal(state.lastReportSentAt.toISOString(), now.toISOString());
    assert.equal(state.lastRunIdIncluded, 42);
  });
});

describe('scan_report MCP tool (spec R1.4): never writes the marker', () => {
  test('on-demand call returns a report and leaves the marker untouched', async () => {
    // Stamps a test-owned sentinel value immediately before the call and checks it is STILL that value
    // immediately after, rather than comparing against a "before" snapshot captured earlier -- ic_report_
    // state is a real singleton row shared by every test FILE against the isolated test database (node
    // --test runs files in parallel by default), so a snapshot taken well before the call could already
    // be stale from another file's own marker-writing test; this shrinks the race window to the width of
    // this one call instead of the whole suite's run time.
    const sentinel = new Date('2099-01-01T00:00:00.000Z');
    await stampReportSent(client, sentinel, 999999);
    const deps = /** @type {any} */ ({
      withClient: async (/** @type {any} */ fn) => fn(client),
      config: null,
    });
    const r = /** @type {any} */ (await scanReport.handler({ profile: 'exec-default' }, deps));
    assert.equal(r.ok, true);
    assert.ok(r.report.startsWith('<<<UNTRUSTED_LISTING_TEXT'));
    assert.ok(r.report.endsWith('>>>END_UNTRUSTED_LISTING_TEXT'));
    const after = await getReportState(client);
    assert.equal(after.lastReportSentAt?.toISOString(), sentinel.toISOString(), 'scan_report never advances the marker');
  });

  test('run_id scoping returns NOT_FOUND for an unknown run', async () => {
    const deps = /** @type {any} */ ({ withClient: async (/** @type {any} */ fn) => fn(client), config: null });
    await assert.rejects(scanReport.handler({ run_id: 999999999, profile: 'exec-default' }, deps), /not found/);
  });
});
