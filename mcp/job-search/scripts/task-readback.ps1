<#
.SYNOPSIS
  Shared helpers for the register scripts, dot-sourced by each of them. Not run on its own.

.DESCRIPTION
  Invariant: a register script reports success only when the live task, read back after registration,
  matches what the script asked for. Any other outcome is a visible failure with a non-zero exit.

  Assert-RegisteredTaskMatches reads the task back and throws on the first mismatch. Exit-RegisterFailure
  prints one "FAILED: <reason>" line (apply-schedule.ps1 reads that line for its summary) and exits 1. It
  never attempts elevation, ownership changes, or deletion.
#>

function Test-IsAccessDenied {
  param($ErrorRecord)
  $ex = $ErrorRecord.Exception
  while ($ex) {
    if ($ex -is [System.UnauthorizedAccessException]) { return $true }
    if ($ex.HResult -eq -2147024891) { return $true }
    if ($ex.Message -match 'Access is denied|0x80070005') { return $true }
    $ex = $ex.InnerException
  }
  return $false
}

function ConvertTo-DelayMinutes {
  param($Value)
  if ($null -eq $Value -or "$Value" -eq "") { return 0 }
  return [System.Xml.XmlConvert]::ToTimeSpan("$Value").TotalMinutes
}

function ConvertTo-DayMask {
  param($Value)
  $bits = @{ Sunday = 1; Monday = 2; Tuesday = 4; Wednesday = 8; Thursday = 16; Friday = 32; Saturday = 64 }
  if ($Value -is [string] -and $Value -notmatch '^\d+$') {
    $mask = 0
    foreach ($name in ($Value -split '[,\s]+' | Where-Object { $_ })) { $mask += $bits[$name] }
    return $mask
  }
  return [int]$Value
}

function Assert-RegisteredTaskMatches {
  param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)][datetime]$ExpectedTime,
    [string[]]$ExpectedDays = @(),
    [int]$ExpectedRandomDelayMinutes = 0,
    [Parameter(Mandatory)][string]$ExpectedExecute,
    [Parameter(Mandatory)][string]$ExpectedArguments
  )

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $trigger = @($task.Triggers)[0]
  $action = @($task.Actions)[0]
  if (-not $trigger) { throw "read-back found no trigger on '$TaskName'" }
  if (-not $action) { throw "read-back found no action on '$TaskName'" }

  $actual = [datetimeoffset]::Parse("$($trigger.StartBoundary)", [System.Globalization.CultureInfo]::InvariantCulture)
  if ($actual.Hour -ne $ExpectedTime.Hour -or $actual.Minute -ne $ExpectedTime.Minute) {
    throw ("start time is {0:HH:mm}, expected {1:HH:mm}" -f $actual, $ExpectedTime)
  }

  if ($ExpectedDays.Count -gt 0) {
    $expectedMask = 0
    $bits = @{ Sunday = 1; Monday = 2; Tuesday = 4; Wednesday = 8; Thursday = 16; Friday = 32; Saturday = 64 }
    foreach ($d in $ExpectedDays) { $expectedMask += $bits[$d] }
    $actualMask = ConvertTo-DayMask $trigger.DaysOfWeek
    if ($actualMask -ne $expectedMask) {
      throw "days of week mask is $actualMask, expected $expectedMask ($($ExpectedDays -join ','))"
    }
  } else {
    if ($trigger.CimClass.CimClassName -ne 'MSFT_TaskDailyTrigger' -or [int]$trigger.DaysInterval -ne 1) {
      throw "trigger is not a daily trigger with interval 1"
    }
  }

  $actualDelay = ConvertTo-DelayMinutes $trigger.RandomDelay
  if ($actualDelay -ne $ExpectedRandomDelayMinutes) {
    throw "random delay is $actualDelay min, expected $ExpectedRandomDelayMinutes min"
  }

  if ($action.Execute -ine $ExpectedExecute) {
    throw "Execute is '$($action.Execute)', expected '$ExpectedExecute'"
  }
  if ("$($action.Arguments)" -ine $ExpectedArguments) {
    throw "Arguments are '$($action.Arguments)', expected '$ExpectedArguments'"
  }
}

function Exit-RegisterFailure {
  param(
    [Parameter(Mandatory)][string]$TaskName,
    [Parameter(Mandatory)]$ErrorRecord
  )
  if (Test-IsAccessDenied $ErrorRecord) {
    Write-Host "FAILED: Access is denied. The existing task '$TaskName' is owned by Administrators. Run this script from a PowerShell window opened with Run as administrator. Nothing was changed."
  } else {
    Write-Host "FAILED: task '$TaskName' was not registered as requested: $($ErrorRecord.Exception.Message)"
  }
  exit 1
}
