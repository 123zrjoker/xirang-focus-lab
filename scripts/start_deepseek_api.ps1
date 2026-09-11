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
        throw "8000 端口已有服务运行。请先停止当前 npm run dev:api，再启动 DeepSeek 后端。"
    }

    if ([string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY)) {
        Write-Host "请输入 DeepSeek API Key（输入不会显示，也不会写入文件）："
        $secureKey = Read-Host -AsSecureString
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
        if ([string]::IsNullOrWhiteSpace($plainKey)) {
            throw "DeepSeek API Key 不能为空。"
        }
        $env:DEEPSEEK_API_KEY = $plainKey
        $keyWasPrompted = $true
        $plainKey = $null
    }

    $env:DEEPSEEK_MODEL = $Model
    $env:DEEPSEEK_BASE_URL = $BaseUrl
    Write-Host "DeepSeek 凭据仅注入当前后端进程；模型：$Model"
    python -m uvicorn server.main:app --host 127.0.0.1 --port 8000
    if ($LASTEXITCODE -ne 0) {
        throw "本地 API 服务退出，代码：$LASTEXITCODE"
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
