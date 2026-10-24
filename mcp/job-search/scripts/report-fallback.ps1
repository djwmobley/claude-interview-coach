# Report fallback delivery (bin/remind.js, src/core/report-fallback.js): shows a Windows toast naming the
# problem and the report path, then opens the HTML report in the default browser. Invoked as
#   powershell -NoProfile -File scripts/report-fallback.ps1 <payload.json>
# (never an encoded command). The payload is a small JSON file: { title, message, html }. Each step is
# independent: a toast failure does not stop the browser open.
param([Parameter(Mandatory = $true)][string]$PayloadPath)

$ErrorActionPreference = 'Continue'
$p = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $title = [System.Security.SecurityElement]::Escape([string]$p.title)
  $message = [System.Security.SecurityElement]::Escape([string]$p.message)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$message</text></binding></visual></toast>")
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
  Write-Error ("toast failed: " + $_.Exception.Message)
}

if ($p.html -and (Test-Path -LiteralPath $p.html)) {
  try {
    Start-Process -FilePath $p.html
  } catch {
    Write-Error ("open failed: " + $_.Exception.Message)
  }
}

Remove-Item -LiteralPath $PayloadPath -ErrorAction SilentlyContinue
