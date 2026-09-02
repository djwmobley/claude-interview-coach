<#
.SYNOPSIS
  Registers (or unregisters) the "job-search dashboard" Windows Scheduled Task: runs bin/watchdog.js every
  5 minutes and at logon for the interactive user, so the dashboard is probed for health and (re)started
  automatically without a manual start after a crash, reboot, or log off/on.

.DESCRIPTION
  Dashboard PR 2, plan line 128 and pr2-spec-decisions.md "Single instance and startup"; updated by the
  self-healing watchdog + logging feature to run bin/watchdog.js instead of bin/dashboard.js directly.
  This script only WRITES the task definition when run; it is not invoked automatically by anything in
  this repository, and applying it to the live scheduled task is left to the operator after merge (this
  PR does not run schtasks or touch the live Task Scheduler).

  The task name here MUST match DASHBOARD_TASK_NAME in src/dashboard/task-names.js ("job-search
  dashboard"); if you rename one, rename the other.

  Why watchdog.js, not dashboard.js, is the task's action (self-healing watchdog + logging feature):
  bin/watchdog.js probes the dashboard's own /api/health, (re)starts it with full stdout/stderr log
  capture when unhealthy, and writes a small JSON state file bin/remind.js's daily digest reads to
  surface a down/stuck dashboard or a restart count to the operator. It exits within seconds either way
  (healthy, restarted, or gave up), so a 5-minute recurring trigger -- not "keep dashboard.js running as
  the task's own long-lived action" -- is the correct shape for it; the dashboard process itself is a
  detached, unref'd grandchild of a watchdog run that already exited, invisible to Task Scheduler once
  that watchdog instance ends (see src/dashboard/watchdog.js's own doc comment for why 'pipe' stdio is
  never used for it).

.PARAMETER TaskName
  Scheduled task name. Defaults to "job-search dashboard".

.PARAMETER RepoRoot
  Repository root (the directory containing mcp/job-search). Defaults to three levels above this script
  (mcp/job-search/scripts -> mcp/job-search -> mcp -> repo root).

.PARAMETER Unregister
  Remove the task instead of registering it.

.EXAMPLE
  powershell -File scripts\register-dashboard-task.ps1
  Start-ScheduledTask -TaskName "job-search dashboard"

.EXAMPLE
  powershell -File scripts\register-dashboard-task.ps1 -Unregister

.NOTES
  -ExecutionTimeLimit 0 (TimeSpan zero): watchdog.js itself exits in seconds, but a zero TimeSpan is kept
  so a future slow run (e.g. a stalled health probe) is never killed mid-cycle by the default 72-hour
  Task Scheduler limit.
  -MultipleInstances IgnoreNew: covers the case of one 5-minute tick still running when the next one
  fires; watchdog.js's own start-race lock file (readStartLock/writeStartLock in
  src/dashboard/watchdog.js) is the second line of defense for the narrower window Task Scheduler's own
  IgnoreNew does NOT cover -- a watchdog instance that already exited after spawning a dashboard process
  that is still initializing.
  RestartCount 3 / RestartInterval 1 minute (spec: "3x/1min"): a watchdog run that exits 1 (failed to
  restore health, a kill-guard mismatch, or an unexpected error) is retried a bounded number of times
  rather than left down until the next scheduled 5-minute tick or retried forever.
  -WindowStyle Hidden: no visible console window for a background task. AtLogOn with -RunLevel Limited
  does not require an elevated shell to register.
#>

param(
  [string]$TaskName = "job-search dashboard",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Unregistered scheduled task '$TaskName', or it was not registered."
  exit 0
}

$watchdogScript = Join-Path $RepoRoot "mcp\job-search\bin\watchdog.js"
if (-not (Test-Path $watchdogScript)) {
  throw "watchdog.js not found at $watchdogScript -- pass -RepoRoot explicitly if this repo checkout lives elsewhere."
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "node was not found on PATH. Install Node.js (>=22) or add it to PATH before registering this task."
}

# powershell -WindowStyle Hidden wraps the node invocation so no console window is shown; watchdog.js
# prints one summary line to its own stdout (unused here) and logs everything else to
# mcp/job-search/logs/watchdog-YYYY-MM-DD.log (its own run log) and
# mcp/job-search/logs/dashboard-YYYY-MM-DD.log (every dashboard start's captured stdout+stderr, plus the
# dashboard's own pino logging) via core/logger.js.
$psArgument = "-NoLogo -NoProfile -WindowStyle Hidden -Command `"& '$($nodeCmd.Source)' '$watchdogScript'`""

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgument -WorkingDirectory $RepoRoot
$trigger = @(
  New-ScheduledTaskTrigger -AtLogOn
  New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
)
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs bin/watchdog.js every 5 minutes and at logon for the current user)."
Write-Host "Start it now with:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check it with:       Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Unregister it with:  powershell -File `"$PSCommandPath`" -Unregister"
