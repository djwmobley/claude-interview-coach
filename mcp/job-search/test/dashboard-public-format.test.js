// @ts-check
/** Pure formatting function tests (pr3-spec-decisions.md section 12 item 2). No DOM required. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, ageDays, agingBucket, scoreBucket, fitBucket, fitDisplayState, shortDate, shortDateTime, salaryRange, formatMoney, pluralize, truncate, sourceLabel, formatPercent, normalizeAgendaTime, agendaTimeLabel } from '../src/dashboard/public/lib/format.js';

describe('relativeTime', () => {
  test('fixed-input cases', () => {
    const now = new Date('2026-08-27T12:00:00Z');
    assert.equal(relativeTime(null, now), 'unknown');
    assert.equal(relativeTime(undefined, now), 'unknown');
    assert.equal(relativeTime('not a date', now), 'unknown');
    assert.equal(relativeTime(new Date('2026-08-27T11:59:30Z'), now), 'just now');
    assert.equal(relativeTime(new Date('2026-08-27T11:30:00Z'), now), '30m ago');
    assert.equal(relativeTime(new Date('2026-08-27T09:00:00Z'), now), '3h ago');
    assert.equal(relativeTime(new Date('2026-08-25T12:00:00Z'), now), '2d ago');
    assert.equal(relativeTime(new Date('2026-08-27T12:30:00Z'), now), 'in 30m');
  });
});

describe('ageDays / agingBucket', () => {
  test('null and zero-clamped inputs', () => {
    const now = new Date('2026-08-27T00:00:00Z');
    assert.equal(ageDays(null, now), null);
    assert.equal(ageDays(new Date('2026-08-30T00:00:00Z'), now), 0);
    assert.equal(ageDays(new Date('2026-08-20T00:00:00Z'), now), 7);
  });

  test('bucket thresholds: under 7 / 7-14 / over 14', () => {
    assert.equal(agingBucket(null), 'fresh');
    assert.equal(agingBucket(0), 'fresh');
    assert.equal(agingBucket(6), 'fresh');
    assert.equal(agingBucket(7), 'aging');
    assert.equal(agingBucket(14), 'aging');
    assert.equal(agingBucket(15), 'stale');
  });
});

describe('scoreBucket', () => {
  test('thresholds: >=85 good, >=70 ok, else low, missing treated as low', () => {
    assert.equal(scoreBucket(null), 'low');
    assert.equal(scoreBucket(undefined), 'low');
    assert.equal(scoreBucket(69), 'low');
    assert.equal(scoreBucket(70), 'ok');
    assert.equal(scoreBucket(84), 'ok');
    assert.equal(scoreBucket(85), 'good');
    assert.equal(scoreBucket(100), 'good');
  });
});

describe('fitBucket: same thresholds as scoreBucket, but missing maps to its own neutral bucket', () => {
  test('missing/NaN maps to "not-scored", never "low"', () => {
    assert.equal(fitBucket(null), 'not-scored');
    assert.equal(fitBucket(undefined), 'not-scored');
    assert.equal(fitBucket(Number.NaN), 'not-scored');
  });

  test('thresholds match scoreBucket exactly once a real score is present', () => {
    assert.equal(fitBucket(69), 'low');
    assert.equal(fitBucket(70), 'ok');
    assert.equal(fitBucket(84), 'ok');
    assert.equal(fitBucket(85), 'good');
    assert.equal(fitBucket(100), 'good');
  });

  test('a real 0 score is "low", not "not-scored" (0 is a score, not an absence)', () => {
    assert.equal(fitBucket(0), 'low');
  });
});

describe('fitDisplayState: total classification of the fit-score DISPLAY state (jobs-unscored-visibility PR, Change 3)', () => {
  const band = { floor: 40, ceiling: 70 };

  test('rule 1: fit_score IS NOT NULL always wins, regardless of status/noise/prescore', () => {
    const r = fitDisplayState({ fit_score: 62, noise_class: 'suspect', status: 'review', prescore: 5 }, band);
    assert.equal(r.label, '62');
    assert.equal(r.bucket, fitBucket(62));
    assert.equal(r.scored, true);
  });

  test('rule 1: fit_score = 0 is shown as "0", never treated as unscored', () => {
    const r = fitDisplayState({ fit_score: 0, noise_class: 'ok', status: null, prescore: 55 }, band);
    assert.equal(r.label, '0');
    assert.equal(r.bucket, 'low');
    assert.equal(r.scored, true);
  });

  test('rule 2: noise_class not in (ok, ok_manual) -> "noise", even on a status=review row', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'aggregator_repost', status: 'review', prescore: 55 }, band);
    assert.equal(r.label, 'noise');
    assert.equal(r.bucket, 'not-scored');
    assert.equal(r.scored, false);
  });

  test('rule 2: a NULL noise_class also counts as "not ok" -> "noise"', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: null, status: null, prescore: 55 }, band);
    assert.equal(r.label, 'noise');
  });

  test('rule 3: status=review, noise ok, prescore in band -> "pending review"', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status: 'review', prescore: 55 }, band);
    assert.equal(r.label, 'pending review');
    assert.equal(r.bucket, 'not-scored');
  });

  test('rule 3: status=review, noise ok_manual, prescore at floor/ceiling boundaries -> "pending review" (inclusive both ends)', () => {
    const atFloor = fitDisplayState({ fit_score: null, noise_class: 'ok_manual', status: 'review', prescore: 40 }, band);
    const atCeiling = fitDisplayState({ fit_score: null, noise_class: 'ok_manual', status: 'review', prescore: 70 }, band);
    assert.equal(atFloor.label, 'pending review');
    assert.equal(atCeiling.label, 'pending review');
  });

  test('rule 3: status=review, noise ok, prescore NULL -> "pending review" (never a blank state, even though it will not be auto-scored -- see triage.test.js\'s review_other coverage)', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status: 'review', prescore: null }, band);
    assert.equal(r.label, 'pending review');
  });

  test('rule 3: unavailable triageBand (no config/triage.json loaded server-side) means "in-band" can never be proven -- a NULL prescore still shows "pending review", a known prescore falls to "below floor"', () => {
    const nullPrescore = fitDisplayState({ fit_score: null, noise_class: 'ok', status: 'review', prescore: null }, null);
    assert.equal(nullPrescore.label, 'pending review');
    const knownPrescore = fitDisplayState({ fit_score: null, noise_class: 'ok', status: 'review', prescore: 55 }, null);
    assert.equal(knownPrescore.label, 'below floor');
    const undefinedBand = fitDisplayState({ fit_score: null, noise_class: 'ok', status: 'review', prescore: 55 }, undefined);
    assert.equal(undefinedBand.label, 'below floor');
  });

  test('rule 4: status=review, noise ok, prescore below floor -> "below floor"', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status: 'review', prescore: 20 }, band);
    assert.equal(r.label, 'below floor');
    assert.equal(r.bucket, 'not-scored');
  });

  test('rule 4: status=review, noise ok, prescore above ceiling -> "below floor" (the catch-all bucket, not literally "above ceiling")', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status: 'review', prescore: 95 }, band);
    assert.equal(r.label, 'below floor');
  });

  test('rule 4: status=null (untriaged, never reviewed), noise ok, prescore below floor -> "below floor"', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status: null, prescore: 20 }, band);
    assert.equal(r.label, 'below floor');
  });

  test('rule 4: status=null, noise ok, prescore NULL -> "below floor" (never a blank state)', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status: null, prescore: null }, band);
    assert.equal(r.label, 'below floor');
  });

  test('rule 4: status=null, noise ok, prescore IN band (a model_band row awaiting the model step) -> "below floor" -- accepted, documented imprecision (see this PR\'s blind-spot note)', () => {
    const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status: null, prescore: 55 }, band);
    assert.equal(r.label, 'below floor');
  });

  test('rule 4: any other real status (e.g. skip, dead) with noise ok -> "below floor"', () => {
    for (const status of ['skip', 'dead', 'maybe', 'shortlisted']) {
      const r = fitDisplayState({ fit_score: null, noise_class: 'ok', status, prescore: 55 }, band);
      assert.equal(r.label, 'below floor', `status=${status}`);
    }
  });

  test('every unscored sub-state (noise / pending review / below floor) shares the SAME neutral "not-scored" CSS bucket -- only the label differs', () => {
    const cases = [
      { fit_score: null, noise_class: 'suspect', status: null, prescore: 55 },
      { fit_score: null, noise_class: 'ok', status: 'review', prescore: 55 },
      { fit_score: null, noise_class: 'ok', status: null, prescore: 20 },
    ];
    for (const c of cases) assert.equal(fitDisplayState(c, band).bucket, 'not-scored', JSON.stringify(c));
  });

  test('totality: every combination of fit_score x noise_class x status x prescore (incl. NULL) maps to exactly one non-empty label, never throws, never blank', () => {
    const fitScores = [null, undefined, 0, 55, 100];
    const noiseClasses = [null, undefined, 'ok', 'ok_manual', 'suspect', 'aggregator_repost'];
    const statuses = [null, undefined, 'review', 'new', 'skip', 'dead'];
    const prescores = [null, undefined, 5, 39, 40, 55, 70, 71, 100];
    let count = 0;
    for (const fit_score of fitScores) {
      for (const noise_class of noiseClasses) {
        for (const status of statuses) {
          for (const prescore of prescores) {
            const row = { fit_score, noise_class, status, prescore };
            let r;
            assert.doesNotThrow(() => { r = fitDisplayState(row, band); }, JSON.stringify(row));
            assert.ok(typeof r.label === 'string' && r.label.length > 0, `blank label for ${JSON.stringify(row)}`);
            assert.ok(['good', 'ok', 'low', 'not-scored'].includes(r.bucket), `unknown bucket for ${JSON.stringify(row)}`);
            count++;
          }
        }
      }
    }
    assert.equal(count, fitScores.length * noiseClasses.length * statuses.length * prescores.length);
  });
});

describe('shortDate / salaryRange / formatMoney', () => {
  test('missing/invalid inputs never throw', () => {
    assert.equal(shortDate(null), 'not set');
    assert.equal(shortDate('not a date'), 'not set');
    assert.equal(formatMoney(null), 'not listed');
    assert.equal(salaryRange(null, null), 'not listed');
    assert.equal(salaryRange(100000, null), '$100,000');
    assert.equal(salaryRange(100000, 120000), '$100,000 to $120,000');
    assert.equal(salaryRange(100000, 100000), '$100,000');
  });
});

describe('pluralize / truncate', () => {
  test('pluralize', () => {
    assert.equal(pluralize(1, 'item'), '1 item');
    assert.equal(pluralize(2, 'item'), '2 items');
    assert.equal(pluralize(0, 'item'), '0 items');
  });

  test('truncate never exceeds max length', () => {
    assert.equal(truncate('hello', 10), 'hello');
    assert.equal(truncate('hello world this is long', 10).length, 10);
  });
});

describe('sourceLabel: totality over known and unknown sources', () => {
  test('known sources', () => {
    assert.equal(sourceLabel('greenhouse'), 'Greenhouse');
    assert.equal(sourceLabel('ziprecruiter'), 'ZipRecruiter');
    assert.equal(sourceLabel('manual'), 'Manual');
  });

  test('unknown source falls back to title-cased raw value, never blank', () => {
    assert.equal(sourceLabel('some-new-board'), 'Some-new-board');
    assert.equal(sourceLabel(null), 'Unknown');
    assert.equal(sourceLabel(undefined), 'Unknown');
  });
});

describe('formatPercent', () => {
  test('null/undefined/NaN render as a fixed no-data phrase, never NaN%', () => {
    assert.equal(formatPercent(null), 'not enough data yet');
    assert.equal(formatPercent(undefined), 'not enough data yet');
    assert.equal(formatPercent(0.5), '50%');
    assert.equal(formatPercent(1), '100%');
  });
});

describe('normalizeAgendaTime: total classification of a Google Calendar `start`/`end` value', () => {
  test('bare ISO string', () => {
    assert.deepEqual(normalizeAgendaTime('2026-08-27T09:00:00Z'), { at: '2026-08-27T09:00:00.000Z', allDay: false });
  });

  test('{ dateTime } (real Google Calendar timed-event shape)', () => {
    assert.deepEqual(
      normalizeAgendaTime({ dateTime: '2026-08-27T09:00:00-05:00', timeZone: 'America/Chicago' }),
      { at: '2026-08-27T14:00:00.000Z', allDay: false },
    );
  });

  test('{ date } (real Google Calendar all-day-event shape)', () => {
    assert.deepEqual(normalizeAgendaTime({ date: '2026-08-27' }), { at: '2026-08-27T00:00:00.000Z', allDay: true });
  });

  test('null/undefined: a well-formed item with no start at all', () => {
    assert.deepEqual(normalizeAgendaTime(null), { at: null, allDay: false });
    assert.deepEqual(normalizeAgendaTime(undefined), { at: null, allDay: false });
  });

  test('anything else maps to null and never throws', () => {
    assert.equal(normalizeAgendaTime(42), null);
    assert.equal(normalizeAgendaTime(true), null);
    assert.equal(normalizeAgendaTime([]), null);
    assert.equal(normalizeAgendaTime({}), null, 'object with neither dateTime nor date');
    assert.equal(normalizeAgendaTime({ foo: 'bar' }), null);
    assert.equal(normalizeAgendaTime('not a date'), null, 'unparseable bare string');
    assert.equal(normalizeAgendaTime({ dateTime: 'not a date' }), null, 'unparseable dateTime');
    assert.equal(normalizeAgendaTime({ date: 'not a date' }), null, 'unparseable date');
    assert.equal(normalizeAgendaTime({ dateTime: 123 }), null, 'dateTime not a string');
  });
});

describe('agendaTimeLabel', () => {
  test('timed item uses shortDateTime', () => {
    assert.equal(agendaTimeLabel({ at: '2026-08-27T14:00:00.000Z', allDay: false }), shortDateTime('2026-08-27T14:00:00.000Z'));
  });

  test('all-day item shows a date plus a plain "all day" marker', () => {
    assert.equal(agendaTimeLabel({ at: '2026-08-27T00:00:00.000Z', allDay: true }), `${shortDate('2026-08-27T00:00:00.000Z')}, all day`);
  });

  test('at: null falls back to the fixed placeholder for both branches', () => {
    assert.equal(agendaTimeLabel({ at: null, allDay: false }), 'not set');
    assert.equal(agendaTimeLabel({ at: null, allDay: true }), 'not set');
  });
});
