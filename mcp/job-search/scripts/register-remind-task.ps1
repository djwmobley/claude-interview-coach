<#
.SYNOPSIS
  Registers (or unregisters) the "job-search remind" Windows Scheduled Task: runs bin/remind.js every day
  of the week at 10:30, after the 09:00 scan and the 09:25 auto-apply run, because the digest carries the
  scan report and the auto-apply summary.

.PARAMETER TaskName
  Scheduled task name. Defaults to "job-search remind".

.PARAMETER RepoRoot
  Repository root (the directory containing mcp/job-search). Defaults to three levels above this script.

.PARAMETER Time
  Daily run time, HH:mm (24-hour). Defaults to "10:30".

.PARAMETER Arguments
  Arguments passed to bin/remind.js. Defaults to "--open-dashboard", matching the live task and the README
  registration snippet.

.PARAMETER Unregister
  Remove the task instead of registering it.

.EXAMPLE
  powershell -File scripts\register-remind-task.ps1
#>

param(
  [string]$TaskName = "job-search remind",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path,
  [string]$Time = "10:30",
  [string]$Arguments = "--open-dashboard",
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "task-readback.ps1")

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Unregistered scheduled task '$TaskName', or it was not registered."
  exit 0
}

$remindScript = Join-Path $RepoRoot "mcp\job-search\bin\remind.js"
if (-not (Test-Path $remindScript)) {
  throw "remind.js not found at $remindScript -- pass -RepoRoot explicitly if this repo checkout lives elsewhere."
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $nodeCmd.Source) {
  throw "node was not found on PATH. Install Node.js (>=22) or add it to PATH before registering this task."
}

[datetime]$startTime = [datetime]::ParseExact($Time, "HH:mm", $null)

$argLine = "mcp\job-search\bin\remind.js"
if ($Arguments) { $argLine = "$argLine $Arguments" }

$action = New-ScheduledTaskAction -Execute $nodeCmd.Source -Argument $argLine -WorkingDirectory $RepoRoot
$days = @("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday -At $startTime
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries

try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force -ErrorAction Stop | Out-Null
  Assert-RegisteredTaskMatches -TaskName $TaskName -ExpectedTime $startTime -ExpectedDays $days -ExpectedExecute $nodeCmd.Source -ExpectedArguments $argLine
} catch {
  Exit-RegisterFailure -TaskName $TaskName -ErrorRecord $_
}

Write-Host "Registered scheduled task '$TaskName' (runs bin/remind.js daily at $Time)."
Write-Host "Unregister it with:  powershell -File `"$PSCommandPath`" -Unregister"
