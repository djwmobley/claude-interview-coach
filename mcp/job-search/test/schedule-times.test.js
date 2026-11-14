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
  test('task name, 09:00 default, 10 minute delay, all 7 days', () => {
    assert.match(S, /\[string\]\$TaskName = "job-search scan"/);
    assert.match(S, /\[string\]\$Time = "09:00"/);
    assert.match(S, /\[int\]\$RandomDelayMinutes = 10/);
    assert.match(S, /-DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday/);
    assert.match(S, /\$trigger\.RandomDelay = /);
  });
  test('arguments match the live task: --profile exec-default --json --launch-chrome', () => {
    assert.match(S, /-Argument "mcp\\job-search\\bin\\scan\.js --profile exec-default --json --launch-chrome"/);
    assert.match(S, /-WorkingDirectory \$RepoRoot/);
  });
  test('executes the resolved node path, not bare node, and fails if unresolved', () => {
    assert.match(S, /-Execute \$nodeCmd\.Source/);
    assert.doesNotMatch(S, /-Execute "node"/);
    assert.match(S, /Get-Command node/);
    assert.match(S, /if \(-not \$nodeCmd -or -not \$nodeCmd\.Source\) \{\s*throw/);
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
  test('task name, 10:30 default, all 7 days, no random delay, bin/remind.js', () => {
    assert.match(S, /\[string\]\$TaskName = "job-search remind"/);
    assert.match(S, /\[string\]\$Time = "10:30"/);
    assert.match(S, /-DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday/);
    assert.doesNotMatch(S, /RandomDelay/);
    assert.match(S, /bin\\remind\.js/);
    assert.match(S, /\[switch\]\$Unregister/);
  });
  test('default arguments include --open-dashboard', () => {
    assert.match(S, /\[string\]\$Arguments = "--open-dashboard"/);
    assert.match(S, /\$argLine = "mcp\\job-search\\bin\\remind\.js"/);
  });
  test('executes the resolved node path, not bare node, and fails if unresolved', () => {
    assert.match(S, /-Execute \$nodeCmd\.Source/);
    assert.doesNotMatch(S, /-Execute "node"/);
    assert.match(S, /Get-Command node/);
    assert.match(S, /if \(-not \$nodeCmd -or -not \$nodeCmd\.Source\) \{\s*throw/);
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

describe('register scripts verify the live task (read-back) and fail loudly', () => {
  const SHARED = read('scripts/task-readback.ps1');
  const SCRIPTS = ['register-scan-task.ps1', 'register-remind-task.ps1', 'register-auto-apply-task.ps1'];

  test('shared function reads the task back and compares every requested value', () => {
    assert.match(SHARED, /function Assert-RegisteredTaskMatches/);
    assert.match(SHARED, /Get-ScheduledTask -TaskName \$TaskName -ErrorAction Stop/);
    for (const f of ['StartBoundary', 'DaysOfWeek', 'RandomDelay', '\\.Execute', '\\.Arguments']) {
      assert.match(SHARED, new RegExp(f));
    }
  });

  test('shared failure path prints FAILED and exits non-zero', () => {
    assert.match(SHARED, /function Exit-RegisterFailure/);
    assert.match(SHARED, /FAILED: /);
    assert.match(SHARED, /exit 1/);
  });

  test('access-denied message names Administrators and Run as administrator; no elevation or deletion', () => {
    assert.match(SHARED, /Access is denied/);
    assert.match(SHARED, /owned by Administrators/);
    assert.match(SHARED, /Run as administrator/);
    assert.doesNotMatch(SHARED, /Start-Process[^\n]*-Verb RunAs/i);
    assert.doesNotMatch(SHARED, /takeown|icacls|Unregister-ScheduledTask|Remove-Item/i);
  });

  for (const f of SCRIPTS) {
    test(`${f} dot-sources the shared file, uses -ErrorAction Stop in try/catch, then read-back, then Registered`, () => {
      const S = read(`scripts/${f}`);
      assert.match(S, /^\. \(Join-Path \$PSScriptRoot "task-readback\.ps1"\)/m);
      assert.doesNotMatch(S, /function Assert-RegisteredTaskMatches/);
      const reg = S.match(/Register-ScheduledTask -TaskName \$TaskName[^\n]*/)?.[0] ?? '';
      assert.match(reg, /-ErrorAction Stop/);
      const iTry = S.indexOf('try {');
      const iReg = S.indexOf('Register-ScheduledTask -TaskName $TaskName');
      const iRead = S.indexOf('Assert-RegisteredTaskMatches');
      const iCatch = S.indexOf('Exit-RegisterFailure');
      const iOk = S.indexOf('Write-Host "Registered scheduled task');
      assert.ok(iTry >= 0 && iTry < iReg && iReg < iRead && iRead < iCatch && iCatch < iOk);
    });
  }
});

describe('apply-schedule.ps1 failure reporting', () => {
  const S = read('scripts/apply-schedule.ps1');
  test('runs every register script, collects results, prints a per-task line', () => {
    assert.match(S, /foreach \(\$name in @\("scan", "auto-apply", "remind"\)\)/);
    assert.match(S, /register-\$name-task\.ps1/);
    assert.match(S, /\$LASTEXITCODE/);
    assert.match(S, /: OK"/);
    assert.match(S, /: FAILED - /);
  });
  test('final Schedule applied line comes only after a non-zero exit on any failure', () => {
    const iExit = S.indexOf('exit 1');
    const iFinal = S.indexOf('Write-Host "Schedule applied:');
    assert.ok(iExit >= 0 && iFinal > iExit);
    assert.equal(S.match(/Schedule applied:/g)?.length, 1);
    assert.match(S, /if \(@\(\$results \| Where-Object \{ -not \$_\.Ok \}\)\.Count -gt 0\) \{\s*exit 1\s*\}/);
  });
});

describe('no stale pre-shift times in shipped schedule docs', () => {
  test('README scan trigger is 09:00 with PT10M delay and remind is 10:30', () => {
    const r = read('README.md');
    assert.match(r, /-At 09:00\r?\n\$t\.RandomDelay = "PT10M"/);
    assert.match(r, /-At 10:30\r?\nRegister-ScheduledTask -TaskName "job-search remind"/);
    assert.doesNotMatch(r, /PT45M/);
    assert.match(r, /scan\.js --profile exec-default --json --launch-chrome"/);
    assert.match(r, /remind\.js --open-dashboard"/);
    assert.match(r, /Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday -At 09:00/);
    assert.match(r, /Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday -At 10:30/);
  });
});
