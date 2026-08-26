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
} from '../src/core/report.js';
import { tool as scanReport } from '../src/tools/scan_report.js';
import { registryFrom } from '../src/core/urlguard.js';

const SRC = `zz-test-report-${process.pid}`;
const CO = `ZZ-TEST-REPORT-${process.pid}`;
/** @type {pg.Client} */
let client;
/** @type {{ last_report_sent_at: Date|null, last_run_id_included: number|null } | null} */
let stateSnapshot;

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

before(async () => {
  client = new pg.Client(pgConnectionConfig());
  await client.connect();
  await ensureAuxSchema(client);
  stateSnapshot = (await client.query('SELECT last_report_sent_at, last_run_id_included FROM ic_report_state WHERE id = true')).rows[0] ?? null;
  await cleanup();
});
after(async () => {
  await cleanup();
  if (stateSnapshot) {
    await client.query('UPDATE ic_report_state SET last_report_sent_at = $1, last_run_id_included = $2 WHERE id = true', [stateSnapshot.last_report_sent_at, stateSnapshot.last_run_id_included]);
  }
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
  test('"Look at these" excludes noise rows and counts them; "Houston / Texas" ignores prescore and the noise filter', async () => {
    const since = new Date(Date.now() - 5000);
    const ok = await insertListing({ title: 'Chief Technology Officer', prescore: 80, noise: 'ok' });
    const noisy = await insertListing({ title: 'Fractional CTO', prescore: 90, noise: 'fractional_or_founder' });
    const lowHome = await insertListing({ title: 'Head of Technology', prescore: 5, noise: 'staffing_generic', location: 'Houston, TX', location_norm: 'houston-tx' });
    const report = await buildScanReport(client, { sinceOverride: since, homeLocationNorms: ['houston-tx'] });
    const lookIds = report.lookAtThese.rows.map((r) => r.id);
    assert.ok(lookIds.includes(ok), 'ok row included');
    assert.ok(!lookIds.includes(noisy), 'noise row excluded from Look at these');
    assert.ok(report.lookAtThese.excludedCount >= 1);
    const homeIds = report.homeLocations.map((r) => r.id);
    assert.ok(homeIds.includes(lowHome), 'a low-prescore, noise-classified row still appears in Houston / Texas (R1.2c: any prescore, no noise filter)');
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
    await client.query(`INSERT INTO ic_source_state (source, manual_disable, disabled_until) VALUES ($1, true, NULL) ON CONFLICT (source) DO UPDATE SET manual_disable = true`, [`${SRC}-disabled`]);
    try {
      const report = await buildScanReport(client, { sinceOverride: new Date(Date.now() - 1000) });
      assert.ok(report.disabledSources.some((s) => s.source === `${SRC}-disabled` && s.manual === true));
    } finally {
      await client.query(`DELETE FROM ic_source_state WHERE source = $1`, [`${SRC}-disabled`]);
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
    const before = await getReportState(client);
    const deps = /** @type {any} */ ({
      withClient: async (/** @type {any} */ fn) => fn(client),
      config: null,
    });
    const r = /** @type {any} */ (await scanReport.handler({ profile: 'exec-default' }, deps));
    assert.equal(r.ok, true);
    assert.ok(r.report.startsWith('<<<UNTRUSTED_LISTING_TEXT'));
    assert.ok(r.report.endsWith('>>>END_UNTRUSTED_LISTING_TEXT'));
    const after = await getReportState(client);
    assert.equal(after.lastReportSentAt?.toISOString(), before.lastReportSentAt?.toISOString(), 'scan_report never advances the marker');
  });

  test('run_id scoping returns NOT_FOUND for an unknown run', async () => {
    const deps = /** @type {any} */ ({ withClient: async (/** @type {any} */ fn) => fn(client), config: null });
    await assert.rejects(scanReport.handler({ run_id: 999999999, profile: 'exec-default' }, deps), /not found/);
  });
});
