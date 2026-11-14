// @ts-check
/**
 * Morning schedule anchor (scan 09:00): the register scripts, the auto-apply wait deadlines (schema default
 * and the shipped config/auto-apply.json), and scripts/apply-schedule.ps1 must agree. Text-level checks on
 * the .ps1 files, same convention as register-auto-apply-task-script.test.js.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoApplySchema } from '../src/core/config.js';
import { localDeadline } from '../src/core/scan-wait.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('auto-apply wait deadlines', () => {
  test('schema defaults are soft 10:10 and hard 10:25', () => {
    const parsed = autoApplySchema.parse({});
    assert.equal(parsed.waitDeadlineLocal, '10:10');
    assert.equal(parsed.waitHardDeadlineLocal, '10:25');
  });

  test('shipped config/auto-apply.json matches the schema defaults', () => {
    const cfg = JSON.parse(read('config/auto-apply.json'));
    assert.equal(cfg.waitDeadlineLocal, '10:10');
    assert.equal(cfg.waitHardDeadlineLocal, '10:25');
  });

  test('10:10 and 10:25 America/Chicago on 2026-09-04 CDT are 15:10Z and 15:25Z', () => {
    const noon = new Date('2026-09-04T12:00:00.000Z');
    assert.equal(localDeadline(noon, 'America/Chicago', '10:10').toISOString(), '2026-09-04T15:10:00.000Z');
    assert.equal(localDeadline(noon, 'America/Chicago', '10:25').toISOString(), '2026-09-04T15:25:00.000Z');
  });

  test('hard deadline is after auto-apply start (09:25) plus soft deadline ordering', () => {
    const parsed = autoApplySchema.parse({});
    assert.ok('09:25' < parsed.waitDeadlineLocal && parsed.waitDeadlineLocal < parsed.waitHardDeadlineLocal);
  });
});

describe('register-scan-task.ps1', () => {
  const S = read('scripts/register-scan-task.ps1');
  test('task name, 09:00 default, 10 minute delay, weekdays only', () => {
    assert.match(S, /\[string\]\$TaskName = "job-search scan"/);
    assert.match(S, /\[string\]\$Time = "09:00"/);
    assert.match(S, /\[int\]\$RandomDelayMinutes = 10/);
    assert.match(S, /-DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday/);
    assert.match(S, /\$trigger\.RandomDelay = /);
  });
  test('targets bin/scan.js and carries unattended-safety settings and -Unregister', () => {
    assert.match(S, /bin\\scan\.js/);
    assert.match(S, /-StartWhenAvailable/);
    assert.match(S, /-AllowStartIfOnBatteries/);
    assert.match(S, /-DontStopIfGoingOnBatteries/);
    assert.match(S, /\[switch\]\$Unregister/);
    for (const call of S.match(/Register-ScheduledTask[^\n]*/g) ?? []) assert.match(call, /-TaskName \$TaskName/);
  });
});

describe('register-remind-task.ps1', () => {
  const S = read('scripts/register-remind-task.ps1');
  test('task name, 10:30 default, weekdays, bin/remind.js', () => {
    assert.match(S, /\[string\]\$TaskName = "job-search remind"/);
    assert.match(S, /\[string\]\$Time = "10:30"/);
    assert.match(S, /-DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday/);
    assert.match(S, /bin\\remind\.js/);
    assert.match(S, /\[switch\]\$Unregister/);
  });
});

describe('apply-schedule.ps1', () => {
  const S = read('scripts/apply-schedule.ps1');
  test('calls the scan, auto-apply and remind register scripts, and not confirm', () => {
    assert.match(S, /register-scan-task\.ps1/);
    assert.match(S, /register-auto-apply-task\.ps1/);
    assert.match(S, /register-remind-task\.ps1/);
    assert.doesNotMatch(S, /register-confirm/);
  });
  test('never shells out to schtasks directly', () => {
    assert.doesNotMatch(S, /schtasks/i);
  });
});

describe('no stale pre-shift times in shipped schedule docs', () => {
  test('README scan trigger is 09:00 with PT10M delay and remind is 10:30', () => {
    const r = read('README.md');
    assert.match(r, /-At 09:00\r?\n\$t\.RandomDelay = "PT10M"/);
    assert.match(r, /-At 10:30\r?\nRegister-ScheduledTask -TaskName "job-search remind"/);
    assert.doesNotMatch(r, /PT45M/);
  });
});
