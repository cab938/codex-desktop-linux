import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import {
  canonicalizeWorkspaceRoot,
  documentIdentity,
  readMarkdownFile,
  resolveMarkdownFile,
  validateRelativeMarkdownPath,
} from '../workspace.mjs'
import { WorkspaceRegistry } from '../workspace-registry.mjs'
import { makeFixture } from './helpers.mjs'

test('workspace approval is app-confirmed, persisted, and capability-bound', async (t) => {
  const { stateRoot, workspaceRoot } = await makeFixture(t)
  const registry = new WorkspaceRegistry(stateRoot)
  await registry.initialize()
  await assert.rejects(
    registry.requireApproved(workspaceRoot),
    { code: 'WORKSPACE_AUTHORIZATION_REQUIRED' },
  )
  const proposal = await registry.propose(workspaceRoot)
  await assert.rejects(
    registry.authorize({
      proposalId: proposal.proposalId,
      confirmationToken: 'wrong',
      workspaceRoot,
      confirmed: true,
    }),
    { code: 'PERMISSION_DENIED' },
  )
  await assert.rejects(
    registry.authorize({
      proposalId: proposal.proposalId,
      confirmationToken: proposal.confirmationToken,
      workspaceRoot,
      confirmed: false,
    }),
    { code: 'INVALID_ARGUMENT' },
  )
  const approved = await registry.authorize({
    proposalId: proposal.proposalId,
    confirmationToken: proposal.confirmationToken,
    workspaceRoot,
    confirmed: true,
  })
  assert.equal(approved.canonicalRoot, await fs.realpath(workspaceRoot))
  assert.equal(registry.listRedacted()[0].canonicalRoot, undefined)

  const reloaded = new WorkspaceRegistry(stateRoot)
  await reloaded.initialize()
  assert.equal(
    (await reloaded.requireApproved(workspaceRoot)).workspaceId,
    approved.workspaceId,
  )
})

test('path and file checks reject traversal, symlinks, invalid UTF-8, and mixed EOLs', async (t) => {
  const { workspaceRoot } = await makeFixture(t)
  await fs.writeFile(path.join(workspaceRoot, 'good.md'), 'one\r\ntwo\r\n')
  const good = await readMarkdownFile(
    await resolveMarkdownFile(workspaceRoot, 'good.md'),
  )
  assert.equal(good.text, 'one\ntwo\n')
  assert.equal(good.lineEndings, 'crlf')

  for (const unsafe of [
    '../outside.md',
    '%2e%2e/outside.md',
    '/tmp/outside.md',
    'nested\\outside.md',
    'notes.txt',
  ]) {
    assert.throws(() => validateRelativeMarkdownPath(unsafe))
  }

  await fs.writeFile(path.join(workspaceRoot, 'mixed.md'), 'one\r\ntwo\n')
  await assert.rejects(
    readMarkdownFile(await resolveMarkdownFile(workspaceRoot, 'mixed.md')),
    { code: 'MIXED_LINE_ENDINGS' },
  )
  await fs.writeFile(path.join(workspaceRoot, 'invalid.md'), Buffer.from([0xff]))
  await assert.rejects(
    readMarkdownFile(await resolveMarkdownFile(workspaceRoot, 'invalid.md')),
    { code: 'INVALID_UTF8' },
  )
  await fs.symlink('good.md', path.join(workspaceRoot, 'linked.md'))
  await assert.rejects(
    resolveMarkdownFile(workspaceRoot, 'linked.md'),
    { code: 'SYMLINK_UNSUPPORTED' },
  )
})

test('canonical identity separates worktrees containing the same relative path', async (t) => {
  const { parent } = await makeFixture(t)
  const first = path.join(parent, 'worktree-one')
  const second = path.join(parent, 'worktree-two')
  await fs.mkdir(first)
  await fs.mkdir(second)
  await fs.writeFile(path.join(first, 'notes.md'), 'same\n')
  await fs.writeFile(path.join(second, 'notes.md'), 'same\n')
  const firstRoot = await canonicalizeWorkspaceRoot(first)
  const secondRoot = await canonicalizeWorkspaceRoot(second)
  assert.notEqual(
    documentIdentity(firstRoot, path.join(firstRoot, 'notes.md')),
    documentIdentity(secondRoot, path.join(secondRoot, 'notes.md')),
  )
})
