import { describe, expect, it } from 'vitest'
import {
  MCP_APP_POLL_INTERVAL_MS,
  MCP_APP_PULL_WAIT_MS,
  decodeBase64,
  encodeBase64,
  isFenceError,
  loadPreferences,
  parseBootstrap,
  presentStatus,
  safeExternalUrl,
  savePreferences,
  sha256,
} from './mcp-app-state.ts'

describe('MCP App state helpers', () => {
  it('parses authorization and ready metadata but rejects missing capabilities', () => {
    expect(parseBootstrap({
      kind: 'authorization',
      authorization_session_id: crypto.randomUUID(),
      session_capability: 'a'.repeat(43),
      workspace_root: '/workspace',
      path: 'notes.md',
    }).kind).toBe('authorization')
    expect(parseBootstrap({
      kind: 'ready',
      document_id: `doc_v1_${'a'.repeat(43)}`,
      generation: crypto.randomUUID(),
      document_epoch: crypto.randomUUID(),
      ui_session_id: crypto.randomUUID(),
      session_capability: 'b'.repeat(43),
      revision: '0',
      snapshot_base64: 'AAA=',
      snapshot_sha256: `sha256:${'0'.repeat(64)}`,
      state_vector_base64: 'AA==',
      flush_state: 'file_durable',
      file_durable_revision: '0',
    }).kind).toBe('ready')
    expect(() => parseBootstrap({ kind: 'ready' })).toThrow()
  })

  it('round-trips large base64 values and hashes decoded bytes', async () => {
    const bytes = Uint8Array.from(
      { length: 100_000 },
      (_value, index) => index % 251,
    )
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes)
    expect(await sha256(new TextEncoder().encode('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('persists only compatible selection, scroll, and preview state', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    savePreferences(storage, 'doc', {
      livePreview: false,
      anchor: 4,
      head: 8,
      scrollTop: 12,
    })
    expect(loadPreferences(storage, 'doc')).toEqual({
      livePreview: false,
      anchor: 4,
      head: 8,
      scrollTop: 12,
    })
    values.set('collaborative-markdown-editor:v1:bad', '{')
    expect(loadPreferences(storage, 'bad').livePreview).toBe(true)
  })

  it('maps durability and conflict states to honest UI labels', () => {
    expect(presentStatus('local_queued')).toEqual({
      label: 'Edit queued…',
      tone: 'pending',
      readOnly: false,
    })
    expect(presentStatus('file_durable')).toEqual({
      label: 'Saved to Markdown',
      tone: 'ok',
      readOnly: false,
    })
    expect(presentStatus('recovery_log_durable').label).toBe(
      'Saved to recovery log',
    )
    expect(presentStatus('conflict').readOnly).toBe(true)
    expect(presentStatus('file_durable', 'deleted').label).toBe(
      'File deleted',
    )
  })

  it('keeps host-bridged pulls nonblocking so pushes cannot be starved', () => {
    expect(MCP_APP_PULL_WAIT_MS).toBe(0)
    expect(MCP_APP_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(250)
  })

  it('recognizes only session-fencing failures as reconnectable', () => {
    expect(isFenceError('GENERATION_STALE')).toBe(true)
    expect(isFenceError('STALE_REVISION')).toBe(false)
  })

  it('allows ordinary external links but blocks executable and local schemes', () => {
    expect(safeExternalUrl('https://example.com/read')).toBe(
      'https://example.com/read',
    )
    expect(safeExternalUrl('mailto:editor@example.com')).toBe(
      'mailto:editor@example.com',
    )
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('java\u0000script:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(safeExternalUrl('vbscript:msgbox(1)')).toBeNull()
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(safeExternalUrl('../relative.md')).toBeNull()
  })
})
