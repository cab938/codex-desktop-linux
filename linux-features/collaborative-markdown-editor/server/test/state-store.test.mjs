import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import * as Y from 'yjs'
import { DocumentStateStore } from '../state-store.mjs'
import {
  documentIdentity,
  readMarkdownFile,
  resolveMarkdownFile,
} from '../workspace.mjs'
import { makeFixture } from './helpers.mjs'

test('persisted snapshot and recovery log replay once across restart and compaction', async (t) => {
  const { stateRoot, workspaceRoot } = await makeFixture(t)
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), 'hello\n')
  const file = await readMarkdownFile(
    await resolveMarkdownFile(workspaceRoot, 'notes.md'),
  )
  const identity = {
    documentId: documentIdentity(file.canonicalRoot, file.canonicalPath),
    canonicalRoot: file.canonicalRoot,
    canonicalPath: file.canonicalPath,
    relativePath: file.relativePath,
  }
  const store = new DocumentStateStore(stateRoot)
  const state = await store.open(identity, file)
  const before = Y.encodeStateVector(state.doc)
  state.ytext.insert(5, ' world')
  const update = Y.encodeStateAsUpdate(state.doc, before)
  await store.appendUpdate(state, update, 1n, 'test')
  state.revision = 1n
  state.metadata.revision = '1'
  state.doc.destroy()

  const recovered = await store.open(identity, file)
  assert.equal(recovered.ytext.toString(), 'hello world\n')
  assert.equal(recovered.revision, 1n)
  await store.compact(recovered)
  recovered.doc.destroy()

  const compacted = await store.open(identity, file)
  assert.equal(compacted.ytext.toString(), 'hello world\n')
  assert.equal(compacted.revision, 1n)
  await fs.appendFile(compacted.paths.log, '{"partial":')
  compacted.doc.destroy()

  const tailRecovered = await store.open(identity, file)
  assert.equal(tailRecovered.ytext.toString(), 'hello world\n')
  assert.equal((await fs.readFile(tailRecovered.paths.log)).length, 0)
  assert.equal((await fs.readdir(tailRecovered.paths.recovery)).length, 1)
  tailRecovered.doc.destroy()
})

test('newer persisted schemas fail closed', async (t) => {
  const { stateRoot, workspaceRoot } = await makeFixture(t)
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), 'hello\n')
  const file = await readMarkdownFile(
    await resolveMarkdownFile(workspaceRoot, 'notes.md'),
  )
  const identity = {
    documentId: documentIdentity(file.canonicalRoot, file.canonicalPath),
    canonicalRoot: file.canonicalRoot,
    canonicalPath: file.canonicalPath,
    relativePath: file.relativePath,
  }
  const store = new DocumentStateStore(stateRoot)
  const state = await store.open(identity, file)
  state.doc.destroy()
  const metadata = JSON.parse(await fs.readFile(state.paths.metadata, 'utf8'))
  metadata.schemaVersion = 999
  await fs.writeFile(state.paths.metadata, JSON.stringify(metadata))
  await assert.rejects(
    store.open(identity, file),
    { code: 'STATE_VERSION_UNSUPPORTED' },
  )
})
