// @ts-check
/**
 * scripts/register-auto-apply-task.ps1 (auto-apply PR B): a text-level check (this repo's JS test suite
 * has no PowerShell execution harness) that the script names the right task, the right default time, and
 * carries the same unattended-run-safety settings scripts/register-dashboard-task.ps1 already established
 * (StartWhenAvailable, battery allowed, IgnoreNew) -- mirrors this repo's existing convention of grep-level
 * assertions on script text where a full interpreter isn't available.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fs.readFileSync(path.join(HERE, '..', 'scripts', 'register-auto-apply-task.ps1'), 'utf8');

describe('register-auto-apply-task.ps1', () => {
  test('default task name is "job-search auto-apply"', () => {
    assert.match(SCRIPT, /\[string\]\$TaskName = "job-search auto-apply"/);
  });

  test('default run time is 06:55', () => {
    assert.match(SCRIPT, /\[string\]\$Time = "06:55"/);
  });

  test('targets bin/auto-apply.js, never bin/scan.js or bin/apply.js', () => {
    assert.match(SCRIPT, /bin\\auto-apply\.js/);
    assert.doesNotMatch(SCRIPT, /bin\\scan\.js/);
    assert.doesNotMatch(SCRIPT, /bin\\apply\.js/);
  });

  test('carries the unattended-run-safety settings', () => {
    assert.match(SCRIPT, /-StartWhenAvailable/);
    assert.match(SCRIPT, /-AllowStartIfOnBatteries/);
    assert.match(SCRIPT, /-DontStopIfGoingOnBatteries/);
    assert.match(SCRIPT, /-MultipleInstances IgnoreNew/);
  });

  test('supports -Unregister', () => {
    assert.match(SCRIPT, /\[switch\]\$Unregister/);
    assert.match(SCRIPT, /Unregister-ScheduledTask -TaskName \$TaskName/);
  });

  test('never runs schtasks or Register-ScheduledTask against a hardcoded literal task name outside $TaskName', () => {
    // The only Register-ScheduledTask call uses the $TaskName variable, never a literal string -- so
    // renaming $TaskName's default actually changes what gets registered.
    const registerCalls = SCRIPT.match(/Register-ScheduledTask[^\n]*/g) ?? [];
    assert.ok(registerCalls.length >= 1);
    for (const call of registerCalls) assert.match(call, /-TaskName \$TaskName/);
  });
});
