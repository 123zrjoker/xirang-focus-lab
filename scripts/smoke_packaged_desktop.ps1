param([string]$ExecutablePath = '')

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$unpackedRoot = Join-Path $projectRoot 'release\win-unpacked'
$appExe = if ($ExecutablePath) {
  $resolvedExecutable = if ([System.IO.Path]::IsPathRooted($ExecutablePath)) {
    $ExecutablePath
  } else {
    Join-Path $projectRoot $ExecutablePath
  }
  Get-Item -LiteralPath $resolvedExecutable
} else {
  Get-ChildItem -LiteralPath $unpackedRoot -Filter '*.exe' -File |
    Where-Object { $_.Name -notin @('elevate.exe', 'crashpad_handler.exe') } |
    Select-Object -First 1
}
if (-not $appExe) { throw 'Packaged desktop executable was not found.' }

$runtimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("xirang-packaged-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
$rendererDataRoot = Join-Path $runtimeRoot 'renderer-user-data'
$previousDataRoot = $env:XIRANG_DATA_DIR
$previousSmokeExit = $env:XIRANG_DESKTOP_SMOKE_AUTO_EXIT_MS
$env:XIRANG_DATA_DIR = $runtimeRoot
$env:XIRANG_DESKTOP_SMOKE_AUTO_EXIT_MS = '5000'
$process = $null
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$healthyAtSeconds = $null

try {
  $process = Start-Process -FilePath $appExe.FullName -ArgumentList "--user-data-dir=$rendererDataRoot" -PassThru -WindowStyle Hidden
  $logPath = Join-Path $runtimeRoot 'logs\desktop-api.log'
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  $baseUrl = $null
  while ([DateTime]::UtcNow -lt $deadline -and -not $baseUrl) {
    if (Test-Path -LiteralPath $logPath) {
      $records = Get-Content -LiteralPath $logPath | ForEach-Object {
        try { $_ | ConvertFrom-Json } catch { $null }
      }
      $startRecord = $records | Where-Object { $_.event -eq 'service_start' -and $_.launchKind -eq 'packaged-sidecar' } | Select-Object -Last 1
      if ($startRecord) {
        $baseUrl = $startRecord.baseUrl
      } else {
        $match = Select-String -LiteralPath $logPath -Pattern 'starting packaged-sidecar on (http://127\.0\.0\.1:\d+)' | Select-Object -Last 1
        if ($match) { $baseUrl = $match.Matches[0].Groups[1].Value }
      }
    }
    if (-not $baseUrl) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $baseUrl) { throw 'Packaged desktop did not write a sidecar startup record.' }

  $health = $null
  while ([DateTime]::UtcNow -lt $deadline -and -not $health) {
    try { $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 3 }
    catch { Start-Sleep -Milliseconds 350 }
  }
  if (-not $health -or $health.status -ne 'ok') { throw 'Packaged desktop sidecar did not become healthy.' }
  $healthyAtSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
  if ([System.IO.Path]::GetFullPath($health.runtime.dataRoot) -ne [System.IO.Path]::GetFullPath($runtimeRoot)) {
    throw 'Packaged desktop did not propagate its data root.'
  }

  if (-not $process.WaitForExit(20000)) { throw 'Packaged desktop did not complete its automatic graceful exit.' }

  $sidecarStopped = $false
  $stopDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $stopDeadline -and -not $sidecarStopped) {
    try {
      Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 1 | Out-Null
      Start-Sleep -Milliseconds 250
    } catch { $sidecarStopped = $true }
  }
  if (-not $sidecarStopped) { throw 'Sidecar remained reachable after the desktop app exited.' }

  [pscustomobject]@{
    app = $appExe.Name
    version = $health.version
    sidecar = 'packaged-sidecar'
    healthy = $true
    gracefulExit = $true
    sidecarStopped = $true
    rendererDataIsolated = $true
    modelAvailable = $health.index.modelAvailable
    rerankerAvailable = $health.reranker.available
    healthyAtSeconds = $healthyAtSeconds
    totalSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
  } | ConvertTo-Json
} finally {
  $stopwatch.Stop()
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  $env:XIRANG_DATA_DIR = $previousDataRoot
  $env:XIRANG_DESKTOP_SMOKE_AUTO_EXIT_MS = $previousSmokeExit
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedRuntime = [System.IO.Path]::GetFullPath($runtimeRoot)
  if ($resolvedRuntime.StartsWith($tempRoot) -and (Split-Path -Leaf $resolvedRuntime).StartsWith('xirang-packaged-smoke-')) {
    Remove-Item -LiteralPath $resolvedRuntime -Recurse -Force -ErrorAction SilentlyContinue
  }
}
