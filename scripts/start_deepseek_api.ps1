param(
    [string]$Model = "deepseek-v4-flash",
    [string]$BaseUrl = "https://api.deepseek.com"
)

$ErrorActionPreference = "Stop"
$keyPointer = [IntPtr]::Zero
$keyWasPrompted = $false

try {
    $existingApi = Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue
    if ($existingApi) {
        throw "Port 8000 is already in use. Stop the current API process before starting the DeepSeek API."
    }

    if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
        Write-Host "Enter the DeepSeek API Key. Input is hidden and is not written to a file:"
        $secureKey = Read-Host -AsSecureString
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        if ([string]::IsNullOrWhiteSpace($plainKey)) {
            throw "The DeepSeek API Key cannot be empty."
        }
        $env:DEEPSEEK_API_KEY = $plainKey
        $keyWasPrompted = $true
        $plainKey = $null
    }

    $env:DEEPSEEK_MODEL = $Model
    $env:DEEPSEEK_BASE_URL = $BaseUrl
    Write-Host "The DeepSeek credential is available only to this API process. Model: $Model"
    python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
    if ($LASTEXITCODE -ne 0) {
        throw "The local API process exited with code $LASTEXITCODE."
    }
}
finally {
    if ($keyPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    }
    if ($keyWasPrompted) {
        Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
    }
}
