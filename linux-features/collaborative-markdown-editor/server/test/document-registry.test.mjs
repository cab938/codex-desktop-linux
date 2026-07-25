import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import * as Y from 'yjs'
import { MAX_FILE_BYTES } from '../config.mjs'
import { DocumentRegistry } from '../document-registry.mjs'
import { acquireDirectoryLock } from '../lock.mjs'
import { approveWorkspace, makeFixture } from './helpers.mjs'

const ADAPTER_ONE = 'adapter_one_123456789'
const ADAPTER_TWO = 'adapter_two_123456789'

test('one Y.Doc serves adapters, serializes revisions, and survives restart', async (t) => {
  const { stateRoot, workspaceRoot } = await makeFixture(t)
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), 'hello\n')
  const workspaceRegistry = await approveWorkspace(stateRoot, workspaceRoot)
  const registry = new DocumentRegistry({ stateRoot, workspaceRegistry })
  const opened = await registry.open(
    { workspaceRoot, path: 'notes.md' },
    ADAPTER_ONE,
  )
  const attached = await registry.open(
    { workspaceRoot, path: 'notes.md' },
    ADAPTER_TWO,
  )
  assert.equal(attached.documentId, opened.documentId)
  assert.equal(registry.documents.size, 1)

  const first = registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: '0',
    edits: [{ start: 5, end: 5, replacement: ' world' }],
  }, ADAPTER_ONE)
  const staleConcurrent = registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: '0',
    edits: [{ start: 0, end: 0, replacement: 'X' }],
  }, ADAPTER_TWO)
  assert.equal((await first).revision, '1')
  await assert.rejects(staleConcurrent, { code: 'STALE_REVISION' })
  assert.equal(
    registry.read({ documentId: opened.documentId }, ADAPTER_TWO).text,
    'hello world\n',
  )

  const competing = new DocumentRegistry({ stateRoot, workspaceRegistry })
  await assert.rejects(
    competing.open({ workspaceRoot, path: 'notes.md' }, ADAPTER_ONE),
    { code: 'LOCKED' },
  )
  const malicious = new Y.Doc()
  malicious.getMap('unexpected').set('key', 'value')
  await assert.rejects(
    registry.applyYUpdate({
      documentId: opened.documentId,
      expectedRevision: '1',
      update: Y.encodeStateAsUpdate(malicious),
    }, ADAPTER_ONE),
    { code: 'INVALID_ARGUMENT' },
  )
  malicious.destroy()
  await assert.rejects(
    registry.applyTextEdits({
      documentId: opened.documentId,
      expectedRevision: '1',
      edits: [{
        start: 0,
        end: 0,
        replacement: 'x'.repeat(MAX_FILE_BYTES),
      }],
    }, ADAPTER_ONE),
    { code: 'INVALID_ARGUMENT' },
  )

  await registry.shutdown()
  const restarted = new DocumentRegistry({ stateRoot, workspaceRegistry })
  const reopened = await restarted.open(
    { workspaceRoot, path: 'notes.md' },
    ADAPTER_ONE,
  )
  assert.equal(reopened.revision, '1')
  assert.equal(
    restarted.read({ documentId: reopened.documentId }, ADAPTER_ONE).text,
    'hello world\n',
  )
  await restarted.shutdown()
})

test('adapter leases expire and idle documents are checkpointed and evicted', async (t) => {
  const { stateRoot, workspaceRoot } = await makeFixture(t)
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), 'hello\n')
  const workspaceRegistry = await approveWorkspace(stateRoot, workspaceRoot)
  let now = 1_000
  const registry = new DocumentRegistry({
    stateRoot,
    workspaceRegistry,
    clock: () => now,
    idleMs: 100,
  })
  const opened = await registry.open(
    { workspaceRoot, path: 'notes.md' },
    ADAPTER_ONE,
  )
  now += 30_001
  assert.equal(await registry.evictIdle(), 1)
  assert.equal(registry.documents.size, 0)
  assert.throws(
    () => registry.status(opened.documentId, ADAPTER_ONE),
    { code: 'DOCUMENT_NOT_OPEN' },
  )
  await registry.shutdown()
})

test('directory locks reject live owners and recover incomplete and dead owners', async (t) => {
  const { parent } = await makeFixture(t)
  const lockPath = path.join(parent, 'locks', 'document.lock')
  const first = await acquireDirectoryLock(lockPath)
  await assert.rejects(acquireDirectoryLock(lockPath), { code: 'LOCKED' })
  await first.release()

  await fs.mkdir(lockPath, { recursive: true })
  const recoveredIncomplete = await acquireDirectoryLock(lockPath)
  await recoveredIncomplete.release()

  await fs.mkdir(lockPath, { recursive: true })
  await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'document',
    pid: 2_147_483_647,
    token: 'dead-owner',
  }))
  const recoveredDead = await acquireDirectoryLock(lockPath)
  await recoveredDead.release()
})

test('accepted edit and create idempotency receipts survive broker restart', async (t) => {
  const { stateRoot, workspaceRoot } = await makeFixture(t)
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), 'hello\n')
  const workspaceRegistry = await approveWorkspace(stateRoot, workspaceRoot)
  const first = new DocumentRegistry({ stateRoot, workspaceRegistry })
  const opened = await first.open(
    { workspaceRoot, path: 'notes.md' },
    ADAPTER_ONE,
  )
  const editInput = {
    documentId: opened.documentId,
    expectedRevision: '0',
    idempotencyKey: 'restart-edit-idempotency-01',
    edits: [{ start: 5, end: 5, replacement: ' persisted' }],
  }
  assert.equal(
    (await first.applyTextEdits(editInput, ADAPTER_ONE)).revision,
    '1',
  )
  const created = await first.create({
    workspaceRoot,
    path: 'created.md',
    initialText: '# Created',
    idempotencyKey: 'restart-create-idempotency-1',
  }, ADAPTER_ONE)
  await first.shutdown()

  const restarted = new DocumentRegistry({ stateRoot, workspaceRegistry })
  await restarted.open({ workspaceRoot, path: 'notes.md' }, ADAPTER_ONE)
  assert.equal(
    (await restarted.applyTextEdits(editInput, ADAPTER_ONE)).revision,
    '1',
  )
  await assert.rejects(
    restarted.applyTextEdits({
      ...editInput,
      edits: [{ start: 0, end: 0, replacement: 'different' }],
    }, ADAPTER_ONE),
    { code: 'IDEMPOTENCY_REUSE' },
  )
  const createdReplay = await restarted.create({
    workspaceRoot,
    path: 'created.md',
    initialText: '# Created',
    idempotencyKey: 'restart-create-idempotency-1',
  }, ADAPTER_ONE)
  assert.equal(createdReplay.documentId, created.documentId)
  assert.equal(await fs.readFile(
    path.join(workspaceRoot, 'created.md'),
    'utf8',
  ), '# Created\n')
  await restarted.shutdown()
})
