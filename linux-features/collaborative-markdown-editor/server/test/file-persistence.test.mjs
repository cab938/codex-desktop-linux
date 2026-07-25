import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as fc from 'fast-check'
import { DocumentRegistry } from '../document-registry.mjs'
import {
  atomicReplaceMarkdown,
  encodeMarkdown,
} from '../file-persistence.mjs'
import { computeMergedTarget } from '../merge.mjs'
import {
  hashBytes,
} from '../workspace.mjs'
import {
  approveWorkspace,
  makeFixture,
  waitFor,
} from './helpers.mjs'

const ADAPTER = 'file_adapter_123456789'
const NO_WATCHER = () => ({ on() {}, close() {} })
const CRASH_WORKER = fileURLToPath(new URL('./crash-worker.mjs', import.meta.url))

test('flush preserves BOM, CRLF, final newline, and POSIX mode byte-for-byte', async (t) => {
  const fixture = await makeFixture(t, 'file-codec')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(
    target,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Title\r\n', 'utf8'),
    ]),
    { mode: 0o640 },
  )
  const { registry, opened } = await openRegistry(fixture)
  await registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: '0',
    edits: [{ start: 7, end: 7, replacement: ' edited' }],
  }, ADAPTER)
  const flushed = await registry.flush({
    documentId: opened.documentId,
    expectedRevision: '1',
  }, ADAPTER)
  assert.equal(flushed.flushState, 'file_durable')
  assert.deepEqual(
    await fs.readFile(target),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Title edited\r\n', 'utf8'),
    ]),
  )
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
  }
  await registry.shutdown()
})

test('ordinary edits debounce to a durable Markdown file', async (t) => {
  const fixture = await makeFixture(t, 'file-debounce')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'hello\n')
  const { registry, opened } = await openRegistry(fixture, {
    flushDebounceMs: 10,
  })
  await registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: '0',
    edits: [{ start: 5, end: 5, replacement: ' timer' }],
  }, ADAPTER)
  await waitFor(async () => (await fs.readFile(target, 'utf8')) === 'hello timer\n')
  assert.equal(
    registry.status(opened.documentId, ADAPTER).flushState,
    'file_durable',
  )
  await registry.shutdown()
})

test('safe-write external replacement imports one minimal durable revision', async (t) => {
  const fixture = await makeFixture(t, 'file-safe-write')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'first\nsecond\n')
  const { registry, opened } = await openRegistry(fixture)
  const replacement = path.join(fixture.workspaceRoot, '.editor-save')
  await fs.writeFile(replacement, 'first changed\nsecond\n')
  await fs.rename(replacement, target)
  const result = await registry.reconcile(opened.documentId, ADAPTER)
  assert.equal(result.state, 'imported')
  assert.equal(result.revision, '1')
  assert.equal(
    registry.read({ documentId: opened.documentId }, ADAPTER).text,
    'first changed\nsecond\n',
  )
  assert.equal(
    registry.status(opened.documentId, ADAPTER).flushState,
    'file_durable',
  )
  await registry.shutdown()
})

test('disjoint agent and external edits merge and then flush without loss', async (t) => {
  const fixture = await makeFixture(t, 'file-merge')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'alpha paragraph\n\nbeta paragraph\n')
  const { registry, opened } = await openRegistry(fixture)
  await registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: '0',
    edits: [{ start: 15, end: 15, replacement: ' AGENT' }],
  }, ADAPTER)
  await fs.writeFile(target, 'alpha paragraph\n\nbeta paragraph FILE\n')
  const imported = await registry.reconcile(opened.documentId, ADAPTER)
  assert.equal(imported.state, 'imported')
  assert.equal(imported.revision, '2')
  const merged = registry.read({
    documentId: opened.documentId,
    expectedRevision: '2',
  }, ADAPTER).text
  assert.match(merged, /AGENT/)
  assert.match(merged, /FILE/)
  await registry.flush({
    documentId: opened.documentId,
    expectedRevision: '2',
  }, ADAPTER)
  assert.equal(await fs.readFile(target, 'utf8'), merged)
  await registry.shutdown()
})

test('ambiguous rewrite enters a preserved read-only conflict', async (t) => {
  const fixture = await makeFixture(t, 'file-conflict')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  const baseline = 'The quick brown fox jumps over the lazy dog. '.repeat(8)
  await fs.writeFile(target, baseline)
  const { registry, opened } = await openRegistry(fixture)
  await registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: '0',
    edits: [{ start: 0, end: 0, replacement: 'AGENT ' }],
  }, ADAPTER)
  const external = 'Entirely unrelated replacement.\n'
  await fs.writeFile(target, external)
  const result = await registry.reconcile(opened.documentId, ADAPTER)
  assert.equal(result.state, 'conflict')
  const status = registry.status(opened.documentId, ADAPTER)
  assert.equal(status.flushState, 'conflict')
  assert.equal(status.readOnly, true)
  assert.equal(await fs.readFile(target, 'utf8'), external)
  const conflictRoot = path.join(
    fixture.stateRoot,
    'documents-v1',
    opened.documentId,
    'conflict',
    status.conflictId,
  )
  assert.equal(await fs.readFile(path.join(conflictRoot, 'baseline.md'), 'utf8'), baseline)
  assert.equal(await fs.readFile(path.join(conflictRoot, 'external.md'), 'utf8'), external)
  assert.match(
    await fs.readFile(path.join(conflictRoot, 'current.md'), 'utf8'),
    /^AGENT /,
  )
  await assert.rejects(
    registry.applyTextEdits({
      documentId: opened.documentId,
      expectedRevision: '1',
      edits: [{ start: 0, end: 0, replacement: 'NO' }],
    }, ADAPTER),
    { code: 'READ_ONLY' },
  )
  await registry.shutdown()
})

test('delete is preserved as a conflict and never silently recreates the file', async (t) => {
  const fixture = await makeFixture(t, 'file-delete')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'hello\n')
  const { registry, opened } = await openRegistry(fixture)
  await fs.unlink(target)
  const result = await registry.reconcile(opened.documentId, ADAPTER)
  assert.equal(result.state, 'deleted')
  assert.equal(
    registry.status(opened.documentId, ADAPTER).externalState,
    'deleted',
  )
  await registry.shutdown()
  await assert.rejects(fs.access(target), { code: 'ENOENT' })
})

test('rename-away is distinguished from deletion and preserves the new path', async (t) => {
  const fixture = await makeFixture(t, 'file-rename')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  const renamed = path.join(fixture.workspaceRoot, 'renamed.md')
  await fs.writeFile(target, 'hello\n')
  const { registry, opened } = await openRegistry(fixture)
  await fs.rename(target, renamed)
  const result = await registry.reconcile(opened.documentId, ADAPTER)
  assert.equal(result.state, 'renamed')
  const status = registry.status(opened.documentId, ADAPTER)
  const conflict = JSON.parse(await fs.readFile(path.join(
    fixture.stateRoot,
    'documents-v1',
    opened.documentId,
    'conflict',
    status.conflictId,
    'conflict.json',
  ), 'utf8'))
  assert.equal(conflict.renamedPath, 'renamed.md')
  await registry.shutdown()
  assert.equal(await fs.readFile(renamed, 'utf8'), 'hello\n')
  await assert.rejects(fs.access(target), { code: 'ENOENT' })
})

test('invalid external bytes enter conflict without overwriting the project file', async (t) => {
  const fixture = await makeFixture(t, 'file-invalid-external')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'hello\n')
  const { registry, opened } = await openRegistry(fixture)
  const invalid = Buffer.from([0xff, 0xfe, 0x00])
  await fs.writeFile(target, invalid)
  const result = await registry.reconcile(opened.documentId, ADAPTER)
  assert.equal(result.state, 'conflict')
  assert.deepEqual(await fs.readFile(target), invalid)
  assert.equal(
    registry.status(opened.documentId, ADAPTER).flushState,
    'conflict',
  )
  await registry.shutdown()
})

test('external permission changes become the preserved mode for later flushes', async (t) => {
  if (process.platform === 'win32') return
  const fixture = await makeFixture(t, 'file-mode')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'hello\n', { mode: 0o644 })
  const { registry, opened } = await openRegistry(fixture)
  await fs.chmod(target, 0o600)
  assert.equal(
    (await registry.reconcile(opened.documentId, ADAPTER)).state,
    'unchanged',
  )
  await registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: '0',
    edits: [{ start: 5, end: 5, replacement: ' mode' }],
  }, ADAPTER)
  await registry.flush({
    documentId: opened.documentId,
    expectedRevision: '1',
  }, ADAPTER)
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600)
  await registry.shutdown()
})

test('the real directory watcher imports an external edit', async (t) => {
  const fixture = await makeFixture(t, 'file-watch')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'before\n')
  const workspaceRegistry = await approveWorkspace(
    fixture.stateRoot,
    fixture.workspaceRoot,
  )
  const registry = new DocumentRegistry({
    stateRoot: fixture.stateRoot,
    workspaceRegistry,
    filePersistenceOptions: {
      flushDebounceMs: 60_000,
      watchDebounceMs: 10,
    },
  })
  const opened = await registry.open({
    workspaceRoot: fixture.workspaceRoot,
    path: 'notes.md',
  }, ADAPTER)
  await fs.writeFile(target, 'after\n')
  await waitFor(
    () => registry.status(opened.documentId, ADAPTER).revision === '1',
  )
  assert.equal(
    registry.read({ documentId: opened.documentId }, ADAPTER).text,
    'after\n',
  )
  await registry.shutdown()
})

test('atomic replacement detects a racing external write and leaves it intact', async (t) => {
  const fixture = await makeFixture(t, 'file-race')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'baseline\n')
  const expectedHash = hashBytes(await fs.readFile(target))
  await assert.rejects(
    atomicReplaceMarkdown({
      target,
      expectedHash,
      contents: Buffer.from('agent\n'),
      mode: 0o644,
      documentId: 'doc_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      generation: '00000000-0000-4000-8000-000000000000',
      async fault(point) {
        if (point === 'after-temp-sync') {
          await fs.writeFile(target, 'external\n')
        }
      },
    }),
    { code: 'EXTERNAL_CHANGED' },
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'external\n')
})

test('process death before rename preserves the file and quarantines the orphan temp', async (t) => {
  const fixture = await makeFixture(t, 'file-crash-before')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'hello\n')
  await approveWorkspace(fixture.stateRoot, fixture.workspaceRoot)
  assert.equal(
    await runCrashWorker(fixture, 'after-temp-sync'),
    92,
  )
  assert.equal(await fs.readFile(target, 'utf8'), 'hello\n')

  const { registry, opened } = await openRegistry(fixture)
  assert.equal(opened.revision, '1')
  await registry.flush({
    documentId: opened.documentId,
    expectedRevision: '1',
  }, ADAPTER)
  assert.equal(await fs.readFile(target, 'utf8'), 'hello crash\n')
  const recovery = path.join(
    fixture.stateRoot,
    'documents-v1',
    opened.documentId,
    'recovery',
    'orphan-temps',
  )
  assert.equal((await fs.readdir(recovery)).length, 1)
  await registry.shutdown()
})

test('process death after rename is recognized as an already durable revision', async (t) => {
  const fixture = await makeFixture(t, 'file-crash-after')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'hello\n')
  await approveWorkspace(fixture.stateRoot, fixture.workspaceRoot)
  assert.equal(await runCrashWorker(fixture, 'after-rename'), 91)
  assert.equal(await fs.readFile(target, 'utf8'), 'hello crash\n')

  const { registry, opened } = await openRegistry(fixture)
  assert.equal(opened.revision, '1')
  assert.equal(opened.fileDurableRevision, '1')
  assert.equal(opened.flushState, 'file_durable')
  assert.equal(
    registry.read({ documentId: opened.documentId }, ADAPTER).text,
    'hello crash\n',
  )
  await registry.shutdown()
})

test('process exit after the durability checkpoint reopens without replay loss', async (t) => {
  const fixture = await makeFixture(t, 'file-crash-checkpointed')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'hello\n')
  await approveWorkspace(fixture.stateRoot, fixture.workspaceRoot)
  assert.equal(await runCrashWorker(fixture, 'after-state-checkpoint'), 90)
  assert.equal(await fs.readFile(target, 'utf8'), 'hello crash\n')

  const { registry, opened } = await openRegistry(fixture)
  assert.equal(opened.revision, '1')
  assert.equal(opened.fileDurableRevision, '1')
  assert.equal(
    registry.read({ documentId: opened.documentId }, ADAPTER).text,
    'hello crash\n',
  )
  await registry.shutdown()
})

test('codec property never introduces mixed line endings', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom('a', 'Z', ' ', '\n', '\t', 'é', '\u{1f680}'),
        { maxLength: 500 },
      ).map((characters) => characters.join('')),
      fc.constantFrom('lf', 'crlf'),
      fc.boolean(),
      (text, lineEndings, bom) => {
        const encoded = encodeMarkdown(text, { lineEndings, bom })
        const body = bom ? encoded.subarray(3).toString('utf8') : encoded.toString('utf8')
        assert.equal(body.includes('\r') && lineEndings === 'lf', false)
        assert.equal(
          lineEndings === 'crlf' && body.replaceAll('\r\n', '').includes('\r'),
          false,
        )
      },
    ),
    { numRuns: 200 },
  )
})

test('runtime merge property preserves disjoint concurrent paragraph edits', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 24 })
          .filter((value) => !value.includes('\n')),
        { minLength: 2, maxLength: 8 },
      ),
      (values) => {
        const paragraphs = values.map((value, index) => `P${index} ${value}`)
        const baseline = paragraphs.join('\n\n')
        const current = [
          `${paragraphs[0]} AGENT`,
          ...paragraphs.slice(1),
        ].join('\n\n')
        const external = [
          ...paragraphs.slice(0, -1),
          `${paragraphs.at(-1)} FILE`,
        ].join('\n\n')
        const result = computeMergedTarget(current, baseline, external)
        assert.equal(result.failedHunks.length, 0)
        assert.match(result.target, /AGENT/)
        assert.match(result.target, /FILE/)
      },
    ),
    { numRuns: 100 },
  )
})

async function openRegistry(fixture, overrides = {}) {
  const workspaceRegistry = await approveWorkspace(
    fixture.stateRoot,
    fixture.workspaceRoot,
  )
  const registry = new DocumentRegistry({
    stateRoot: fixture.stateRoot,
    workspaceRegistry,
    filePersistenceOptions: {
      flushDebounceMs: 60_000,
      watchFactory: NO_WATCHER,
      ...overrides,
    },
  })
  const opened = await registry.open({
    workspaceRoot: fixture.workspaceRoot,
    path: 'notes.md',
  }, ADAPTER)
  return { registry, opened }
}

async function runCrashWorker(fixture, phase) {
  const child = spawn(process.execPath, [
    CRASH_WORKER,
    fixture.stateRoot,
    fixture.workspaceRoot,
    phase,
  ], { stdio: 'ignore' })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
}
