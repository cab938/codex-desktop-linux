export interface ReadyBootstrap {
  kind: 'ready'
  document_id: string
  generation: string
  document_epoch: string
  ui_session_id: string
  session_capability: string
  revision: string
  snapshot_base64: string
  snapshot_sha256: string
  state_vector_base64: string
  flush_state: FlushState
  file_durable_revision: string
  path?: string | null
  workspace_root?: string | null
}

export interface AuthorizationBootstrap {
  kind: 'authorization'
  authorization_session_id: string
  session_capability: string
  workspace_root: string
  path: string
}

export type AppBootstrap = ReadyBootstrap | AuthorizationBootstrap
export type FlushState =
  | 'local_queued'
  | 'file_durable'
  | 'recovery_log_durable'
  | 'flushing'
  | 'conflict'
  | 'read_only'
  | 'recovery_required'

export interface UiPreferences {
  livePreview: boolean
  anchor: number
  head: number
  scrollTop: number
}

export interface StatusPresentation {
  label: string
  tone: 'ok' | 'pending' | 'warning' | 'error'
  readOnly: boolean
}

// Codex currently serializes MCP App tool calls for a rendered component.
// Keep pulls nonblocking so a local edit can immediately use the same bridge.
export const MCP_APP_PULL_WAIT_MS = 0
export const MCP_APP_POLL_INTERVAL_MS = 300

const DEFAULT_PREFERENCES: UiPreferences = {
  livePreview: true,
  anchor: 0,
  head: 0,
  scrollTop: 0,
}

export function parseBootstrap(value: unknown): AppBootstrap {
  if (!isRecord(value)) throw new Error('Missing editor bootstrap metadata.')
  if (value.kind === 'authorization') {
    requireString(value, 'authorization_session_id')
    requireCapability(value, 'session_capability')
    requireString(value, 'workspace_root')
    requireString(value, 'path')
    return value as unknown as AuthorizationBootstrap
  }
  if (value.kind === 'ready') {
    for (const field of [
      'document_id',
      'generation',
      'document_epoch',
      'ui_session_id',
      'revision',
      'snapshot_base64',
      'snapshot_sha256',
      'state_vector_base64',
      'flush_state',
      'file_durable_revision',
    ]) {
      requireString(value, field)
    }
    requireCapability(value, 'session_capability')
    return value as unknown as ReadyBootstrap
  }
  throw new Error('Unsupported editor bootstrap kind.')
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function encodeBase64(value: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < value.length; index += chunk) {
    binary += String.fromCharCode(...value.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ) as ArrayBuffer,
  )
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`
}

export function loadPreferences(
  storage: Pick<Storage, 'getItem'>,
  documentId: string,
): UiPreferences {
  try {
    const value = JSON.parse(
      storage.getItem(preferenceKey(documentId)) ?? 'null',
    )
    if (
      typeof value?.livePreview === 'boolean' &&
      Number.isSafeInteger(value?.anchor) &&
      Number.isSafeInteger(value?.head) &&
      Number.isFinite(value?.scrollTop)
    ) {
      return {
        livePreview: value.livePreview,
        anchor: Math.max(0, value.anchor),
        head: Math.max(0, value.head),
        scrollTop: Math.max(0, value.scrollTop),
      }
    }
  } catch {}
  return { ...DEFAULT_PREFERENCES }
}

export function savePreferences(
  storage: Pick<Storage, 'setItem'>,
  documentId: string,
  preferences: UiPreferences,
): void {
  storage.setItem(preferenceKey(documentId), JSON.stringify(preferences))
}

export function presentStatus(
  flushState: FlushState,
  externalState = 'clean',
  readOnly = false,
): StatusPresentation {
  if (flushState === 'conflict' || externalState === 'conflict') {
    return {
      label: 'Conflict preserved',
      tone: 'error',
      readOnly: true,
    }
  }
  if (flushState === 'recovery_required') {
    return {
      label: 'Recovery required',
      tone: 'error',
      readOnly: true,
    }
  }
  if (
    readOnly ||
    flushState === 'read_only' ||
    ['deleted', 'renamed'].includes(externalState)
  ) {
    return {
      label:
        externalState === 'deleted'
          ? 'File deleted'
          : externalState === 'renamed'
            ? 'File renamed'
            : 'Read only',
      tone: 'warning',
      readOnly: true,
    }
  }
  if (flushState === 'file_durable') {
    return { label: 'Saved to Markdown', tone: 'ok', readOnly: false }
  }
  if (flushState === 'flushing') {
    return { label: 'Saving…', tone: 'pending', readOnly: false }
  }
  if (flushState === 'local_queued') {
    return { label: 'Edit queued…', tone: 'pending', readOnly: false }
  }
  return {
    label: 'Saved to recovery log',
    tone: 'pending',
    readOnly: false,
  }
}

export function isFenceError(code: unknown): boolean {
  return [
    'GENERATION_STALE',
    'DOCUMENT_EPOCH_STALE',
    'PERMISSION_DENIED',
    'DOCUMENT_NOT_OPEN',
  ].includes(String(code))
}

export function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol)
      ? url.href
      : null
  } catch {
    return null
  }
}

function preferenceKey(documentId: string): string {
  return `collaborative-markdown-editor:v1:${documentId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(
  value: Record<string, unknown>,
  field: string,
): void {
  if (typeof value[field] !== 'string' || value[field].length === 0) {
    throw new Error(`Invalid editor bootstrap field: ${field}.`)
  }
}

function requireCapability(
  value: Record<string, unknown>,
  field: string,
): void {
  requireString(value, field)
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(value[field]))) {
    throw new Error(`Invalid editor capability field: ${field}.`)
  }
}
