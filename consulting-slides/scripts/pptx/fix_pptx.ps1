# Post-process a PPTX written by to_pptx.mjs, using PowerPoint (COM) on Windows.
#  - set Japanese (1041) on every text range so kinsoku (line-breaking rules) apply
#  - texts that were one line in the HTML: turn word wrap off (PowerPoint measures Japanese text wider than Chrome)
#  - texts that were multi-line: shrink-to-fit inside the box
#  - optionally export every slide as PNG (1280x720) for visual verification
#
# usage (from WSL):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File fix_pptx.ps1 -Pptx <win path> -Lines <win path to .lines.json> [-PngDir <win path>]
param(
  [Parameter(Mandatory=$true)][string]$Pptx,
  [Parameter(Mandatory=$true)][string]$Lines,
  [string]$PngDir = ""
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$obj = Get-Content -Raw -Encoding UTF8 $Lines | ConvertFrom-Json
$map = @{}
$obj.PSObject.Properties | ForEach-Object { $map[$_.Name] = [int]$_.Value }

$app = New-Object -ComObject PowerPoint.Application
$pres = $app.Presentations.Open($Pptx, 0, 0, 0)
try {
  $one = 0; $multi = 0; $miss = @()
  foreach ($sl in $pres.Slides) {
    foreach ($sh in $sl.Shapes) {
      if (-not ($sh.HasTextFrame -and $sh.TextFrame.HasText)) { continue }
      $sh.TextFrame2.TextRange.LanguageID = 1041
      $key = ($sh.TextFrame2.TextRange.Text -replace '\s', '')
      if (-not $map.ContainsKey($key)) {
        $miss += ($sl.SlideIndex.ToString() + ':' + $key.Substring(0, [Math]::Min(24, $key.Length)))
        continue
      }
      if ($map[$key] -eq 1) { $sh.TextFrame2.WordWrap = 0; $one++ }
      else { $sh.TextFrame2.AutoSize = 2; $multi++ }
    }
  }
  Write-Output ('wrap off: ' + $one + ' / shrink-to-fit: ' + $multi + ' / unmatched: ' + $miss.Count + '  ' + ($miss -join ' | '))
  $pres.Save()
  if ($PngDir) {
    New-Item -ItemType Directory -Force -Path $PngDir | Out-Null
    for ($i = 1; $i -le $pres.Slides.Count; $i++) {
      $pres.Slides.Item($i).Export((Join-Path $PngDir ('s' + $i.ToString('00') + '.png')), 'PNG', 1280, 720)
    }
    Write-Output ('png: ' + $pres.Slides.Count + ' slides -> ' + $PngDir)
  }
} finally {
  $pres.Close()
  $app.Quit()
}
