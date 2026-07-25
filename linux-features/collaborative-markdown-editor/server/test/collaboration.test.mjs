import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import * as Y from 'yjs'
import { DocumentRegistry } from '../document-registry.mjs'
import { approveWorkspace, makeFixture } from './helpers.mjs'

const ADAPTER_ONE = 'collaboration_adapter_one'
const ADAPTER_TWO = 'collaboration_adapter_two'
const NO_WATCHER = () => ({ on() {}, close() {} })

test('two UI clients exchange concurrent Yjs updates and awareness', async (t) => {
  const fixture = await makeFixture(t, 'ui-convergence')
  await fs.writeFile(path.join(fixture.workspaceRoot, 'notes.md'), 'seed\n')
  const { registry, opened } = await openRegistry(fixture)
  await registry.open(
    { workspaceRoot: fixture.workspaceRoot, path: 'notes.md' },
    ADAPTER_TWO,
  )
  const firstSession = registry.createUiSession(
    opened.documentId,
    ADAPTER_ONE,
  )
  const secondSession = registry.createUiSession(
    opened.documentId,
    ADAPTER_TWO,
  )
  const firstDoc = docFromBootstrap(firstSession)
  const secondDoc = docFromBootstrap(secondSession)
  t.after(() => {
    firstDoc.destroy()
    secondDoc.destroy()
  })

  const firstUpdate = transactAndCapture(firstDoc, 'first-ui', (text) => {
    text.insert(0, 'first ')
  })
  const secondUpdate = transactAndCapture(secondDoc, 'second-ui', (text) => {
    text.insert(text.length - 1, ' second')
  })
  const firstPush = await registry.applyUiUpdate(uiInput(firstSession, {
    clientSequence: '1',
    updateBase64: encodeBase64(firstUpdate),
    updateSha256: hashUpdate(firstUpdate),
  }), ADAPTER_ONE)
  const secondPush = await registry.applyUiUpdate(uiInput(secondSession, {
    clientSequence: '1',
    updateBase64: encodeBase64(secondUpdate),
    updateSha256: hashUpdate(secondUpdate),
  }), ADAPTER_TWO)
  assert.equal(firstPush.revision, '1')
  assert.equal(secondPush.revision, '2')

  const firstPull = await registry.pullUiUpdate(uiInput(firstSession, {
    afterRevision: '1',
    stateVectorBase64: encodeBase64(Y.encodeStateVector(firstDoc)),
    awarenessClock: 0,
    waitMs: 0,
  }), ADAPTER_ONE)
  const secondPull = await registry.pullUiUpdate(uiInput(secondSession, {
    afterRevision: '1',
    stateVectorBase64: encodeBase64(Y.encodeStateVector(secondDoc)),
    awarenessClock: 0,
    waitMs: 0,
  }), ADAPTER_TWO)
  Y.applyUpdate(firstDoc, decodeBase64(firstPull.updateBase64), 'broker')
  Y.applyUpdate(secondDoc, decodeBase64(secondPull.updateBase64), 'broker')
  const brokerText = registry.read({
    documentId: opened.documentId,
  }, ADAPTER_ONE).text
  assert.equal(firstDoc.getText('content').toString(), brokerText)
  assert.equal(secondDoc.getText('content').toString(), brokerText)
  assert.match(brokerText, /first/)
  assert.match(brokerText, /second/)

  registry.updateUiAwareness(uiInput(firstSession, {
    awarenessClock: 1,
    awareness: awareness('First human', '#336699', 0),
  }), ADAPTER_ONE)
  registry.updateUiAwareness(uiInput(secondSession, {
    awarenessClock: 1,
    awareness: awareness('Second human', '#993366', brokerText.length),
  }), ADAPTER_TWO)
  const presence = await registry.pullUiUpdate(uiInput(firstSession, {
    afterRevision: '2',
    stateVectorBase64: encodeBase64(Y.encodeStateVector(firstDoc)),
    awarenessClock: 0,
    waitMs: 0,
  }), ADAPTER_ONE)
  assert.deepEqual(
    presence.awareness.map((entry) => entry.displayName).sort(),
    ['First human', 'Second human'],
  )
  await registry.shutdown()
})

test('two agent tasks rebase stale edits without loss or duplicate retries', async (t) => {
  const fixture = await makeFixture(t, 'agent-convergence')
  await fs.writeFile(path.join(fixture.workspaceRoot, 'notes.md'), 'base\n')
  const { registry, opened } = await openRegistry(fixture)
  await registry.open(
    { workspaceRoot: fixture.workspaceRoot, path: 'notes.md' },
    ADAPTER_TWO,
  )
  const attempts = [
    {
      adapter: ADAPTER_ONE,
      label: 'Task A',
      key: 'agent-task-a-edit-0001',
    },
    {
      adapter: ADAPTER_TWO,
      label: 'Task B',
      key: 'agent-task-b-edit-0001',
    },
  ]
  const concurrent = await Promise.allSettled(attempts.map((attempt) =>
    registry.applyTextEdits({
      documentId: opened.documentId,
      expectedRevision: '0',
      idempotencyKey: attempt.key,
      edits: [{ start: 0, end: 0, replacement: `${attempt.label}\n` }],
    }, attempt.adapter)))
  assert.equal(
    concurrent.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    concurrent.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason?.code === 'STALE_REVISION',
    ).length,
    1,
  )
  const losingIndex = concurrent.findIndex(
    (result) => result.status === 'rejected',
  )
  const losingAttempt = attempts[losingIndex]
  const afterFirst = registry.read({
    documentId: opened.documentId,
  }, losingAttempt.adapter)
  const rebasedInput = {
    documentId: opened.documentId,
    expectedRevision: afterFirst.revision,
    idempotencyKey: `${losingAttempt.key}-rebased`,
    edits: [{
      start: afterFirst.text.length,
      end: afterFirst.text.length,
      replacement: `${losingAttempt.label}\n`,
    }],
  }
  const rebased = await registry.applyTextEdits(
    rebasedInput,
    losingAttempt.adapter,
  )
  assert.equal(rebased.revision, '2')
  const replay = await registry.applyTextEdits(
    rebasedInput,
    losingAttempt.adapter,
  )
  assert.deepEqual(replay, rebased)
  const finalText = registry.read({
    documentId: opened.documentId,
  }, ADAPTER_ONE).text
  assert.equal(count(finalText, 'Task A'), 1)
  assert.equal(count(finalText, 'Task B'), 1)
  assert.equal(count(finalText, 'base'), 1)

  const beforeRejected = finalText
  await assert.rejects(
    registry.applyTextEdits({
      documentId: opened.documentId,
      expectedRevision: '1',
      idempotencyKey: 'interrupted-stale-agent-edit',
      edits: [{ start: 0, end: 4, replacement: 'partial' }],
    }, ADAPTER_ONE),
    { code: 'STALE_REVISION' },
  )
  assert.equal(registry.read({
    documentId: opened.documentId,
  }, ADAPTER_ONE).text, beforeRejected)
  const released = await registry.releaseAdapterEverywhere(ADAPTER_TWO)
  assert.equal(released.releasedDocuments, 1)
  assert.equal(registry.read({
    documentId: opened.documentId,
  }, ADAPTER_ONE).text, beforeRejected)
  await registry.shutdown()
})

test('human, agent, and external editor changes merge through one document', async (t) => {
  const fixture = await makeFixture(t, 'mixed-convergence')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  const baseline =
    '# Title\n\nHuman line\n\nAgent line\n\nExternal line\n'
  await fs.writeFile(target, baseline)
  const { registry, opened } = await openRegistry(fixture)
  const uiSession = registry.createUiSession(
    opened.documentId,
    ADAPTER_ONE,
  )
  const uiDoc = docFromBootstrap(uiSession)
  t.after(() => uiDoc.destroy())
  const humanUpdate = transactAndCapture(uiDoc, 'human', (text) => {
    const start = text.toString().indexOf('Human')
    text.delete(start, 'Human'.length)
    text.insert(start, 'Human edited')
  })
  await registry.applyUiUpdate(uiInput(uiSession, {
    clientSequence: '1',
    updateBase64: encodeBase64(humanUpdate),
    updateSha256: hashUpdate(humanUpdate),
  }), ADAPTER_ONE)

  const afterHuman = registry.read({
    documentId: opened.documentId,
  }, ADAPTER_ONE)
  const agentStart = afterHuman.text.indexOf('Agent')
  await registry.applyTextEdits({
    documentId: opened.documentId,
    expectedRevision: afterHuman.revision,
    idempotencyKey: 'mixed-agent-edit-0001',
    edits: [{
      start: agentStart,
      end: agentStart + 'Agent'.length,
      replacement: 'Agent edited',
    }],
  }, ADAPTER_ONE)

  await fs.writeFile(target, baseline.replace('External', 'External edited'))
  const imported = await registry.reconcile(
    opened.documentId,
    ADAPTER_ONE,
  )
  assert.equal(imported.state, 'imported')
  assert.equal(imported.merged, true)
  const merged = registry.read({
    documentId: opened.documentId,
  }, ADAPTER_ONE)
  assert.match(merged.text, /Human edited line/)
  assert.match(merged.text, /Agent edited line/)
  assert.match(merged.text, /External edited line/)
  assert.equal(count(merged.text, 'edited'), 3)
  const flushed = await registry.flush({
    documentId: opened.documentId,
    expectedRevision: merged.revision,
  }, ADAPTER_ONE)
  assert.equal(flushed.flushState, 'file_durable')
  assert.equal(await fs.readFile(target, 'utf8'), merged.text)
  await registry.shutdown()
})

async function openRegistry(fixture) {
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
    },
  })
  const opened = await registry.open({
    workspaceRoot: fixture.workspaceRoot,
    path: 'notes.md',
  }, ADAPTER_ONE)
  return { registry, opened }
}

function docFromBootstrap(bootstrap) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, decodeBase64(bootstrap.snapshotBase64), 'bootstrap')
  return doc
}

function transactAndCapture(doc, origin, mutate) {
  let captured
  const listener = (update, updateOrigin) => {
    if (updateOrigin === origin) captured = update
  }
  doc.on('update', listener)
  doc.transact(() => mutate(doc.getText('content')), origin)
  doc.off('update', listener)
  assert.ok(captured)
  return captured
}

function uiInput(bootstrap, fields) {
  return {
    documentId: bootstrap.documentId,
    generation: bootstrap.generation,
    documentEpoch: bootstrap.documentEpoch,
    uiSessionId: bootstrap.uiSessionId,
    sessionCapability: bootstrap.sessionCapability,
    ...fields,
  }
}

function awareness(displayName, color, selection) {
  return {
    displayName,
    color,
    selectionAnchor: selection,
    selectionHead: selection,
    originClass: 'human',
  }
}

function encodeBase64(value) {
  return Buffer.from(value).toString('base64')
}

function decodeBase64(value) {
  return Buffer.from(value, 'base64')
}

function hashUpdate(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function count(text, needle) {
  return text.split(needle).length - 1
}
