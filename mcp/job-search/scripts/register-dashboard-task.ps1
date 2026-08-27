<#
.SYNOPSIS
  Registers (or unregisters) the "job-search dashboard" Windows Scheduled Task: launches the dashboard at
  logon for the interactive user, so it is available without a manual start after reboot or log off/on.

.DESCRIPTION
  Dashboard PR 2, plan line 128 and pr2-spec-decisions.md "Single instance and startup". This script only
  WRITES the task definition when run; it is not invoked automatically by anything in this repository.
  Registering (and the first Start-ScheduledTask) is left to the operator, in the end-to-end verification
  phase, not to the PR that authors this file.

  The task name here MUST match DASHBOARD_TASK_NAME in src/dashboard/task-names.js ("job-search
  dashboard"); if you rename one, rename the other.

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
  -ExecutionTimeLimit 0 (TimeSpan zero): the default 72-hour Task Scheduler limit would kill a
  long-running dashboard server; a zero TimeSpan means unlimited.
  -MultipleInstances IgnoreNew: a second logon (RDP, fast user switching) never starts a second copy of
  the dashboard; bin/dashboard.js's own EADDRINUSE health probe is the second line of defense if this
  ever races.
  RestartCount 3 / RestartInterval 1 minute: a crashed dashboard process is retried a bounded number of
  times rather than left down indefinitely or retried forever.
  -WindowStyle Hidden: no visible console window for a background service. AtLogOn with -RunLevel
  Limited does not require an elevated shell to register.
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

$dashboardScript = Join-Path $RepoRoot "mcp\job-search\bin\dashboard.js"
if (-not (Test-Path $dashboardScript)) {
  throw "dashboard.js not found at $dashboardScript -- pass -RepoRoot explicitly if this repo checkout lives elsewhere."
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "node was not found on PATH. Install Node.js (>=22) or add it to PATH before registering this task."
}

# powershell -WindowStyle Hidden wraps the node invocation so no console window is shown; the dashboard
# prints one startup line to its own stdout (unused here) and logs everything else to
# mcp/job-search/logs/dashboard-YYYY-MM-DD.log via core/logger.js.
$psArgument = "-NoLogo -NoProfile -WindowStyle Hidden -Command `"& '$($nodeCmd.Source)' '$dashboardScript'`""

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgument -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs at logon for the current user)."
Write-Host "Start it now with:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check it with:       Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Unregister it with:  powershell -File `"$PSCommandPath`" -Unregister"
