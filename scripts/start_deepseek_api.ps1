param(
    [string]$Model = "deepseek-v4-flash",
    [string]$BaseUrl = "https://api.deepseek.com"
)

$ErrorActionPreference = "Stop"

try {
    $existingApi = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue
    if ($existingApi) {
        throw "Port 8000 is already in use. Stop the current API process before starting the DeepSeek API."
    }

    $env:DEEPSEEK_MODEL = $Model
    $env:DEEPSEEK_BASE_URL = $BaseUrl
    if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
        Write-Host "The API will use the encrypted DeepSeek Key saved from the Xirang settings page. Model: $Model"
    }
    else {
        Write-Host "The explicit DEEPSEEK_API_KEY environment variable overrides the saved credential for this startup. Model: $Model"
    }
    $pythonExecutable = Join-Path $PSScriptRoot "..\.venv311\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $pythonExecutable)) {
        throw "Python 3.11 项目环境不存在。请先运行 npm run setup:api:py311。"
    }
    & $pythonExecutable -m uvicorn server.main:app --host 127.0.0.1 --port 8000
    if ($LASTEXITCODE -ne 0) {
        throw "The local API process exited with code $LASTEXITCODE."
    }
}
catch {
    throw
}
