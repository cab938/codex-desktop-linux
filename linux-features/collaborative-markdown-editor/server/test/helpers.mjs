import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceRegistry } from '../workspace-registry.mjs'

export async function makeFixture(t, name = 'broker-test') {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const stateRoot = path.join(parent, 'state')
  const workspaceRoot = path.join(parent, 'workspace')
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.mkdir(workspaceRoot, { recursive: true })
  return { parent, stateRoot, workspaceRoot }
}

export async function approveWorkspace(stateRoot, workspaceRoot) {
  const registry = new WorkspaceRegistry(stateRoot)
  await registry.initialize()
  const proposal = await registry.propose(workspaceRoot)
  await registry.authorize({
    proposalId: proposal.proposalId,
    confirmationToken: proposal.confirmationToken,
    workspaceRoot,
    confirmed: true,
  })
  return registry
}

export async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for condition')
}
