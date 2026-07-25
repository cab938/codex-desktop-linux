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

export function assertSupportedRuntimePlatform(
  platform = process.platform,
) {
  if (!['linux', 'darwin'].includes(platform)) {
    throw new BrokerError(
      'PLATFORM_UNSUPPORTED',
      'Collaborative Markdown v1 supports Linux; macOS remains a candidate. ' +
        'Windows atomic replacement is not supported.',
    )
  }
  return platform
}

export function resolveStateRoot(options = {}) {
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  const userHome = options.userHome ?? os.homedir()
  const pathApi = options.pathApi ?? path
  const override =
    options.override ??
    environment.CODEX_COLLABORATIVE_MARKDOWN_STATE_ROOT

  if (override) return requireAbsoluteRoot(override, 'state override', pathApi)

  if (platform === 'linux') {
    const xdg = environment.XDG_STATE_HOME
    const base = xdg && pathApi.isAbsolute(xdg)
      ? xdg
      : pathApi.join(userHome, '.local', 'state')
    return pathApi.join(base, 'codex', 'collaborative-markdown-editor')
  }
  if (platform === 'darwin') {
    return pathApi.join(
      userHome,
      'Library',
      'Application Support',
      'Codex',
      'collaborative-markdown-editor',
    )
  }
  if (platform === 'win32') {
    const base =
      environment.LOCALAPPDATA &&
      pathApi.isAbsolute(environment.LOCALAPPDATA)
      ? environment.LOCALAPPDATA
      : pathApi.join(userHome, 'AppData', 'Local')
    return pathApi.join(base, 'Codex', 'collaborative-markdown-editor')
  }
  throw new BrokerError(
    'BROKER_UNAVAILABLE',
    `Unsupported platform for private broker state: ${platform}`,
  )
}

export async function ensureBrokerStateRoot(options = {}) {
  const preferredRoot =
    options.preferredRoot ?? resolveStateRoot(options)
  const ensureRoot = options.ensureRoot ?? ensurePrivateStateRoot
  try {
    await ensureRoot(preferredRoot)
    return {
      path: preferredRoot,
      persistence: 'platform_state',
    }
  } catch (error) {
    if (
      options.allowRuntimeFallback === false ||
      !['EACCES', 'ENOENT', 'EPERM', 'EROFS'].includes(error?.code)
    ) {
      throw error
    }
  }

  const temporaryRoot =
    options.temporaryRoot ?? os.tmpdir()
  const userId =
    options.userId ??
    (typeof process.getuid === 'function' ? process.getuid() : 'user')
  const runtimeRoot = path.join(
    temporaryRoot,
    `codex-collaborative-markdown-editor-${userId}`,
  )
  await ensureRoot(runtimeRoot)
  return {
    path: runtimeRoot,
    persistence: 'runtime',
  }
}

function requireAbsoluteRoot(value, label, pathApi = path) {
  if (!pathApi.isAbsolute(value)) {
    throw new BrokerError(
      'BROKER_UNAVAILABLE',
      `The ${label} must be an absolute path.`,
    )
  }
  return pathApi.resolve(value)
}

export async function ensurePrivateStateRoot(stateRoot) {
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    const initial = await fs.lstat(stateRoot)
    if (
      initial.isSymbolicLink() ||
      !initial.isDirectory() ||
      (
        typeof process.geteuid === 'function' &&
        initial.uid !== process.geteuid()
      )
    ) {
      throw new BrokerError(
        'BROKER_UNAVAILABLE',
        'The collaborative Markdown state root is not private.',
      )
    }
    await fs.chmod(stateRoot, 0o700)
    const hardened = await fs.lstat(stateRoot)
    if ((hardened.mode & 0o777) !== 0o700) {
      throw new BrokerError(
        'BROKER_UNAVAILABLE',
        'The collaborative Markdown state root is not private.',
      )
    }
  }
  return stateRoot
}
