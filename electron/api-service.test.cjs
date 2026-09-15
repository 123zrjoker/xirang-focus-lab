const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { test } = require('node:test')
const { ApiServiceSupervisor, findAvailablePort } = require('./api-service.cjs')
const { buildApiEnvironment, resolveApiLaunch, resolveRuntimePaths } = require('./runtime-paths.cjs')

function fakeApp(userData = path.join(os.tmpdir(), 'xirang-renderer-test')) {
  return { getPath: (name) => name === 'userData' ? userData : os.tmpdir() }
}

test('runtime paths keep mutable service data outside application resources', () => {
  const paths = resolveRuntimePaths({
    app: fakeApp(),
    appPath: 'C:\\Program Files\\Xirang\\resources\\app.asar',
    resourcesPath: 'C:\\Program Files\\Xirang\\resources',
    isPackaged: true,
    env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
  })
  assert.equal(paths.dataRoot, path.resolve('C:\\Users\\tester\\AppData\\Local\\Xirang'))
  assert.equal(paths.modelRoot, path.resolve('C:\\Program Files\\Xirang\\resources\\models'))
  assert.ok(paths.checkpointPath.endsWith(path.join('agent', 'checkpoints.sqlite3')))
  assert.ok(paths.credentialDir.endsWith('credentials'))
})

test('packaged launch uses the bundled sidecar and loopback arguments', () => {
  const paths = { backendRoot: path.resolve('C:\\Program Files\\Xirang\\resources\\backend\\xirang-api') }
  const launch = resolveApiLaunch({ paths, appPath: 'unused', isPackaged: true, env: {}, port: 43123 })
  assert.equal(launch.kind, 'packaged-sidecar')
  assert.deepEqual(launch.args, ['--host', '127.0.0.1', '--port', '43123'])
  assert.ok(launch.command.endsWith(process.platform === 'win32' ? 'xirang-api.exe' : 'xirang-api'))
})

test('service environment isolates checkpoint, credentials and vector index', () => {
  const paths = {
    dataRoot: 'data-root', modelRoot: 'models', checkpointPath: 'checkpoint', credentialDir: 'credentials',
    vectorIndexDir: 'vectors', vectorMetaPath: 'meta',
  }
  const environment = buildApiEnvironment(paths, { EXISTING: 'kept' })
  assert.equal(environment.EXISTING, 'kept')
  assert.equal(environment.XIRANG_AGENT_CHECKPOINT_PATH, 'checkpoint')
  assert.equal(environment.XIRANG_CREDENTIAL_DIR, 'credentials')
  assert.equal(environment.XIRANG_VECTOR_INDEX_DIR, 'vectors')
})

test('supervisor publishes ready and stopped states', async () => {
  const child = new EventEmitter()
  child.pid = 1234
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  const root = path.join(os.tmpdir(), `xirang-supervisor-${process.pid}`)
  const supervisor = new ApiServiceSupervisor({
    paths: {
      dataRoot: root,
      modelRoot: root,
      backendRoot: root,
      logRoot: root,
      checkpointPath: path.join(root, 'checkpoint.sqlite3'),
      credentialDir: path.join(root, 'credentials'),
      vectorIndexDir: path.join(root, 'vectors'),
      vectorMetaPath: path.join(root, 'meta.json'),
    },
    appPath: process.cwd(),
    isPackaged: false,
    env: { XIRANG_DESKTOP_API_EXECUTABLE: process.execPath },
    spawnProcess: () => child,
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
  })
  const states = []
  supervisor.on('status', (status) => states.push(status.state))
  await supervisor.start()
  assert.equal(supervisor.snapshot().state, 'ready')
  assert.equal(supervisor.snapshot().pid, 1234)
  await supervisor.stop()
  assert.equal(supervisor.snapshot().state, 'stopped')
  assert.ok(states.includes('starting'))
  assert.ok(states.includes('ready'))
})

test('packaged supervisor uses the resources directory instead of app.asar as cwd', async () => {
  const child = new EventEmitter()
  child.pid = 4321
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 0, null))
    return true
  }
  let spawnOptions = null
  const resources = path.join(os.tmpdir(), `xirang-packaged-${process.pid}`)
  const backendRoot = path.join(resources, 'backend', 'xirang-api')
  const executable = path.join(backendRoot, process.platform === 'win32' ? 'xirang-api.exe' : 'xirang-api')
  fs.mkdirSync(backendRoot, { recursive: true })
  fs.writeFileSync(executable, '')
  const supervisor = new ApiServiceSupervisor({
    paths: {
      dataRoot: resources, modelRoot: resources, backendRoot, logRoot: resources,
      checkpointPath: path.join(resources, 'checkpoint'), credentialDir: path.join(resources, 'credentials'),
      vectorIndexDir: path.join(resources, 'vectors'), vectorMetaPath: path.join(resources, 'meta'),
    },
    appPath: path.join(resources, 'app.asar'),
    isPackaged: true,
    spawnProcess: (_command, _args, options) => { spawnOptions = options; return child },
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
  })
  await supervisor.start()
  assert.equal(spawnOptions.cwd, resources)
  await supervisor.stop()
  fs.rmSync(resources, { recursive: true, force: true })
})

test('available-port probe returns an unprivileged TCP port', async () => {
  const port = await findAvailablePort()
  assert.ok(port > 1024 && port <= 65535)
})

test('spawn errors fail fast instead of waiting for the startup timeout', async () => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const root = path.join(os.tmpdir(), `xirang-spawn-error-${process.pid}`)
  const supervisor = new ApiServiceSupervisor({
    paths: {
      dataRoot: root, modelRoot: root, backendRoot: root, logRoot: root,
      checkpointPath: path.join(root, 'checkpoint'), credentialDir: path.join(root, 'credentials'),
      vectorIndexDir: path.join(root, 'vectors'), vectorMetaPath: path.join(root, 'meta'),
    },
    appPath: process.cwd(),
    isPackaged: false,
    env: { XIRANG_DESKTOP_API_EXECUTABLE: process.execPath },
    spawnProcess: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn denied')))
      return child
    },
    fetchImpl: async () => { throw new Error('not ready') },
  })
  await assert.rejects(supervisor.start(), /spawn denied/)
  assert.equal(supervisor.snapshot().state, 'failed')
  await supervisor.waitForLogClose()
  fs.rmSync(root, { recursive: true, force: true })
})

test('lifecycle operations are serialized and logs are structured JSON lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xirang-lifecycle-'))
  const children = []
  const supervisor = new ApiServiceSupervisor({
    paths: {
      dataRoot: root, modelRoot: root, backendRoot: root, logRoot: root,
      checkpointPath: path.join(root, 'checkpoint'), credentialDir: path.join(root, 'credentials'),
      vectorIndexDir: path.join(root, 'vectors'), vectorMetaPath: path.join(root, 'meta'),
    },
    appPath: process.cwd(),
    isPackaged: false,
    env: { XIRANG_DESKTOP_API_EXECUTABLE: process.execPath },
    spawnProcess: () => {
      const child = new EventEmitter()
      child.pid = 5000 + children.length
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {
        queueMicrotask(() => child.emit('exit', 0, null))
        return true
      }
      children.push(child)
      return child
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
  })

  await supervisor.start()
  await Promise.all([supervisor.restart(), supervisor.restart()])
  assert.equal(supervisor.snapshot().state, 'ready')
  assert.equal(children.length, 3)
  await supervisor.stop()
  assert.equal(supervisor.snapshot().state, 'stopped')

  const records = fs.readFileSync(path.join(root, 'desktop-api.log'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line))
  assert.equal(records.filter((record) => record.event === 'service_start').length, 3)
  assert.equal(records.filter((record) => record.event === 'process_exit').length, 3)
  assert.ok(records.every((record) => typeof record.timestamp === 'string'))
  fs.rmSync(root, { recursive: true, force: true })
})
