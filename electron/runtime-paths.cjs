const fs = require('node:fs')
const path = require('node:path')

const API_EXECUTABLE_NAME = process.platform === 'win32' ? 'xirang-api.exe' : 'xirang-api'

function resolveRuntimePaths({ app, appPath, resourcesPath, isPackaged, env = process.env }) {
  const localAppData = String(env.LOCALAPPDATA || '').trim()
  const dataRoot = path.resolve(
    String(env.XIRANG_DATA_DIR || '').trim()
      || (localAppData ? path.join(localAppData, 'Xirang') : path.join(app.getPath('userData'), 'runtime')),
  )
  const modelRoot = path.resolve(
    String(env.XIRANG_MODEL_DIR || '').trim()
      || (isPackaged ? path.join(resourcesPath, 'models') : path.join(appPath, '.model-cache')),
  )
  const backendRoot = path.resolve(
    String(env.XIRANG_DESKTOP_BACKEND_DIR || '').trim()
      || (isPackaged ? path.join(resourcesPath, 'backend', 'xirang-api') : appPath),
  )
  const logRoot = path.join(dataRoot, 'logs')

  return {
    dataRoot,
    modelRoot,
    backendRoot,
    logRoot,
    rendererDataRoot: app.getPath('userData'),
    checkpointPath: path.join(dataRoot, 'agent', 'checkpoints.sqlite3'),
    credentialDir: path.join(dataRoot, 'credentials'),
    vectorIndexDir: path.join(dataRoot, 'retrieval', 'qdrant'),
    vectorMetaPath: path.join(dataRoot, 'retrieval', 'index-meta.json'),
  }
}

function resolveApiLaunch({ paths, appPath, isPackaged, env = process.env, port }) {
  const executableOverride = String(env.XIRANG_DESKTOP_API_EXECUTABLE || '').trim()
  if (executableOverride) {
    return {
      command: path.resolve(executableOverride),
      args: ['--host', '127.0.0.1', '--port', String(port)],
      kind: 'override',
    }
  }

  if (isPackaged) {
    return {
      command: path.join(paths.backendRoot, API_EXECUTABLE_NAME),
      args: ['--host', '127.0.0.1', '--port', String(port)],
      kind: 'packaged-sidecar',
    }
  }

  const pythonOverride = String(env.XIRANG_DESKTOP_PYTHON || '').trim()
  const python = pythonOverride || path.join(appPath, '.venv311', 'Scripts', 'python.exe')
  return {
    command: path.resolve(python),
    args: ['-m', 'server.desktop_entry', '--host', '127.0.0.1', '--port', String(port)],
    kind: 'development-python',
  }
}

function validateApiLaunch(launch) {
  if (!path.isAbsolute(launch.command)) throw new Error('本机 API 启动路径不是绝对路径。')
  if (!fs.existsSync(launch.command)) {
    const hint = launch.kind === 'packaged-sidecar'
      ? '安装包缺少后端 sidecar，请重新安装完整版本。'
      : '未找到 .venv311 Python，请先运行 npm.cmd run setup:api:py311。'
    throw new Error(`${hint}（${launch.command}）`)
  }
}

function buildApiEnvironment(paths, env = process.env) {
  return {
    ...env,
    PYTHONUNBUFFERED: '1',
    XIRANG_DATA_DIR: paths.dataRoot,
    XIRANG_MODEL_DIR: paths.modelRoot,
    XIRANG_AGENT_CHECKPOINT_PATH: paths.checkpointPath,
    XIRANG_CREDENTIAL_DIR: paths.credentialDir,
    XIRANG_VECTOR_INDEX_DIR: paths.vectorIndexDir,
    XIRANG_VECTOR_META_PATH: paths.vectorMetaPath,
  }
}

module.exports = {
  API_EXECUTABLE_NAME,
  buildApiEnvironment,
  resolveApiLaunch,
  resolveRuntimePaths,
  validateApiLaunch,
}
