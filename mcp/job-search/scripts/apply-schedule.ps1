<#
.SYNOPSIS
  Re-registers every scheduled task whose time depends on the morning scan time, by calling the
  individual register scripts: scan (09:00 daily), auto-apply (09:25 daily), remind (10:30 daily).

.DESCRIPTION
  The "job-search confirm" task is not touched: bin/confirm.js reads Gmail and the applications table and
  never reads scan output, so its time does not depend on the scan.

  Run this once, by hand, after merging a schedule change. It overwrites the live tasks (-Force in each
  register script). To change only one task, run its register script directly instead.

.EXAMPLE
  powershell -File scripts\apply-schedule.ps1
#>

param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
)

$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "register-scan-task.ps1") -RepoRoot $RepoRoot
& (Join-Path $PSScriptRoot "register-auto-apply-task.ps1") -RepoRoot $RepoRoot
& (Join-Path $PSScriptRoot "register-remind-task.ps1") -RepoRoot $RepoRoot

Write-Host "Schedule applied: scan 09:00 (daily, +10 min delay), auto-apply 09:25, remind 10:30 (daily)."
