param(
  [string]$BaselineSetupPath = 'release-candidate\0.8.0\Xirang-Setup-0.8.0-x64.exe',
  [string]$CandidateSetupPath = 'release-candidate\0.9.0\Xirang-Setup-0.9.0-x64.exe'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$smokeParent = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'desktop-runtime'))
$smokeToken = [guid]::NewGuid().ToString('N')
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $smokeParent ("upgrade-smoke-" + $smokeToken)))
$installRoot = Join-Path $workspaceRoot 'app'
$temporaryParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$dataWorkspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $temporaryParent ("xirang-upgrade-smoke-" + $smokeToken)))
$runtimeRoot = Join-Path $dataWorkspaceRoot 'runtime'
$rendererDataRoot = Join-Path $dataWorkspaceRoot 'renderer-user-data'
$checkpointPath = Join-Path $runtimeRoot 'agent\checkpoints.sqlite3'
$rendererMarkerPath = Join-Path $rendererDataRoot 'upgrade-smoke-marker.txt'
$threadId = 'upgrade-smoke-thread'
$baselineLaunch = $null
$candidateLaunch = $null
$installed = $false
$uninstalled = $false

$previousDataRoot = $env:XIRANG_DATA_DIR
$previousSmokeExit = $env:XIRANG_DESKTOP_SMOKE_AUTO_EXIT_MS
$previousDeepSeekKey = $env:DEEPSEEK_API_KEY
$previousXirangAiKey = $env:XIRANG_AI_API_KEY

function Resolve-ProjectPath([string]$Path) {
  $candidate = if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $projectRoot $Path }
  return (Get-Item -LiteralPath $candidate).FullName
}

function Test-SafeWorkspaceRoot([string]$Path) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $relative = $resolved.Substring($smokeParent.Length).TrimStart('\')
  return $resolved.StartsWith($smokeParent + '\', [System.StringComparison]::OrdinalIgnoreCase) `
    -and $relative.StartsWith('upgrade-smoke-', [System.StringComparison]::OrdinalIgnoreCase) `
    -and -not $relative.Contains('\')
}

function Test-SafeDataWorkspaceRoot([string]$Path) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $relative = $resolved.Substring($temporaryParent.Length).TrimStart('\')
  return $resolved.StartsWith($temporaryParent + '\', [System.StringComparison]::OrdinalIgnoreCase) `
    -and $relative.StartsWith('xirang-upgrade-smoke-', [System.StringComparison]::OrdinalIgnoreCase) `
    -and -not $relative.Contains('\')
}

function Find-InstalledApp {
  $app = Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File |
    Where-Object { $_.Name -notmatch '^(Uninstall|unins|elevate|crashpad_handler)' } |
    Select-Object -First 1
  if (-not $app) { throw 'Installed desktop executable was not found.' }
  return $app
}

function Get-ServiceStartRecords([string]$LogPath) {
  if (-not (Test-Path -LiteralPath $LogPath)) { return @() }
  return @(
    Get-Content -LiteralPath $LogPath | ForEach-Object {
      try { $_ | ConvertFrom-Json } catch { $null }
    } | Where-Object { $_.event -eq 'service_start' -and $_.launchKind -eq 'packaged-sidecar' }
  )
}

function Start-SmokeApp([System.IO.FileInfo]$App, [string]$ExpectedVersion) {
  $logPath = Join-Path $runtimeRoot 'logs\desktop-api.log'
  $previousStartCount = @(Get-ServiceStartRecords $logPath).Count
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $App.FullName -ArgumentList "--user-data-dir=$rendererDataRoot" -PassThru -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  $baseUrl = $null

  while ([DateTime]::UtcNow -lt $deadline -and -not $baseUrl) {
    $records = @(Get-ServiceStartRecords $logPath)
    if ($records.Count -gt $previousStartCount) { $baseUrl = $records[-1].baseUrl }
    if (-not $baseUrl) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $baseUrl) { throw "$ExpectedVersion did not write a sidecar startup record." }

  $health = $null
  while ([DateTime]::UtcNow -lt $deadline -and -not $health) {
    try { $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 3 }
    catch { Start-Sleep -Milliseconds 350 }
  }
  if (-not $health -or $health.status -ne 'ok') { throw "$ExpectedVersion sidecar did not become healthy." }
  if ($health.version -ne $ExpectedVersion) { throw "Expected runtime $ExpectedVersion but received $($health.version)." }
  if ($health.apiContractVersion -ne '1') { throw "Expected API contract 1 but received $($health.apiContractVersion)." }
  if ([System.IO.Path]::GetFullPath($health.runtime.dataRoot) -ne [System.IO.Path]::GetFullPath($runtimeRoot)) {
    throw "$ExpectedVersion did not use the guarded upgrade data root. Expected '$runtimeRoot'; received '$($health.runtime.dataRoot)'."
  }

  $stopwatch.Stop()
  return [pscustomobject]@{
    Process = $process
    BaseUrl = $baseUrl
    Health = $health
    HealthyAtSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
  }
}

function Complete-SmokeApp($Launch, [string]$Version) {
  if (-not $Launch.Process.WaitForExit(40000)) { throw "$Version did not complete its automatic graceful exit." }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $sidecarStopped = $false
  while ([DateTime]::UtcNow -lt $deadline -and -not $sidecarStopped) {
    try {
      Invoke-RestMethod -Uri "$($Launch.BaseUrl)/api/health" -TimeoutSec 1 | Out-Null
      Start-Sleep -Milliseconds 250
    } catch { $sidecarStopped = $true }
  }
  if (-not $sidecarStopped) { throw "$Version sidecar remained reachable after the desktop app exited." }
  return $true
}

function Invoke-JsonApi(
  [string]$Uri,
  [ValidateSet('Get', 'Post', 'Put', 'Delete')][string]$Method = 'Get',
  $Body = $null,
  [int]$TimeoutSec = 30
) {
  $parameters = @{ Uri = $Uri; Method = $Method; TimeoutSec = $TimeoutSec }
  if ($null -ne $Body) {
    $parameters.ContentType = 'application/json'
    $parameters.Body = $Body | ConvertTo-Json -Depth 12 -Compress
  }
  return Invoke-RestMethod @parameters
}

function Install-Version([string]$SetupPath) {
  $setup = Get-Item -LiteralPath $SetupPath
  $process = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$installRoot") -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "$($setup.Name) returned exit code $($process.ExitCode)." }
  return $process.ExitCode
}

function Stop-TrackedProcess($Launch) {
  if ($Launch -and $Launch.Process -and -not $Launch.Process.HasExited) {
    Stop-Process -Id $Launch.Process.Id -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-SafeWorkspaceRoot $workspaceRoot)) {
  throw 'Upgrade smoke target is outside the guarded desktop-runtime directory.'
}
if (-not (Test-SafeDataWorkspaceRoot $dataWorkspaceRoot)) {
  throw 'Upgrade smoke data target is outside the guarded system temporary directory.'
}

$baselineSetup = Resolve-ProjectPath $BaselineSetupPath
$candidateSetup = Resolve-ProjectPath $CandidateSetupPath
$python = Get-Item -LiteralPath (Join-Path $projectRoot '.venv311\Scripts\python.exe')
$fixtureScript = Get-Item -LiteralPath (Join-Path $PSScriptRoot 'seed_upgrade_checkpoint.py')

try {
  New-Item -ItemType Directory -Path $installRoot, $runtimeRoot, $rendererDataRoot | Out-Null

  $fixtureOutput = & $python.FullName $fixtureScript.FullName --path $checkpointPath --thread-id $threadId
  if ($LASTEXITCODE -ne 0) { throw 'Unable to seed the Agent upgrade checkpoint.' }
  $fixture = ($fixtureOutput -join [Environment]::NewLine) | ConvertFrom-Json

  $env:XIRANG_DATA_DIR = $runtimeRoot
  $env:XIRANG_DESKTOP_SMOKE_AUTO_EXIT_MS = '30000'
  $env:DEEPSEEK_API_KEY = ''
  $env:XIRANG_AI_API_KEY = ''

  $baselineInstallExit = Install-Version $baselineSetup
  $installed = $true
  $baselineApp = Find-InstalledApp
  $baselineLaunch = Start-SmokeApp $baselineApp '0.8.0'

  $baselineAgent = Invoke-JsonApi "$($baselineLaunch.BaseUrl)/api/agent/threads/$threadId"
  if ($baselineAgent.runId -ne $fixture.runId -or $baselineAgent.status -ne $fixture.status) {
    throw '0.8.0 could not recover the seeded Agent checkpoint.'
  }

  $credentialRequest = @{
    Uri = "$($baselineLaunch.BaseUrl)/api/settings/ai-provider/deepseek/credential"
    Method = 'Put'
    Body = @{ apiKey = 'upgrade-smoke-placeholder-key' }
  }
  $credential = Invoke-JsonApi @credentialRequest
  if (-not $credential.configured -or $credential.credentialSource -ne 'windows_dpapi_current_user') {
    throw '0.8.0 did not persist the smoke credential with Windows DPAPI.'
  }

  $chunks = @(@{
    id = 'upgrade-smoke-focus'
    sourceId = 'upgrade-smoke-note'
    sourceTitle = 'Desktop upgrade acceptance'
    heading = 'Data retention'
    content = 'An in-place upgrade must retain the local vector index, credential, and Agent checkpoint.'
    startLine = 1
    endLine = 1
    startOffset = 0
    endOffset = 89
  })
  $baselineIndex = Invoke-JsonApi "$($baselineLaunch.BaseUrl)/api/index/sync" -Method Post -Body @{ chunks = $chunks } -TimeoutSec 120
  if (-not $baselineIndex.fingerprint -or $baselineIndex.chunkCount -ne 1) {
    throw '0.8.0 did not build the upgrade smoke vector index.'
  }

  $baselineSidecarStopped = Complete-SmokeApp $baselineLaunch '0.8.0'
  [System.IO.File]::WriteAllText($rendererMarkerPath, 'xirang-upgrade-smoke-renderer-marker')

  $credentialPath = Join-Path $runtimeRoot 'credentials\deepseek.json'
  $indexMetaPath = Join-Path $runtimeRoot 'retrieval\index-meta.json'
  foreach ($requiredPath in @($checkpointPath, $credentialPath, $indexMetaPath, $rendererMarkerPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Upgrade fixture was not persisted: $requiredPath"
    }
  }
  $credentialHashBefore = (Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256).Hash
  $rendererMarkerHashBefore = (Get-FileHash -LiteralPath $rendererMarkerPath -Algorithm SHA256).Hash

  $candidateInstallExit = Install-Version $candidateSetup
  $candidateApp = Find-InstalledApp
  $candidateLaunch = Start-SmokeApp $candidateApp '0.9.0'

  $candidateCredential = Invoke-JsonApi "$($candidateLaunch.BaseUrl)/api/settings/ai-provider/deepseek/credential"
  $candidateIndex = Invoke-JsonApi "$($candidateLaunch.BaseUrl)/api/index/status"
  $candidateAgent = Invoke-JsonApi "$($candidateLaunch.BaseUrl)/api/agent/threads/$threadId"

  $credentialPreserved = $candidateCredential.configured `
    -and $candidateCredential.credentialSource -eq 'windows_dpapi_current_user' `
    -and (Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256).Hash -eq $credentialHashBefore
  $indexPreserved = $candidateIndex.ready `
    -and $candidateIndex.fingerprint -eq $baselineIndex.fingerprint `
    -and $candidateIndex.chunkCount -eq $baselineIndex.chunkCount
  $checkpointPreserved = $candidateAgent.runId -eq $baselineAgent.runId `
    -and $candidateAgent.status -eq $baselineAgent.status `
    -and $candidateAgent.graphVersion -eq $baselineAgent.graphVersion
  $rendererDataPreserved = (Test-Path -LiteralPath $rendererMarkerPath -PathType Leaf) `
    -and (Get-FileHash -LiteralPath $rendererMarkerPath -Algorithm SHA256).Hash -eq $rendererMarkerHashBefore

  if (-not $credentialPreserved) { throw 'DPAPI credential was not preserved across the upgrade.' }
  if (-not $indexPreserved) { throw 'Vector index was not preserved across the upgrade.' }
  if (-not $checkpointPreserved) { throw 'Agent checkpoint was not preserved across the upgrade.' }
  if (-not $rendererDataPreserved) { throw 'Renderer user-data marker was not preserved across the upgrade.' }

  $candidateSidecarStopped = Complete-SmokeApp $candidateLaunch '0.9.0'

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File |
    Where-Object { $_.Name -match '^(Uninstall|unins)' } |
    Select-Object -First 1
  if (-not $uninstaller) { throw 'NSIS uninstaller was not found after the upgrade.' }
  $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  if ($uninstallProcess.ExitCode -ne 0) { throw "Silent uninstaller returned exit code $($uninstallProcess.ExitCode)." }

  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline -and (Test-Path -LiteralPath $candidateApp.FullName)) {
    Start-Sleep -Milliseconds 250
  }
  $programFilesRemoved = -not (Test-Path -LiteralPath $candidateApp.FullName)
  $userDataRetainedAfterUninstall = (Test-Path -LiteralPath $checkpointPath -PathType Leaf) `
    -and (Test-Path -LiteralPath $credentialPath -PathType Leaf) `
    -and (Test-Path -LiteralPath $indexMetaPath -PathType Leaf) `
    -and (Test-Path -LiteralPath $rendererMarkerPath -PathType Leaf)
  if (-not $programFilesRemoved) { throw 'Installed application remained after the upgraded version was uninstalled.' }
  if (-not $userDataRetainedAfterUninstall) { throw 'Uninstall removed data that must remain under the user-data boundary.' }
  $uninstalled = $true

  [pscustomobject]@{
    baselineSetup = (Split-Path -Leaf $baselineSetup)
    candidateSetup = (Split-Path -Leaf $candidateSetup)
    baselineInstallExitCode = $baselineInstallExit
    candidateInstallExitCode = $candidateInstallExit
    baselineVersion = $baselineLaunch.Health.version
    upgradedVersion = $candidateLaunch.Health.version
    apiContractVersion = $candidateLaunch.Health.apiContractVersion
    baselineHealthyAtSeconds = $baselineLaunch.HealthyAtSeconds
    candidateHealthyAtSeconds = $candidateLaunch.HealthyAtSeconds
    baselineGracefulExit = $true
    candidateGracefulExit = $true
    baselineSidecarStopped = $baselineSidecarStopped
    candidateSidecarStopped = $candidateSidecarStopped
    credentialPreserved = $credentialPreserved
    indexPreserved = $indexPreserved
    indexFingerprint = $candidateIndex.fingerprint
    checkpointPreserved = $checkpointPreserved
    checkpointGraphVersion = $candidateAgent.graphVersion
    rendererDataPreserved = $rendererDataPreserved
    uninstallExitCode = $uninstallProcess.ExitCode
    programFilesRemoved = $programFilesRemoved
    userDataRetainedAfterUninstall = $userDataRetainedAfterUninstall
  } | ConvertTo-Json
} finally {
  Stop-TrackedProcess $baselineLaunch
  Stop-TrackedProcess $candidateLaunch

  if ($installed -and -not $uninstalled -and (Test-Path -LiteralPath $installRoot)) {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path -and $_.Path.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    $fallbackUninstaller = Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(Uninstall|unins)' } |
      Select-Object -First 1
    if ($fallbackUninstaller) {
      Start-Process -FilePath $fallbackUninstaller.FullName -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    }
  }

  $env:XIRANG_DATA_DIR = $previousDataRoot
  $env:XIRANG_DESKTOP_SMOKE_AUTO_EXIT_MS = $previousSmokeExit
  $env:DEEPSEEK_API_KEY = $previousDeepSeekKey
  $env:XIRANG_AI_API_KEY = $previousXirangAiKey

  if ((Test-SafeWorkspaceRoot $workspaceRoot) -and (Test-Path -LiteralPath $workspaceRoot)) {
    Remove-Item -LiteralPath $workspaceRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ((Test-SafeDataWorkspaceRoot $dataWorkspaceRoot) -and (Test-Path -LiteralPath $dataWorkspaceRoot)) {
    Remove-Item -LiteralPath $dataWorkspaceRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
