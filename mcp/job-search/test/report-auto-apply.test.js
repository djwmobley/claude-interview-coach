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
