import crypto from 'node:crypto'
import path from 'node:path'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import {
  ADAPTER_LEASE_TTL_MS,
  DOCUMENT_IDLE_MS,
  MAX_ADAPTER_LEASES,
  MAX_FILE_BYTES,
  MAX_OPEN_DOCUMENTS,
} from './config.mjs'
import { BrokerError, assertBroker } from './errors.mjs'
import { acquireDirectoryLock } from './lock.mjs'
import { DocumentStateStore } from './state-store.mjs'
import {
  documentIdentity,
  readMarkdownFile,
  resolveMarkdownFile,
} from './workspace.mjs'

const UINT64_MAX = 18_446_744_073_709_551_615n
const MAX_EDITS = 256
const MAX_REPLACEMENT_BYTES = 512 * 1024

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
    this.documents = new Map()
    this.closed = false
  }

  async open(input, adapterId) {
    this.assertRunning()
    validateAdapterId(adapterId)
    const approval = await this.workspaceRegistry.requireApproved(
      input?.workspaceRoot,
    )
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
      const session = new DocumentSession({
        registry: this,
        stateStore: this.stateStore,
        state,
        lock,
        generation: this.generation,
        clock: this.clock,
        idleMs: this.idleMs,
      })
      session.acquireAdapter(adapterId)
      this.documents.set(documentId, session)
      return session.describe()
    } catch (error) {
      await lock.release()
      throw error
    }
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
    return this.require(input?.documentId, adapterId).applyTextEdits(input)
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
    const session = this.require(input?.documentId, adapterId)
    if (input?.expectedRevision !== undefined) {
      session.assertExpectedRevision(input.expectedRevision)
    }
    return session.releaseAdapter(adapterId)
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
    const operation = this.serial.then(async () => {
      this.assertWritable()
      this.assertExpectedRevision(resultFields.expectedRevision)
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
      if (this.stateStore.shouldCompact(this.state)) {
        await this.stateStore.compact(this.state)
      }
      return {
        documentId: this.documentId,
        previousRevision: previousRevision.toString(),
        revision: nextRevision.toString(),
        changed: true,
        durability: 'recovery_log',
        flushState: this.flushState(),
        fileDurableRevision: this.fileDurableRevision.toString(),
        ...publicResultFields,
      }
    })
    this.serial = operation.catch(() => {})
    return operation
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
      conflictId: null,
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
    if (this.readOnly) return 'read_only'
    if (this.externalState === 'conflict') return 'conflict'
    return this.revision === this.fileDurableRevision
      ? 'file_durable'
      : 'recovery_log_durable'
  }

  async releaseAdapter(adapterId) {
    const released = this.adapters.delete(adapterId)
    this.touch()
    return {
      documentId: this.documentId,
      revision: this.revision.toString(),
      released,
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
    this.destroyed = true
    try {
      await this.checkpoint()
    } finally {
      this.registry.remove(this.documentId, this)
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
