param([string]$SetupPath = 'release\Xirang-Setup-0.7.0-x64.exe')

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$setupCandidate = if ([System.IO.Path]::IsPathRooted($SetupPath)) {
  $SetupPath
} else {
  Join-Path $projectRoot $SetupPath
}
$setup = Get-Item -LiteralPath $setupCandidate
$smokeParent = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'desktop-runtime'))
$installRoot = [System.IO.Path]::GetFullPath((Join-Path $smokeParent ("installer-smoke-" + [guid]::NewGuid().ToString('N'))))
$installed = $false
$uninstalled = $false
$smoke = $null

function Test-SafeInstallRoot([string]$Path) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $relative = $resolved.Substring($smokeParent.Length).TrimStart('\')
  return $resolved.StartsWith($smokeParent + '\', [System.StringComparison]::OrdinalIgnoreCase) `
    -and $relative.StartsWith('installer-smoke-', [System.StringComparison]::OrdinalIgnoreCase) `
    -and -not $relative.Contains('\')
}

if (-not (Test-SafeInstallRoot $installRoot)) {
  throw 'Installer smoke target is outside the guarded desktop-runtime directory.'
}

try {
  New-Item -ItemType Directory -Path $installRoot | Out-Null
  $installProcess = Start-Process -FilePath $setup.FullName -ArgumentList @('/S', "/D=$installRoot") -PassThru -Wait -WindowStyle Hidden
  if ($installProcess.ExitCode -ne 0) { throw "Silent installer returned exit code $($installProcess.ExitCode)." }

  $appExe = Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File |
    Where-Object { $_.Name -notmatch '^(Uninstall|unins)' } |
    Select-Object -First 1
  if (-not $appExe) { throw 'Installed desktop executable was not found.' }
  $installed = $true

  $smokeOutput = & (Join-Path $PSScriptRoot 'smoke_packaged_desktop.ps1') -ExecutablePath $appExe.FullName
  $smoke = ($smokeOutput -join [Environment]::NewLine) | ConvertFrom-Json
  if (-not $smoke.healthy -or -not $smoke.gracefulExit -or -not $smoke.sidecarStopped) {
    throw 'Installed application smoke assertions did not pass.'
  }

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File |
    Where-Object { $_.Name -match '^(Uninstall|unins)' } |
    Select-Object -First 1
  if (-not $uninstaller) { throw 'NSIS uninstaller was not found.' }
  $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
  if ($uninstallProcess.ExitCode -ne 0) { throw "Silent uninstaller returned exit code $($uninstallProcess.ExitCode)." }

  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline -and (Test-Path -LiteralPath $appExe.FullName)) {
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $appExe.FullName) { throw 'Installed application remained after uninstall.' }
  $uninstalled = $true

  [pscustomobject]@{
    setup = $setup.Name
    installExitCode = $installProcess.ExitCode
    installedApp = $appExe.Name
    appVersion = $smoke.version
    healthy = $smoke.healthy
    modelAvailable = $smoke.modelAvailable
    rerankerAvailable = $smoke.rerankerAvailable
    healthyAtSeconds = $smoke.healthyAtSeconds
    gracefulExit = $smoke.gracefulExit
    sidecarStopped = $smoke.sidecarStopped
    uninstallExitCode = $uninstallProcess.ExitCode
    programFilesRemoved = $true
  } | ConvertTo-Json
} finally {
  if ($installed -and -not $uninstalled -and (Test-Path -LiteralPath $installRoot)) {
    $fallbackUninstaller = Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(Uninstall|unins)' } |
      Select-Object -First 1
    if ($fallbackUninstaller) {
      Start-Process -FilePath $fallbackUninstaller.FullName -ArgumentList '/S' -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
    }
  }
  if ((Test-SafeInstallRoot $installRoot) -and (Test-Path -LiteralPath $installRoot)) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
