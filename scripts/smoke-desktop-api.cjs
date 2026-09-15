const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ApiServiceSupervisor } = require('../electron/api-service.cjs')
const { resolveRuntimePaths } = require('../electron/runtime-paths.cjs')

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const payload = await response.json()
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xirang-desktop-smoke-'))
  const sidecar = process.argv.includes('--sidecar')
  const env = {
    ...process.env,
    XIRANG_DATA_DIR: path.join(temporaryRoot, 'runtime'),
    XIRANG_MODEL_DIR: path.join(projectRoot, '.model-cache'),
    ...(sidecar ? { XIRANG_DESKTOP_BACKEND_DIR: path.join(projectRoot, 'desktop-runtime', 'backend', 'xirang-api') } : {}),
  }
  const app = { getPath: () => path.join(temporaryRoot, 'renderer') }
  const paths = resolveRuntimePaths({
    app,
    appPath: projectRoot,
    resourcesPath: projectRoot,
    isPackaged: sidecar,
    env,
  })
  const supervisor = new ApiServiceSupervisor({ paths, appPath: projectRoot, isPackaged: sidecar, env })
  try {
    const status = await supervisor.start()
    const health = await jsonRequest(`${status.baseUrl}/api/health`)
    if (health.status !== 'ok') throw new Error('health payload did not report ok')
    if (path.resolve(health.runtime.dataRoot) !== path.resolve(paths.dataRoot)) {
      throw new Error('desktop data directory was not propagated to the API')
    }
    const sentinel = 'SMOKE_PRIVATE_SENTINEL'
    const chunks = [{
      id: 'desktop-smoke-focus',
      sourceId: 'desktop-smoke-note',
      sourceTitle: '桌面端烟雾测试',
      heading: '减少干扰',
      content: `专注时把手机放远并关闭非必要通知。${sentinel}`,
      startLine: 1,
      endLine: 1,
      startOffset: 0,
      endOffset: 35,
    }]
    let indexTask = await jsonRequest(`${status.baseUrl}/api/index/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunks }),
    })
    const indexDeadline = Date.now() + 120_000
    while (['queued', 'running', 'cancel_requested'].includes(indexTask.state) && Date.now() < indexDeadline) {
      await delay(250)
      indexTask = await jsonRequest(`${status.baseUrl}/api/index/tasks/current`)
    }
    if (indexTask.state !== 'succeeded') {
      throw new Error(`background index task did not succeed: ${JSON.stringify(indexTask)}`)
    }
    if (JSON.stringify(indexTask).includes(sentinel)) throw new Error('index task status exposed source content')
    const searchBody = JSON.stringify({
      query: '如何减少手机干扰',
      mode: 'vector',
      topK: 3,
      corpusFingerprint: indexTask.result.fingerprint,
    })
    const firstSearch = await jsonRequest(`${status.baseUrl}/api/retrieval/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: searchBody,
    })
    if (firstSearch.results?.[0]?.chunkId !== chunks[0].id) throw new Error('vector search missed the indexed smoke chunk')
    await jsonRequest(`${status.baseUrl}/api/retrieval/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: searchBody,
    })
    const diagnostics = await jsonRequest(`${status.baseUrl}/api/diagnostics`)
    const resultCache = diagnostics.retrieval?.cache?.resultCache
    if (!resultCache || resultCache.hits < 1 || resultCache.capacity !== 64) {
      throw new Error('diagnostics did not report the bounded retrieval result cache')
    }
    process.stdout.write(`${JSON.stringify({
      state: status.state,
      version: health.version,
      baseUrl: status.baseUrl,
      launchKind: status.launchKind,
      modelAvailable: health.index.modelAvailable,
      rerankerAvailable: health.reranker.available,
      backgroundIndex: indexTask.state,
      resultCacheHits: resultCache.hits,
      sidecar,
    }, null, 2)}\n`)
  } finally {
    await supervisor.stop()
    const safePrefix = path.join(os.tmpdir(), 'xirang-desktop-smoke-')
    if (temporaryRoot.startsWith(safePrefix)) fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`)
  process.exitCode = 1
})
