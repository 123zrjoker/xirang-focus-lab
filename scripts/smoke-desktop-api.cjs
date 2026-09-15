const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ApiServiceSupervisor } = require('../electron/api-service.cjs')
const { resolveRuntimePaths } = require('../electron/runtime-paths.cjs')

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
    const response = await fetch(`${status.baseUrl}/api/health`)
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`)
    const health = await response.json()
    if (health.status !== 'ok') throw new Error('health payload did not report ok')
    if (path.resolve(health.runtime.dataRoot) !== path.resolve(paths.dataRoot)) {
      throw new Error('desktop data directory was not propagated to the API')
    }
    process.stdout.write(`${JSON.stringify({
      state: status.state,
      version: health.version,
      baseUrl: status.baseUrl,
      launchKind: status.launchKind,
      modelAvailable: health.index.modelAvailable,
      rerankerAvailable: health.reranker.available,
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
