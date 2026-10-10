// @ts-check
/**
 * src/core/ready-to-apply.js, pure layer (spec sections 3 and 5 with R2, R3, R7, R8, A2, A3, A6-A9):
 * mapSelectReason is total over CLOSED_REASONS plus anything unknown (T1), every mapping-table row (T2),
 * rule U (T3), the no-control hold (T9), and classifyRows' post-mapping rules: blocked host, age-out,
 * link check, markup-drift breaker, dedup, and the bucket counts summing to the total.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_REASONS } from '../src/core/auto-apply-select.js';
import {
  READY_BUCKETS, READY_CHANNELS, mapSelectReason, classifyRows, readyConfig, morningRunsBetween, isListedBucket,
} from '../src/core/ready-to-apply.js';

const NOW = new Date('2026-10-07T15:00:00Z');
const CFG = readyConfig({});
const CTX = { ...CFG, now: NOW, timezone: 'America/Chicago', lifetimeProbeAttempts: 3 };

/** @param {Record<string, unknown>} o */
function row(o = {}) {
  return /** @type {any} */ ({
    listingId: 1, fitScore: 80, fitActor: 'auto', fitBasis: 'description', duplicateOf: null, locationNorm: 'state-tx', remoteMode: null,
    salaryMax: null, salaryPeriod: null, salaryRaw: null, hasActiveApplication: false, description: 'x'.repeat(400),
    applyUrl: null, applyAts: null, applyConfidence: null, applyEasyOnly: false, source: 'linkedin', company: 'Acme', companyNorm: 'acme',
    title: 'CTO', titleNorm: 'cto', sourceUrl: 'https://www.linkedin.com/jobs/view/4000000001', listingUrl: 'https://www.linkedin.com/jobs/view/4000000001',
    manualApplyUrl: null, gmailFinalUrl: null, applyProbedAt: new Date('2026-10-06T12:00:00Z'), probeAttempts: 1,
    applyPageBranch: null, applyPageReason: null, applyPageRepeat: 0, applyPageFirstSeenAt: null,
    firstSeen: new Date('2026-10-05T12:00:00Z'), appId: null, appState: null, appUpdatedAt: null, autoPathSince: null, locked: false,
    ...o,
  });
}

describe('T1 totality', () => {
  test('every CLOSED_REASONS value and an unknown string map to a bucket in READY_BUCKETS', () => {
    for (const reason of [...CLOSED_REASONS, 'something_new', '']) {
      const m = mapSelectReason(row(), reason, CTX);
      assert.ok(READY_BUCKETS.includes(m.bucket), `${reason} -> ${m.bucket}`);
      if (m.channel !== null) assert.ok(READY_CHANNELS.includes(m.channel), m.channel);
    }
    assert.equal(mapSelectReason(row(), 'something_new', CTX).bucket, 'held_unknown');
  });

  test('a property sweep of odd rows never throws', () => {
    const odd = [null, undefined, '', 'x', 0, -1, 'not a url', 'https://bit.ly/x'];
    for (const v of odd) {
      for (const reason of CLOSED_REASONS) {
        const r = row({ source: v, listingUrl: v, sourceUrl: v, manualApplyUrl: v, applyUrl: v, applyPageBranch: v, applyProbedAt: v, firstSeen: v, appUpdatedAt: v, autoPathSince: v });
        const m = mapSelectReason(r, reason, CTX);
        assert.ok(READY_BUCKETS.includes(m.bucket));
      }
    }
  });
});

describe('T2 mapping table', () => {
  const cases = /** @type {Array<[string, Record<string, unknown>, string, string|null]>} */ ([
    ['exclusion_blocked_company', {}, 'excluded_blocked_company', null],
    ['exclusion_already_applied_listing', {}, 'excluded_already_applied', null],
    ['exclusion_already_applied_history', {}, 'excluded_already_applied', null],
    ['exclusion_previously_withdrawn', {}, 'excluded_withdrawn', null],
    ['exclusion_applied_company_other_role', {}, 'held_applied_company_other_role', null],
    ['exclusion_blocked_company_suspect', {}, 'held_blocked_company_suspect', null],
    ['exclusion_unknown_company', {}, 'held_unknown_company', null],
    ['duplicate_of', {}, 'excluded_duplicate', null],
    ['below_fit', {}, 'excluded_below_fit', null],
    ['not_scored', {}, 'excluded_below_fit', null],
    ['human_fit_override', {}, 'excluded_below_fit', null],
    ['fit_unverified', {}, 'held_fit_unverified', null],
    ['not_us', { locationNorm: 'absent' }, 'held_location_unknown', null],
    ['not_us', { locationNorm: 'remote' }, 'held_location_unknown', null],
    ['not_us', { locationNorm: 'unknown:abc' }, 'held_location_unknown', null],
    ['not_us', { locationNorm: 'country-de' }, 'excluded_not_us', null],
    ['salary_below_floor', {}, 'excluded_salary_below_floor', null],
    ['active_application', { appId: 9, appState: 'drafting', appUpdatedAt: NOW }, 'excluded_active_application', null],
    ['no_description', {}, 'held_no_description', null],
    ['hourly_pay', {}, 'excluded_hourly_pay', null],
    ['director_level', {}, 'excluded_title_gate', null],
    ['non_tech_function', {}, 'excluded_title_gate', null],
    ['easy_apply_only', { source: 'indeed' }, 'ready_to_apply', 'indeed_easy'],
    ['easy_apply_only', { source: 'dice' }, 'ready_to_apply', 'easy_other'],
    ['easy_apply_assisted', {}, 'ready_to_apply', 'linkedin_easy'],
    ['ats_not_allowed', { applyUrl: 'https://acme.taleo.net/j/1', applyAts: 'unknown' }, 'ready_to_apply', 'ats_manual'],
    ['confidence_not_exact', { applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', applyAts: 'greenhouse' }, 'ready_to_apply', 'ats_inferred'],
    ['eligible', {}, 'auto_submit_path', null],
  ]);
  for (const [reason, o, bucket, channel] of cases) {
    test(`${reason} ${JSON.stringify(o)} -> ${bucket}`, () => {
      const m = mapSelectReason(row(o), reason, CTX);
      assert.equal(m.bucket, bucket);
      if (channel) assert.equal(m.channel, channel);
    });
  }

  test('includeEasyApply false: a LinkedIn Easy Apply row is the assisted path (auto_submit_path)', () => {
    assert.equal(mapSelectReason(row(), 'easy_apply_assisted', { ...CTX, includeEasyApply: false }).bucket, 'auto_submit_path');
  });

  test('confidence_not_exact carries the unverified_target flag', () => {
    assert.ok(mapSelectReason(row({ applyUrl: 'https://x.com/a', applyAts: 'greenhouse' }), 'confidence_not_exact', CTX).flags.includes('unverified_target'));
  });

  test('R8: a locked eligible row is listed (manual only) instead of vanishing on the auto path', () => {
    const m = mapSelectReason(row({ locked: true, applyUrl: 'https://boards.greenhouse.io/acme/jobs/1', applyAts: 'greenhouse' }), 'eligible', CTX);
    assert.equal(m.bucket, 'ready_to_apply');
    assert.equal(m.channel, 'ats_exact');
    assert.ok(m.flags.includes('manual_only'));
  });
});

describe('A6 stalled auto path and stale applications', () => {
  test('an eligible row on the auto path through 2 morning runs is held_auto_stalled', () => {
    assert.equal(mapSelectReason(row({ autoPathSince: new Date('2026-10-06T12:00:00Z') }), 'eligible', CTX).bucket, 'auto_submit_path');
    assert.equal(mapSelectReason(row({ autoPathSince: new Date('2026-10-05T12:00:00Z') }), 'eligible', CTX).bucket, 'held_auto_stalled');
  });
  test('an application parked at needs_human longer than staleNeedsHumanHours is held with a pointer', () => {
    const m = mapSelectReason(row({ appId: 42, appState: 'needs_human', appUpdatedAt: new Date('2026-10-05T12:00:00Z') }), 'active_application', CTX);
    assert.equal(m.bucket, 'held_stale_application');
    assert.equal(m.applicationId, 42);
    assert.equal(mapSelectReason(row({ appId: 42, appState: 'needs_human', appUpdatedAt: new Date('2026-10-07T12:00:00Z') }), 'active_application', CTX).bucket, 'excluded_active_application');
  });
  test('morningRunsBetween counts local day boundaries', () => {
    assert.equal(morningRunsBetween(new Date('2026-10-06T23:00:00Z'), NOW, 'America/Chicago'), 1);
    assert.equal(morningRunsBetween(NOW, NOW, 'America/Chicago'), 0);
    assert.equal(morningRunsBetween(null, NOW, 'America/Chicago'), 0);
  });
});

describe('T3 rule U (apply_target_unresolved)', () => {
  const U = 'apply_target_unresolved';
  test('hourly first, on every source', () => {
    assert.equal(mapSelectReason(row({ salaryPeriod: 'hour', manualApplyUrl: 'https://careers.acme.com/j' }), U, CTX).bucket, 'excluded_hourly_pay');
  });
  test('a kept manual href is ready via external_manual', () => {
    const m = mapSelectReason(row({ manualApplyUrl: 'https://careers.acme.com/j/1' }), U, CTX);
    assert.equal(m.channel, 'external_manual');
    assert.equal(m.link, 'https://careers.acme.com/j/1');
  });
  test('LinkedIn never probed -> held_not_probed', () => {
    assert.equal(mapSelectReason(row({ applyProbedAt: null }), U, CTX).bucket, 'held_not_probed');
  });
  test('T9 no-control hold: held at repeat 1, listed at repeat 2, after the hold days, and at the lifetime cap', () => {
    const base = { applyPageBranch: 'no_control', applyPageReason: 'top_card_no_anchor', applyPageFirstSeenAt: new Date('2026-10-06T12:00:00Z') };
    assert.equal(mapSelectReason(row({ ...base, applyPageRepeat: 1 }), U, CTX).bucket, 'held_awaiting_reprobe');
    const listed = mapSelectReason(row({ ...base, applyPageRepeat: 2 }), U, CTX);
    assert.equal(listed.bucket, 'ready_to_apply');
    assert.ok(listed.flags.includes('no_apply_control_seen'));
    assert.equal(mapSelectReason(row({ ...base, applyPageRepeat: 1, applyPageFirstSeenAt: new Date('2026-10-01T12:00:00Z') }), U, CTX).bucket, 'ready_to_apply');
    assert.equal(mapSelectReason(row({ ...base, applyPageRepeat: 1, probeAttempts: 3 }), U, CTX).bucket, 'ready_to_apply');
  });
  test('external branch without a kept href, and an unknown probe state, are listed with flags', () => {
    assert.ok(mapSelectReason(row({ applyPageBranch: 'external' }), U, CTX).flags.includes('external_target_unknown'));
    assert.ok(mapSelectReason(row({ applyPageBranch: null }), U, CTX).flags.includes('probe_state_unknown'));
  });
  test('Indeed, Gmail final_url preferred, other sources, and no URL', () => {
    assert.equal(mapSelectReason(row({ source: 'indeed', listingUrl: 'https://www.indeed.com/viewjob?jk=abcdef12345678' }), U, CTX).channel, 'indeed_page');
    const g = mapSelectReason(row({ source: 'gmail', listingUrl: 'https://t.ladders.co/f/a', gmailFinalUrl: 'https://careers.acme.com/j/2' }), U, CTX);
    assert.equal(g.channel, 'listing_page');
    assert.equal(g.link, 'https://careers.acme.com/j/2');
    assert.equal(mapSelectReason(row({ source: 'dice', listingUrl: 'https://www.dice.com/job/1' }), U, CTX).channel, 'listing_page');
    assert.equal(mapSelectReason(row({ source: 'dice', listingUrl: null, sourceUrl: null }), U, CTX).bucket, 'held_no_link');
  });
});

describe('classifyRows post-mapping rules', () => {
  const EXCL = { blockedCompanies: ['Immunotec', 'Advisicon'], appliedHistory: [] };
  /** @param {any[]} rows @param {(r: any) => string} reasonOf @param {Record<string, unknown>} [extra] */
  const run = (rows, reasonOf, extra = {}) => classifyRows(rows, { classify: async (r) => reasonOf(r), ctx: { ...CTX, ...extra }, exclusionConfig: EXCL, locks: [] });

  test('bucket counts sum to the total and every row has exactly one bucket', async () => {
    const reasons = [...CLOSED_REASONS, 'mystery'];
    const rows = reasons.map((reason, i) => row({ listingId: i + 1, titleNorm: `t${i}`, companyNorm: `c${i}`, manualApplyUrl: `https://careers.c${i}.com/j/1`, _reason: reason }));
    const res = await run(rows, (r) => r._reason);
    const sum = Object.values(res.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, rows.length);
    assert.equal(res.rows.length, rows.length);
    for (const r of res.rows) assert.ok(READY_BUCKETS.includes(r.bucket));
  });

  test('a classify error maps to held_unknown with the error code, never vanishing', async () => {
    const res = await classifyRows([row()], { classify: async () => { throw Object.assign(new Error('boom'), { code: 'DB' }); }, ctx: CTX, exclusionConfig: EXCL, locks: [] });
    assert.equal(res.rows[0].bucket, 'held_unknown');
    assert.match(res.rows[0].reason, /^classify_error:/);
  });

  test('A3: a blocked employer in the manual link or Gmail final URL host is excluded_blocked_company with no link', async () => {
    const res = await run([
      row({ listingId: 1, manualApplyUrl: 'https://immunotec.wd5.myworkdayjobs.com/x' }),
      row({ listingId: 2, source: 'gmail', gmailFinalUrl: 'https://jobs.advisicon.com/1', titleNorm: 'other' }),
    ], () => 'apply_target_unresolved');
    assert.deepEqual(res.rows.map((r) => r.bucket), ['excluded_blocked_company', 'excluded_blocked_company']);
    assert.equal(res.rows[0].link, null);
  });

  test('A9 age-out: a listed row first seen more than 21 days ago is excluded_stale', async () => {
    const res = await run([row({ firstSeen: new Date('2026-09-10T12:00:00Z'), manualApplyUrl: 'https://careers.acme.com/j' })], () => 'apply_target_unresolved');
    assert.equal(res.rows[0].bucket, 'excluded_stale');
  });

  test('A8: an unsafe link holds the row without its link; a missing link is held_no_link', async () => {
    const res = await run([
      row({ listingId: 1, manualApplyUrl: 'https://bit.ly/abc' }),
      row({ listingId: 2, titleNorm: 'x', manualApplyUrl: 'https://careers.acme.com/unsubscribe' }),
    ], () => 'apply_target_unresolved');
    assert.equal(res.rows[0].bucket, 'held_unsafe_link');
    assert.equal(res.rows[0].link, null);
    assert.equal(res.rows[1].bucket, 'held_unsafe_link');
  });

  test('A9 drift breaker: over 40% of probed LinkedIn rows on no_control holds them as held_markup_drift', async () => {
    const rows = [];
    for (let i = 1; i <= 6; i++) rows.push(row({ listingId: i, titleNorm: `t${i}`, applyPageBranch: i <= 3 ? 'no_control' : 'easy_apply', applyPageRepeat: 5 }));
    const res = await run(rows, (r) => (r.applyPageBranch === 'no_control' ? 'apply_target_unresolved' : 'easy_apply_assisted'));
    assert.equal(res.drift.tripped, true);
    assert.deepEqual(res.rows.filter((r) => r.bucket === 'held_markup_drift').map((r) => r.listingId), [1, 2, 3]);
    const calm = await run(rows.slice(2), (r) => (r.applyPageBranch === 'no_control' ? 'apply_target_unresolved' : 'easy_apply_assisted'));
    assert.equal(calm.drift.tripped, false, '1 of 4 is under the floor (min rows 5) and under 40%');
  });

  test('R2/A7 dedup: same company, title, and link collapse with also_on; placeholders and different locations without a shared link do not', async () => {
    const res = await run([
      row({ listingId: 1, fitScore: 90, source: 'linkedin', manualApplyUrl: 'https://careers.acme.com/j/1' }),
      row({ listingId: 2, fitScore: 85, source: 'indeed', listingUrl: 'https://www.indeed.com/viewjob?jk=abcdef12345678', locationNorm: 'state-tx' }),
      row({ listingId: 3, fitScore: 84, source: 'indeed', listingUrl: 'https://www.indeed.com/viewjob?jk=abcdef99999999', locationNorm: 'state-ca' }),
      row({ listingId: 4, fitScore: 83, company: 'Confidential', companyNorm: 'confidential:x', manualApplyUrl: 'https://careers.z.com/1' }),
      row({ listingId: 5, fitScore: 82, company: 'Confidential', companyNorm: 'confidential:x', manualApplyUrl: 'https://careers.z.com/2' }),
    ], (r) => (r.source === 'indeed' ? 'apply_target_unresolved' : 'apply_target_unresolved'));
    const by = Object.fromEntries(res.rows.map((r) => [r.listingId, r]));
    assert.equal(by[1].bucket, 'ready_to_apply');
    assert.deepEqual(by[1].alsoOn, ['indeed']);
    assert.equal(by[2].bucket, 'excluded_duplicate');
    assert.equal(by[3].bucket, 'ready_to_apply', 'different location and link: kept');
    assert.equal(by[4].bucket, 'ready_to_apply');
    assert.equal(by[5].bucket, 'ready_to_apply', 'placeholder companies never collapse');
  });

  test('R3: a ready row without a description is listed with resume eligibility false', async () => {
    const res = await run([row({ description: 'short', manualApplyUrl: 'https://careers.acme.com/j' })], () => 'apply_target_unresolved');
    assert.equal(res.rows[0].bucket, 'ready_to_apply');
    assert.equal(res.rows[0].resumeEligible, false);
  });

  test('ready rows sort by fit desc, then first_listed_at, then id; isListedBucket covers ready and held only', async () => {
    const res = await run([
      row({ listingId: 3, fitScore: 70, titleNorm: 'a', manualApplyUrl: 'https://a.com/1' }),
      row({ listingId: 2, fitScore: 90, titleNorm: 'b', manualApplyUrl: 'https://b.com/1' }),
      row({ listingId: 1, fitScore: 70, titleNorm: 'c', manualApplyUrl: 'https://c.com/1' }),
    ], () => 'apply_target_unresolved');
    assert.deepEqual(res.ready.map((r) => r.listingId), [2, 1, 3]);
    assert.equal(isListedBucket('ready_to_apply'), true);
    assert.equal(isListedBucket('held_unknown'), true);
    assert.equal(isListedBucket('excluded_stale'), false);
    assert.equal(isListedBucket('auto_submit_path'), false);
  });
});
