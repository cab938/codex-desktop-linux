import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrokerError } from './errors.mjs'

export const BROKER_PROTOCOL_VERSION = 1
export const STATE_SCHEMA_VERSION = 1
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_OPEN_DOCUMENTS = 16
export const MAX_UI_SESSIONS_PER_DOCUMENT = 8
export const MAX_ADAPTER_LEASES = 32
export const UPDATE_LOG_RECORD_LIMIT = 4096
export const UPDATE_LOG_BYTE_LIMIT = 8 * 1024 * 1024
export const ADAPTER_LEASE_TTL_MS = 30_000
export const DOCUMENT_IDLE_MS = 60_000

export function resolveStateRoot(options = {}) {
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  const userHome = options.userHome ?? os.homedir()
  const override =
    options.override ??
    environment.CODEX_COLLABORATIVE_MARKDOWN_STATE_ROOT

  if (override) return requireAbsoluteRoot(override, 'state override')

  if (platform === 'linux') {
    const xdg = environment.XDG_STATE_HOME
    const base = xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(userHome, '.local', 'state')
    return path.join(base, 'codex', 'collaborative-markdown-editor')
  }
  if (platform === 'darwin') {
    return path.join(
      userHome,
      'Library',
      'Application Support',
      'Codex',
      'collaborative-markdown-editor',
    )
  }
  if (platform === 'win32') {
    const base = environment.LOCALAPPDATA && path.isAbsolute(environment.LOCALAPPDATA)
      ? environment.LOCALAPPDATA
      : path.join(userHome, 'AppData', 'Local')
    return path.join(base, 'Codex', 'collaborative-markdown-editor')
  }
  throw new BrokerError(
    'BROKER_UNAVAILABLE',
    `Unsupported platform for private broker state: ${platform}`,
  )
}

function requireAbsoluteRoot(value, label) {
  if (!path.isAbsolute(value)) {
    throw new BrokerError(
      'BROKER_UNAVAILABLE',
      `The ${label} must be an absolute path.`,
    )
  }
  return path.resolve(value)
}

export async function ensurePrivateStateRoot(stateRoot) {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    await fs.chmod(stateRoot, 0o700)
  }
  return stateRoot
}
