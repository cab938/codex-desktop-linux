import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import {
  ADAPTER_LEASE_TTL_MS,
  DOCUMENT_IDLE_MS,
  MAX_ADAPTER_LEASES,
  MAX_FILE_BYTES,
  MAX_OPEN_DOCUMENTS,
  MAX_UI_SESSIONS_PER_DOCUMENT,
} from './config.mjs'
import { BrokerError, assertBroker } from './errors.mjs'
import { FilePersistence } from './file-persistence.mjs'
import { acquireDirectoryLock } from './lock.mjs'
import {
  DEGENERATE_DELETE_RATIO,
  applyTextTarget,
  computeMergedTarget,
} from './merge.mjs'
import { DocumentStateStore } from './state-store.mjs'
import {
  createMarkdownFile,
  documentIdentity,
  readMarkdownFile,
  resolveMarkdownFile,
} from './workspace.mjs'

const UINT64_MAX = 18_446_744_073_709_551_615n
const MAX_EDITS = 256
const MAX_REPLACEMENT_BYTES = 512 * 1024
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000
const MAX_IDEMPOTENCY_RECORDS = 4_096
const UI_SESSION_TTL_MS = 60_000
const MAX_UI_SEQUENCE_RECORDS = 256

export class DocumentRegistry {
  constructor(options) {
    this.stateRoot = options.stateRoot
    this.workspaceRegistry = options.workspaceRegistry
    this.stateStore =
      options.stateStore ?? new DocumentStateStore(options.stateRoot, options)
    this.clock = options.clock ?? (() => Date.now())
    this.generation = options.generation ?? crypto.randomUUID()
    this.maxDocuments = options.maxDocuments ?? MAX_OPEN_DOCUMENTS
    this.idleMs = options.idleMs ?? DOCUMENT_IDLE_MS
    this.filePersistenceOptions = options.filePersistenceOptions ?? {}
    this.documents = new Map()
    this.createIdempotency = new Map()
    this.createReceiptsLoaded = false
    this.createReceiptsPath = path.join(
      this.stateRoot,
      'create-idempotency-v1.json',
    )
    this.closed = false
  }

  async open(input, adapterId) {
    this.assertRunning()
    validateAdapterId(adapterId)
    const approval = await this.workspaceRegistry.requireApproved(
      input?.workspaceRoot,
    )
    await this.loadCreateReceipts()
    const resolved = await resolveMarkdownFile(
      approval.canonicalRoot,
      input?.path,
    )
    const snapshot = await readMarkdownFile(resolved)
    const documentId = documentIdentity(
      resolved.canonicalRoot,
      resolved.canonicalPath,
    )
    const existing = this.documents.get(documentId)
    if (existing) {
      existing.assertIdentity(resolved)
      existing.acquireAdapter(adapterId)
      return existing.describe()
    }
    assertBroker(
      this.documents.size < this.maxDocuments,
      'RESOURCE_LIMIT',
      `At most ${this.maxDocuments} Markdown documents may be open.`,
      { retryable: true },
    )

    const lockPath = path.join(
      this.stateRoot,
      'locks-v1',
      `${documentId}.lock`,
    )
    const lock = await acquireDirectoryLock(lockPath, {
      kind: 'document',
      label: `document ${documentId}`,
    })
    let session
    try {
      const state = await this.stateStore.open(
        {
          documentId,
          canonicalRoot: resolved.canonicalRoot,
          canonicalPath: resolved.canonicalPath,
          relativePath: resolved.relativePath,
        },
        snapshot,
      )
      session = new DocumentSession({
        registry: this,
        stateStore: this.stateStore,
        state,
        lock,
        generation: this.generation,
        clock: this.clock,
        idleMs: this.idleMs,
        fileSnapshot: snapshot,
        filePersistenceOptions: this.filePersistenceOptions,
      })
      await session.initialize()
      session.acquireAdapter(adapterId)
      this.documents.set(documentId, session)
      return session.describe()
    } catch (error) {
      if (session) {
        await session.abortInitialization()
      } else {
        await lock.release()
      }
      throw error
    }
  }

  async create(input, adapterId) {
    this.assertRunning()
    validateAdapterId(adapterId)
    validateIdempotencyKey(input?.idempotencyKey)
    const approval = await this.workspaceRegistry.requireApproved(
      input?.workspaceRoot,
    )
    await this.loadCreateReceipts()
    const requestHash = stableRequestHash({
      operation: 'create',
      canonicalRoot: approval.canonicalRoot,
      path: input?.path,
      initialText: input?.initialText,
    })
    const key = `${approval.workspaceId}\0${input?.path}\0${input.idempotencyKey}`
    const cutoff = this.clock() - IDEMPOTENCY_TTL_MS
    for (const [cachedKey, record] of this.createIdempotency) {
      if (record.createdAt < cutoff) this.createIdempotency.delete(cachedKey)
    }
    const existing = this.createIdempotency.get(key)
    if (existing) {
      assertBroker(
        existing.requestHash === requestHash,
        'IDEMPOTENCY_REUSE',
        'This create idempotency key was reused with different content.',
      )
      const document = existing.promise
        ? await existing.promise
        : await this.open({
          workspaceRoot: approval.canonicalRoot,
          path: input.path,
        }, adapterId)
      const session = this.documents.get(document.documentId)
      session?.acquireAdapter(adapterId)
      return document
    }
    assertBroker(
      this.createIdempotency.size < MAX_IDEMPOTENCY_RECORDS,
      'RESOURCE_LIMIT',
      'The create idempotency cache is full.',
      { retryable: true },
    )
    const promise = (async () => {
      await createMarkdownFile(
        approval.canonicalRoot,
        input?.path,
        input?.initialText,
      )
      return this.open({
        workspaceRoot: approval.canonicalRoot,
        path: input.path,
      }, adapterId)
    })()
    const record = {
      key,
      requestHash,
      createdAt: this.clock(),
      promise,
    }
    this.createIdempotency.set(key, record)
    try {
      const result = await promise
      record.result = {
        documentId: result.documentId,
        canonicalRoot: approval.canonicalRoot,
        path: input.path,
      }
      delete record.promise
      await this.persistCreateReceipts()
      return result
    } catch (error) {
      if (this.createIdempotency.get(key) === record) {
        this.createIdempotency.delete(key)
      }
      throw error
    }
  }

  async loadCreateReceipts() {
    if (this.createReceiptsLoaded) return
    this.createReceiptsLoaded = true
    let records
    try {
      records = JSON.parse(await fs.readFile(this.createReceiptsPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return
      if (error instanceof SyntaxError) {
        throw new BrokerError(
          'STATE_CORRUPT',
          'The create idempotency journal is not valid JSON.',
          { cause: error },
        )
      }
      throw error
    }
    assertBroker(
      Array.isArray(records),
      'STATE_CORRUPT',
      'The create idempotency journal is invalid.',
    )
    const cutoff = this.clock() - IDEMPOTENCY_TTL_MS
    for (const record of records.slice(-MAX_IDEMPOTENCY_RECORDS)) {
      if (
        typeof record?.key === 'string' &&
        typeof record?.requestHash === 'string' &&
        Number.isFinite(record?.createdAt) &&
        record.createdAt >= cutoff &&
        record.result &&
        typeof record.result.path === 'string'
      ) {
        this.createIdempotency.set(record.key, record)
      }
    }
  }

  async persistCreateReceipts() {
    const records = [...this.createIdempotency.values()]
      .filter((record) => record.result)
      .map(({ key, requestHash, createdAt, result }) => ({
        key,
        requestHash,
        createdAt,
        result,
      }))
      .slice(-MAX_IDEMPOTENCY_RECORDS)
    await writePrivateJson(this.createReceiptsPath, records)
  }

  require(documentId, adapterId) {
    this.assertRunning()
    const session = this.documents.get(documentId)
    assertBroker(
      session,
      'DOCUMENT_NOT_OPEN',
      'The requested Markdown document is not open in this broker.',
      { retryable: true },
    )
    session.requireAdapter(adapterId)
    return session
  }

  async applyTextEdits(input, adapterId) {
    const session = this.require(input?.documentId, adapterId)
    const operation = async () => {
      const result = await session.applyTextEdits(input)
      if (input?.durability === 'file') {
        const flushed = await session.flush(result.revision)
        return {
          ...result,
          durability: 'file',
          flushState: flushed.flushState,
          fileDurableRevision: flushed.fileDurableRevision,
        }
      }
      return result
    }
    if (input?.idempotencyKey === undefined) return operation()
    return session.withIdempotency(
      input.idempotencyKey,
      stableRequestHash({
        operation: 'applyText',
        expectedRevision: input?.expectedRevision,
        edits: input?.edits,
        durability: input?.durability ?? 'recovery_log',
      }),
      operation,
    )
  }

  async applyYUpdate(input, adapterId) {
    return this.require(input?.documentId, adapterId).applyYUpdate(input)
  }

  read(input, adapterId) {
    return this.require(input?.documentId, adapterId).read(input)
  }

  status(documentId, adapterId) {
    return this.require(documentId, adapterId).status()
  }

  async close(input, adapterId) {
    this.assertRunning()
    const session = this.documents.get(input?.documentId)
    assertBroker(
      session,
      'DOCUMENT_NOT_OPEN',
      'The requested Markdown document is not open in this broker.',
      { retryable: true },
    )
    const operation = async () => {
      session.requireAdapter(adapterId)
      session.assertExpectedRevision(input?.expectedRevision)
      return session.releaseAdapter(adapterId)
    }
    if (input?.idempotencyKey === undefined) return operation()
    return session.withIdempotency(
      input.idempotencyKey,
      stableRequestHash({
        operation: 'close',
        adapterId,
        expectedRevision: input?.expectedRevision,
      }),
      operation,
    )
  }

  async flush(input, adapterId) {
    const session = this.require(input?.documentId, adapterId)
    if (input?.idempotencyKey === undefined) {
      return session.flush(input?.expectedRevision)
    }
    return session.withIdempotency(
      input.idempotencyKey,
      stableRequestHash({
        operation: 'flush',
        expectedRevision: input?.expectedRevision,
      }),
      () => session.flush(input?.expectedRevision),
    )
  }

  async reconcile(documentId, adapterId) {
    return this.require(documentId, adapterId).reconcileExternal()
  }

  createUiSession(documentId, adapterId) {
    return this.require(documentId, adapterId).createUiSession(adapterId)
  }

  async applyUiUpdate(input, adapterId) {
    return this.require(input?.documentId, adapterId).applyUiUpdate(input)
  }

  async pullUiUpdate(input, adapterId, options = {}) {
    return this.require(input?.documentId, adapterId)
      .pullUiUpdate(input, options)
  }

  updateUiAwareness(input, adapterId) {
    return this.require(input?.documentId, adapterId)
      .updateUiAwareness(input)
  }

  async refreshUiSession(input, adapterId) {
    this.assertRunning()
    validateAdapterId(adapterId)
    let session = this.documents.get(input?.documentId)
    if (!session) {
      const identity = await this.stateStore.readIdentity(input?.documentId)
      await this.open({
        workspaceRoot: identity.canonicalRoot,
        path: identity.relativePath,
      }, adapterId)
      session = this.documents.get(input.documentId)
    } else {
      session.acquireAdapter(adapterId)
    }
    assertBroker(
      session,
      'DOCUMENT_NOT_OPEN',
      'The requested Markdown document could not be reopened.',
      { retryable: true },
    )
    if (
      input?.generation !== session.generation ||
      input?.documentEpoch !== session.documentEpoch
    ) {
      return session.createUiSession(adapterId)
    }
    return session.refreshUiSession(input, adapterId)
  }

  async releaseAdapterEverywhere(adapterId) {
    validateAdapterId(adapterId)
    let releasedDocuments = 0
    let releasedUiSessions = 0
    for (const session of [...this.documents.values()]) {
      const result = await session.releaseAdapter(adapterId)
      if (result.released) releasedDocuments += 1
      releasedUiSessions += result.releasedUiSessions
      if (
        result.remainingAdapterLeases === 0 &&
        result.remainingUiSessions === 0
      ) {
        await session.destroy('adapter-released')
      }
    }
    return {
      adapterId,
      releasedDocuments,
      releasedUiSessions,
      remainingDocuments: this.documents.size,
    }
  }

  async revokeWorkspace(inputRoot) {
    const result = await this.workspaceRegistry.revoke(inputRoot)
    if (!result.revoked) return result
    const closing = [...this.documents.values()].filter(
      (session) => session.canonicalRoot === result.canonicalRoot,
    )
    for (const session of closing) {
      await session.destroy('workspace-revoked')
    }
    return { ...result, fencedDocuments: closing.length }
  }

  async evictIdle() {
    const now = this.clock()
    const candidates = [...this.documents.values()].filter(
      (session) => session.isIdle(now),
    )
    for (const session of candidates) await session.destroy('idle')
    return candidates.length
  }

  async shutdown() {
    if (this.closed) return
    this.closed = true
    const sessions = [...this.documents.values()]
    const results = await Promise.allSettled(
      sessions.map((session) => session.destroy('shutdown')),
    )
    const rejected = results.find((result) => result.status === 'rejected')
    if (rejected) throw rejected.reason
  }

  remove(documentId, session) {
    if (this.documents.get(documentId) === session) {
      this.documents.delete(documentId)
    }
  }

  assertRunning() {
    assertBroker(
      !this.closed,
      'BROKER_UNAVAILABLE',
      'The collaborative Markdown broker is shutting down.',
      { retryable: true },
    )
  }
}

export class DocumentSession {
  constructor(options) {
    this.registry = options.registry
    this.stateStore = options.stateStore
    this.state = options.state
    this.doc = options.state.doc
    this.ytext = options.state.ytext
    this.awareness = new Awareness(this.doc)
    this.lock = options.lock
    this.generation = options.generation
    this.clock = options.clock
    this.idleMs = options.idleMs
    this.documentId = options.state.metadata.documentId
    this.canonicalRoot = options.state.metadata.canonicalRoot
    this.canonicalPath = options.state.metadata.canonicalPath
    this.relativePath = options.state.metadata.relativePath
    this.revision = options.state.revision
    this.fileDurableRevision = options.state.fileDurableRevision
    this.documentEpoch = options.state.metadata.documentEpoch
    this.externalState = options.state.externalState
    this.readOnly = false
    this.recoveryRequired = false
    this.adapters = new Map()
    this.uiSessions = new Map()
    this.lastActiveAt = this.clock()
    this.serial = Promise.resolve()
    this.destroyed = false
    this.conflictId = options.state.metadata.conflictId ?? null
    this.filePersistence = new FilePersistence({
      session: this,
      stateStore: this.stateStore,
      state: this.state,
      generation: this.generation,
      fileSnapshot: options.fileSnapshot,
      ...options.filePersistenceOptions,
    })
    this.idempotency = new Map()
    for (const record of options.state.idempotencyRecords ?? []) {
      if (record.createdAt >= this.clock() - IDEMPOTENCY_TTL_MS) {
        this.idempotency.set(record.key, {
          requestHash: record.requestHash,
          createdAt: record.createdAt,
          promise: Promise.resolve(record.result),
        })
      }
    }
    this.revisionWaiters = new Set()
    this.recentAgentActivityUntil = 0
  }

  async initialize() {
    await this.filePersistence.initialize()
  }

  async abortInitialization() {
    this.destroyed = true
    await this.filePersistence.close()
    this.awareness.destroy()
    this.doc.destroy()
    await this.lock.release()
  }

  assertIdentity(resolved) {
    assertBroker(
      this.canonicalRoot === resolved.canonicalRoot &&
        this.canonicalPath === resolved.canonicalPath,
      'STATE_CORRUPT',
      'An open document identity collided with a different canonical path.',
    )
  }

  acquireAdapter(adapterId) {
    this.pruneAdapterLeases()
    assertBroker(
      this.adapters.has(adapterId) || this.adapters.size < MAX_ADAPTER_LEASES,
      'RESOURCE_LIMIT',
      `At most ${MAX_ADAPTER_LEASES} adapters may attach to one document.`,
      { retryable: true },
    )
    this.adapters.set(adapterId, this.clock())
    this.touch()
  }

  requireAdapter(adapterId) {
    this.pruneAdapterLeases()
    assertBroker(
      this.adapters.has(adapterId),
      'DOCUMENT_NOT_OPEN',
      'This adapter has no lease for the requested document.',
      { retryable: true },
    )
    this.adapters.set(adapterId, this.clock())
    this.touch()
  }

  pruneAdapterLeases() {
    const cutoff = this.clock() - ADAPTER_LEASE_TTL_MS
    for (const [adapterId, lastSeen] of this.adapters) {
      if (lastSeen < cutoff) this.adapters.delete(adapterId)
    }
  }

  async applyTextEdits(input) {
    const edits = validateEdits(input?.edits, this.ytext.length)
    return this.enqueueMutation('agent', () => {
      const projected = applyEditsToText(this.ytext.toString(), edits)
      assertBroker(
        Buffer.byteLength(projected, 'utf8') <= MAX_FILE_BYTES,
        'FILE_TOO_LARGE',
        `Markdown content may not exceed ${MAX_FILE_BYTES} UTF-8 bytes.`,
      )
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        if (edit.end > edit.start) {
          this.ytext.delete(edit.start, edit.end - edit.start)
        }
        if (edit.replacement.length > 0) {
          this.ytext.insert(edit.start, edit.replacement)
        }
      }
    }, {
      expectedRevision: input?.expectedRevision,
      changedFrom: Math.min(...edits.map((edit) => edit.start)),
      changedTo: Math.max(...edits.map((edit) => edit.end)),
    })
  }

  async applyYUpdate(input) {
    const update = Buffer.isBuffer(input?.update)
      ? input.update
      : Buffer.from(input?.updateBase64 ?? '', 'base64')
    assertBroker(
      update.length > 0 && update.length <= MAX_REPLACEMENT_BYTES,
      'INVALID_ARGUMENT',
      `A UI update must contain at most ${MAX_REPLACEMENT_BYTES} bytes.`,
    )
    return this.enqueueMutation(input?.originClass ?? 'ui', () => {
      validateYUpdateResult(this.doc, update)
      Y.applyUpdate(this.doc, update, input?.originClass ?? 'ui')
    }, { expectedRevision: input?.expectedRevision })
  }

  async enqueueMutation(originClass, mutate, resultFields = {}) {
    return this.enqueueFileOperation(() =>
      this.performMutation(originClass, mutate, resultFields))
  }

  async performMutation(originClass, mutate, resultFields = {}) {
    this.assertWritable()
    if (resultFields.expectedRevision !== undefined) {
      this.assertExpectedRevision(resultFields.expectedRevision)
    }
    const { expectedRevision: _expectedRevision, ...publicResultFields } =
      resultFields
    const beforeVector = Buffer.from(Y.encodeStateVector(this.doc))
    const previousRevision = this.revision
    this.doc.transact(mutate, originClass)
    const afterVector = Buffer.from(Y.encodeStateVector(this.doc))
    if (beforeVector.equals(afterVector)) {
      return {
        documentId: this.documentId,
        previousRevision: previousRevision.toString(),
        revision: previousRevision.toString(),
        changed: false,
        flushState: this.flushState(),
        fileDurableRevision: this.fileDurableRevision.toString(),
        ...publicResultFields,
      }
    }
    assertBroker(
      previousRevision < UINT64_MAX,
      'REVISION_EXHAUSTED',
      'The document revision counter is exhausted.',
    )
    const update = Y.encodeStateAsUpdate(this.doc, beforeVector)
    const nextRevision = previousRevision + 1n
    try {
      await this.stateStore.appendUpdate(
        this.state,
        update,
        nextRevision,
        originClass,
      )
    } catch (error) {
      this.readOnly = true
      this.recoveryRequired = true
      throw error
    }
    this.revision = nextRevision
    this.state.revision = nextRevision
    this.state.metadata.revision = nextRevision.toString()
    this.touch()
    if (originClass === 'agent') {
      this.recentAgentActivityUntil = this.clock() + 5_000
    }
    this.notifyRevisionWaiters()
    if (this.stateStore.shouldCompact(this.state)) {
      try {
        await this.stateStore.compact(this.state)
      } catch (error) {
        this.state.metadata.lastCompactionError = {
          code: error?.code ?? 'COMPACTION_FAILED',
          at: new Date(this.clock()).toISOString(),
        }
      }
    }
    if (originClass !== 'external-file') {
      this.filePersistence.scheduleFlush()
    }
    return {
      documentId: this.documentId,
      previousRevision: previousRevision.toString(),
      revision: nextRevision.toString(),
      changed: true,
      durability: 'recovery_log',
      flushState: this.flushState(),
      fileDurableRevision: this.fileDurableRevision.toString(),
      readOnly: this.readOnly,
      externalState: this.externalState,
      conflictId: this.conflictId,
      ...publicResultFields,
    }
  }

  read(input = {}) {
    if (input.expectedRevision !== undefined) {
      this.assertExpectedRevision(input.expectedRevision)
    }
    const length = this.ytext.length
    const hasFrom = input.from !== undefined
    const hasTo = input.to !== undefined
    assertBroker(
      hasFrom === hasTo,
      'INVALID_ARGUMENT',
      'from and to must be supplied together.',
    )
    const from = hasFrom ? input.from : 0
    const to = hasTo ? input.to : Math.min(length, 65_536)
    assertBroker(
      Number.isSafeInteger(from) &&
        Number.isSafeInteger(to) &&
        from >= 0 &&
        to >= from &&
        to <= length &&
        to - from <= 65_536,
      'INVALID_ARGUMENT',
      'The requested UTF-16 range is invalid or exceeds 65,536 code units.',
    )
    return {
      documentId: this.documentId,
      revision: this.revision.toString(),
      from,
      to,
      totalUtf16Length: length,
      text: this.ytext.toString().slice(from, to),
      truncated: to < length,
    }
  }

  status() {
    this.pruneAdapterLeases()
    this.pruneUiSessions()
    return {
      documentId: this.documentId,
      revision: this.revision.toString(),
      generation: this.generation,
      documentEpoch: this.documentEpoch,
      flushState: this.flushState(),
      fileDurableRevision: this.fileDurableRevision.toString(),
      uiSessions: this.uiSessions.size,
      adapterLeases: this.adapters.size,
      readOnly: this.readOnly,
      externalState: this.externalState,
      conflictId: this.conflictId,
    }
  }

  describe() {
    return {
      documentId: this.documentId,
      workspaceRoot: this.canonicalRoot,
      path: this.relativePath,
      revision: this.revision.toString(),
      generation: this.generation,
      documentEpoch: this.documentEpoch,
      byteLength: Buffer.byteLength(this.ytext.toString(), 'utf8'),
      utf16Length: this.ytext.length,
      encoding: this.state.metadata.encoding,
      bom: this.state.metadata.bom,
      lineEndings: this.state.metadata.lineEndings,
      finalNewline: this.state.metadata.finalNewline,
      mode: this.state.metadata.mode,
      flushState: this.flushState(),
      fileDurableRevision: this.fileDurableRevision.toString(),
    }
  }

  assertExpectedRevision(value) {
    assertBroker(
      typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value),
      'INVALID_ARGUMENT',
      'expected_revision must be an unsigned decimal revision string.',
    )
    assertBroker(
      BigInt(value) === this.revision,
      'STALE_REVISION',
      `Expected revision ${value}, but the document is at ${this.revision}.`,
      {
        retryable: true,
        details: { currentRevision: this.revision.toString() },
      },
    )
  }

  assertWritable() {
    assertBroker(
      !this.destroyed,
      'DOCUMENT_NOT_OPEN',
      'The document session is closed.',
      { retryable: true },
    )
    assertBroker(
      !this.readOnly && !this.recoveryRequired,
      this.recoveryRequired ? 'RECOVERY_REQUIRED' : 'READ_ONLY',
      'The document is not accepting mutations.',
    )
  }

  flushState() {
    if (this.recoveryRequired) return 'recovery_required'
    if (this.externalState === 'conflict') return 'conflict'
    if (this.readOnly) return 'read_only'
    return this.revision === this.fileDurableRevision
      ? 'file_durable'
      : 'recovery_log_durable'
  }

  async flush(expectedRevision) {
    return this.filePersistence.flushBarrier(expectedRevision)
  }

  async reconcileExternal() {
    return this.enqueueFileOperation(() =>
      this.filePersistence.reconcileExternal())
  }

  enqueueFileOperation(operation) {
    const pending = this.serial.then(operation)
    this.serial = pending.catch(() => {})
    return pending
  }

  async importExternalSnapshot(snapshot) {
    this.assertWritable()
    const current = this.ytext.toString()
    const baseline = this.filePersistence.baselineText
    if (snapshot.text === current) {
      this.externalState = 'clean'
      this.filePersistence.fileSnapshot = snapshot
      this.filePersistence.baselineText = snapshot.text
      await this.stateStore.markFileDurable(
        this.state,
        snapshot,
        this.revision,
      )
      this.fileDurableRevision = this.revision
      return {
        state: 'imported',
        revision: this.revision.toString(),
        merged: false,
      }
    }
    const computation = computeMergedTarget(current, baseline, snapshot.text)
    if (
      computation.failedHunks.length > 0 ||
      (computation.drifted &&
        computation.deletedRatio > DEGENERATE_DELETE_RATIO)
    ) {
      await this.enterConflict({
        externalState: 'conflict',
        externalText: snapshot.text,
        baselineText: baseline,
        failedHunks: computation.failedHunks,
      })
      return { state: 'conflict', conflictId: this.conflictId }
    }

    if (computation.target !== current) {
      await this.performMutation(
        'external-file',
        () => applyTextTarget(
          this.ytext,
          computation.target,
          'external-file',
        ),
        {},
      )
    }
    this.externalState = 'clean'
    this.filePersistence.fileSnapshot = snapshot
    this.filePersistence.baselineText = snapshot.text
    if (computation.target === snapshot.text) {
      await this.stateStore.markFileDurable(
        this.state,
        snapshot,
        this.revision,
      )
      this.fileDurableRevision = this.revision
    } else {
      await this.stateStore.updateFileMetadata(this.state, snapshot)
      this.filePersistence.scheduleFlush()
    }
    return {
      state: 'imported',
      revision: this.revision.toString(),
      merged: computation.drifted,
    }
  }

  async enterConflict(input) {
    if (this.conflictId) return this.conflictId
    const conflictId = crypto.randomUUID()
    this.conflictId = conflictId
    this.externalState = input.externalState ?? 'conflict'
    this.readOnly = true
    try {
      await this.stateStore.recordConflict(this.state, {
        id: conflictId,
        currentText: this.ytext.toString(),
        baselineText: input.baselineText ?? this.filePersistence.baselineText,
        externalText: input.externalText,
        externalState: input.externalState ?? 'conflict',
        externalError: input.externalError,
        failedHunks: input.failedHunks,
        renamedPath: input.renamedPath,
      })
    } catch (error) {
      this.recoveryRequired = true
      throw new BrokerError(
        'RECOVERY_REQUIRED',
        'The external conflict could not be checkpointed safely.',
        { cause: error },
      )
    }
    return conflictId
  }

  async withIdempotency(key, requestHash, operation) {
    validateIdempotencyKey(key)
    this.pruneIdempotency()
    const existing = this.idempotency.get(key)
    if (existing) {
      assertBroker(
        existing.requestHash === requestHash,
        'IDEMPOTENCY_REUSE',
        'This idempotency key was already used for a different request.',
      )
      return existing.promise
    }
    assertBroker(
      this.idempotency.size < MAX_IDEMPOTENCY_RECORDS,
      'RESOURCE_LIMIT',
      'The document idempotency cache is full.',
      { retryable: true },
    )
    const createdAt = this.clock()
    const promise = Promise.resolve()
      .then(operation)
      .then(async (result) => {
        try {
          await this.stateStore.saveIdempotency(this.state, {
            key,
            requestHash,
            createdAt,
            result,
          })
        } catch (error) {
          this.readOnly = true
          this.recoveryRequired = true
          throw new BrokerError(
            'RECOVERY_REQUIRED',
            'The mutation completed, but its idempotency receipt could not be checkpointed.',
            { cause: error },
          )
        }
        return result
      })
    const record = {
      requestHash,
      createdAt,
      promise,
    }
    this.idempotency.set(key, record)
    try {
      return await promise
    } catch (error) {
      if (this.idempotency.get(key) === record) this.idempotency.delete(key)
      throw error
    }
  }

  pruneIdempotency() {
    const cutoff = this.clock() - IDEMPOTENCY_TTL_MS
    for (const [key, record] of this.idempotency) {
      if (record.createdAt < cutoff) this.idempotency.delete(key)
    }
  }

  createUiSession(adapterId) {
    validateAdapterId(adapterId)
    this.pruneUiSessions()
    assertBroker(
      this.uiSessions.size < MAX_UI_SESSIONS_PER_DOCUMENT,
      'RESOURCE_LIMIT',
      `At most ${MAX_UI_SESSIONS_PER_DOCUMENT} UI sessions may attach to one document.`,
      { retryable: true },
    )
    const uiSessionId = crypto.randomUUID()
    const sessionCapability = crypto.randomBytes(32).toString('base64url')
    this.uiSessions.set(uiSessionId, {
      capability: sessionCapability,
      adapterId,
      expiresAt: this.clock() + UI_SESSION_TTL_MS,
      awarenessClock: 0,
      awareness: null,
      sequences: new Map(),
      pullPending: false,
    })
    this.touch()
    return this.uiBootstrap(uiSessionId, sessionCapability)
  }

  refreshUiSession(input, adapterId) {
    let record
    try {
      record = this.requireUiSession(input)
    } catch (error) {
      if (error?.code === 'PERMISSION_DENIED') {
        return this.createUiSession(adapterId)
      }
      throw error
    }
    const capability = crypto.randomBytes(32).toString('base64url')
    record.capability = capability
    record.adapterId = adapterId
    record.expiresAt = this.clock() + UI_SESSION_TTL_MS
    record.sequences.clear()
    return this.uiBootstrap(input.uiSessionId, capability)
  }

  async applyUiUpdate(input) {
    const uiSession = this.requireUiSession(input)
    assertBroker(
      typeof input.clientSequence === 'string' &&
        /^(0|[1-9][0-9]{0,19})$/.test(input.clientSequence),
      'INVALID_ARGUMENT',
      'client_sequence must be an unsigned decimal string.',
    )
    const update = Buffer.from(input.updateBase64 ?? '', 'base64')
    assertBroker(
      update.length > 0 && update.length <= MAX_REPLACEMENT_BYTES,
      'INVALID_ARGUMENT',
      `A UI update must contain at most ${MAX_REPLACEMENT_BYTES} bytes.`,
    )
    const updateHash = hashBuffer(update)
    assertBroker(
      updateHash === input.updateSha256,
      'INVALID_ARGUMENT',
      'The UI update hash does not match its decoded bytes.',
    )
    const prior = uiSession.sequences.get(input.clientSequence)
    if (prior) {
      assertBroker(
        prior.updateHash === updateHash,
        'IDEMPOTENCY_REUSE',
        'This UI client sequence was reused with different update bytes.',
      )
      return prior.result
    }
    const result = await this.enqueueMutation('ui', () => {
      validateYUpdateResult(this.doc, update)
      Y.applyUpdate(this.doc, update, 'ui')
    })
    const response = {
      revision: result.revision,
      acceptedSequence: input.clientSequence,
      durability: result.changed ? 'recovery_log' : undefined,
      flushState: result.flushState,
      fileDurableRevision: result.fileDurableRevision,
    }
    uiSession.sequences.set(input.clientSequence, {
      updateHash,
      result: response,
    })
    while (uiSession.sequences.size > MAX_UI_SEQUENCE_RECORDS) {
      uiSession.sequences.delete(uiSession.sequences.keys().next().value)
    }
    return response
  }

  async pullUiUpdate(input, options = {}) {
    const uiSession = this.requireUiSession(input)
    assertBroker(
      !uiSession.pullPending,
      'RESOURCE_LIMIT',
      'This UI session already has an outstanding synchronization poll.',
      { retryable: true },
    )
    assertBroker(
      typeof input.afterRevision === 'string' &&
        /^(0|[1-9][0-9]{0,19})$/.test(input.afterRevision),
      'INVALID_ARGUMENT',
      'after_revision must be an unsigned decimal string.',
    )
    assertBroker(
      Number.isSafeInteger(input.waitMs) &&
        input.waitMs >= 0 &&
        input.waitMs <= 20_000,
      'INVALID_ARGUMENT',
      'wait_ms must be between 0 and 20,000.',
    )
    const afterRevision = BigInt(input.afterRevision)
    assertBroker(
      afterRevision <= this.revision,
      'STALE_REVISION',
      'The UI revision is ahead of the broker revision.',
      { retryable: true },
    )
    if (afterRevision === this.revision && input.waitMs > 0) {
      uiSession.pullPending = true
      try {
        await this.waitForRevision(
          afterRevision,
          input.waitMs,
          options.signal,
        )
      } finally {
        uiSession.pullPending = false
      }
    }
    const vector = Buffer.from(input.stateVectorBase64 ?? '', 'base64')
    let update
    try {
      update = Y.encodeStateAsUpdate(this.doc, vector)
    } catch (cause) {
      throw new BrokerError(
        'INVALID_ARGUMENT',
        'The UI state vector is not valid Yjs state.',
        { cause },
      )
    }
    uiSession.expiresAt = this.clock() + UI_SESSION_TTL_MS
    return {
      revision: this.revision.toString(),
      updateBase64: Buffer.from(update).toString('base64'),
      updateSha256: hashBuffer(update),
      awareness: this.awarenessSnapshot(),
      awarenessClock: Math.max(
        0,
        ...[...this.uiSessions.values()].map((entry) =>
          entry.awarenessClock),
      ),
      flushState: this.flushState(),
      fileDurableRevision: this.fileDurableRevision.toString(),
      readOnly: this.readOnly,
      externalState: this.externalState,
      conflictId: this.conflictId,
    }
  }

  updateUiAwareness(input) {
    const uiSession = this.requireUiSession(input)
    assertBroker(
      Number.isSafeInteger(input.awarenessClock) &&
        input.awarenessClock > uiSession.awarenessClock,
      'STALE_AWARENESS',
      'Awareness clocks must increase monotonically.',
      { retryable: true },
    )
    uiSession.awarenessClock = input.awarenessClock
    uiSession.awareness = sanitizeAwareness(input.awareness)
    return { awarenessClock: uiSession.awarenessClock }
  }

  requireUiSession(input) {
    this.pruneUiSessions()
    assertBroker(
      input?.generation === this.generation,
      'GENERATION_STALE',
      'The UI belongs to a stale broker generation.',
      { retryable: true },
    )
    assertBroker(
      input?.documentEpoch === this.documentEpoch,
      'DOCUMENT_EPOCH_STALE',
      'The UI belongs to a stale document epoch.',
      { retryable: true },
    )
    const record = this.uiSessions.get(input?.uiSessionId)
    assertBroker(
      record && safeEqual(record.capability, input?.sessionCapability),
      'PERMISSION_DENIED',
      'The scoped UI session capability is invalid or expired.',
    )
    record.expiresAt = this.clock() + UI_SESSION_TTL_MS
    this.touch()
    return record
  }

  pruneUiSessions() {
    const now = this.clock()
    for (const [id, record] of this.uiSessions) {
      if (record.expiresAt <= now) this.uiSessions.delete(id)
    }
  }

  uiBootstrap(uiSessionId, sessionCapability) {
    const snapshot = Y.encodeStateAsUpdate(this.doc)
    const stateVector = Y.encodeStateVector(this.doc)
    return {
      documentId: this.documentId,
      generation: this.generation,
      documentEpoch: this.documentEpoch,
      uiSessionId,
      sessionCapability,
      revision: this.revision.toString(),
      snapshotBase64: Buffer.from(snapshot).toString('base64'),
      snapshotSha256: hashBuffer(snapshot),
      stateVectorBase64: Buffer.from(stateVector).toString('base64'),
      flushState: this.flushState(),
      fileDurableRevision: this.fileDurableRevision.toString(),
      path: this.relativePath,
      workspaceRoot: this.canonicalRoot,
    }
  }

  awarenessSnapshot() {
    const sessions = [...this.uiSessions.entries()]
      .filter(([_id, record]) => record.awareness !== null)
      .map(([uiSessionId, record]) => ({
        uiSessionId,
        awarenessClock: record.awarenessClock,
        ...record.awareness,
      }))
    if (this.recentAgentActivityUntil > this.clock()) {
      sessions.push({
        uiSessionId: 'agent',
        awarenessClock: Number(
          this.revision > BigInt(Number.MAX_SAFE_INTEGER)
            ? BigInt(Number.MAX_SAFE_INTEGER)
            : this.revision,
        ),
        displayName: 'Codex agent',
        color: '#7c3aed',
        selectionAnchor: this.ytext.length,
        selectionHead: this.ytext.length,
        originClass: 'agent',
      })
    }
    return sessions
  }

  waitForRevision(afterRevision, waitMs, signal) {
    if (this.revision > afterRevision || waitMs === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(waiter.timer)
        signal?.removeEventListener('abort', abort)
        this.revisionWaiters.delete(waiter)
        resolve()
      }
      const abort = () => {
        finish()
      }
      const waiter = { afterRevision, resolve: finish, timer: null }
      waiter.timer = setTimeout(() => {
        finish()
      }, waitMs)
      waiter.timer.unref?.()
      this.revisionWaiters.add(waiter)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  notifyRevisionWaiters() {
    for (const waiter of this.revisionWaiters) {
      if (this.revision > waiter.afterRevision) {
        clearTimeout(waiter.timer)
        this.revisionWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  async enterFileError(error) {
    this.readOnly = true
    this.externalState = 'changed'
    this.state.metadata.lastFileError = {
      code: error?.code ?? 'FILE_WATCH_FAILED',
      at: new Date(this.clock()).toISOString(),
    }
    await this.stateStore.compact(this.state)
  }

  async releaseAdapter(adapterId) {
    const released = this.adapters.delete(adapterId)
    let releasedUiSessions = 0
    for (const [uiSessionId, record] of this.uiSessions) {
      if (record.adapterId === adapterId) {
        this.uiSessions.delete(uiSessionId)
        releasedUiSessions += 1
      }
    }
    this.touch()
    return {
      documentId: this.documentId,
      revision: this.revision.toString(),
      released,
      releasedUiSessions,
      remainingAdapterLeases: this.adapters.size,
      remainingUiSessions: this.uiSessions.size,
      evictionScheduled:
        this.adapters.size === 0 && this.uiSessions.size === 0,
    }
  }

  isIdle(now = this.clock()) {
    this.pruneAdapterLeases()
    return this.adapters.size === 0 &&
      this.uiSessions.size === 0 &&
      now - this.lastActiveAt >= this.idleMs
  }

  touch() {
    this.lastActiveAt = this.clock()
  }

  async checkpoint() {
    await this.serial
    await this.stateStore.compact(this.state)
  }

  async destroy() {
    if (this.destroyed) return
    try {
      await this.serial
      await this.filePersistence.close()
      if (
        !this.readOnly &&
        !this.recoveryRequired &&
        this.externalState === 'clean' &&
        this.revision > this.fileDurableRevision
      ) {
        await this.filePersistence.flushNow()
      }
      await this.checkpoint()
    } finally {
      this.destroyed = true
      await this.filePersistence.close()
      this.registry.remove(this.documentId, this)
      for (const waiter of this.revisionWaiters) {
        clearTimeout(waiter.timer)
        waiter.resolve()
      }
      this.revisionWaiters.clear()
      this.awareness.destroy()
      this.doc.destroy()
      await this.lock.release()
    }
  }
}

function validateAdapterId(adapterId) {
  assertBroker(
    typeof adapterId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(adapterId),
    'INVALID_ARGUMENT',
    'adapter_id must be a 16–128 character opaque identifier.',
  )
}

function validateIdempotencyKey(key) {
  assertBroker(
    typeof key === 'string' &&
      key.length >= 16 &&
      key.length <= 128 &&
      /^[\x20-\x7e]+$/.test(key),
    'INVALID_ARGUMENT',
    'idempotency_key must contain 16–128 printable ASCII characters.',
  )
}

function stableRequestHash(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`
}

function hashBuffer(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')}`
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
}

function sanitizeAwareness(value) {
  assertBroker(
    value && typeof value === 'object' && !Array.isArray(value),
    'INVALID_ARGUMENT',
    'awareness must be an object.',
  )
  const allowed = new Set([
    'displayName',
    'color',
    'selectionAnchor',
    'selectionHead',
    'originClass',
  ])
  assertBroker(
    Object.keys(value).every((key) => allowed.has(key)),
    'INVALID_ARGUMENT',
    'awareness contains an unsupported field.',
  )
  assertBroker(
    typeof value.displayName === 'string' &&
      value.displayName.length >= 1 &&
      value.displayName.length <= 80 &&
      typeof value.color === 'string' &&
      /^#[0-9a-fA-F]{6}$/.test(value.color) &&
      Number.isSafeInteger(value.selectionAnchor) &&
      Number.isSafeInteger(value.selectionHead) &&
      value.selectionAnchor >= 0 &&
      value.selectionHead >= 0 &&
      value.selectionAnchor <= 2_097_152 &&
      value.selectionHead <= 2_097_152 &&
      ['human', 'agent'].includes(value.originClass),
    'INVALID_ARGUMENT',
    'awareness fields are invalid or out of bounds.',
  )
  return {
    displayName: value.displayName,
    color: value.color.toLowerCase(),
    selectionAnchor: value.selectionAnchor,
    selectionHead: value.selectionHead,
    originClass: value.originClass,
  }
}

function validateEdits(edits, documentLength) {
  assertBroker(
    Array.isArray(edits) && edits.length >= 1 && edits.length <= MAX_EDITS,
    'INVALID_ARGUMENT',
    `edits must contain between 1 and ${MAX_EDITS} entries.`,
  )
  let replacementBytes = 0
  const sorted = edits.map((edit) => {
    assertBroker(
      Number.isSafeInteger(edit?.start) &&
        Number.isSafeInteger(edit?.end) &&
        edit.start >= 0 &&
        edit.end >= edit.start &&
        edit.end <= documentLength &&
        typeof edit.replacement === 'string' &&
        !edit.replacement.includes('\r') &&
        !hasIsolatedSurrogate(edit.replacement),
      'INVALID_ARGUMENT',
      'Every edit must contain a valid UTF-16 range and Unicode replacement.',
    )
    replacementBytes += Buffer.byteLength(edit.replacement, 'utf8')
    return {
      start: edit.start,
      end: edit.end,
      replacement: edit.replacement,
    }
  }).sort((a, b) => a.start - b.start || a.end - b.end)
  for (let index = 1; index < sorted.length; index += 1) {
    assertBroker(
      sorted[index].start >= sorted[index - 1].end,
      'INVALID_ARGUMENT',
      'Edit ranges must not overlap.',
    )
  }
  assertBroker(
    replacementBytes <= MAX_REPLACEMENT_BYTES,
    'INVALID_ARGUMENT',
    `Replacement text may not exceed ${MAX_REPLACEMENT_BYTES} UTF-8 bytes.`,
  )
  return sorted
}

function hasIsolatedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function applyEditsToText(text, edits) {
  let result = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, edit.start) +
      edit.replacement +
      result.slice(edit.end)
  }
  return result
}

function validateYUpdateResult(currentDoc, update) {
  const probe = new Y.Doc()
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(currentDoc), 'probe:base')
    Y.applyUpdate(probe, update, 'probe:update')
    assertBroker(
      [...probe.share.keys()].every((key) => key === 'content'),
      'INVALID_ARGUMENT',
      'A UI update may only change the shared Markdown content type.',
    )
    assertBroker(
      Buffer.byteLength(probe.getText('content').toString(), 'utf8') <=
        MAX_FILE_BYTES,
      'FILE_TOO_LARGE',
      `Markdown content may not exceed ${MAX_FILE_BYTES} UTF-8 bytes.`,
    )
    assertBroker(
      !probe.getText('content').toString().includes('\r'),
      'INVALID_ARGUMENT',
      'A UI update must use normalized LF line endings.',
    )
  } catch (error) {
    if (error instanceof BrokerError) throw error
    throw new BrokerError(
      'INVALID_ARGUMENT',
      'The UI update is not a valid Yjs document update.',
      { cause: error },
    )
  } finally {
    probe.destroy()
  }
}

async function writePrivateJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
  if (process.platform !== 'win32') await fs.chmod(target, 0o600)
}
