// @ts-check
/**
 * Chip/badge totality tests (pr3-spec-decisions.md section 12 item 5): iterate the REAL source lists
 * from src/core/statuses.js, src/core/events.js, and src/core/documents.js -- never a locally
 * re-declared copy -- and assert components/chips.js (the browser-side, hand-maintained mirror) returns
 * a defined {label, fg, bg, style} for every one of them, plus null/unrecognized-value fallbacks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_STATUSES } from '../src/core/statuses.js';
import { EVENT_ACTORS } from '../src/core/events.js';
import { DOCUMENT_KINDS } from '../src/core/documents.js';
import { stageChip, actorBadge, documentChip, sourceChip, runStatusChip, runItemOutcomeChip, chipClassName } from '../src/dashboard/public/components/chips.js';

function assertChipShape(chip, ctx) {
  assert.equal(typeof chip, 'object', ctx);
  assert.notEqual(chip, null, ctx);
  assert.equal(typeof chip.label, 'string', `${ctx}: label`);
  assert.equal(typeof chip.fg, 'string', `${ctx}: fg`);
  assert.equal(typeof chip.bg, 'string', `${ctx}: bg`);
  assert.ok(chip.style === 'outline' || chip.style === 'filled', `${ctx}: style`);
}

describe('stageChip(): totality over every real PIPELINE_STATUSES value plus null', () => {
  test('every real status returns a defined chip', () => {
    for (const status of [...PIPELINE_STATUSES, null]) {
      assertChipShape(stageChip(status), `status=${status}`);
    }
  });

  test('an unrecognized status still returns a defined fallback, never undefined', () => {
    assertChipShape(stageChip('some-future-status'), 'unrecognized status');
  });
});

describe('actorBadge(): totality over every real EVENT_ACTORS value, including migration', () => {
  test('every real actor returns a defined badge', () => {
    assert.ok(EVENT_ACTORS.includes('migration'), 'sanity: migration must be a real actor for this test to mean anything');
    for (const actor of EVENT_ACTORS) {
      assertChipShape(actorBadge(actor), `actor=${actor}`);
    }
  });

  test('an unrecognized actor still returns a defined fallback', () => {
    assertChipShape(actorBadge('some-future-actor'), 'unrecognized actor');
  });
});

describe('documentChip(): totality over every real DOCUMENT_KINDS value, including other', () => {
  test('every real kind returns a defined chip', () => {
    assert.ok(DOCUMENT_KINDS.includes('other'), 'sanity: other must be a real kind for this test to mean anything');
    for (const kind of DOCUMENT_KINDS) {
      assertChipShape(documentChip(kind), `kind=${kind}`);
    }
  });
});

describe('sourceChip(): the seven known analytics sources plus a defined fallback (section 9 item 17)', () => {
  test('every known source maps to a defined color', () => {
    for (const source of ['greenhouse', 'lever', 'linkedin', 'indeed', 'builtin', 'ziprecruiter', 'manual']) {
      assertChipShape(sourceChip(source), `source=${source}`);
    }
  });

  test('a synthetic unrecognized source maps to the defined fallback, never undefined reaching a DOM attribute', () => {
    const chip = sourceChip('some-new-board');
    assertChipShape(chip, 'unrecognized source');
    assert.equal(chip.fg, '--muted-2');
  });
});

describe('runStatusChip(): the five DB CHECK statuses, the CANCELLED derivation, and an unknown fallback', () => {
  test('failed with a CANCELLED error entry maps to Canceled', () => {
    const chip = runStatusChip({ status: 'failed', errors: [{ code: 'CANCELLED' }] });
    assert.equal(chip.label, 'Canceled');
  });

  test('failed with an empty or unrelated errors array maps to plain Failed', () => {
    assert.equal(runStatusChip({ status: 'failed', errors: [] }).label, 'Failed');
    assert.equal(runStatusChip({ status: 'failed', errors: [{ code: 'OTHER' }] }).label, 'Failed');
    assert.equal(runStatusChip({ status: 'failed' }).label, 'Failed');
  });

  test('the remaining known DB statuses (ok, partial, running, locked) all return defined chips', () => {
    for (const status of ['ok', 'partial', 'running', 'locked']) {
      assertChipShape(runStatusChip({ status }), `status=${status}`);
    }
  });

  test('a value outside the five known DB statuses maps to a defined Unknown fallback, never throws', () => {
    assert.doesNotThrow(() => runStatusChip({ status: 'some-future-status' }));
    const chip = runStatusChip({ status: 'some-future-status' });
    assertChipShape(chip, 'unrecognized run status');
    assert.equal(chip.label, 'Unknown');
  });
});

describe('runItemOutcomeChip(): the real ic_scan_run_items.outcome CHECK constraint values', () => {
  test('every real outcome value (sql/003_scan_runs.sql) returns a defined chip', () => {
    // Not imported from a core/*.js module: outcome is a DB-level CHECK constraint string, not exported
    // as a JS constant anywhere in src/core/. This closed list is transcribed directly from
    // sql/003_scan_runs.sql's CHECK clause, found to differ from the design doc's inserted/seen/review/
    // noise labels while seeding fixture data for the Playwright screenshot pass.
    for (const outcome of ['new', 'update', 'cross_source_dup', 'repost', 'ambiguous']) {
      assertChipShape(runItemOutcomeChip(outcome), `outcome=${outcome}`);
    }
  });

  test('an unrecognized outcome still returns a defined fallback, never undefined', () => {
    assertChipShape(runItemOutcomeChip('some-future-outcome'), 'unrecognized outcome');
  });
});

describe('chipClassName(): turns a chip tuple into a stable, predictable class string', () => {
  test('slugs the fg/bg token names and includes the style modifier', () => {
    const cls = chipClassName({ label: 'x', fg: '--purple', bg: '--purple-dim', style: 'outline' });
    assert.equal(cls, 'chip chip--outline fg-purple bg-purple-dim');
  });
});
