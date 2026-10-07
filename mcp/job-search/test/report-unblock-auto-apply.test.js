// @ts-check
/**
 * src/core/report.js additions for the unblock-auto-apply PR: the v2 funnel line (Item 4 "funnel labels",
 * the version-less shape still renders the old way), the coverage triage line (Item 4), the approved-driver
 * and reroute lines (Items 1-2), the prepare line's never-probed / not_us_location counts (Item 3), and the
 * SOURCE DISABLED headline for every latched source (Item 6) in both the scan report and the auto-apply
 * section.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { pgConnectionConfig } from '../src/core/config.js';
import {
  collectAutoApply, renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown, renderTriageLine,
  renderReportText, renderReportHtml, renderReportMarkdown, collectLatchedSources, latchedSourceLines, buildScanReport, buildReportSubject, gmailDetailLine, gmailManualApplyLines,
} from '../src/core/report.js';

const emptyClient = { async query() { return { rows: [] }; } };

/** @param {any} extra */
async function dataFor(extra) {
  return collectAutoApply(/** @type {any} */ (emptyClient), { phase: 'done', select: { results: [], cap_used: 0, cap_remaining: 5, dailyCap: 5 }, applied: [], ...extra });
}

describe('funnel line v2 (Item 4)', () => {
  test('renders considered, the nonzero eliminations in gate order with the fit breakdown, eligible, and the cap', async () => {
    const funnel = {
      version: 2, considered: 421,
      eliminated: {
        exclusions: 12, fit: 374, duplicate_of: 0, not_us: 7, salary_below_floor: 1, active_application: 0, no_description: 0,
        easy_apply_only: 1, apply_target_unresolved: 26, ats_not_allowed: 0, confidence_not_exact: 0, hourly_pay: 0,
      },
      reasons: { exclusion_blocked_company: 12, not_scored: 172, below_fit: 202, not_us: 7, salary_below_floor: 1, easy_apply_only: 1, apply_target_unresolved: 26 },
      eligible: 0,
    };
    const data = await dataFor({ select: { results: [], cap_used: 0, cap_remaining: 5, dailyCap: 5, funnel } });
    const text = renderAutoApplyText(data);
    assert.match(text, /funnel: considered 421; eliminated exclusions 12, fit 374 \(not_scored 172, below_fit 202\), not_us 7, salary_below_floor 1, easy_apply_only 1, apply_target_unresolved 26; eligible 0; applied 0 of cap 5/);
    assert.match(renderAutoApplyMarkdown(data), /funnel: considered 421; eliminated exclusions 12/);
    assert.match(renderAutoApplyHtml(data), /funnel: considered 421; eliminated exclusions 12/);
  });

  test('a version-less funnel still renders as remaining after each gate', async () => {
    const funnel = {
      considered: 10, exclusions: 9, fit: 7, duplicate_of: 7, not_us: 6, salary_below_floor: 6,
      active_application: 6, no_description: 6, easy_apply_only: 6, apply_target_unresolved: 5,
      ats_not_allowed: 5, confidence_not_exact: 5, hourly_pay: 4, eligible: 4,
    };
    const data = await dataFor({ select: { results: [], cap_used: 0, cap_remaining: 5, dailyCap: 5, funnel } });
    assert.match(renderAutoApplyText(data), /funnel: considered 10 > exclusions 9 > fit 7/);
  });

  test('nothing eliminated renders "eliminated none"', async () => {
    const funnel = { version: 2, considered: 2, eliminated: { exclusions: 0, fit: 0 }, reasons: { eligible: 2 }, eligible: 2 };
    const data = await dataFor({ select: { results: [], cap_used: 0, cap_remaining: 5, dailyCap: 5, funnel } });
    assert.match(renderAutoApplyText(data), /funnel: considered 2; eliminated none; eligible 2; applied 0 of cap 5/);
  });
});

describe('coverage triage line (Item 4)', () => {
  test('a run with coverage renders sent by kind, scored, unscored, capped, skip_low, noise', () => {
    const line = renderTriageLine({
      configured: true,
      deterministic: { skip_noise: 3, skip_low: 9, auto_new: 2, model_band: 4, model_low: 6, review_band: 1 },
      backlog: { skip_low: 1, skip_noise: 1 },
      model: { enabled: true, batches_sent: 2, batches_ok: 2, batches_failed: 0, batches_zero_scored: 0, scored: 9, unscored: 1 },
      coverage: { eligible: 20, sent: 18, scored: 16, capped: 2, failed: 2, by_kind: { band: 4, low: 6, auto_new: 2, rescore: 0, backlog: 5, review: 1 } },
    });
    assert.equal(line, 'triage: sent 18 (band 4, low 6, auto_new 2, review 1, backlog 5); scored 16; unscored 2; capped 2; skip_low 10; noise 4');
  });
  test('rescore appears in the breakdown only when nonzero; a failed batch and a disabled model are named', () => {
    const base = {
      configured: true, deterministic: { skip_noise: 0, skip_low: 0 },
      coverage: { eligible: 3, sent: 3, scored: 0, capped: 0, failed: 3, by_kind: { band: 1, low: 0, auto_new: 0, rescore: 2, backlog: 0, review: 0 } },
    };
    const failed = renderTriageLine({ ...base, model: { enabled: true, batches_failed: 1, last_failure_reason: 'timeout' } });
    assert.equal(failed, 'triage: sent 3 (band 1, low 0, auto_new 0, review 0, backlog 0, rescore 2); scored 0; unscored 3; capped 0; skip_low 0; noise 0; claude -p timed out');
    const off = renderTriageLine({ ...base, model: { enabled: false, reason: 'model_disabled' } });
    assert.match(off, /\(model scoring disabled\)$/);
  });
});

describe('approved-driver, reroute, and prepare lines (Items 1-3)', () => {
  test('the approved line and the reroute line render every count with reason breakdowns', async () => {
    const data = await dataFor({
      approved_driver: {
        counts: {
          approved: 7, drove: 3, drove_ok: 1, drove_parked: 1, drove_deferred: 1, deferred_reasons: { workday_daily_cap: 1 },
          parked: 2, parked_reasons: { listing_closed: 1, missing_resume: 1 }, reroute: 1, easy_apply_path: 1, other: 0, other_outcomes: {},
        },
      },
      reroute: {
        attempted: 3, rerouted: 1, by_ats: { greenhouse: 1 }, parked: 1, parked_reasons: { reroute_unresolved: 1 }, deferred: 1, deferred_reasons: { budget_exhausted: 1 }, other: 0, other_outcomes: {},
      },
    });
    const text = renderAutoApplyText(data);
    assert.match(text, /approved: 7; drove 3 \(ok 1, parked 1, deferred 1 \[workday_daily_cap:1\]\); parked 2 \[listing_closed:1, missing_resume:1\]; reroute 1; easy_apply_path 1/);
    assert.match(text, /reroute: 3; rerouted 1 \[greenhouse:1\]; parked 1 \[reroute_unresolved:1\]; deferred 1 \[budget_exhausted:1\]/);
    assert.match(renderAutoApplyMarkdown(data), /approved: 7; drove 3/);
    assert.match(renderAutoApplyHtml(data), /approved: 7; drove 3/);
  });
  test('an approved-driver error is a visible line, never silence', async () => {
    const data = await dataFor({ approved_driver: { error: 'boom' } });
    assert.match(renderAutoApplyText(data), /approved: driver failed \(boom\)/);
  });
  test('the prepare line carries never_probed attempted N of M and not_us_location', async () => {
    const data = await dataFor({ prepare: { attempted: 5, resolved: 2, unresolved: 3, skipped: 2, skippedByReason: { not_us_location: 2 }, neverProbedAttempted: 4, neverProbedSeen: 9 } });
    const text = renderAutoApplyText(data);
    assert.match(text, /prepare: probed 5, resolved 2, unresolved 3, skipped 2 \(not_us_location=2\), never_probed attempted 4 of 9, not_us_location 2/);
  });
});

describe('SOURCE DISABLED headline (Item 6)', () => {
  const latched = [{ source: 'linkedin', since: '2026-10-01T12:00:00.000Z', reason: '3 consecutive walls' }];
  test('latchedSourceLines: one line per latched source; none gives none', () => {
    assert.deepEqual(latchedSourceLines(latched), ['SOURCE DISABLED: linkedin since 2026-10-01T12:00:00.000Z (3 consecutive walls); re-enable on dashboard Scans']);
    assert.deepEqual(latchedSourceLines([]), []);
    assert.deepEqual(latchedSourceLines(undefined), []);
  });

  /** @param {any} latchedSources */
  const scanData = (latchedSources) => ({
    dayKey: '2026-10-07', timezone: 'America/Chicago', noScan: false, runs: [], lookAtThese: { rows: [], excludedCount: 0 }, suspectUnclassified: [],
    homeLocations: { rows: [], excludedCount: 0 }, reviewQueue: { total: 0, topReasons: [] }, disabledSources: [], latchedSources,
  });
  test('the scan report opens with the line in text, markdown, and html; none gives none', () => {
    const text = renderReportText(/** @type {any} */ (scanData(latched)));
    assert.match(text.split('\n')[0], /^SOURCE DISABLED: linkedin since 2026-10-01T12:00:00.000Z \(3 consecutive walls\); re-enable on dashboard Scans$/);
    assert.match(renderReportMarkdown(/** @type {any} */ (scanData(latched))).split('\n')[0], /SOURCE DISABLED: linkedin/);
    assert.match(renderReportHtml(/** @type {any} */ (scanData(latched))), /^<p><strong>SOURCE DISABLED: linkedin/);
    assert.doesNotMatch(renderReportText(/** @type {any} */ (scanData([]))), /SOURCE DISABLED/);
  });
  test('the auto-apply section opens with the line in every state; none gives none', async () => {
    const data = /** @type {any} */ (await dataFor({}));
    data.latchedSources = latched;
    assert.match(renderAutoApplyText(data).split('\n')[0], /^SOURCE DISABLED: linkedin/);
    assert.match(renderAutoApplyMarkdown(data).split('\n')[0], /SOURCE DISABLED: linkedin/);
    assert.match(renderAutoApplyHtml(data), /^<p><strong>SOURCE DISABLED: linkedin/);
    const noRun = /** @type {any} */ ({ hasRun: false, latchedSources: latched });
    assert.match(renderAutoApplyText(noRun).split('\n')[0], /^SOURCE DISABLED: linkedin/);
    const clean = /** @type {any} */ (await dataFor({}));
    clean.latchedSources = [];
    assert.doesNotMatch(renderAutoApplyText(clean), /SOURCE DISABLED/);
  });

  describe('collectLatchedSources (real DB)', () => {
    const SRC = `zz-latched-${process.pid}`;
    /** @type {pg.Client} */
    let client;
    before(async () => {
      client = new pg.Client(pgConnectionConfig());
      await client.connect();
    });
    after(async () => {
      await client.query('DELETE FROM ic_source_state WHERE source = $1', [SRC]);
      await client.end();
    });
    test('a manual_disable row gives the line every run until re-enabled', async () => {
      await client.query(
        `INSERT INTO ic_source_state (source, consecutive_walls, last_wall_at, manual_disable) VALUES ($1, 3, '2026-10-01T12:00:00Z', true)
         ON CONFLICT (source) DO UPDATE SET consecutive_walls = 3, last_wall_at = '2026-10-01T12:00:00Z', manual_disable = true`,
        [SRC],
      );
      const rows = await collectLatchedSources(client);
      const mine = rows.filter((r) => r.source === SRC);
      assert.deepEqual(mine, [{ source: SRC, since: '2026-10-01T12:00:00.000Z', reason: '3 consecutive walls' }]);
      const report = await buildScanReport(client, { sinceOverride: null });
      assert.ok(report.latchedSources.some((r) => r.source === SRC));
      await client.query('UPDATE ic_source_state SET manual_disable = false WHERE source = $1', [SRC]);
      assert.equal((await collectLatchedSources(client)).filter((r) => r.source === SRC).length, 0, 're-enabled: no line');
    });
  });
});

describe('Gmail intake report (G4, B7)', () => {
  const gmailStats = {
    by_sender: {
      'jobalert@lensa.com': { emails: 3, ok: 0, partial: 0, parse_empty: 3, no_job_markers: 0, parse_error: 0, no_body: 0, fetch_error: 0, listings: 0, matched: 0, markers: 66, incomplete: 0, parser: 'lensa', parser_version: 2 },
      'jobs@my.theladders.com': { emails: 2, ok: 1, partial: 0, parse_empty: 0, no_job_markers: 1, parse_error: 0, no_body: 0, fetch_error: 0, listings: 10, matched: 4, markers: 10, incomplete: 0, parser: 'ladders', parser_version: 2 },
      'dice@connect.dice.com': { emails: 1, ok: 0, partial: 1, parse_empty: 0, no_job_markers: 0, parse_error: 0, no_body: 0, fetch_error: 0, listings: 1, matched: 1, markers: 3, incomplete: 2, parser: 'dice', parser_version: 1 },
    },
    unhandled_senders: { 'a@new.example': 3, 'b@new.example': 1 },
    messages: { fetch_error: 0, unhandled_sender: 0 },
    discovery: { outcome: 'ok' },
  };
  /** @param {any} gmail */
  const data = (gmail) => ({
    dayKey: '2026-10-07', timezone: 'America/Chicago', noScan: false, lockMismatch: null, worstStatus: 'ok',
    runs: [{ run_id: 9, profile: 'p', status: 'ok', started_at: 'x', duration_seconds: 1, stats: { gmail }, errors: [], pages_by_source: {} }],
    lookAtThese: { rows: [], excludedCount: 0 }, suspectUnclassified: [], homeLocations: { rows: [], excludedCount: 0 },
    reviewQueue: { total: 0, topReasons: [] }, disabledSources: [], latchedSources: [],
  });
  test('PARSER BROKEN only for a registered sender with parse_empty or parse_error; info for no_job_markers; ratio warning under 50%', () => {
    const text = renderReportText(/** @type {any} */ (data(gmailStats)));
    assert.match(text, /PARSER BROKEN: jobalert@lensa\.com 3 emails, 0 listings \(parse_empty 3, parse_error 0\)/);
    assert.doesNotMatch(text, /PARSER BROKEN: jobs@my\.theladders\.com/);
    assert.match(text, /gmail info: jobs@my\.theladders\.com 1 email with no job markers/);
    assert.match(text, /gmail warning: dice@connect\.dice\.com parsed 1 listing from 3 job markers/);
    assert.match(text, /gmail: 6 emails; listings 11 \(matched 5\); ok 1, partial 1, parse_empty 3, no_job_markers 1, parse_error 0, no_body 0, fetch_error 0; unhandled senders 4 \[a@new\.example:3, b@new\.example:1\]; discovery ok/);
    assert.match(text, / {2}jobalert@lensa\.com \(lensa v2\): 3 emails, 0 listings, parse_empty 3, partial 0/);
    assert.match(renderReportHtml(/** @type {any} */ (data(gmailStats))), /PARSER BROKEN: jobalert@lensa\.com/);
    assert.match(renderReportMarkdown(/** @type {any} */ (data(gmailStats))), /PARSER BROKEN: jobalert@lensa\.com/);
  });
  test('subject prefix only for the hard case; a run without stats.gmail renders no gmail headline', () => {
    assert.match(buildReportSubject(/** @type {any} */ (data(gmailStats))), /\[PARSER BROKEN\]/);
    const soft = { ...gmailStats, by_sender: { 'jobs@my.theladders.com': gmailStats.by_sender['jobs@my.theladders.com'] } };
    assert.doesNotMatch(buildReportSubject(/** @type {any} */ (data(soft))), /PARSER BROKEN/);
    const none = renderReportText(/** @type {any} */ (data(undefined)));
    assert.doesNotMatch(none, /PARSER BROKEN|gmail:/);
  });
});

describe('Gmail details line and manual-apply list (G3, B2)', () => {
  test('the gmail details line renders every count; the manual-apply list shows each item with its link', () => {
    const line = gmailDetailLine({
      candidates: 9, fetched_by: { linkedin: 0, indeed: 0, ats: 0, generic: 2 }, deduped: 1, empty: 1,
      unwrap_failed: { blocked_by_guard: 1 }, denied: 2, no_link: 1, unknown: 0, deferred: { skipped_run_cap: 1 }, stuck_ineligible: 3,
    });
    assert.equal(line, 'gmail details: candidates 9; fetched 2 (linkedin 0, indeed 0, ats 0, generic 2); deduped 1; empty 1; unwrap failed 1 [blocked_by_guard:1]; denied 2; no_link 1; unknown 0; deferred 1 [skipped_run_cap:1]; stuck ineligible 3');
    // Ready to apply list R5: the list itself moved to the Ready section; only a pointer remains here.
    const lines = gmailManualApplyLines([{ id: 5, title: 'CTO', company: 'Acme', fit: 72, link: 'https://www.remotehunter.com/apply-with-ai/x', outcome: 'denied_apply_link' }]);
    assert.match(lines.join('\n'), /Gmail jobs to apply to by hand: 1; see Ready to apply/);
    assert.deepEqual(gmailManualApplyLines([]), []);
  });
});
