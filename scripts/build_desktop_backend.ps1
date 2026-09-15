param([switch]$ReuseExisting)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv311\Scripts\python.exe'
$outputRoot = Join-Path $projectRoot 'desktop-runtime'
$distRoot = Join-Path $outputRoot 'backend'
$workRoot = Join-Path $outputRoot 'build'
$specRoot = Join-Path $outputRoot 'spec'
$executable = Join-Path $distRoot 'xirang-api\xirang-api.exe'

if (-not (Test-Path -LiteralPath $python)) {
  throw 'Missing .venv311. Run npm.cmd run setup:api:py311 first.'
}

if (-not ($ReuseExisting -and (Test-Path -LiteralPath $executable))) {
  & $python -c 'import PyInstaller' 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller is missing. Install server/requirements-build.txt first.'
  }

  New-Item -ItemType Directory -Force -Path $distRoot, $workRoot, $specRoot | Out-Null

  $arguments = @(
    '-m', 'PyInstaller',
    '--noconfirm', '--clean', '--onedir',
    '--name', 'xirang-api',
    '--distpath', $distRoot,
    '--workpath', $workRoot,
    '--specpath', $specRoot,
    '--paths', $projectRoot,
    '--hidden-import', 'server.main',
    '--hidden-import', 'langgraph.checkpoint.sqlite',
    '--collect-all', 'jieba',
    '--collect-all', 'qdrant_client',
    '--collect-all', 'sentence_transformers',
    '--collect-all', 'transformers',
    '--collect-all', 'uvicorn',
    (Join-Path $projectRoot 'server\desktop_entry.py')
  )

  & $python @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Desktop API sidecar build failed.' }
}

if (-not (Test-Path -LiteralPath $executable)) {
  throw "Desktop API sidecar was not found: $executable"
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($executable)
try {
  $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
} finally {
  $stream.Dispose()
  $sha256.Dispose()
}
Write-Host "Desktop API sidecar: $executable"
Write-Host "Entry SHA-256: $hash"
