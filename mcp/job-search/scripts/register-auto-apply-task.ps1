<#
.SYNOPSIS
  Registers (or unregisters) the "job-search auto-apply" Windows Scheduled Task: runs bin/auto-apply.js
  once daily at 06:55, so the prepare/select/apply pipeline runs unattended every morning shortly before
  the "job-search remind" digest email (08:00) and after the "job-search scan" run (06:30 + delay) and the
  "job-search confirm" run (07:45), so the report those two produce reflects the SAME day's auto-apply
  activity (docs/auto-apply-spec.md's own report-timing note).

.DESCRIPTION
  Auto-apply PR B. Mirrors scripts/register-dashboard-task.ps1's own structure and settings (StartWhen
  Available, battery allowed, hidden window, Limited run level) but its action is bin/auto-apply.js itself,
  run directly -- there is no watchdog-style wrapper here, unlike the dashboard task: bin/auto-apply.js is
  a normal one-shot CLI (like bin/scan.js's own scheduled "job-search scan" task) that exits on its own
  once its lock/prepare/select/apply cycle finishes, not a long-lived server process that needs restarting.

  The task name here has no corresponding constant to keep in sync (unlike the dashboard task's
  DASHBOARD_TASK_NAME in src/dashboard/task-names.js) -- bin/auto-apply.js itself never reads its own task
  name back.

  This script only WRITES the task definition when run; it is not invoked automatically by anything in
  this repository, and applying it to the live scheduled task is left to the operator after merge (this
  script does not run schtasks or touch the live Task Scheduler on its own, matching
  register-dashboard-task.ps1's own documented behavior).

.PARAMETER TaskName
  Scheduled task name. Defaults to "job-search auto-apply".

.PARAMETER RepoRoot
  Repository root (the directory containing mcp/job-search). Defaults to three levels above this script
  (mcp/job-search/scripts -> mcp/job-search -> mcp -> repo root).

.PARAMETER Time
  Daily run time, HH:mm (24-hour). Defaults to "06:55".

.PARAMETER Unregister
  Remove the task instead of registering it.

.EXAMPLE
  powershell -File scripts\register-auto-apply-task.ps1
  Start-ScheduledTask -TaskName "job-search auto-apply"

.EXAMPLE
  powershell -File scripts\register-auto-apply-task.ps1 -Unregister

.NOTES
  -ExecutionTimeLimit 0 (TimeSpan zero): bin/auto-apply.js's own advisory-lock poll can legitimately run
  up to config/auto-apply.json's lockMinutes (default 40) before giving up, on top of however long the
  resume/review/apply chain itself takes for up to dailyCap candidates -- a bounded default Task Scheduler
  timeout (commonly 72 hours) would be generous enough in practice, but zero removes any risk of an
  unrelated slow morning being cut off mid-run, matching register-dashboard-task.ps1's own reasoning for
  the identical setting.
  -MultipleInstances IgnoreNew: bin/auto-apply.js's own advisory lock (src/core/scan-run.js's LOCK_KEY)
  already serializes a second run against a first that is still holding it during its prepare phase; this
  setting additionally stops Task Scheduler itself from ever starting a second instance of the task in the
  same tick.
  -StartWhenAvailable / -AllowStartIfOnBatteries / -DontStopIfGoingOnBatteries: an unattended morning run
  must not be silently skipped because the laptop was off, asleep, or on battery at 06:55 (the exact
  "silently skipped" incident this repo's own CLAUDE.md and 2026-08-29 fix history call out for the other
  scheduled job-search tasks) -- this task follows the same "warn and proceed" floor rather than the
  earlier, since-corrected "block on battery" default.
#>

param(
  [string]$TaskName = "job-search auto-apply",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [string]$Time = "06:55",
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Unregistered scheduled task '$TaskName', or it was not registered."
  exit 0
}

$autoApplyScript = Join-Path $RepoRoot "mcp\job-search\bin\auto-apply.js"
if (-not (Test-Path $autoApplyScript)) {
  throw "auto-apply.js not found at $autoApplyScript -- pass -RepoRoot explicitly if this repo checkout lives elsewhere."
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "node was not found on PATH. Install Node.js (>=22) or add it to PATH before registering this task."
}

[datetime]$startTime = [datetime]::ParseExact($Time, "HH:mm", $null)

# powershell -WindowStyle Hidden wraps the node invocation so no console window is shown; bin/auto-apply.js
# logs to mcp/job-search/logs/auto-apply-YYYY-MM-DD.log (src/core/logger.js's dailyLogPath convention,
# identical to bin/scan.js and bin/apply.js) and prints one JSON summary line to its own stdout (unused
# here, same as watchdog.js's own single summary line).
$psArgument = "-NoLogo -NoProfile -WindowStyle Hidden -Command `"& '$($nodeCmd.Source)' '$autoApplyScript'`""

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgument -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $startTime
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs bin/auto-apply.js daily at $Time)."
Write-Host "Start it now with:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check it with:       Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Unregister it with:  powershell -File `"$PSCommandPath`" -Unregister"
