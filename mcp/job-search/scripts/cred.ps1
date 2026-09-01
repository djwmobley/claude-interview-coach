#requires -Version 5.1
<#
.SYNOPSIS
  Windows Credential Manager wrapper for the job-search apply pipeline (slice 4, plan section "5.
  Credentials"). Called only from src/core/credentials.js via an injected execFile -- never invoked
  directly by a human except for manual troubleshooting.

.DESCRIPTION
  Thin P/Invoke wrapper around advapi32.dll's CredRead/CredWrite/CredDelete/CredEnumerate. A secret
  NEVER crosses this script's own command line: -Write reads the password from stdin, -Read prints it
  (as part of a JSON object) to stdout only. Every stored credential's TargetName is prefixed
  "ic-jobsearch/" (validated below) so this script can never touch a credential belonging to anything
  else on the machine, including Windows' own saved logins.

.PARAMETER Op
  One of: read, write, delete, list.

.PARAMETER Target
  Required for read/write/delete. Must match ^ic-jobsearch/[A-Za-z0-9.-]+$ (the "ic-jobsearch/<tenantHost>"
  shape src/core/credentials.js's credentialTarget() constructs). Rejected otherwise, before any Win32
  call is made.

.PARAMETER Username
  Required for write. Not treated as a secret (it is the account email, not the password); may appear on
  the command line.

.NOTES
  Exit codes: 0 success. 2 "not found" for -Op read/delete (a legitimate, non-error outcome -- the
  caller distinguishes this from a real failure). 1 any other failure (message on stderr).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('read', 'write', 'delete', 'list')][string]$Op,
  [Parameter(Mandatory = $false)][string]$Target,
  [Parameter(Mandatory = $false)][string]$Username
)

$ErrorActionPreference = 'Stop'

# Every target this script will ever touch must be under this prefix -- a hard, structural guard
# independent of whatever src/core/credentials.js already validates on the Node side, so a bug or a
# future direct invocation of this script can never write/read/delete a credential outside the
# job-search apply pipeline's own namespace.
$TargetPrefix = 'ic-jobsearch/'
$TargetPattern = '^ic-jobsearch/[A-Za-z0-9.-]+$'

function Assert-Target {
  param([string]$T)
  if ([string]::IsNullOrWhiteSpace($T)) {
    Write-Error "cred.ps1: -Target is required for -Op $Op"
    exit 1
  }
  if ($T -notmatch $TargetPattern) {
    Write-Error "cred.ps1: -Target must match $TargetPattern, got `"$T`""
    exit 1
  }
}

Add-Type -Namespace IcJobSearch -Name CredMan -MemberDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
}

[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredDelete(string target, int type, int flags);

[DllImport("advapi32.dll", SetLastError = true)]
public static extern bool CredFree(IntPtr cred);

[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr pCredentials);
'@

$CRED_TYPE_GENERIC = 1
$CRED_PERSIST_LOCAL_MACHINE = 2
$ERROR_NOT_FOUND = 1168

function Read-Credential {
  param([string]$T)
  $ptr = [IntPtr]::Zero
  $ok = [IcJobSearch.CredMan]::CredRead($T, $CRED_TYPE_GENERIC, 0, [ref]$ptr)
  if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq $ERROR_NOT_FOUND) { exit 2 }
    Write-Error "cred.ps1: CredRead failed for `"$T`" (Win32 error $err)"
    exit 1
  }
  try {
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][IcJobSearch.CredMan+CREDENTIAL])
    $passwordBytes = New-Object byte[] ($cred.CredentialBlobSize)
    if ($cred.CredentialBlobSize -gt 0) {
      [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $passwordBytes, 0, $cred.CredentialBlobSize)
    }
    $password = [System.Text.Encoding]::Unicode.GetString($passwordBytes)
    $result = [ordered]@{ username = $cred.UserName; password = $password }
    $result | ConvertTo-Json -Compress
  } finally {
    [IcJobSearch.CredMan]::CredFree($ptr) | Out-Null
  }
}

function Write-CredentialToStore {
  param([string]$T, [string]$U, [string]$P)
  $passwordBytes = [System.Text.Encoding]::Unicode.GetBytes($P)
  $blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($passwordBytes.Length)
  try {
    [System.Runtime.InteropServices.Marshal]::Copy($passwordBytes, 0, $blobPtr, $passwordBytes.Length)
    $cred = New-Object IcJobSearch.CredMan+CREDENTIAL
    $cred.Flags = 0
    $cred.Type = $CRED_TYPE_GENERIC
    $cred.TargetName = $T
    $cred.Comment = 'ic-jobsearch apply pipeline'
    $cred.CredentialBlobSize = $passwordBytes.Length
    $cred.CredentialBlob = $blobPtr
    $cred.Persist = $CRED_PERSIST_LOCAL_MACHINE
    $cred.AttributeCount = 0
    $cred.Attributes = [IntPtr]::Zero
    $cred.TargetAlias = $null
    $cred.UserName = $U
    $ok = [IcJobSearch.CredMan]::CredWrite([ref]$cred, 0)
    if (-not $ok) {
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Write-Error "cred.ps1: CredWrite failed for `"$T`" (Win32 error $err)"
      exit 1
    }
  } finally {
    # Zero the unmanaged buffer before freeing it: the password lived here in plaintext for the
    # duration of the call, and this is the one place in the pipeline it is ever held outside a
    # Credential Manager-encrypted store.
    if ($passwordBytes.Length -gt 0) {
      $zero = New-Object byte[] ($passwordBytes.Length)
      [System.Runtime.InteropServices.Marshal]::Copy($zero, 0, $blobPtr, $passwordBytes.Length)
    }
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
  }
}

function Remove-CredentialFromStore {
  param([string]$T)
  $ok = [IcJobSearch.CredMan]::CredDelete($T, $CRED_TYPE_GENERIC, 0)
  if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq $ERROR_NOT_FOUND) { exit 2 }
    Write-Error "cred.ps1: CredDelete failed for `"$T`" (Win32 error $err)"
    exit 1
  }
}

function Get-CredentialTargets {
  $count = 0
  $arrPtr = [IntPtr]::Zero
  $filter = "$TargetPrefix*"
  $ok = [IcJobSearch.CredMan]::CredEnumerate($filter, 0, [ref]$count, [ref]$arrPtr)
  if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($err -eq $ERROR_NOT_FOUND) {
      # No credentials matching the filter at all: a legitimate empty list, not an error.
      '[]'
      return
    }
    Write-Error "cred.ps1: CredEnumerate failed (Win32 error $err)"
    exit 1
  }
  try {
    $targets = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $count; $i++) {
      $itemPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($arrPtr, $i * [IntPtr]::Size)
      $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($itemPtr, [Type][IcJobSearch.CredMan+CREDENTIAL])
      # Defensive re-check: only ever report a target actually under our own prefix, even though the
      # CredEnumerate filter above should already guarantee this.
      if ($cred.TargetName -and $cred.TargetName.StartsWith($TargetPrefix)) {
        $targets.Add($cred.TargetName)
      }
    }
    ConvertTo-Json -InputObject @($targets) -Compress
  } finally {
    [IcJobSearch.CredMan]::CredFree($arrPtr) | Out-Null
  }
}

switch ($Op) {
  'read' {
    Assert-Target $Target
    Read-Credential -T $Target
  }
  'write' {
    Assert-Target $Target
    if ([string]::IsNullOrWhiteSpace($Username)) {
      Write-Error 'cred.ps1: -Username is required for -Op write'
      exit 1
    }
    # The secret is read from stdin ONLY -- never from a parameter, never from the command line, so it
    # never appears in the process list or in Task Scheduler / event log history on this machine.
    $password = [Console]::In.ReadToEnd()
    $password = $password -replace "`r?`n$", ''
    if ([string]::IsNullOrEmpty($password)) {
      Write-Error 'cred.ps1: no password received on stdin for -Op write'
      exit 1
    }
    Write-CredentialToStore -T $Target -U $Username -P $password
  }
  'delete' {
    Assert-Target $Target
    Remove-CredentialFromStore -T $Target
  }
  'list' {
    Get-CredentialTargets
  }
}
exit 0
