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

$results = @()
# register-scan-task.ps1, register-auto-apply-task.ps1, register-remind-task.ps1
foreach ($name in @("scan", "auto-apply", "remind")) {
  $ok = $false
  $reason = "no FAILED line reported"
  try {
    $global:LASTEXITCODE = 0
    $lines = @(& (Join-Path $PSScriptRoot "register-$name-task.ps1") -RepoRoot $RepoRoot *>&1 | ForEach-Object { "$_" })
    $lines | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -eq 0) {
      $ok = $true
    } else {
      $failed = @($lines | Where-Object { $_ -like "FAILED: *" })
      if ($failed.Count -gt 0) { $reason = $failed[0].Substring(8) }
    }
  } catch {
    $reason = $_.Exception.Message
  }
  $results += [pscustomobject]@{ Name = $name; Ok = $ok; Reason = $reason }
}

foreach ($r in $results) {
  if ($r.Ok) { Write-Host "$($r.Name): OK" } else { Write-Host "$($r.Name): FAILED - $($r.Reason)" }
}

if (@($results | Where-Object { -not $_.Ok }).Count -gt 0) {
  exit 1
}

Write-Host "Schedule applied: scan 09:00 (daily, +10 min delay), auto-apply 09:25, remind 10:30 (daily)."
