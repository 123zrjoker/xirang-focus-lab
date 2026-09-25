param(
  [string]$PythonPath = '.venv-quality\Scripts\python.exe',
  [string]$OutputDirectory = 'artifacts\security'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageJson = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$releaseVersion = [string]$packageJson.version
$resolvedPython = if ([System.IO.Path]::IsPathRooted($PythonPath)) {
  $PythonPath
} else {
  Join-Path $projectRoot $PythonPath
}
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path $projectRoot $OutputDirectory
}
if (-not (Test-Path -LiteralPath $resolvedPython -PathType Leaf)) {
  throw "Quality Python was not found at $resolvedPython. Run npm.cmd run setup:quality first."
}
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$npmAuditPath = Join-Path $resolvedOutput 'npm-audit.json'
$npmSbomPath = Join-Path $resolvedOutput 'npm.cdx.json'
$pythonSbomPath = Join-Path $resolvedOutput 'python.cdx.json'
$summaryPath = Join-Path $resolvedOutput "$releaseVersion-security-audit.md"

Push-Location $projectRoot
try {
  $npmAuditOutput = (& npm.cmd audit --audit-level=high --json 2>&1 | Out-String).Trim()
  $npmAuditExitCode = $LASTEXITCODE
  [System.IO.File]::WriteAllText($npmAuditPath, $npmAuditOutput + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

  $npmSbomOutput = (& npm.cmd sbom --sbom-format=cyclonedx 2>&1 | Out-String).Trim()
  $npmSbomExitCode = $LASTEXITCODE
  [System.IO.File]::WriteAllText($npmSbomPath, $npmSbomOutput + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

  & $resolvedPython -m pip_audit -r server\requirements-build.txt --format cyclonedx-json --output $pythonSbomPath --progress-spinner off --cache-dir desktop-runtime\pip-audit-cache
  $pythonAuditExitCode = $LASTEXITCODE

  $npmCounts = @{ low = 0; moderate = 0; high = 0; critical = 0; total = 0 }
  try {
    $npmAudit = $npmAuditOutput | ConvertFrom-Json
    foreach ($name in @('low', 'moderate', 'high', 'critical', 'total')) {
      $value = $npmAudit.metadata.vulnerabilities.$name
      if ($null -ne $value) { $npmCounts[$name] = [int]$value }
    }
  } catch {
    if ($npmAuditExitCode -eq 0) { throw 'npm audit returned invalid JSON.' }
  }

  $pythonVulnerabilityCount = $null
  if (Test-Path -LiteralPath $pythonSbomPath) {
    try {
      $pythonSbom = Get-Content -LiteralPath $pythonSbomPath -Raw | ConvertFrom-Json
      $pythonVulnerabilityCount = if ($null -eq $pythonSbom.vulnerabilities) {
        0
      } else {
        @($pythonSbom.vulnerabilities).Count
      }
    } catch {
      if ($pythonAuditExitCode -eq 0) { throw 'pip-audit returned invalid CycloneDX JSON.' }
    }
  }

  $passed = $npmAuditExitCode -eq 0 `
    -and $npmSbomExitCode -eq 0 `
    -and $pythonAuditExitCode -eq 0 `
    -and $pythonVulnerabilityCount -eq 0
  $pythonCountText = if ($null -eq $pythonVulnerabilityCount) { 'unknown (tool failed)' } else { [string]$pythonVulnerabilityCount }
  $lines = @(
    "# $releaseVersion Dependency Security Audit and SBOM",
    '',
    "> Executed: $([DateTime]::UtcNow.ToString('o')); gate: $(if ($passed) { 'passed' } else { 'failed' }).",
    '',
    '| Check | Result |',
    '| --- | --- |',
    "| npm audit (including shipped desktop build dependencies) | low=$($npmCounts.low), moderate=$($npmCounts.moderate), high=$($npmCounts.high), critical=$($npmCounts.critical); exit=$npmAuditExitCode |",
    "| npm CycloneDX SBOM | $(if ($npmSbomExitCode -eq 0) { 'generated' } else { 'generation failed' }); exit=$npmSbomExitCode |",
    "| Python pip-audit + CycloneDX SBOM | vulnerabilities=$pythonCountText; exit=$pythonAuditExitCode |",
    '',
    'JSON audit output and SBOMs are not committed; CI preserves them as run artifacts. This Markdown file records the gate summary only.'
  )
  [System.IO.File]::WriteAllLines($summaryPath, $lines, [System.Text.UTF8Encoding]::new($false))

  [pscustomobject]@{
    passed = $passed
    npmAuditExitCode = $npmAuditExitCode
    npmSbomExitCode = $npmSbomExitCode
    pythonAuditExitCode = $pythonAuditExitCode
    npmVulnerabilities = $npmCounts
    pythonVulnerabilities = $pythonVulnerabilityCount
    outputDirectory = $resolvedOutput
  } | ConvertTo-Json

  if (-not $passed) { exit 1 }
} finally {
  Pop-Location
}
