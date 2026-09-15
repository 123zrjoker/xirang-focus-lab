import type { PersonalNote } from '../types'

export type KnowledgeSourceKind = 'note' | 'text' | 'markdown' | 'docx' | 'pdf'

export interface KnowledgeSource {
  id: string
  kind: KnowledgeSourceKind
  title: string
  content: string
  contentFingerprint: string
  contentHash?: string
  hashAlgorithm?: 'SHA-256'
  sizeBytes: number
  createdAt: string
  updatedAt: string
  sourceNoteId?: string
  sourceUpdatedAt?: string
  originalFileName?: string
  originalMimeType?: string
  originalSizeBytes?: number
  pageCount?: number
  extractedAt?: string
  extractionWarnings?: string[]
}

export interface KnowledgePermission {
  sourceId: string
  sourceKind: KnowledgeSourceKind
  sourceNoteId?: string
  grantedAt: string
  updatedAt: string
}

export interface KnowledgeChunk {
  id: string
  sourceId: string
  sourceTitle: string
  sourceContentHash: string
  sequence: number
  content: string
  contentHash: string
  heading: string
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  characterCount: number
  processorVersion: number
  tokenEstimate?: number
  embedding?: number[]
  embeddingModel?: string
  embeddingDimensions?: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeRetrievalRecord {
  id: string
  query: string
  sourceIds: string[]
  chunkIds: string[]
  resultCount: number
  durationMs?: number
  engine?: string
  mode?: 'keyword' | 'vector' | 'hybrid' | 'hybrid_rerank'
  queryTerms?: string[]
  confidence?: 'strong' | 'possible' | 'none'
  topScore?: number
  createdAt: string
}

export interface KnowledgeStorageSummary {
  databaseVersion: number
  sourceCount: number
  permissionCount: number
  chunkCount: number
  retrievalCount: number
  embeddingCount: number
  sourceBytes: number
  chunkBytes: number
}

export interface KnowledgeBaseBackup {
  schemaVersion: number
  sources: KnowledgeSource[]
  permissions: KnowledgePermission[]
  chunks: KnowledgeChunk[]
  retrievals: KnowledgeRetrievalRecord[]
  metadata: Record<string, unknown>[]
}

export type NoteKnowledgeStatus = 'not-authorized' | 'ready' | 'outdated'

export const KNOWLEDGE_DB_NAME = 'xirang-knowledge-base'
export const KNOWLEDGE_SOURCE_STORE = 'sources'
export const KNOWLEDGE_PERMISSION_STORE = 'permissions'
export const KNOWLEDGE_CHUNK_STORE = 'chunks'
export const KNOWLEDGE_RETRIEVAL_STORE = 'retrievals'
export const KNOWLEDGE_METADATA_STORE = 'metadata'
export const KNOWLEDGE_DB_VERSION = 2
export const MAX_KNOWLEDGE_FILE_BYTES = 2 * 1024 * 1024
export const MAX_KNOWLEDGE_DOCUMENT_BYTES = 10 * 1024 * 1024
export const MAX_KNOWLEDGE_EXTRACTED_BYTES = 4 * 1024 * 1024
export const MAX_KNOWLEDGE_SOURCES = 100
export const MAX_RETRIEVAL_RECORDS = 200

function textBytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export function normalizeKnowledgeContent(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
}

export function fingerprintKnowledgeText(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

export async function sha256KnowledgeText(value: string) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持 SHA-256 内容校验。')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function sourceHashInput(source: KnowledgeSource) {
  return `${source.kind}\n${source.title}\n${source.content}`
}

async function sourceWithIntegrity(source: KnowledgeSource) {
  const contentHash = await sha256KnowledgeText(sourceHashInput(source))
  if (source.contentHash === contentHash && source.hashAlgorithm === 'SHA-256') return source
  return { ...source, contentHash, hashAlgorithm: 'SHA-256' as const }
}

function permissionForSource(source: KnowledgeSource): KnowledgePermission {
  return {
    sourceId: source.id,
    sourceKind: source.kind,
    sourceNoteId: source.sourceNoteId,
    grantedAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}

function noteSnapshot(note: PersonalNote) {
  return `${note.title}\n${note.content}`
}

export function createNoteKnowledgeSource(
  note: PersonalNote,
  existing?: KnowledgeSource,
  now = new Date().toISOString(),
): KnowledgeSource {
  const snapshot = noteSnapshot(note)
  const content = normalizeKnowledgeContent(note.content) || note.title
  return {
    id: existing?.id ?? crypto.randomUUID(),
    kind: 'note',
    title: note.title,
    content,
    contentFingerprint: fingerprintKnowledgeText(snapshot),
    sizeBytes: textBytes(snapshot),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sourceNoteId: note.id,
    sourceUpdatedAt: note.updatedAt,
  }
}

export function knowledgeFileKind(fileName: string): Exclude<KnowledgeSourceKind, 'note'> | null {
  const lowerName = fileName.trim().toLocaleLowerCase()
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) return 'markdown'
  if (lowerName.endsWith('.txt')) return 'text'
  if (lowerName.endsWith('.docx')) return 'docx'
  if (lowerName.endsWith('.pdf')) return 'pdf'
  return null
}

export function validateKnowledgeFile(file: Pick<File, 'name' | 'size'>) {
  const kind = knowledgeFileKind(file.name)
  if (!kind) return '只支持 TXT、MD、Markdown、DOCX 和文字型 PDF 文档。'
  if (file.size <= 0) return '文件内容为空。'
  const limit = kind === 'docx' || kind === 'pdf' ? MAX_KNOWLEDGE_DOCUMENT_BYTES : MAX_KNOWLEDGE_FILE_BYTES
  if (file.size > limit) return `单个${kind === 'docx' || kind === 'pdf' ? ' DOCX/PDF ' : '文本'}文件不能超过 ${limit / 1024 / 1024} MB。`
  return null
}

function titleFromFileName(fileName: string) {
  const title = fileName.replace(/\.(?:txt|md|markdown|docx|pdf)$/i, '').trim()
  return (title || '未命名资料').slice(0, 120)
}

export function createImportedKnowledgeSource(
  fileName: string,
  rawContent: string,
  existing?: KnowledgeSource,
  now = new Date().toISOString(),
): KnowledgeSource {
  const kind = knowledgeFileKind(fileName)
  if (!kind || kind === 'docx' || kind === 'pdf') throw new Error('这个入口只处理 TXT、MD 和 Markdown 文档。')
  const content = normalizeKnowledgeContent(rawContent)
  if (!content) throw new Error('文件中没有可保存的文字。')
  const sizeBytes = textBytes(content)
  if (sizeBytes > MAX_KNOWLEDGE_FILE_BYTES) throw new Error('处理后的文字超过 2 MB。')
  return {
    id: existing?.id ?? crypto.randomUUID(),
    kind,
    title: titleFromFileName(fileName),
    content,
    contentFingerprint: fingerprintKnowledgeText(content),
    sizeBytes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    originalFileName: fileName.slice(0, 240),
  }
}

export function createExtractedDocumentKnowledgeSource(
  fileName: string,
  kind: 'docx' | 'pdf',
  rawContent: string,
  metadata: {
    mimeType: string
    originalSizeBytes: number
    pageCount?: number
    warnings?: string[]
  },
  existing?: KnowledgeSource,
  now = new Date().toISOString(),
): KnowledgeSource {
  const detectedKind = knowledgeFileKind(fileName)
  if (detectedKind !== kind) throw new Error('文档扩展名与提取类型不匹配。')
  const content = normalizeKnowledgeContent(rawContent)
  if (!content) throw new Error(kind === 'pdf' ? 'PDF 中没有检测到可提取文字；扫描件需要 OCR。' : 'DOCX 中没有检测到可提取文字。')
  const sizeBytes = textBytes(content)
  if (sizeBytes > MAX_KNOWLEDGE_EXTRACTED_BYTES) throw new Error('提取后的正文超过 4 MB，请拆分文档后再导入。')
  return {
    id: existing?.id ?? crypto.randomUUID(),
    kind,
    title: titleFromFileName(fileName),
    content,
    contentFingerprint: fingerprintKnowledgeText(content),
    sizeBytes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    originalFileName: fileName.slice(0, 240),
    originalMimeType: metadata.mimeType,
    originalSizeBytes: metadata.originalSizeBytes,
    pageCount: metadata.pageCount,
    extractedAt: now,
    extractionWarnings: metadata.warnings?.slice(0, 10),
  }
}

export function noteKnowledgeStatus(note: PersonalNote, source?: KnowledgeSource): NoteKnowledgeStatus {
  if (!source) return 'not-authorized'
  return source.sourceUpdatedAt === note.updatedAt
    && source.contentFingerprint === fingerprintKnowledgeText(noteSnapshot(note))
    ? 'ready'
    : 'outdated'
}

export function knowledgeSourceBytes(sources: KnowledgeSource[]) {
  return sources.reduce((sum, source) => sum + source.sizeBytes, 0)
}

export function supportsKnowledgeBase() {
  return typeof indexedDB !== 'undefined'
}

function openKnowledgeDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!supportsKnowledgeBase()) {
      reject(new Error('当前环境不支持本地知识库。'))
      return
    }
    const request = indexedDB.open(KNOWLEDGE_DB_NAME, KNOWLEDGE_DB_VERSION)
    request.onupgradeneeded = (event) => {
      const database = request.result
      const transaction = request.transaction
      if (!database.objectStoreNames.contains(KNOWLEDGE_SOURCE_STORE)) {
        const store = database.createObjectStore(KNOWLEDGE_SOURCE_STORE, { keyPath: 'id' })
        store.createIndex('kind', 'kind', { unique: false })
        store.createIndex('sourceNoteId', 'sourceNoteId', { unique: false })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
      if (!database.objectStoreNames.contains(KNOWLEDGE_PERMISSION_STORE)) {
        const store = database.createObjectStore(KNOWLEDGE_PERMISSION_STORE, { keyPath: 'sourceId' })
        store.createIndex('sourceKind', 'sourceKind', { unique: false })
        store.createIndex('sourceNoteId', 'sourceNoteId', { unique: false })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
      if (!database.objectStoreNames.contains(KNOWLEDGE_CHUNK_STORE)) {
        const store = database.createObjectStore(KNOWLEDGE_CHUNK_STORE, { keyPath: 'id' })
        store.createIndex('sourceId', 'sourceId', { unique: false })
        store.createIndex('sourceSequence', ['sourceId', 'sequence'], { unique: true })
        store.createIndex('contentHash', 'contentHash', { unique: false })
        store.createIndex('updatedAt', 'updatedAt', { unique: false })
      }
      if (!database.objectStoreNames.contains(KNOWLEDGE_RETRIEVAL_STORE)) {
        const store = database.createObjectStore(KNOWLEDGE_RETRIEVAL_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
        store.createIndex('query', 'query', { unique: false })
      }
      if (!database.objectStoreNames.contains(KNOWLEDGE_METADATA_STORE)) {
        database.createObjectStore(KNOWLEDGE_METADATA_STORE, { keyPath: 'key' })
      }
      if (transaction) {
        const now = new Date().toISOString()
        transaction.objectStore(KNOWLEDGE_METADATA_STORE).put({
          key: 'schema',
          databaseVersion: KNOWLEDGE_DB_VERSION,
          upgradedFrom: event.oldVersion,
          updatedAt: now,
        })
        if (event.oldVersion > 0 && event.oldVersion < 2) {
          const sourceStore = transaction.objectStore(KNOWLEDGE_SOURCE_STORE)
          const permissionStore = transaction.objectStore(KNOWLEDGE_PERMISSION_STORE)
          sourceStore.openCursor().onsuccess = (cursorEvent) => {
            const cursor = (cursorEvent.target as IDBRequest<IDBCursorWithValue | null>).result
            if (!cursor) return
            const source = cursor.value as KnowledgeSource
            permissionStore.put(permissionForSource(source))
            cursor.continue()
          }
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开本地知识库。'))
    request.onblocked = () => reject(new Error('本地知识库正在被其他窗口占用，请关闭其他窗口后重试。'))
  })
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地知识库操作失败。'))
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('本地知识库事务失败。'))
    transaction.onabort = () => reject(transaction.error ?? new Error('本地知识库事务已取消。'))
  })
}

export async function listKnowledgeSources() {
  const database = await openKnowledgeDatabase()
  let rawSources: KnowledgeSource[] = []
  let permissions: KnowledgePermission[] = []
  try {
    const transaction = database.transaction([KNOWLEDGE_SOURCE_STORE, KNOWLEDGE_PERMISSION_STORE], 'readonly')
    const completed = transactionComplete(transaction)
    ;[rawSources, permissions] = await Promise.all([
      requestResult(transaction.objectStore(KNOWLEDGE_SOURCE_STORE).getAll()) as Promise<KnowledgeSource[]>,
      requestResult(transaction.objectStore(KNOWLEDGE_PERMISSION_STORE).getAll()) as Promise<KnowledgePermission[]>,
    ])
    await completed
  } finally {
    database.close()
  }

  const sources = await Promise.all(rawSources.map(sourceWithIntegrity))
  const permissionIds = new Set(permissions.map((permission) => permission.sourceId))
  const needsBackfill = sources.some((source, index) => source !== rawSources[index] || !permissionIds.has(source.id))
  if (needsBackfill && sources.length) await writeKnowledgeSources(sources, false)
  return sources.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

async function writeKnowledgeSources(sources: KnowledgeSource[], invalidateChangedChunks: boolean) {
  const database = await openKnowledgeDatabase()
  try {
    const transaction = database.transaction(
      [KNOWLEDGE_SOURCE_STORE, KNOWLEDGE_PERMISSION_STORE, KNOWLEDGE_CHUNK_STORE],
      'readwrite',
    )
    const completed = transactionComplete(transaction)
    const sourceStore = transaction.objectStore(KNOWLEDGE_SOURCE_STORE)
    const permissionStore = transaction.objectStore(KNOWLEDGE_PERMISSION_STORE)
    const chunkStore = transaction.objectStore(KNOWLEDGE_CHUNK_STORE)
    for (const source of sources) {
      if (invalidateChangedChunks) {
        const existing = await requestResult(sourceStore.get(source.id)) as KnowledgeSource | undefined
        if (existing?.contentHash && existing.contentHash !== source.contentHash) {
          const keys = await requestResult(chunkStore.index('sourceId').getAllKeys(source.id))
          keys.forEach((key) => chunkStore.delete(key))
        }
      }
      sourceStore.put(source)
      permissionStore.put(permissionForSource(source))
    }
    await completed
  } finally {
    database.close()
  }
}

export async function saveKnowledgeSource(source: KnowledgeSource) {
  const persisted = await sourceWithIntegrity(source)
  await writeKnowledgeSources([persisted], true)
  return persisted
}

export async function deleteKnowledgeSource(id: string) {
  const database = await openKnowledgeDatabase()
  try {
    const transaction = database.transaction(
      [KNOWLEDGE_SOURCE_STORE, KNOWLEDGE_PERMISSION_STORE, KNOWLEDGE_CHUNK_STORE],
      'readwrite',
    )
    const completed = transactionComplete(transaction)
    const chunkStore = transaction.objectStore(KNOWLEDGE_CHUNK_STORE)
    const chunkKeys = await requestResult(chunkStore.index('sourceId').getAllKeys(id))
    chunkKeys.forEach((key) => chunkStore.delete(key))
    transaction.objectStore(KNOWLEDGE_SOURCE_STORE).delete(id)
    transaction.objectStore(KNOWLEDGE_PERMISSION_STORE).delete(id)
    await completed
  } finally {
    database.close()
  }
}

export async function deleteKnowledgeSourcesForNote(noteId: string) {
  if (!supportsKnowledgeBase()) return
  const sources = await listKnowledgeSources()
  await Promise.all(sources.filter((source) => source.sourceNoteId === noteId).map((source) => deleteKnowledgeSource(source.id)))
}

export async function clearKnowledgeBase() {
  if (!supportsKnowledgeBase()) return
  const database = await openKnowledgeDatabase()
  try {
    const stores = [KNOWLEDGE_SOURCE_STORE, KNOWLEDGE_PERMISSION_STORE, KNOWLEDGE_CHUNK_STORE, KNOWLEDGE_RETRIEVAL_STORE]
    const transaction = database.transaction(stores, 'readwrite')
    const completed = transactionComplete(transaction)
    stores.forEach((storeName) => transaction.objectStore(storeName).clear())
    await completed
  } finally {
    database.close()
  }
}

export async function listKnowledgePermissions() {
  const database = await openKnowledgeDatabase()
  try {
    const transaction = database.transaction(KNOWLEDGE_PERMISSION_STORE, 'readonly')
    const completed = transactionComplete(transaction)
    const permissions = await requestResult(transaction.objectStore(KNOWLEDGE_PERMISSION_STORE).getAll()) as KnowledgePermission[]
    await completed
    return permissions
  } finally {
    database.close()
  }
}

export async function listKnowledgeChunks(sourceId?: string) {
  const database = await openKnowledgeDatabase()
  try {
    const transaction = database.transaction(KNOWLEDGE_CHUNK_STORE, 'readonly')
    const completed = transactionComplete(transaction)
    const store = transaction.objectStore(KNOWLEDGE_CHUNK_STORE)
    const chunks = await requestResult(sourceId ? store.index('sourceId').getAll(sourceId) : store.getAll()) as KnowledgeChunk[]
    await completed
    return chunks.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.sequence - b.sequence)
  } finally {
    database.close()
  }
}

export async function replaceKnowledgeChunks(sourceId: string, chunks: KnowledgeChunk[]) {
  if (chunks.some((chunk) => chunk.sourceId !== sourceId)) throw new Error('文本块与知识来源不匹配。')
  const database = await openKnowledgeDatabase()
  try {
    const transaction = database.transaction([KNOWLEDGE_SOURCE_STORE, KNOWLEDGE_CHUNK_STORE], 'readwrite')
    const completed = transactionComplete(transaction)
    const source = await requestResult(transaction.objectStore(KNOWLEDGE_SOURCE_STORE).get(sourceId)) as KnowledgeSource | undefined
    if (!source) {
      transaction.abort()
      throw new Error('找不到对应的知识来源。')
    }
    const chunkStore = transaction.objectStore(KNOWLEDGE_CHUNK_STORE)
    const existingKeys = await requestResult(chunkStore.index('sourceId').getAllKeys(sourceId))
    existingKeys.forEach((key) => chunkStore.delete(key))
    chunks.forEach((chunk) => chunkStore.put(chunk))
    await completed
  } finally {
    database.close()
  }
}

export async function saveKnowledgeRetrieval(record: KnowledgeRetrievalRecord) {
  const database = await openKnowledgeDatabase()
  try {
    const transaction = database.transaction(KNOWLEDGE_RETRIEVAL_STORE, 'readwrite')
    const completed = transactionComplete(transaction)
    const store = transaction.objectStore(KNOWLEDGE_RETRIEVAL_STORE)
    store.put(record)
    const records = await requestResult(store.index('createdAt').getAll()) as KnowledgeRetrievalRecord[]
    records
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(MAX_RETRIEVAL_RECORDS)
      .forEach((item) => store.delete(item.id))
    await completed
    return record
  } finally {
    database.close()
  }
}

export async function listKnowledgeRetrievals(limit = 50) {
  const database = await openKnowledgeDatabase()
  try {
    const transaction = database.transaction(KNOWLEDGE_RETRIEVAL_STORE, 'readonly')
    const completed = transactionComplete(transaction)
    const records = await requestResult(transaction.objectStore(KNOWLEDGE_RETRIEVAL_STORE).getAll()) as KnowledgeRetrievalRecord[]
    await completed
    return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, Math.max(0, limit))
  } finally {
    database.close()
  }
}

export async function getKnowledgeStorageSummary(): Promise<KnowledgeStorageSummary> {
  const database = await openKnowledgeDatabase()
  try {
    const stores = [KNOWLEDGE_SOURCE_STORE, KNOWLEDGE_PERMISSION_STORE, KNOWLEDGE_CHUNK_STORE, KNOWLEDGE_RETRIEVAL_STORE]
    const transaction = database.transaction(stores, 'readonly')
    const completed = transactionComplete(transaction)
    const [sources, permissionCount, chunks, retrievalCount] = await Promise.all([
      requestResult(transaction.objectStore(KNOWLEDGE_SOURCE_STORE).getAll()) as Promise<KnowledgeSource[]>,
      requestResult(transaction.objectStore(KNOWLEDGE_PERMISSION_STORE).count()),
      requestResult(transaction.objectStore(KNOWLEDGE_CHUNK_STORE).getAll()) as Promise<KnowledgeChunk[]>,
      requestResult(transaction.objectStore(KNOWLEDGE_RETRIEVAL_STORE).count()),
    ])
    await completed
    return {
      databaseVersion: database.version,
      sourceCount: sources.length,
      permissionCount,
      chunkCount: chunks.length,
      retrievalCount,
      embeddingCount: chunks.filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0).length,
      sourceBytes: knowledgeSourceBytes(sources),
      chunkBytes: chunks.reduce((sum, chunk) => sum + textBytes(chunk.content), 0),
    }
  } finally {
    database.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateBackupCollections(value: unknown): KnowledgeBaseBackup {
  if (!isRecord(value)) throw new Error('知识库备份内容不完整。')
  const schemaVersion = Number(value.schemaVersion)
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > KNOWLEDGE_DB_VERSION) {
    throw new Error('知识库备份版本不受当前应用支持。')
  }
  const collectionNames = ['sources', 'permissions', 'chunks', 'retrievals', 'metadata'] as const
  for (const name of collectionNames) {
    if (!Array.isArray(value[name])) throw new Error(`知识库备份缺少 ${name} 集合。`)
  }
  const rawSources = value.sources as unknown[]
  const rawPermissions = value.permissions as unknown[]
  const rawChunks = value.chunks as unknown[]
  const rawRetrievals = value.retrievals as unknown[]
  const rawMetadata = value.metadata as unknown[]
  const sources = rawSources.filter(isRecord) as unknown as KnowledgeSource[]
  const permissions = rawPermissions.filter(isRecord) as unknown as KnowledgePermission[]
  const chunks = rawChunks.filter(isRecord) as unknown as KnowledgeChunk[]
  const retrievals = rawRetrievals.filter(isRecord) as unknown as KnowledgeRetrievalRecord[]
  const metadata = rawMetadata.filter(isRecord)
  if (sources.length !== rawSources.length || sources.length > MAX_KNOWLEDGE_SOURCES) {
    throw new Error('知识来源数量或格式无效。')
  }
  if (permissions.length !== rawPermissions.length || permissions.length > MAX_KNOWLEDGE_SOURCES) {
    throw new Error('知识库授权记录数量或格式无效。')
  }
  if (chunks.length !== rawChunks.length || chunks.length > MAX_KNOWLEDGE_SOURCES * 10_000) {
    throw new Error('知识文本块数量或格式无效。')
  }
  if (retrievals.length !== rawRetrievals.length || retrievals.length > MAX_RETRIEVAL_RECORDS) {
    throw new Error('知识检索记录数量或格式无效。')
  }
  if (metadata.length !== rawMetadata.length || metadata.length > 20) {
    throw new Error('知识库元数据数量或格式无效。')
  }
  const sourceIds = new Set<string>()
  for (const source of sources) {
    if (typeof source.id !== 'string' || !source.id || sourceIds.has(source.id)
      || typeof source.title !== 'string' || typeof source.content !== 'string') {
      throw new Error('知识来源记录格式无效或 ID 重复。')
    }
    sourceIds.add(source.id)
  }
  if (permissions.some((permission) => typeof permission.sourceId !== 'string' || !sourceIds.has(permission.sourceId))) {
    throw new Error('知识库授权记录引用了不存在的来源。')
  }
  if (chunks.some((chunk) => typeof chunk.id !== 'string' || !chunk.id
    || typeof chunk.sourceId !== 'string' || !sourceIds.has(chunk.sourceId) || typeof chunk.content !== 'string')) {
    throw new Error('知识文本块引用了不存在的来源。')
  }
  return { schemaVersion, sources, permissions, chunks, retrievals, metadata }
}

export async function exportKnowledgeBase(): Promise<KnowledgeBaseBackup> {
  const database = await openKnowledgeDatabase()
  try {
    const stores = [
      KNOWLEDGE_SOURCE_STORE,
      KNOWLEDGE_PERMISSION_STORE,
      KNOWLEDGE_CHUNK_STORE,
      KNOWLEDGE_RETRIEVAL_STORE,
      KNOWLEDGE_METADATA_STORE,
    ]
    const transaction = database.transaction(stores, 'readonly')
    const completed = transactionComplete(transaction)
    const [rawSources, permissions, chunks, retrievals, metadata] = await Promise.all([
      requestResult(transaction.objectStore(KNOWLEDGE_SOURCE_STORE).getAll()) as Promise<KnowledgeSource[]>,
      requestResult(transaction.objectStore(KNOWLEDGE_PERMISSION_STORE).getAll()) as Promise<KnowledgePermission[]>,
      requestResult(transaction.objectStore(KNOWLEDGE_CHUNK_STORE).getAll()) as Promise<KnowledgeChunk[]>,
      requestResult(transaction.objectStore(KNOWLEDGE_RETRIEVAL_STORE).getAll()) as Promise<KnowledgeRetrievalRecord[]>,
      requestResult(transaction.objectStore(KNOWLEDGE_METADATA_STORE).getAll()) as Promise<Record<string, unknown>[]>,
    ])
    await completed
    return {
      schemaVersion: KNOWLEDGE_DB_VERSION,
      sources: await Promise.all(rawSources.map(sourceWithIntegrity)),
      permissions,
      chunks,
      retrievals,
      metadata,
    }
  } finally {
    database.close()
  }
}

export async function restoreKnowledgeBase(value: unknown) {
  const backup = validateBackupCollections(value)
  const sources = await Promise.all(backup.sources.map(sourceWithIntegrity))
  const sourceIds = new Set(sources.map((source) => source.id))
  const permissionsBySource = new Map(backup.permissions.map((permission) => [permission.sourceId, permission]))
  const permissions = sources.map((source) => permissionsBySource.get(source.id) ?? permissionForSource(source))
  const database = await openKnowledgeDatabase()
  try {
    const stores = [
      KNOWLEDGE_SOURCE_STORE,
      KNOWLEDGE_PERMISSION_STORE,
      KNOWLEDGE_CHUNK_STORE,
      KNOWLEDGE_RETRIEVAL_STORE,
      KNOWLEDGE_METADATA_STORE,
    ]
    const transaction = database.transaction(stores, 'readwrite')
    const completed = transactionComplete(transaction)
    stores.forEach((storeName) => transaction.objectStore(storeName).clear())
    sources.forEach((source) => transaction.objectStore(KNOWLEDGE_SOURCE_STORE).put(source))
    permissions.forEach((permission) => transaction.objectStore(KNOWLEDGE_PERMISSION_STORE).put(permission))
    backup.chunks
      .filter((chunk) => sourceIds.has(chunk.sourceId))
      .forEach((chunk) => transaction.objectStore(KNOWLEDGE_CHUNK_STORE).put(chunk))
    backup.retrievals
      .slice(-MAX_RETRIEVAL_RECORDS)
      .forEach((record) => transaction.objectStore(KNOWLEDGE_RETRIEVAL_STORE).put(record))
    backup.metadata.forEach((item) => {
      if (typeof item.key === 'string' && item.key) transaction.objectStore(KNOWLEDGE_METADATA_STORE).put(item)
    })
    transaction.objectStore(KNOWLEDGE_METADATA_STORE).put({
      key: 'schema',
      databaseVersion: KNOWLEDGE_DB_VERSION,
      restoredFrom: backup.schemaVersion,
      updatedAt: new Date().toISOString(),
    })
    await completed
  } finally {
    database.close()
  }
}
