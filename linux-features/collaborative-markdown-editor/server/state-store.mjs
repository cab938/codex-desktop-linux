import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import {
  STATE_SCHEMA_VERSION,
  UPDATE_LOG_BYTE_LIMIT,
  UPDATE_LOG_RECORD_LIMIT,
} from './config.mjs'
import { BrokerError, assertBroker } from './errors.mjs'
import { hashBytes, hashText } from './workspace.mjs'

const UINT64_MAX = 18_446_744_073_709_551_615n

export class DocumentStateStore {
  constructor(stateRoot, options = {}) {
    this.stateRoot = stateRoot
    this.documentsRoot = path.join(stateRoot, 'documents-v1')
    this.clock = options.clock ?? (() => Date.now())
  }

  async open(identity, fileSnapshot) {
    const paths = this.paths(identity.documentId)
    await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 })
    let metadata
    try {
      metadata = await this.readMetadata(paths.metadata)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return this.initialize(identity, fileSnapshot, paths)
    }

    validateIdentity(metadata, identity)
    const snapshot = await readRequired(paths.snapshot, 'STATE_CORRUPT')
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, snapshot, 'state:snapshot')
    } catch (cause) {
      doc.destroy()
      throw new BrokerError(
        'STATE_CORRUPT',
        'The persisted Yjs snapshot cannot be decoded.',
        { cause },
      )
    }
    const replay = await this.replayLog(paths, doc, BigInt(metadata.revision))
    const revision = replay.revision
    const ytext = doc.getText('content')
    const externalState =
      metadata.fileContentHash === fileSnapshot.contentHash ? 'clean' : 'changed'
    const fileDurableRevision = BigInt(metadata.fileDurableRevision)
    const dirty = revision > fileDurableRevision
    const fileBaselineText = await this.readFileBaseline(
      paths,
      metadata,
      fileSnapshot,
    )
    const idempotencyRecords = await this.readIdempotency(paths)

    return {
      doc,
      ytext,
      metadata: {
        ...metadata,
        revision: revision.toString(),
        lastOpenedAt: new Date(this.clock()).toISOString(),
      },
      revision,
      fileDurableRevision,
      updateLogRecords: replay.records,
      updateLogBytes: replay.bytes,
      externalState,
      dirty,
      fileBaselineText,
      idempotencyRecords,
      paths,
    }
  }

  async initialize(identity, fileSnapshot, paths = this.paths(identity.documentId)) {
    const doc = new Y.Doc()
    const ytext = doc.getText('content')
    if (fileSnapshot.text.length > 0) {
      ytext.insert(0, fileSnapshot.text)
    }
    const now = new Date(this.clock()).toISOString()
    const metadata = {
      schemaVersion: STATE_SCHEMA_VERSION,
      documentId: identity.documentId,
      canonicalRoot: identity.canonicalRoot,
      canonicalPath: identity.canonicalPath,
      relativePath: identity.relativePath,
      documentEpoch: crypto.randomUUID(),
      revision: '0',
      fileDurableRevision: '0',
      fileContentHash: fileSnapshot.contentHash,
      yTextContentHash: hashText(ytext.toString()),
      encoding: 'utf-8',
      bom: fileSnapshot.bom,
      lineEndings: fileSnapshot.lineEndings,
      finalNewline: fileSnapshot.finalNewline,
      mode: fileSnapshot.mode,
      snapshotGeneration: 1,
      createdAt: now,
      lastOpenedAt: now,
      compactedAt: now,
    }
    await writePrivateAtomic(paths.snapshot, Y.encodeStateAsUpdate(doc))
    await writePrivateAtomic(
      paths.metadata,
      Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
    )
    await writePrivateAtomic(paths.log, Buffer.alloc(0))
    await writePrivateAtomic(
      paths.fileBaseline,
      Buffer.from(fileSnapshot.text, 'utf8'),
    )
    await writePrivateAtomic(
      paths.idempotency,
      Buffer.from('[]\n'),
    )
    return {
      doc,
      ytext,
      metadata,
      revision: 0n,
      fileDurableRevision: 0n,
      updateLogRecords: 0,
      updateLogBytes: 0,
      externalState: 'clean',
      dirty: false,
      fileBaselineText: fileSnapshot.text,
      idempotencyRecords: [],
      paths,
    }
  }

  async appendUpdate(state, update, nextRevision, originClass) {
    assertBroker(
      update instanceof Uint8Array && update.byteLength > 0,
      'INVALID_ARGUMENT',
      'A persisted Yjs update must contain bytes.',
    )
    const updateBuffer = Buffer.from(update)
    const record = {
      schemaVersion: 1,
      revision: nextRevision.toString(),
      originClass,
      updateBase64: updateBuffer.toString('base64'),
      updateSha256: hashBytes(updateBuffer),
      yTextContentHash: hashText(state.ytext.toString()),
      acceptedAt: new Date(this.clock()).toISOString(),
    }
    const serializedRecord = JSON.stringify(record)
    const line = `${JSON.stringify({
      ...record,
      checksum: hashBytes(Buffer.from(serializedRecord)),
    })}\n`
    const handle = await fs.open(state.paths.log, 'a', 0o600)
    try {
      await handle.writeFile(line, 'utf8')
      await handle.sync()
    } catch (cause) {
      throw new BrokerError(
        'RECOVERY_REQUIRED',
        'The accepted update could not be written to the recovery log.',
        { cause, retryable: false },
      )
    } finally {
      await handle.close()
    }
    state.updateLogRecords += 1
    state.updateLogBytes += Buffer.byteLength(line)
    state.metadata.yTextContentHash = record.yTextContentHash
    state.dirty = nextRevision > state.fileDurableRevision
  }

  shouldCompact(state) {
    return state.updateLogRecords >= UPDATE_LOG_RECORD_LIMIT ||
      state.updateLogBytes >= UPDATE_LOG_BYTE_LIMIT
  }

  async markFileDurable(state, fileSnapshot, revision) {
    state.fileDurableRevision = revision
    state.dirty = state.revision > revision
    state.metadata = {
      ...state.metadata,
      fileDurableRevision: revision.toString(),
      fileContentHash: fileSnapshot.contentHash,
      encoding: 'utf-8',
      bom: fileSnapshot.bom,
      lineEndings: fileSnapshot.lineEndings,
      finalNewline: fileSnapshot.finalNewline,
      mode: fileSnapshot.mode,
      conflictId: null,
      externalState: 'clean',
    }
    state.fileBaselineText = fileSnapshot.text
    await writePrivateAtomic(
      state.paths.fileBaseline,
      Buffer.from(fileSnapshot.text, 'utf8'),
    )
    await this.compact(state)
  }

  async updateFileMetadata(state, fileSnapshot) {
    state.metadata = {
      ...state.metadata,
      fileContentHash: fileSnapshot.contentHash,
      bom: fileSnapshot.bom,
      lineEndings: fileSnapshot.lineEndings,
      finalNewline: fileSnapshot.finalNewline,
      mode: fileSnapshot.mode,
      lastObservedFileAt: new Date(this.clock()).toISOString(),
    }
    state.fileBaselineText = fileSnapshot.text
    await writePrivateAtomic(
      state.paths.fileBaseline,
      Buffer.from(fileSnapshot.text, 'utf8'),
    )
    await writePrivateAtomic(
      state.paths.metadata,
      Buffer.from(`${JSON.stringify(state.metadata, null, 2)}\n`),
    )
  }

  async recordConflict(state, conflict) {
    const directory = path.join(state.paths.directory, 'conflict', conflict.id)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await writePrivateAtomic(
      path.join(directory, 'current.md'),
      Buffer.from(conflict.currentText, 'utf8'),
    )
    await writePrivateAtomic(
      path.join(directory, 'baseline.md'),
      Buffer.from(conflict.baselineText, 'utf8'),
    )
    if (typeof conflict.externalText === 'string') {
      await writePrivateAtomic(
        path.join(directory, 'external.md'),
        Buffer.from(conflict.externalText, 'utf8'),
      )
    }
    await writePrivateAtomic(
      path.join(directory, 'conflict.json'),
      Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        conflictId: conflict.id,
        externalState: conflict.externalState,
        failedHunks: conflict.failedHunks ?? [],
        errorCode: conflict.externalError?.code ?? null,
        renamedPath: conflict.renamedPath ?? null,
        revision: state.revision.toString(),
        recordedAt: new Date(this.clock()).toISOString(),
      }, null, 2)}\n`),
    )
    state.metadata = {
      ...state.metadata,
      conflictId: conflict.id,
      externalState: conflict.externalState,
    }
    await this.compact(state)
    return directory
  }

  async saveIdempotency(state, record) {
    const cutoff = this.clock() - 24 * 60 * 60_000
    state.idempotencyRecords = [
      ...state.idempotencyRecords.filter(
        (entry) => entry.createdAt >= cutoff && entry.key !== record.key,
      ),
      record,
    ].slice(-4_096)
    await writePrivateAtomic(
      state.paths.idempotency,
      Buffer.from(`${JSON.stringify(state.idempotencyRecords, null, 2)}\n`),
    )
  }

  async compact(state) {
    const nextMetadata = {
      ...state.metadata,
      schemaVersion: STATE_SCHEMA_VERSION,
      revision: state.revision.toString(),
      fileDurableRevision: state.fileDurableRevision.toString(),
      yTextContentHash: hashText(state.ytext.toString()),
      snapshotGeneration: state.metadata.snapshotGeneration + 1,
      compactedAt: new Date(this.clock()).toISOString(),
    }
    await writePrivateAtomic(
      state.paths.snapshot,
      Y.encodeStateAsUpdate(state.doc),
    )
    await writePrivateAtomic(
      state.paths.metadata,
      Buffer.from(`${JSON.stringify(nextMetadata, null, 2)}\n`),
    )
    await writePrivateAtomic(state.paths.log, Buffer.alloc(0))
    state.metadata = nextMetadata
    state.updateLogRecords = 0
    state.updateLogBytes = 0
  }

  paths(documentId) {
    const directory = path.join(this.documentsRoot, documentId)
    return {
      directory,
      metadata: path.join(directory, 'metadata.json'),
      snapshot: path.join(directory, 'snapshot.yjs'),
      log: path.join(directory, 'updates.log'),
      fileBaseline: path.join(directory, 'file-baseline.utf8'),
      idempotency: path.join(directory, 'idempotency.json'),
      recovery: path.join(directory, 'recovery'),
    }
  }

  async readFileBaseline(paths, metadata, fileSnapshot) {
    try {
      return await fs.readFile(paths.fileBaseline, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      assertBroker(
        metadata.fileContentHash === fileSnapshot.contentHash,
        'RECOVERY_REQUIRED',
        'The prior file baseline is missing while the Markdown file has changed.',
      )
      await writePrivateAtomic(
        paths.fileBaseline,
        Buffer.from(fileSnapshot.text, 'utf8'),
      )
      return fileSnapshot.text
    }
  }

  async readIdempotency(paths) {
    let value
    try {
      value = JSON.parse(await fs.readFile(paths.idempotency, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await writePrivateAtomic(paths.idempotency, Buffer.from('[]\n'))
        return []
      }
      if (error instanceof SyntaxError) {
        throw new BrokerError(
          'STATE_CORRUPT',
          'The document idempotency journal is not valid JSON.',
          { cause: error },
        )
      }
      throw error
    }
    assertBroker(
      Array.isArray(value) &&
        value.every((entry) =>
          typeof entry?.key === 'string' &&
          typeof entry?.requestHash === 'string' &&
          Number.isFinite(entry?.createdAt) &&
          entry?.result &&
          typeof entry.result === 'object'),
      'STATE_CORRUPT',
      'The document idempotency journal is invalid.',
    )
    return value.slice(-4_096)
  }

  async readMetadata(metadataPath) {
    let metadata
    try {
      metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new BrokerError(
          'STATE_CORRUPT',
          'The document metadata is not valid JSON.',
          { cause: error },
        )
      }
      throw error
    }
    if (metadata?.schemaVersion === 0) {
      metadata = {
        ...metadata,
        schemaVersion: 1,
        lastOpenedAt: metadata.lastOpenedAt ?? metadata.createdAt,
        compactedAt: metadata.compactedAt ?? metadata.createdAt,
      }
      await writePrivateAtomic(
        metadataPath,
        Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`),
      )
    }
    assertBroker(
      metadata?.schemaVersion === STATE_SCHEMA_VERSION,
      'STATE_VERSION_UNSUPPORTED',
      'The persisted document uses an unsupported state schema.',
      { details: { schemaVersion: metadata?.schemaVersion ?? null } },
    )
    assertBroker(
      typeof metadata.revision === 'string' &&
        typeof metadata.fileDurableRevision === 'string' &&
        typeof metadata.documentEpoch === 'string',
      'STATE_CORRUPT',
      'The document metadata is incomplete.',
    )
    return metadata
  }

  async replayLog(paths, doc, metadataRevision) {
    let bytes
    try {
      bytes = await fs.readFile(paths.log)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await writePrivateAtomic(paths.log, Buffer.alloc(0))
      return { revision: metadataRevision, records: 0, bytes: 0 }
    }
    if (bytes.length === 0) {
      return { revision: metadataRevision, records: 0, bytes: 0 }
    }

    let complete = bytes
    if (bytes.at(-1) !== 0x0a) {
      const lastNewline = bytes.lastIndexOf(0x0a)
      const completeLength = lastNewline < 0 ? 0 : lastNewline + 1
      complete = bytes.subarray(0, completeLength)
      await fs.mkdir(paths.recovery, { recursive: true, mode: 0o700 })
      await writePrivateAtomic(
        path.join(paths.recovery, `truncated-log-${Date.now()}.bin`),
        bytes.subarray(completeLength),
      )
      await writePrivateAtomic(paths.log, complete)
    }

    let revision = metadataRevision
    let records = 0
    let lastRecordRevision = null
    for (const line of complete.toString('utf8').split('\n')) {
      if (line === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch (cause) {
        throw new BrokerError(
          'STATE_CORRUPT',
          'A complete recovery-log record is not valid JSON.',
          { cause },
        )
      }
      validateLogRecord(record)
      const update = Buffer.from(record.updateBase64, 'base64')
      assertBroker(
        hashBytes(update) === record.updateSha256,
        'STATE_CORRUPT',
        'A recovery-log update checksum does not match.',
      )
      const { checksum, ...unsigned } = record
      assertBroker(
        hashBytes(Buffer.from(JSON.stringify(unsigned))) === checksum,
        'STATE_CORRUPT',
        'A recovery-log record checksum does not match.',
      )
      const recordRevision = BigInt(record.revision)
      assertBroker(
        recordRevision <= UINT64_MAX &&
          (lastRecordRevision === null ||
            recordRevision === lastRecordRevision + 1n),
        'STATE_CORRUPT',
        'Recovery-log revisions are not contiguous.',
      )
      lastRecordRevision = recordRevision
      records += 1
      if (recordRevision <= metadataRevision) continue
      assertBroker(
        recordRevision === revision + 1n,
        'STATE_CORRUPT',
        'Recovery-log revisions do not continue the persisted snapshot.',
      )
      try {
        Y.applyUpdate(doc, update, 'state:replay')
      } catch (cause) {
        throw new BrokerError(
          'STATE_CORRUPT',
          'A recovery-log Yjs update cannot be decoded.',
          { cause },
        )
      }
      revision = recordRevision
    }
    return { revision, records, bytes: complete.length }
  }
}

function validateIdentity(metadata, identity) {
  assertBroker(
    metadata.documentId === identity.documentId &&
      metadata.canonicalRoot === identity.canonicalRoot &&
      metadata.canonicalPath === identity.canonicalPath,
    'STATE_CORRUPT',
    'Persisted document identity does not match the canonical file.',
  )
}

function validateLogRecord(record) {
  assertBroker(
    record?.schemaVersion === 1 &&
      /^(0|[1-9][0-9]{0,19})$/.test(record.revision) &&
      typeof record.updateBase64 === 'string' &&
      typeof record.updateSha256 === 'string' &&
      typeof record.checksum === 'string',
    'STATE_CORRUPT',
    'A recovery-log record is incomplete.',
  )
}

async function readRequired(filePath, code) {
  try {
    return await fs.readFile(filePath)
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new BrokerError(
        code,
        'Required persisted document state is missing.',
        { cause },
      )
    }
    throw cause
  }
}

async function writePrivateAtomic(target, contents) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
  if (process.platform !== 'win32') await fs.chmod(target, 0o600)
}
