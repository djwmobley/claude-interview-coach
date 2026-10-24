# Report fallback delivery (bin/remind.js, src/core/report-fallback.js): shows a Windows toast naming the
# problem and the report path, then opens the HTML report in the default browser. Invoked as
#   powershell -NoProfile -File scripts/report-fallback.ps1 <payload.json>
# (never an encoded command). The payload is a small JSON file: { title, message, html }; html may be null.
# Each step is independent: a toast failure does not stop the browser open. Leftover payload files are
# pruned by src/core/report-fallback.js on its next run.
$payloadFile = $args[0]
$ErrorActionPreference = 'Continue'
$data = Get-Content -Raw -LiteralPath $payloadFile | ConvertFrom-Json

try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $title = [System.Security.SecurityElement]::Escape([string]$data.title)
  $message = [System.Security.SecurityElement]::Escape([string]$data.message)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$message</text></binding></visual></toast>")
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
  Write-Error ("toast failed: " + $_.Exception.Message)
  exit 2
}

if ($data.html) {
  if (Test-Path -LiteralPath $data.html) {
    Invoke-Item -LiteralPath $data.html
  }
}
