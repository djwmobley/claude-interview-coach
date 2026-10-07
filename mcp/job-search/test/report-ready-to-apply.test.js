// @ts-check
/**
 * Report section "Ready to apply" (spec section 8, R4, R5, A8, A9; T12): always rendered (empty, error,
 * populated, disabled), ready rows capped with "and N more", held rows shown without unsafe links, links
 * escaped in HTML with rel="noopener noreferrer", host shown as text, an external career-site link
 * rendered even though it fails the source-domain registry, the markup-drift headline, the review verdict
 * on the resume line, the subject's "ready N" part, and the R5 pointers replacing the old lists.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderReadyToApplyText, renderReadyToApplyHtml, renderReadyToApplyMarkdown, buildReportSubject, gmailManualApplyLines,
  renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown,
} from '../src/core/report.js';

/** Built from its code point so this file itself carries no em-dash (the repo-wide lint). */
const EM_DASH_RE = new RegExp(String.fromCharCode(0x2014));

/** @param {Partial<any>} o */
function readyRow(o = {}) {
  return {
    listingId: 11, fit: 86, title: 'VP Digital Transformation', company: 'Acme Corp', channelLabel: 'company site', alsoOn: ['indeed'],
    link: 'https://careers.acme.com/jobs/123?a=1&b=<x>', host: 'careers.acme.com', isNew: true, flags: [],
    resume: { status: 'ready', relPath: 'resumes/Damian Mobley - VP Digital Transformation.docx', verdict: 'PASS', lastError: null, eligible: true },
    ...o,
  };
}

const DATA = {
  enabled: true,
  autoSubmitCount: 3,
  counts: { ready: 3, held: 2, excluded: 5 },
  resumeCounts: { ready: 1, pending: 1, failed: 0, gaveUp: 0, noDescription: 1 },
  ready: [
    readyRow(),
    readyRow({ listingId: 12, fit: 82, title: 'CTO', company: 'Beta', channelLabel: 'Indeed', alsoOn: [], link: 'https://www.indeed.com/viewjob?jk=abc', host: 'www.indeed.com', isNew: false, resume: { status: 'queued', relPath: null, verdict: null, lastError: null, eligible: true } }),
    readyRow({ listingId: 13, fit: 70, title: 'CIO', company: 'Gamma', resume: { status: 'failed', relPath: 'resumes/x.docx', verdict: 'FAIL', lastError: 'review_failed', eligible: true } }),
  ],
  held: [
    { listingId: 21, fit: 78, title: 'COO', company: 'Delta', bucketLabel: 'awaiting re-probe (no Apply button seen once)', link: 'https://www.linkedin.com/jobs/view/21', host: 'www.linkedin.com', applicationId: null },
    { listingId: 22, fit: 74, title: 'CDO', company: 'Eps', bucketLabel: 'unsafe link withheld', link: null, host: null, applicationId: null },
  ],
  excludedCounts: { duplicate: 2, blocked_company: 1, stale: 2 },
  drift: { tripped: true, driftRows: 6, probedRows: 10 },
  dashboardUrl: 'http://127.0.0.1:7311/#/ready',
  maxRows: 2,
  heldMaxRows: 20,
};

describe('renderReadyToApply*', () => {
  test('text: header, counts line, numbered rows, apply link with host, resume line with verdict, cap, held, excluded', () => {
    const t = renderReadyToApplyText(DATA);
    assert.match(t, /== Ready to apply \(3\) ==/);
    assert.match(t, /auto-submit path 3 \| ready 3 \| held 2 \| excluded 5 \| resumes ready 1, pending 1, failed 0, gave up 0, no description 1/);
    assert.match(t, /\[MARKUP DRIFT\] 6 of 10 probed LinkedIn pages showed no Apply control/);
    assert.match(t, / 1\. \[fit 86\] VP Digital Transformation \| Acme Corp \| company site, also on indeed \| careers\.acme\.com \| NEW/);
    assert.match(t, /apply: https:\/\/careers\.acme\.com\/jobs\/123/);
    assert.match(t, /resume: output\/resumes\/Damian Mobley - VP Digital Transformation\.docx \(review PASS\)/);
    assert.match(t, /resume: pending/);
    assert.doesNotMatch(t, /CIO \| Gamma/, 'third row is past the cap');
    assert.match(t, /and 1 more on the dashboard/);
    assert.match(t, /dashboard: http:\/\/127\.0\.0\.1:7311\/#\/ready/);
    assert.match(t, /-- Held \(2\) --/);
    assert.match(t, /CDO \| Eps \| unsafe link withheld$/m);
    assert.match(t, /-- Excluded \(5\) -- duplicate 2, blocked_company 1, stale 2/);
    assert.equal(EM_DASH_RE.test(t), false);
  });

  test('html: escaped anchors with rel=noopener noreferrer, host as text, never an anchor for a withheld link', () => {
    const h = renderReadyToApplyHtml(DATA);
    assert.match(h, /<a href="https:\/\/careers\.acme\.com\/jobs\/123\?a=1&amp;b=&lt;x&gt;" rel="noopener noreferrer">/);
    assert.match(h, /careers\.acme\.com/);
    assert.doesNotMatch(h, /<x>/);
    assert.match(h, /<ol>/);
    assert.equal(EM_DASH_RE.test(h), false);
  });

  test('markdown renders the same rows', () => {
    const m = renderReadyToApplyMarkdown(DATA);
    assert.match(m, /## Ready to apply \(3\)/);
    assert.match(m, /VP Digital Transformation/);
    assert.match(m, /and 1 more on the dashboard/);
  });

  test('always rendered: empty, error, disabled', () => {
    const empty = { ...DATA, ready: [], held: [], counts: { ready: 0, held: 0, excluded: 0 }, drift: { tripped: false, driftRows: 0, probedRows: 0 } };
    assert.match(renderReadyToApplyText(empty), /== Ready to apply \(0\) ==[\s\S]*\(none\)/);
    const err = { error: 'database down' };
    assert.match(renderReadyToApplyText(err), /== Ready to apply ==\n\[READY LIST ERROR\]: database down/);
    assert.match(renderReadyToApplyHtml(err), /\[READY LIST ERROR\]: database down/);
    assert.match(renderReadyToApplyMarkdown(err), /\[READY LIST ERROR\]: database down/);
    assert.match(renderReadyToApplyText({ enabled: false }), /disabled in config/);
  });

  test('a failed review shows on the resume line (A10)', () => {
    const t = renderReadyToApplyText({ ...DATA, maxRows: 10 });
    assert.match(t, /resume: review FAIL \(review_failed\), will retry/);
  });
});

describe('subject and R5 pointers', () => {
  test('subject gains "ready N"', () => {
    const data = /** @type {any} */ ({ dayKey: '2026-10-07', runs: [], noScan: false, worstStatus: 'ok', lookAtThese: { rows: [] }, reviewQueue: { total: 0 } });
    assert.match(buildReportSubject(data, { readyCount: 7 }), /ready 7/);
    assert.doesNotMatch(buildReportSubject(data, {}), /ready/);
    assert.match(buildReportSubject(data, { readyCount: 1, readyDrift: true }), /^\[MARKUP DRIFT\] /);
  });

  test('the Gmail hand-apply list is a pointer to the Ready section', () => {
    const lines = gmailManualApplyLines([{ id: 5, title: 'CTO', company: 'Acme', fit: 72, link: 'https://x.example.com', outcome: 'denied_apply_link' }]);
    assert.match(lines.join('\n'), /Gmail jobs to apply to by hand: 1; see Ready to apply/);
    assert.doesNotMatch(lines.join('\n'), /x\.example\.com/);
    assert.deepEqual(gmailManualApplyLines([]), []);
  });

  test('the auto-apply unresolved list is a pointer to the Ready section in every format', () => {
    const data = { hasRun: true, dryRun: false, appliedCount: 0, cappedCount: 0, capUsed: 0, capRemaining: 5, skippedByReason: {},
      unresolved: [{ id: 10, title: 'CTO', company: 'Acme', source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/10/', linkedinDeepLink: 'https://www.linkedin.com/jobs/view/10/' }] };
    for (const out of [renderAutoApplyText(data), renderAutoApplyHtml(data), renderAutoApplyMarkdown(data)]) {
      assert.match(out, /unresolved apply targets: 1; see Ready to apply/);
      assert.doesNotMatch(out, /jobs\/view\/10/);
    }
  });
});
