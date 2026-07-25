import crypto from 'node:crypto'
import { watch } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_FILE_BYTES,
} from './config.mjs'
import { BrokerError, assertBroker } from './errors.mjs'
import {
  hashBytes,
  readMarkdownFile,
  resolveMarkdownFile,
} from './workspace.mjs'

export const DEFAULT_FLUSH_DEBOUNCE_MS = 150
export const DEFAULT_WATCH_DEBOUNCE_MS = 75

export class FilePersistence {
  constructor(options) {
    this.session = options.session
    this.stateStore = options.stateStore
    this.state = options.state
    this.generation = options.generation
    this.fileSnapshot = options.fileSnapshot
    this.baselineText = options.state.fileBaselineText
    this.flushDebounceMs =
      options.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS
    this.watchDebounceMs =
      options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
    this.fault = options.fault ?? (() => {})
    this.watchFactory = options.watchFactory ?? defaultWatchFactory
    this.flushTimer = null
    this.watchTimer = null
    this.watcher = null
    this.lastSelfWrite = null
    this.closed = false
  }

  async initialize() {
    await this.quarantineOrphanTemps()
    await this.recoverOrImportStartupChange()
    this.startWatcher()
    if (
      !this.session.readOnly &&
      this.session.externalState === 'clean' &&
      this.session.revision > this.session.fileDurableRevision
    ) {
      this.scheduleFlush()
    }
  }

  scheduleFlush() {
    if (this.closed || this.session.readOnly || this.session.recoveryRequired) {
      return
    }
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.session.enqueueFileOperation(() => this.flushNow())
        .catch(() => {})
    }, this.flushDebounceMs)
    this.flushTimer.unref?.()
  }

  async flushBarrier(expectedRevision) {
    this.session.assertExpectedRevision(expectedRevision)
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    return this.session.enqueueFileOperation(async () => {
      this.session.assertExpectedRevision(expectedRevision)
      return this.flushNow()
    })
  }

  async flushNow() {
    this.session.assertWritable()
    if (this.session.externalState !== 'clean') {
      throw new BrokerError(
        'EXTERNAL_CHANGE_PENDING',
        'The Markdown file changed outside the broker and must be reconciled.',
        { retryable: true },
      )
    }
    if (this.session.revision === this.session.fileDurableRevision) {
      return this.flushResult()
    }
    const text = this.session.ytext.toString()
    assertInternalText(text)
    const encoded = encodeMarkdown(text, this.state.metadata)
    assertBroker(
      encoded.length <= MAX_FILE_BYTES,
      'FILE_TOO_LARGE',
      `Markdown files may not exceed ${MAX_FILE_BYTES} bytes.`,
    )
    let written
    try {
      written = await atomicReplaceMarkdown({
        target: this.session.canonicalPath,
        expectedHash: this.fileSnapshot.contentHash,
        contents: encoded,
        mode: this.fileSnapshot.mode,
        documentId: this.session.documentId,
        generation: this.generation,
        fault: this.fault,
      })
    } catch (error) {
      if (error?.code === 'RECOVERY_REQUIRED') {
        const recovered = await this.reconcileExternal()
        if (
          recovered.state === 'imported' ||
          recovered.state === 'self' ||
          recovered.state === 'unchanged'
        ) {
          return this.flushResult()
        }
      }
      if (error?.code === 'EXTERNAL_CHANGED' || error?.code === 'FILE_NOT_FOUND') {
        await this.reconcileExternal()
      }
      throw error
    }
    this.lastSelfWrite = {
      generation: this.generation,
      contentHash: written.contentHash,
      revision: this.session.revision,
    }
    this.fileSnapshot = {
      ...this.fileSnapshot,
      ...written,
      text,
      lineEndings: this.state.metadata.lineEndings,
      bom: this.state.metadata.bom,
      finalNewline: text.endsWith('\n'),
    }
    this.baselineText = text
    try {
      await this.stateStore.markFileDurable(
        this.state,
        this.fileSnapshot,
        this.session.revision,
      )
    } catch (error) {
      this.session.readOnly = true
      this.session.recoveryRequired = true
      throw new BrokerError(
        'RECOVERY_REQUIRED',
        'The Markdown file is durable, but its state checkpoint failed.',
        { cause: error },
      )
    }
    this.session.fileDurableRevision = this.session.revision
    this.session.externalState = 'clean'
    return this.flushResult()
  }

  flushResult() {
    return {
      documentId: this.session.documentId,
      revision: this.session.revision.toString(),
      fileDurableRevision: this.session.fileDurableRevision.toString(),
      contentHash: this.fileSnapshot.contentHash,
      flushState: this.session.flushState(),
    }
  }

  async recoverOrImportStartupChange() {
    if (this.state.metadata.conflictId) {
      this.session.conflictId = this.state.metadata.conflictId
      this.session.externalState =
        this.state.metadata.externalState ?? 'conflict'
      this.session.readOnly = true
      return
    }
    if (this.fileSnapshot.contentHash === this.state.metadata.fileContentHash) {
      this.baselineText = this.fileSnapshot.text
      return
    }
    if (this.fileSnapshot.text === this.session.ytext.toString()) {
      await this.stateStore.markFileDurable(
        this.state,
        this.fileSnapshot,
        this.session.revision,
      )
      this.session.fileDurableRevision = this.session.revision
      this.session.externalState = 'clean'
      this.baselineText = this.fileSnapshot.text
      return
    }
    await this.session.importExternalSnapshot(this.fileSnapshot, {
      startup: true,
    })
  }

  startWatcher() {
    try {
      this.watcher = this.watchFactory(
        path.dirname(this.session.canonicalPath),
        (eventType, filename) => {
          if (
            filename !== null &&
            filename !== path.basename(this.session.canonicalPath)
          ) {
            return
          }
          this.scheduleReconcile(eventType)
        },
      )
      this.watcher.on?.('error', (error) => {
        this.session.enqueueFileOperation(() =>
          this.session.enterFileError(error)).catch(() => {})
      })
    } catch (error) {
      this.session.enqueueFileOperation(() =>
        this.session.enterFileError(error)).catch(() => {})
    }
  }

  scheduleReconcile() {
    if (this.closed) return
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null
      this.session.enqueueFileOperation(() => this.reconcileExternal())
        .catch(() => {})
    }, this.watchDebounceMs)
    this.watchTimer.unref?.()
  }

  async reconcileExternal() {
    if (this.closed) return { state: 'closed' }
    let snapshot
    try {
      snapshot = await readMarkdownFile(
        await resolveMarkdownFile(
          this.session.canonicalRoot,
          this.session.relativePath,
        ),
      )
    } catch (error) {
      if (
        ['FILE_NOT_FOUND', 'FILE_TYPE_UNSUPPORTED', 'SYMLINK_UNSUPPORTED']
          .includes(error?.code)
      ) {
        const renamedPath = error.code === 'FILE_NOT_FOUND'
          ? await this.findRenamedTarget()
          : null
        const externalState =
          error.code === 'FILE_NOT_FOUND' && !renamedPath
            ? 'deleted'
            : 'renamed'
        await this.session.enterConflict({
          externalState,
          externalText: null,
          externalError: error,
          baselineText: this.baselineText,
          renamedPath,
        })
        return { state: externalState }
      }
      if (error?.code === 'PERMISSION_DENIED') {
        await this.session.enterFileError(error)
        return { state: 'read_only' }
      }
      if (
        ['INVALID_UTF8', 'MIXED_LINE_ENDINGS', 'FILE_TOO_LARGE']
          .includes(error?.code)
      ) {
        await this.session.enterConflict({
          externalState: 'conflict',
          externalText: null,
          externalError: error,
          baselineText: this.baselineText,
        })
        return { state: 'conflict' }
      }
      throw error
    }

    if (snapshot.contentHash === this.fileSnapshot.contentHash) {
      if (
        snapshot.mode !== this.fileSnapshot.mode ||
        snapshot.stat.mtimeMs !== this.fileSnapshot.stat.mtimeMs
      ) {
        this.fileSnapshot = snapshot
        await this.stateStore.updateFileMetadata(this.state, snapshot)
      }
      return { state: 'unchanged' }
    }
    if (
      this.lastSelfWrite &&
      snapshot.contentHash === this.lastSelfWrite.contentHash
    ) {
      this.fileSnapshot = snapshot
      this.baselineText = snapshot.text
      this.lastSelfWrite = null
      return { state: 'self' }
    }
    const imported = await this.session.importExternalSnapshot(snapshot)
    this.fileSnapshot = snapshot
    this.baselineText = snapshot.text
    return imported
  }

  async quarantineOrphanTemps() {
    const directory = path.dirname(this.session.canonicalPath)
    const prefix =
      `.${path.basename(this.session.canonicalPath)}.codex-` +
      `${this.session.documentId}-`
    let entries
    try {
      entries = await fs.readdir(directory)
    } catch {
      return
    }
    const orphans = entries.filter(
      (entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'),
    )
    if (orphans.length === 0) return
    const recoveryRoot = path.join(this.state.paths.recovery, 'orphan-temps')
    await fs.mkdir(recoveryRoot, { recursive: true, mode: 0o700 })
    for (const orphan of orphans) {
      const source = path.join(directory, orphan)
      const target = path.join(
        recoveryRoot,
        `${Date.now()}-${crypto.randomUUID()}.tmp`,
      )
      try {
        await fs.rename(source, target)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  async findRenamedTarget() {
    const directory = path.dirname(this.session.canonicalPath)
    let entries
    try {
      entries = await fs.readdir(directory)
    } catch {
      return null
    }
    if (entries.length > 1_024) return null
    const expected = this.fileSnapshot.stat
    for (const entry of entries) {
      const candidate = path.join(directory, entry)
      if (candidate === this.session.canonicalPath) continue
      try {
        const stat = await fs.lstat(candidate)
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.dev === expected.dev &&
          stat.ino === expected.ino
        ) {
          return entry
        }
      } catch {}
    }
    return null
  }

  async close() {
    if (this.closed) return
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.flushTimer = null
    this.watchTimer = null
    this.watcher?.close()
    this.watcher = null
  }
}

export function encodeMarkdown(text, metadata) {
  assertInternalText(text)
  const eolText =
    metadata.lineEndings === 'crlf' ? text.replaceAll('\n', '\r\n') : text
  const body = Buffer.from(eolText, 'utf8')
  return metadata.bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
    : body
}

export async function atomicReplaceMarkdown(options) {
  const current = await readCurrentBytes(options.target)
  assertBroker(
    hashBytes(current) === options.expectedHash,
    'EXTERNAL_CHANGED',
    'The Markdown file changed before the durable flush barrier.',
    { retryable: true },
  )
  const directory = path.dirname(options.target)
  const basename = path.basename(options.target)
  const temporary = path.join(
    directory,
    `.${basename}.codex-${options.documentId}-${options.generation}-` +
      `${crypto.randomUUID()}.tmp`,
  )
  let handle
  let renamed = false
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(options.contents)
    if (options.mode !== null && process.platform !== 'win32') {
      await handle.chmod(options.mode)
    }
    await handle.sync()
    await handle.close()
    handle = null
    await options.fault('after-temp-sync', { temporary, target: options.target })

    const beforeRename = await readCurrentBytes(options.target)
    assertBroker(
      hashBytes(beforeRename) === options.expectedHash,
      'EXTERNAL_CHANGED',
      'The Markdown file changed during the durable flush barrier.',
      { retryable: true },
    )
    await fs.rename(temporary, options.target)
    renamed = true
    await options.fault('after-rename', { temporary, target: options.target })
    await syncDirectory(directory)
    await options.fault('after-directory-sync', {
      temporary,
      target: options.target,
    })
  } catch (cause) {
    if (!renamed && !cause?.simulateCrash) {
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
    if (cause instanceof BrokerError) throw cause
    throw new BrokerError(
      renamed ? 'RECOVERY_REQUIRED' : 'FILE_FLUSH_FAILED',
      renamed
        ? 'The Markdown file was replaced, but the durability checkpoint was interrupted.'
        : 'The Markdown file could not be replaced atomically.',
      {
        cause,
        retryable: !renamed,
        details: { phase: renamed ? 'after_rename' : 'before_rename' },
      },
    )
  } finally {
    await handle?.close().catch(() => {})
  }
  const stat = await fs.lstat(options.target)
  return {
    bytes: options.contents,
    byteLength: options.contents.length,
    contentHash: hashBytes(options.contents),
    finalNewline:
      options.contents.at(-1) === 0x0a,
    mode: process.platform === 'win32' ? null : stat.mode & 0o777,
    stat,
  }
}

function assertInternalText(text) {
  assertBroker(
    typeof text === 'string' &&
      !text.includes('\0') &&
      !text.includes('\r') &&
      !hasIsolatedSurrogate(text),
    'INVALID_UTF8',
    'Internal Markdown must be valid Unicode with normalized LF endings.',
  )
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

async function readCurrentBytes(target) {
  try {
    const stat = await fs.lstat(target)
    assertBroker(
      stat.isFile() && !stat.isSymbolicLink(),
      'FILE_TYPE_UNSUPPORTED',
      'The Markdown target is no longer a regular file.',
    )
    return await fs.readFile(target)
  } catch (cause) {
    if (cause instanceof BrokerError) throw cause
    if (cause?.code === 'ENOENT') {
      throw new BrokerError(
        'FILE_NOT_FOUND',
        'The Markdown target was deleted or renamed.',
        { retryable: true, cause },
      )
    }
    if (cause?.code === 'EACCES' || cause?.code === 'EPERM') {
      throw new BrokerError(
        'PERMISSION_DENIED',
        'The Markdown target is not writable with current permissions.',
        { retryable: true, cause },
      )
    }
    throw cause
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

function defaultWatchFactory(directory, listener) {
  return watch(directory, { persistent: false }, listener)
}
