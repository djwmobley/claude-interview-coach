<#
.SYNOPSIS
  Registers (or unregisters) the "job-search scan" Windows Scheduled Task: runs bin/scan.js every day
  of the week at 09:00 with a 10 minute random delay, so the scan time lives in this repo.

.DESCRIPTION
  Downstream tasks are timed against this one: "job-search auto-apply" at 09:25 (its wait-on-scan soft and
  hard deadlines are 10:10 and 10:25, config/auto-apply.json) and "job-search remind" at 10:30. If the scan
  time here changes, change those too (scripts/apply-schedule.ps1 re-registers all of them together).

  Modeled on scripts/register-auto-apply-task.ps1: StartWhenAvailable, battery allowed, hidden-window-free
  direct node action, Limited run level. The task runs as the interactive user (no stored password) so the
  dedicated scan Chrome is reachable.

  This script only WRITES the task definition when run; nothing in this repository invokes it
  automatically.

.PARAMETER TaskName
  Scheduled task name. Defaults to "job-search scan".

.PARAMETER RepoRoot
  Repository root (the directory containing mcp/job-search). Defaults to three levels above this script.

.PARAMETER Time
  Daily run time, HH:mm (24-hour). Defaults to "09:00".

.PARAMETER RandomDelayMinutes
  Task Scheduler random delay added to each start. Defaults to 10.

.PARAMETER Unregister
  Remove the task instead of registering it.

.EXAMPLE
  powershell -File scripts\register-scan-task.ps1
#>

param(
  [string]$TaskName = "job-search scan",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [string]$Time = "09:00",
  [int]$RandomDelayMinutes = 10,
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Unregistered scheduled task '$TaskName', or it was not registered."
  exit 0
}

$scanScript = Join-Path $RepoRoot "mcp\job-search\bin\scan.js"
if (-not (Test-Path $scanScript)) {
  throw "scan.js not found at $scanScript -- pass -RepoRoot explicitly if this repo checkout lives elsewhere."
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $nodeCmd.Source) {
  throw "node was not found on PATH. Install Node.js (>=22) or add it to PATH before registering this task."
}

[datetime]$startTime = [datetime]::ParseExact($Time, "HH:mm", $null)

$action = New-ScheduledTaskAction -Execute $nodeCmd.Source -Argument "mcp\job-search\bin\scan.js --profile exec-default --json --launch-chrome" -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday -At $startTime
$trigger.RandomDelay = "PT$($RandomDelayMinutes)M"
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs bin/scan.js daily at $Time, random delay $RandomDelayMinutes min)."
Write-Host "Unregister it with:  powershell -File `"$PSCommandPath`" -Unregister"
