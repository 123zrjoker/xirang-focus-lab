const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const readText = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(readText(...parts))
const errors = []

function fail(message) {
  errors.push(message)
}

function extract(text, expression, label) {
  const match = text.match(expression)
  if (!match) {
    fail(`无法读取${label}`)
    return null
  }
  return match[1]
}

const manifest = readJson('docs', 'contracts', '0.9.0-runtime-contract.json')
const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const serverInit = readText('server', '__init__.py')
const serverContracts = readText('server', 'agent', 'contracts.py')
const desktopApiService = readText('electron', 'api-service.cjs')
const storage = readText('src', 'lib', 'storage.ts')
const dataTransfer = readText('src', 'lib', 'dataTransfer.ts')
const knowledgeBase = readText('src', 'lib', 'knowledgeBase.ts')
const apiUrlClient = readText('src', 'lib', 'apiUrl.ts')

const serverVersion = extract(serverInit, /__version__\s*=\s*["']([^"']+)["']/, 'Python API 版本')
const apiContractVersion = extract(serverInit, /API_CONTRACT_VERSION\s*=\s*["']([^"']+)["']/, 'API 契约版本')
const appStateSchema = Number(extract(storage, /CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/, '业务状态 schemaVersion'))
const minimumAppStateSchema = Number(extract(
  storage,
  /MIN_SUPPORTED_SCHEMA_VERSION\s*=\s*(\d+)/,
  '业务状态最低 schemaVersion',
))
const backupFormat = Number(extract(dataTransfer, /BACKUP_FORMAT_VERSION\s*=\s*(\d+)/, '备份格式版本'))
const minimumBackupFormat = Number(extract(
  dataTransfer,
  /MIN_SUPPORTED_BACKUP_FORMAT_VERSION\s*=\s*(\d+)/,
  '备份最低格式版本',
))
const knowledgeSchema = Number(extract(knowledgeBase, /KNOWLEDGE_DB_VERSION\s*=\s*(\d+)/, '知识库版本'))
const minimumKnowledgeBackupSchema = Number(extract(
  knowledgeBase,
  /MIN_SUPPORTED_KNOWLEDGE_BACKUP_VERSION\s*=\s*(\d+)/,
  '知识库备份最低版本',
))
const agentSchema = Number(extract(serverContracts, /AGENT_SCHEMA_VERSION\s*=\s*(\d+)/, 'Agent schemaVersion'))
const agentGraph = extract(serverContracts, /AGENT_GRAPH_VERSION\s*=\s*["']([^"']+)["']/, 'Agent graphVersion')
const compatibleGraphBlock = extract(
  serverContracts,
  /AGENT_COMPATIBLE_GRAPH_VERSIONS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/,
  'Agent graphVersion 兼容矩阵',
)
const codeCompatibleGraphs = compatibleGraphBlock
  ? [
      ...Array.from(compatibleGraphBlock.matchAll(/["']([^"']+)["']/g), (match) => match[1]),
      ...(compatibleGraphBlock.includes('AGENT_GRAPH_VERSION') && agentGraph ? [agentGraph] : []),
    ].filter((value, index, values) => values.indexOf(value) === index).sort()
  : []
const desktopApiContractVersion = extract(
  desktopApiService,
  /SUPPORTED_API_CONTRACT_VERSION\s*=\s*["']([^"']+)["']/,
  '桌面 API 契约版本',
)
const browserApiContractVersion = extract(
  apiUrlClient,
  /SUPPORTED_API_CONTRACT_VERSION\s*=\s*["']([^"']+)["']/,
  '前端 API 契约版本',
)

if (manifest.targetRelease !== '0.9.0') fail('契约清单 targetRelease 必须为 0.9.0')
if (manifest.productVersion?.current !== packageJson.version) fail('契约清单与 package.json 版本不一致')
if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  fail('package-lock.json 与 package.json 版本不一致')
}
if (serverVersion !== packageJson.version) fail(`Python API 版本 ${serverVersion} 与应用版本 ${packageJson.version} 不一致`)
if (apiContractVersion !== manifest.api?.contractVersion) fail('API 契约版本与清单不一致')
if (desktopApiContractVersion !== manifest.api?.contractVersion) fail('桌面 API 契约版本与清单不一致')
if (browserApiContractVersion !== manifest.api?.contractVersion) fail('前端 API 契约版本与清单不一致')
if (appStateSchema !== manifest.storage?.appState?.currentSchemaVersion) fail('业务状态 schemaVersion 与清单不一致')
if (minimumAppStateSchema !== manifest.storage?.appState?.minimumSupportedSchemaVersion) {
  fail('业务状态最低 schemaVersion 与清单不一致')
}
if (backupFormat !== manifest.storage?.backup?.currentFormatVersion) fail('备份格式版本与清单不一致')
const expectedBackupVersions = Array.from(
  { length: backupFormat - minimumBackupFormat + 1 },
  (_, index) => minimumBackupFormat + index,
)
if (JSON.stringify(manifest.storage?.backup?.supportedFormatVersions) !== JSON.stringify(expectedBackupVersions)) {
  fail('备份格式支持矩阵与代码范围不一致')
}
if (knowledgeSchema !== manifest.storage?.knowledgeDatabase?.currentSchemaVersion) fail('知识库版本与清单不一致')
if (minimumKnowledgeBackupSchema !== manifest.storage?.knowledgeDatabase?.minimumSupportedBackupVersion) {
  fail('知识库备份最低版本与清单不一致')
}
if (agentSchema !== manifest.agent?.schemaVersion) fail('Agent schemaVersion 与清单不一致')
if (agentGraph !== manifest.agent?.graphVersion) fail('Agent graphVersion 与清单不一致')
const manifestCompatibleGraphs = [...(manifest.agent?.compatibleGraphVersions ?? [])].sort()
if (JSON.stringify(codeCompatibleGraphs) !== JSON.stringify(manifestCompatibleGraphs)) {
  fail('Agent graphVersion 兼容矩阵与清单不一致')
}

if (errors.length) {
  console.error(`Release contract check failed (${errors.length}):`)
  errors.forEach((error) => console.error(`- ${error}`))
  process.exitCode = 1
} else {
  console.log(`Release contract check passed for ${packageJson.version} targeting ${manifest.targetRelease}.`)
}
