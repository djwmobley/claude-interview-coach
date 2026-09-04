// @ts-check
/**
 * src/core/report.js's auto-apply section (auto-apply PR B, GAP 2 update): collectAutoApply + the three
 * renderers now ALWAYS render a section -- a missing/absent run renders a distinct "no run recorded"
 * empty state rather than being omitted (docs/auto-apply-spec.md section 9).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAutoApply, renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown,
} from '../src/core/report.js';
import { registryFrom } from '../src/core/urlguard.js';

const REGISTRY = registryFrom([{ source: 'linkedin', domains: ['linkedin.com'], pathPatterns: ['^/jobs/view/'] }]);

function fakeClient(rows) {
  return { async query() { return { rows }; } };
}

describe('collectAutoApply: no run today', () => {
  test('no summary at all -> { hasRun: false }, no DB query', async () => {
    let queried = false;
    const client = { async query() { queried = true; return { rows: [] }; } };
    assert.deepEqual(await collectAutoApply(client, null), { hasRun: false });
    assert.deepEqual(await collectAutoApply(client, undefined), { hasRun: false });
    assert.equal(queried, false);
  });

  test('a summary with no results/applied at all still renders zeros, no DB query needed', async () => {
    let queried = false;
    const client = { async query() { queried = true; return { rows: [] }; } };
    const data = await collectAutoApply(client, { select: { results: [] }, applied: [] });
    assert.equal(data.hasRun, true);
    assert.equal(data.appliedCount, 0);
    assert.equal(data.cappedCount, 0);
    assert.deepEqual(data.skippedByReason, {});
    assert.equal(data.unresolved.length, 0);
    assert.equal(queried, false); // no unresolved ids -> no listing lookup query at all
  });
});

describe('collectAutoApply: real data', () => {
  test('counts applied, capped, and skip reasons; looks up only unresolved/easy-apply listings', async () => {
    const client = fakeClient([
      { id: 10, title: 'CTO', company: 'Acme', source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/10/', url_normalized: null },
      { id: 20, title: 'CIO', company: 'Beta', source: 'exec:board', url: 'https://execboard.example.com/jobs/20', url_normalized: null },
    ]);
    const summary = {
      dry_run: false,
      select: {
        results: [
          { listingId: 1, reason: 'eligible' },
          { listingId: 2, reason: 'below_fit' },
          { listingId: 3, reason: 'daily_cap' },
          { listingId: 4, reason: 'daily_cap' },
          { listingId: 10, reason: 'apply_target_unresolved' },
          { listingId: 20, reason: 'easy_apply_only' },
        ],
        cap_used: 3,
        cap_remaining: 2,
      },
      applied: [{ listingId: 1, applicationId: 100, outcome: 'applied' }],
    };
    const data = await collectAutoApply(client, summary);
    assert.equal(data.hasRun, true);
    assert.equal(data.appliedCount, 1);
    assert.equal(data.cappedCount, 2);
    assert.equal(data.capUsed, 3);
    assert.equal(data.capRemaining, 2);
    assert.deepEqual(data.skippedByReason, { below_fit: 1, daily_cap: 2, apply_target_unresolved: 1, easy_apply_only: 1 });
    assert.equal(data.unresolved.length, 2);
    const linkedin = data.unresolved.find((u) => u.id === 10);
    assert.equal(linkedin.linkedinDeepLink, 'https://www.linkedin.com/jobs/view/10/');
    const execBoard = data.unresolved.find((u) => u.id === 20);
    assert.equal(execBoard.linkedinDeepLink, null);
  });
});

describe('renderers: never omit the section, even with no run today', () => {
  test('every renderer returns a non-empty "no run recorded" section, never null/empty', () => {
    for (const [render, marker] of [
      [renderAutoApplyText, 'no auto-apply run recorded today'],
      [renderAutoApplyHtml, 'no auto-apply run recorded today'],
      [renderAutoApplyMarkdown, 'no auto-apply run recorded today'],
    ]) {
      for (const input of [null, undefined, { hasRun: false }]) {
        const out = render(input);
        assert.equal(typeof out, 'string');
        assert.ok(out.length > 0);
        assert.match(out, new RegExp(marker));
      }
    }
  });
});

describe('renderers: unresolved link only passes when it clears the registry', () => {
  const DATA = {
    hasRun: true,
    dryRun: false,
    appliedCount: 1,
    cappedCount: 0,
    capUsed: 1,
    capRemaining: 4,
    skippedByReason: { not_us: 1 },
    unresolved: [
      { id: 10, title: 'CTO', company: 'Acme', source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/10/', linkedinDeepLink: 'https://www.linkedin.com/jobs/view/10/' },
      { id: 20, title: 'CIO', company: 'Beta', source: 'exec:board', url: 'https://not-registered.example.com/jobs/20', linkedinDeepLink: null },
    ],
  };

  test('text: the LinkedIn link renders (registry match), the unregistered host does not', () => {
    const text = renderAutoApplyText(DATA, REGISTRY);
    assert.match(text, /linkedin: https:\/\/www\.linkedin\.com\/jobs\/view\/10\//);
    assert.doesNotMatch(text, /not-registered\.example\.com/);
    assert.match(text, /applied 1/);
    assert.match(text, /skipped: not_us=1/);
  });

  test('html: the LinkedIn link renders as an anchor, escaped', () => {
    const html = renderAutoApplyHtml(DATA, REGISTRY);
    assert.match(html, /<a href="https:\/\/www\.linkedin\.com\/jobs\/view\/10\/">/);
    assert.doesNotMatch(html, /not-registered\.example\.com/);
  });

  test('markdown: the LinkedIn link renders, the unregistered host does not', () => {
    const md = renderAutoApplyMarkdown(DATA, REGISTRY);
    assert.match(md, /\(linkedin: https:\/\/www\.linkedin\.com\/jobs\/view\/10\/\)/);
    assert.doesNotMatch(md, /not-registered\.example\.com/);
  });

  test('with no registry at all, nothing passes (fails closed, never renders an unchecked link)', () => {
    const text = renderAutoApplyText(DATA);
    assert.doesNotMatch(text, /https:\/\//);
  });
});

describe('collectAutoApply: a mid-run summary (phase set, not yet done) renders as in-progress (spec amendment A2)', () => {
  test('phase="waiting" with no select/applied data at all never reads as a completed zero-result run', async () => {
    let queried = false;
    const client = { async query() { queried = true; return { rows: [] }; } };
    const data = await collectAutoApply(client, { phase: 'waiting', started_at: '2026-09-04T11:55:00.000Z' });
    assert.equal(data.hasRun, true);
    assert.equal(data.inProgress, true);
    assert.equal(data.phase, 'waiting');
    assert.equal(data.startedAt, '2026-09-04T11:55:00.000Z');
    assert.equal(queried, false);
  });

  test('phase="preparing"/"selecting"/"applying" all read as in-progress; phase="done" does not', async () => {
    const client = { async query() { return { rows: [] }; } };
    for (const phase of ['preparing', 'selecting', 'applying']) {
      const data = await collectAutoApply(client, { phase, select: { results: [] }, applied: [] });
      assert.equal(data.inProgress, true, phase);
      assert.equal(data.phase, phase);
    }
    const done = await collectAutoApply(client, { phase: 'done', select: { results: [] }, applied: [] });
    assert.equal(/** @type {any} */ (done).inProgress, undefined);
    assert.equal(done.hasRun, true);
  });

  test('a summary with NO phase field at all (every summary written before this fix) is never treated as in-progress', async () => {
    const client = { async query() { return { rows: [] }; } };
    const data = await collectAutoApply(client, { select: { results: [] }, applied: [] });
    assert.equal(/** @type {any} */ (data).inProgress, undefined);
    assert.equal(data.hasRun, true);
    assert.equal(data.appliedCount, 0);
  });

  test('every renderer produces a distinct in-progress line, never the "no run recorded" or a fabricated zero-result line', () => {
    const inProgress = { hasRun: true, inProgress: true, phase: 'preparing', startedAt: '2026-09-04T11:55:00.000Z' };
    for (const render of [renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown]) {
      const out = render(inProgress);
      assert.match(out, /in progress/i);
      assert.match(out, /preparing/);
      assert.doesNotMatch(out, /no auto-apply run recorded today/);
    }
  });
});

describe('collectAutoApply/renderers: warnings render in the fixed order (spec amendment A7)', () => {
  const BASE_SUMMARY = {
    phase: 'done',
    select: { results: [{ listingId: 1, reason: 'eligible' }], cap_used: 0, cap_remaining: 4, dailyCap: 5 },
    applied: [],
  };

  test('warnings pushed out of order still render SCAN_NOT_FINISHED, SCAN_STILL_RUNNING_AT_DEADLINE, SCAN_FAILED, SCAN_STATE_UNKNOWN, CHROME_LAUNCH_FAILED in that fixed order', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = {
      ...BASE_SUMMARY,
      warnings: [
        { code: 'CHROME_LAUNCH_FAILED', severity: 'warning' },
        { code: 'SCAN_STATE_UNKNOWN', severity: 'warning' },
        { code: 'SCAN_FAILED', severity: 'warning' },
        { code: 'SCAN_NOT_FINISHED', severity: 'warning' },
      ],
    };
    const data = await collectAutoApply(client, summary);
    assert.deepEqual(data.warnings.map((w) => w.code), ['SCAN_NOT_FINISHED', 'SCAN_FAILED', 'SCAN_STATE_UNKNOWN', 'CHROME_LAUNCH_FAILED']);
    const text = renderAutoApplyText(data);
    const iNotFinished = text.indexOf('SCAN_NOT_FINISHED');
    const iFailed = text.indexOf('SCAN_FAILED');
    const iUnknown = text.indexOf('SCAN_STATE_UNKNOWN');
    const iChrome = text.indexOf('CHROME_LAUNCH_FAILED');
    assert.ok(iNotFinished < iFailed && iFailed < iUnknown && iUnknown < iChrome, text);
  });

  test('an unrecognized warning code is never dropped -- it renders after every known code', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = {
      ...BASE_SUMMARY,
      warnings: [{ code: 'SOMETHING_NEW', severity: 'warning' }, { code: 'SCAN_FAILED', severity: 'warning' }],
    };
    const data = await collectAutoApply(client, summary);
    assert.deepEqual(data.warnings.map((w) => w.code), ['SCAN_FAILED', 'SOMETHING_NEW']);
  });

  test('no warnings at all renders cleanly, no throw', async () => {
    const client = { async query() { return { rows: [] }; } };
    const data = await collectAutoApply(client, BASE_SUMMARY);
    assert.deepEqual(data.warnings, []);
    for (const render of [renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown]) {
      assert.doesNotThrow(() => render(data));
    }
  });
});

describe('collectAutoApply/renderers: the funnel line (spec amendment A5/A7)', () => {
  test('collectAutoApply passes summary.select.funnel and dailyCap through untouched', async () => {
    const client = { async query() { return { rows: [] }; } };
    const funnel = {
      considered: 10, exclusions: 9, fit: 7, duplicate_of: 7, not_us: 6, salary_below_floor: 6,
      active_application: 6, no_description: 6, easy_apply_only: 6, apply_target_unresolved: 5,
      ats_not_allowed: 5, confidence_not_exact: 5, hourly_pay: 4, eligible: 4,
    };
    const summary = { phase: 'done', select: { results: [], cap_used: 0, cap_remaining: 5, dailyCap: 5, funnel }, applied: [] };
    const data = await collectAutoApply(client, summary);
    assert.deepEqual(data.funnel, funnel);
    assert.equal(data.dailyCap, 5);
  });

  test('the rendered funnel line walks every gate in order and ends with "applied N of cap M"', async () => {
    const client = { async query() { return { rows: [] }; } };
    const funnel = {
      considered: 10, exclusions: 9, fit: 7, duplicate_of: 7, not_us: 6, salary_below_floor: 6,
      active_application: 6, no_description: 6, easy_apply_only: 6, apply_target_unresolved: 5,
      ats_not_allowed: 5, confidence_not_exact: 5, hourly_pay: 4, eligible: 4,
    };
    const summary = { phase: 'done', select: { results: [{ listingId: 1, reason: 'eligible' }], cap_used: 0, cap_remaining: 4, dailyCap: 5, funnel }, applied: [{ listingId: 1, outcome: 'applied' }] };
    const data = await collectAutoApply(client, summary);
    const text = renderAutoApplyText(data);
    assert.match(text, /funnel: considered 10 > exclusions 9 > fit 7 > duplicate_of 7 > not_us 6 > salary_below_floor 6 > active_application 6 > no_description 6 > easy_apply_only 6 > apply_target_unresolved 5 > ats_not_allowed 5 > confidence_not_exact 5 > hourly_pay 4 > eligible 4, applied 1 of cap 5/);
    // Same content reaches markdown and (escaped) html.
    assert.match(renderAutoApplyMarkdown(data), /funnel: considered 10 > exclusions 9/);
    assert.match(renderAutoApplyHtml(data), /funnel: considered 10 &gt; exclusions 9|funnel: considered 10 > exclusions 9/);
  });

  test('no funnel on the summary: the line is simply omitted, never a throw or a fabricated funnel', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = { phase: 'done', select: { results: [], cap_used: 0, cap_remaining: 5 }, applied: [] };
    const data = await collectAutoApply(client, summary);
    assert.equal(data.funnel, null);
    const text = renderAutoApplyText(data);
    assert.doesNotMatch(text, /funnel:/);
  });
});

describe('renderers: prepare-phase stats line (spec amendment A7)', () => {
  test('probed/resolved/unresolved/skipped-by-reason and stopped_by all render', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = {
      phase: 'done',
      prepare: { attempted: 8, resolved: 3, unresolved: 2, skipped: 3, skippedByReason: { no_browser: 2, hourly_pay: 1 }, stoppedBy: 'time_budget', remaining: 5 },
      select: { results: [], cap_used: 0, cap_remaining: 5 },
      applied: [],
    };
    const data = await collectAutoApply(client, summary);
    const text = renderAutoApplyText(data);
    assert.match(text, /prepare: probed 8, resolved 3, unresolved 2, skipped 3 \(no_browser=2, hourly_pay=1\), stopped_by=time_budget remaining=5/);
  });

  test('no prepare stats on the summary (still-running-at-deadline path): the line is simply omitted', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = { phase: 'done', select: { results: [], cap_used: 0, cap_remaining: 5 }, applied: [] };
    const data = await collectAutoApply(client, summary);
    assert.equal(data.prepare, null);
    assert.doesNotMatch(renderAutoApplyText(data), /prepare:/);
  });
});

describe('collectAutoApply/renderers: report_renders_locked_and_error_outcomes_as_warnings (runLifecycle fix)', () => {
  test('outcome "locked" (phase done) renders as [AUTO-APPLY LOCKED], never in-progress and never a quiet zero-result completion', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = { phase: 'done', ok: false, outcome: 'locked', select: null, applied: [] };
    const data = await collectAutoApply(client, summary);
    assert.equal(data.hasRun, true);
    assert.equal(/** @type {any} */ (data).outcome, 'locked');
    assert.equal(/** @type {any} */ (data).inProgress, undefined);
    for (const render of [renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown]) {
      const out = render(data);
      assert.match(out, /AUTO-APPLY LOCKED/);
      assert.doesNotMatch(out, /in progress/i);
      assert.doesNotMatch(out, /no auto-apply run recorded today/);
      assert.doesNotMatch(out, /applied 0/); // never rendered as a completed zero-result run
    }
  });

  test('outcome "error" (phase done) renders as [AUTO-APPLY ERROR] with the message, never in-progress or a quiet completion', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = { phase: 'done', ok: false, outcome: 'error', error: { message: 'boom: something threw', code: null }, select: null, applied: [] };
    const data = await collectAutoApply(client, summary);
    assert.equal(data.hasRun, true);
    assert.equal(/** @type {any} */ (data).outcome, 'error');
    assert.deepEqual(/** @type {any} */ (data).error, { message: 'boom: something threw', code: null });
    for (const render of [renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown]) {
      const out = render(data);
      assert.match(out, /AUTO-APPLY ERROR/);
      assert.match(out, /boom: something threw/);
      assert.doesNotMatch(out, /in progress/i);
      assert.doesNotMatch(out, /no auto-apply run recorded today/);
    }
  });

  test('an outcome "error" summary missing its own error object still renders cleanly with a fallback message', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = { phase: 'done', ok: false, outcome: 'error', select: null, applied: [] };
    const data = await collectAutoApply(client, summary);
    assert.equal(/** @type {any} */ (data).error, null);
    for (const render of [renderAutoApplyText, renderAutoApplyHtml, renderAutoApplyMarkdown]) {
      assert.doesNotThrow(() => render(data));
      assert.match(render(data), /unknown error/);
    }
  });

  test('outcome "ok" is unaffected -- a genuinely completed zero-result run still renders normally', async () => {
    const client = { async query() { return { rows: [] }; } };
    const summary = { phase: 'done', ok: true, outcome: 'ok', select: { results: [], cap_used: 0, cap_remaining: 5 }, applied: [] };
    const data = await collectAutoApply(client, summary);
    assert.equal(/** @type {any} */ (data).outcome, undefined); // not carried through for the normal path -- only locked/error short-circuit
    assert.equal(data.appliedCount, 0);
    assert.doesNotMatch(renderAutoApplyText(data), /AUTO-APPLY (LOCKED|ERROR)/);
  });
});
