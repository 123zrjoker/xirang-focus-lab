const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const {
  buildApiEnvironment,
  resolveApiLaunch,
  validateApiLaunch,
} = require('./runtime-paths.cjs')

const LOOPBACK_HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 90_000
const HEALTH_INTERVAL_MS = 350
const SHUTDOWN_TIMEOUT_MS = 5_000

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function findAvailablePort(host = LOOPBACK_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else if (!port) reject(new Error('无法分配本机 API 端口。'))
        else resolve(port)
      })
    })
  })
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error || '未知错误')
}

function writeStructuredLog(stream, event, details = {}) {
  stream.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...details,
  })}\n`)
}

class ApiServiceSupervisor extends EventEmitter {
  constructor({ paths, appPath, isPackaged, env = process.env, spawnProcess = spawn, fetchImpl = globalThis.fetch }) {
    super()
    this.paths = paths
    this.appPath = appPath
    this.isPackaged = isPackaged
    this.env = env
    this.spawnProcess = spawnProcess
    this.fetchImpl = fetchImpl
    this.child = null
    this.logStream = null
    this.port = null
    this.baseUrl = null
    this.stopRequested = false
    this.processError = null
    this.operation = null
    this.status = {
      state: 'stopped',
      baseUrl: null,
      port: null,
      pid: null,
      launchKind: null,
      startedAt: null,
      readyAt: null,
      error: null,
    }
  }

  snapshot() {
    return { ...this.status }
  }

  update(patch) {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.snapshot())
  }

  async prepare() {
    fs.mkdirSync(this.paths.logRoot, { recursive: true })
    if (!this.port) this.port = await findAvailablePort()
    this.baseUrl = `http://${LOOPBACK_HOST}:${this.port}`
    this.update({ baseUrl: this.baseUrl, port: this.port })
    return this.snapshot()
  }

  async start() {
    return this.enqueue(() => this.startInternal())
  }

  enqueue(operation) {
    const previous = this.operation
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation)
    this.operation = current
    return current.finally(() => {
      if (this.operation === current) this.operation = null
    })
  }

  async startInternal() {
    if (this.child && ['starting', 'ready'].includes(this.status.state)) return this.snapshot()
    await this.prepare()
    const launch = resolveApiLaunch({
      paths: this.paths,
      appPath: this.appPath,
      isPackaged: this.isPackaged,
      env: this.env,
      port: this.port,
    })
    this.stopRequested = false
    this.processError = null
    try {
      validateApiLaunch(launch)
      const logPath = path.join(this.paths.logRoot, 'desktop-api.log')
      const logStream = fs.createWriteStream(logPath, { flags: 'a' })
      this.logStream = logStream
      writeStructuredLog(logStream, 'service_start', {
        launchKind: launch.kind,
        baseUrl: this.baseUrl,
      })
      const child = this.spawnProcess(launch.command, launch.args, {
        cwd: this.isPackaged ? path.dirname(this.appPath) : this.appPath,
        env: buildApiEnvironment(this.paths, this.env),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child = child
      child.stdout?.pipe(logStream, { end: false })
      child.stderr?.pipe(logStream, { end: false })
      child.once('error', (error) => {
        writeStructuredLog(logStream, 'process_error', { message: errorMessage(error) })
        this.processError = error
        if (this.child === child) this.child = null
        logStream.end(() => {
          if (this.logStream === logStream) this.logStream = null
        })
      })
      child.once('exit', (code, signal) => {
        writeStructuredLog(logStream, 'process_exit', { code, signal: signal || null })
        logStream.end(() => {
          if (this.logStream === logStream) this.logStream = null
        })
        if (this.child === child) this.child = null
        if (this.stopRequested) {
          if (this.status.state !== 'failed') this.update({ state: 'stopped', pid: null })
          return
        }
        this.update({
          state: 'failed',
          pid: null,
          error: `本机 API 意外退出（code=${code ?? 'null'}, signal=${signal || 'none'}）。`,
        })
      })
      this.update({
        state: 'starting',
        pid: child.pid ?? null,
        launchKind: launch.kind,
        startedAt: new Date().toISOString(),
        readyAt: null,
        error: null,
      })
      await this.waitUntilReady()
      this.update({ state: 'ready', readyAt: new Date().toISOString(), error: null })
      return this.snapshot()
    } catch (error) {
      const message = errorMessage(error)
      this.update({ state: 'failed', pid: this.child?.pid ?? null, error: message, launchKind: launch.kind })
      if (this.child) {
        this.stopRequested = true
        this.child.kill()
      }
      throw new Error(message)
    }
  }

  async waitUntilReady() {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let lastError = null
    while (Date.now() < deadline) {
      if (this.processError) throw this.processError
      if (!this.child) throw new Error(this.status.error || '本机 API 在完成启动前退出。')
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) {
          const payload = await response.json()
          if (payload?.status === 'ok') return
          lastError = new Error('健康检查响应格式无效。')
        } else {
          lastError = new Error(`健康检查返回 HTTP ${response.status}。`)
        }
      } catch (error) {
        lastError = error
      }
      await delay(HEALTH_INTERVAL_MS)
    }
    throw new Error(`本机 API 启动超时：${errorMessage(lastError)}`)
  }

  async restart() {
    return this.enqueue(async () => {
      await this.stopInternal()
      return this.startInternal()
    })
  }

  async stop() {
    return this.enqueue(() => this.stopInternal())
  }

  async stopInternal() {
    const child = this.child
    if (!child) {
      this.update({ state: 'stopped', pid: null })
      await this.waitForLogClose()
      return this.snapshot()
    }
    this.stopRequested = true
    this.update({ state: 'stopping' })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)])
    if (this.child === child) child.kill('SIGKILL')
    await Promise.race([exited, delay(1_000)])
    if (this.child === child) this.child = null
    await this.waitForLogClose()
    this.update({ state: 'stopped', pid: null })
    return this.snapshot()
  }

  async waitForLogClose() {
    const stream = this.logStream
    if (!stream || stream.closed) return
    await Promise.race([
      new Promise((resolve) => stream.once('close', resolve)),
      delay(1_000),
    ])
  }
}

module.exports = {
  ApiServiceSupervisor,
  findAvailablePort,
}
