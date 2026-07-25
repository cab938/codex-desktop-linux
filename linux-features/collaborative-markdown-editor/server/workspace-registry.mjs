import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BrokerError, assertBroker } from './errors.mjs'
import {
  canonicalizeWorkspaceRoot,
  workspaceIdentity,
} from './workspace.mjs'

const PROPOSAL_TTL_MS = 5 * 60_000

export class WorkspaceRegistry {
  constructor(stateRoot, options = {}) {
    this.stateRoot = stateRoot
    this.filePath = path.join(stateRoot, 'workspaces-v1.json')
    this.clock = options.clock ?? (() => Date.now())
    this.approvals = new Map()
    this.proposals = new Map()
  }

  async initialize() {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      assertBroker(
        value?.schemaVersion === 1 && Array.isArray(value.workspaces),
        'STATE_VERSION_UNSUPPORTED',
        'The workspace approval registry uses an unsupported schema.',
      )
      for (const entry of value.workspaces) {
        if (
          typeof entry?.canonicalRoot === 'string' &&
          typeof entry?.workspaceId === 'string'
        ) {
          this.approvals.set(entry.canonicalRoot, entry)
        }
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await this.persist()
        return
      }
      if (error instanceof SyntaxError) {
        throw new BrokerError(
          'STATE_CORRUPT',
          'The workspace approval registry is not valid JSON.',
          { cause: error },
        )
      }
      throw error
    }
  }

  async propose(inputRoot) {
    this.pruneProposals()
    const canonicalRoot = await canonicalizeWorkspaceRoot(inputRoot)
    const proposalId = crypto.randomUUID()
    const confirmationToken = crypto.randomBytes(32).toString('base64url')
    this.proposals.set(proposalId, {
      proposalId,
      confirmationToken,
      canonicalRoot,
      expiresAt: this.clock() + PROPOSAL_TTL_MS,
    })
    return {
      proposalId,
      confirmationToken,
      canonicalRoot,
      expiresAt: new Date(this.clock() + PROPOSAL_TTL_MS).toISOString(),
      alreadyApproved: this.approvals.has(canonicalRoot),
    }
  }

  async authorize(input) {
    this.pruneProposals()
    assertBroker(
      input?.confirmed === true,
      'INVALID_ARGUMENT',
      'Workspace authorization requires an explicit confirmation.',
    )
    const proposal = this.proposals.get(input.proposalId)
    assertBroker(
      proposal,
      'WORKSPACE_AUTHORIZATION_REQUIRED',
      'The workspace authorization proposal is missing or expired.',
      { retryable: true },
    )
    assertBroker(
      safeEqual(proposal.confirmationToken, input.confirmationToken),
      'PERMISSION_DENIED',
      'The workspace authorization capability is invalid.',
    )
    const canonicalRoot = await canonicalizeWorkspaceRoot(input.workspaceRoot)
    assertBroker(
      canonicalRoot === proposal.canonicalRoot,
      'WORKSPACE_ESCAPE',
      'The confirmed workspace differs from the proposed workspace.',
    )
    const entry = {
      workspaceId: workspaceIdentity(canonicalRoot),
      canonicalRoot,
      approvedAt: new Date(this.clock()).toISOString(),
    }
    this.approvals.set(canonicalRoot, entry)
    this.proposals.delete(proposal.proposalId)
    await this.persist()
    return { ...entry }
  }

  async revoke(inputRoot) {
    const canonicalRoot = await canonicalizeWorkspaceRoot(inputRoot)
    const removed = this.approvals.delete(canonicalRoot)
    if (removed) await this.persist()
    return { canonicalRoot, revoked: removed }
  }

  async requireApproved(inputRoot) {
    const canonicalRoot = await canonicalizeWorkspaceRoot(inputRoot)
    const entry = this.approvals.get(canonicalRoot)
    assertBroker(
      entry,
      'WORKSPACE_AUTHORIZATION_REQUIRED',
      'This workspace root has not been approved by the user.',
      { retryable: true },
    )
    return { ...entry }
  }

  listRedacted() {
    return [...this.approvals.values()].map((entry) => ({
      workspaceId: entry.workspaceId,
      approvedAt: entry.approvedAt,
    }))
  }

  async persist() {
    const body = `${JSON.stringify(
      {
        schemaVersion: 1,
        workspaces: [...this.approvals.values()].sort((left, right) =>
          left.canonicalRoot.localeCompare(right.canonicalRoot)),
      },
      null,
      2,
    )}\n`
    await writePrivateAtomic(this.filePath, body)
  }

  pruneProposals() {
    const now = this.clock()
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) this.proposals.delete(id)
    }
  }
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
}

async function writePrivateAtomic(target, body) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, target)
  if (process.platform !== 'win32') await fs.chmod(target, 0o600)
}
