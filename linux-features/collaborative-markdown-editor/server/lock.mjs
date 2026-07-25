import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BrokerError } from './errors.mjs'

export function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function acquireDirectoryLock(lockPath, options = {}) {
  const token = options.token ?? crypto.randomUUID()
  const owner = {
    schemaVersion: 1,
    kind: options.kind ?? 'document',
    pid: options.pid ?? process.pid,
    token,
    createdAt: new Date().toISOString(),
  }
  const isAlive = options.isAlive ?? processIsAlive
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let created = false
    try {
      await fs.mkdir(lockPath, { mode: 0o700 })
      created = true
      await fs.writeFile(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify(owner, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
      return makeHandle(lockPath, owner)
    } catch (error) {
      if (created) {
        await fs.rm(lockPath, { recursive: true, force: true })
        throw error
      }
      if (error?.code !== 'EEXIST') throw error
    }

    const existing = await readOwner(lockPath)
    if (!existing) {
      const stalePath = `${lockPath}.incomplete-${Date.now()}-${crypto.randomUUID()}`
      try {
        await fs.rename(lockPath, stalePath)
        await fs.rm(stalePath, { recursive: true, force: true })
        continue
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
    }
    if (isAlive(existing.pid)) {
      throw new BrokerError(
        'LOCKED',
        `Another live process owns ${options.label ?? 'the requested resource'}.`,
        {
          retryable: true,
          details: {
            ownerPid: existing.pid,
            ownerKind: existing.kind ?? null,
          },
        },
      )
    }

    const stalePath = `${lockPath}.stale-${Date.now()}-${crypto.randomUUID()}`
    try {
      await fs.rename(lockPath, stalePath)
      await fs.rm(stalePath, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  throw new BrokerError(
    'LOCKED',
    `Could not acquire ${options.label ?? 'the requested resource'} safely.`,
    { retryable: true },
  )
}

async function readOwner(lockPath) {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'),
    )
    return value && typeof value === 'object' ? value : null
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function makeHandle(lockPath, owner) {
  let released = false
  return {
    path: lockPath,
    owner,
    async release() {
      if (released) return
      const current = await readOwner(lockPath)
      if (current?.token !== owner.token) {
        throw new BrokerError(
          'LOCKED',
          'The lock owner changed before release.',
          { retryable: false },
        )
      }
      await fs.rm(lockPath, { recursive: true, force: true })
      released = true
    },
  }
}
