$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$modelDirectory = Join-Path $projectRoot ".model-cache\bge-small-zh-v1.5"
$revision = "7999e1d3359715c523056ef9478215996d62a620"
$expectedSha256 = "354763b9b1357bc9c44f62c6be2276321081ed2567773608c0d0785b61d5a026"
$rerankerDirectory = Join-Path $projectRoot ".model-cache\mmarco-mMiniLMv2-L12-H384-v1"
$rerankerRevision = "1427fd652930e4ba29e8149678df786c240d8825"
$rerankerExpectedSha256 = "6c2513767fb63d008a4377bef7a7a3555433d9436342bb53e35a3a72ffc52d4b"

if (-not (Get-Command hf -ErrorAction SilentlyContinue)) {
  throw "未找到 hf CLI。请先安装 server/requirements.txt。"
}

hf download BAAI/bge-small-zh-v1.5 `
  --revision $revision `
  --local-dir $modelDirectory `
  --exclude "*.bin" "*.onnx" "onnx/*" "openvino/*" "*.msgpack" "*.h5" `
  --max-workers 2

$weights = Join-Path $modelDirectory "model.safetensors"
if (-not (Test-Path -LiteralPath $weights)) {
  throw "模型权重下载不完整：$weights"
}

$actualSha256 = (Get-FileHash -LiteralPath $weights -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "模型 SHA-256 校验失败。期望 $expectedSha256，实际 $actualSha256。"
}

Write-Host "BGE 模型已准备完成：$modelDirectory"
Write-Host "SHA-256：$actualSha256"

hf download cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 `
  README.md config.json sentencepiece.bpe.model special_tokens_map.json tokenizer.json tokenizer_config.json onnx/model_quint8_avx2.onnx `
  --revision $rerankerRevision `
  --local-dir $rerankerDirectory `
  --max-workers 2

$rerankerWeights = Join-Path $rerankerDirectory "onnx\model_quint8_avx2.onnx"
if (-not (Test-Path -LiteralPath $rerankerWeights)) {
  throw "重排模型下载不完整：$rerankerWeights"
}

$rerankerActualSha256 = (Get-FileHash -LiteralPath $rerankerWeights -Algorithm SHA256).Hash.ToLowerInvariant()
if ($rerankerActualSha256 -ne $rerankerExpectedSha256) {
  throw "重排模型 SHA-256 校验失败。期望 $rerankerExpectedSha256，实际 $rerankerActualSha256。"
}

Write-Host "多语言 Cross-Encoder 已准备完成：$rerankerDirectory"
Write-Host "SHA-256：$rerankerActualSha256"
