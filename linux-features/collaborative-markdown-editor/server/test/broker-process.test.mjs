import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { BrokerClient } from '../broker-client.mjs'
import { makeFixture, waitFor } from './helpers.mjs'

test('independent clients attach to one broker and one document authority', async (t) => {
  const { stateRoot, workspaceRoot } = await makeFixture(t, 'broker-process')
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), 'hello\n')
  const first = new BrokerClient({
    stateRoot,
    adapterId: 'process_adapter_one_123',
  })
  const second = new BrokerClient({
    stateRoot,
    adapterId: 'process_adapter_two_123',
  })
  t.after(async () => {
    try {
      await first.rpc('admin', 'broker.shutdown')
    } catch {}
  })

  const [firstDescriptor, secondDescriptor] = await Promise.all([
    first.ensure(),
    second.ensure(),
  ])
  assert.equal(firstDescriptor.pid, secondDescriptor.pid)
  assert.equal(firstDescriptor.generation, secondDescriptor.generation)
  const unauthorized = await fetch(
    `http://${firstDescriptor.host}:${firstDescriptor.port}/health`,
  )
  assert.equal(unauthorized.status, 401)

  await assert.rejects(
    first.rpc('public', 'workspace.propose', { workspaceRoot }),
    { code: 'METHOD_NOT_FOUND' },
  )
  const proposal = await first.rpc('app', 'workspace.propose', {
    workspaceRoot,
  })
  await first.rpc('app', 'workspace.authorize', {
    proposalId: proposal.proposalId,
    confirmationToken: proposal.confirmationToken,
    workspaceRoot,
    confirmed: true,
  })
  const openedFirst = await first.rpc('public', 'document.open', {
    workspaceRoot,
    path: 'notes.md',
  })
  const openedSecond = await second.rpc('public', 'document.open', {
    workspaceRoot,
    path: 'notes.md',
  })
  assert.equal(openedFirst.documentId, openedSecond.documentId)

  const edited = await first.rpc('public', 'document.applyText', {
    documentId: openedFirst.documentId,
    expectedRevision: '0',
    edits: [{ start: 5, end: 5, replacement: ' shared' }],
  })
  assert.equal(edited.revision, '1')
  const read = await second.rpc('public', 'document.read', {
    documentId: openedFirst.documentId,
    expectedRevision: '1',
    from: 0,
    to: 13,
  })
  assert.equal(read.text, 'hello shared\n')
  const status = await second.rpc('public', 'document.status', {
    documentId: openedFirst.documentId,
  })
  assert.equal(status.adapterLeases, 2)
  assert.equal(JSON.stringify(status).includes(firstDescriptor.bearer), false)

  if (process.platform !== 'win32') {
    const descriptorStat = await fs.stat(
      path.join(stateRoot, 'broker-v1', 'descriptor.json'),
    )
    assert.equal(descriptorStat.mode & 0o777, 0o600)
  }
  await first.rpc('admin', 'broker.shutdown')
  await waitFor(async () => {
    try {
      await fs.access(path.join(stateRoot, 'broker-v1', 'descriptor.json'))
      return false
    } catch (error) {
      return error?.code === 'ENOENT'
    }
  })
})
