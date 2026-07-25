import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps'
import * as Y from 'yjs'
import {
  createMarkdownEditor,
  type MarkdownEditor,
} from './editor.ts'
import {
  decodeBase64,
  encodeBase64,
  isFenceError,
  loadPreferences,
  parseBootstrap,
  presentStatus,
  safeExternalUrl,
  savePreferences,
  sha256,
  type AppBootstrap,
  type ReadyBootstrap,
} from './mcp-app-state.ts'
import './mcp-app.css'

const UI_META_KEY = 'collaborativeMarkdownEditor'
const REMOTE_ORIGIN = Symbol('collaborative-markdown-remote')
const MAX_BATCH_BYTES = 256 * 1024
const BATCH_DELAY_MS = 75

interface ToolError {
  code: string
  message: string
  retryable: boolean
  details: Record<string, unknown>
}

interface ToolResult {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

interface Presence {
  uiSessionId: string
  displayName: string
  color: string
  originClass: 'human' | 'agent'
}

const elements = {
  authorization: requiredElement<HTMLElement>('authorization'),
  authorizationRoot: requiredElement<HTMLElement>('authorization-root'),
  authorizationPath: requiredElement<HTMLElement>('authorization-path'),
  authorize: requiredElement<HTMLButtonElement>('authorize'),
  deny: requiredElement<HTMLButtonElement>('deny'),
  workspace: requiredElement<HTMLElement>('workspace'),
  editorRoot: requiredElement<HTMLElement>('editor'),
  actions: requiredElement<HTMLElement>('editor-actions'),
  preview: requiredElement<HTMLButtonElement>('preview'),
  undo: requiredElement<HTMLButtonElement>('undo'),
  redo: requiredElement<HTMLButtonElement>('redo'),
  retry: requiredElement<HTMLButtonElement>('retry'),
  title: requiredElement<HTMLElement>('document-title'),
  path: requiredElement<HTMLElement>('document-path'),
  connection: requiredElement<HTMLElement>('connection-status'),
  revision: requiredElement<HTMLElement>('revision-status'),
  presence: requiredElement<HTMLUListElement>('presence'),
  conflict: requiredElement<HTMLElement>('conflict'),
  conflictMessage: requiredElement<HTMLElement>('conflict-message'),
  message: requiredElement<HTMLOutputElement>('message'),
}

const app = new App(
  { name: 'collaborative-markdown-editor-ui', version: '0.1.0' },
  {},
  { autoResize: false, strict: true },
)

let bootstrap: ReadyBootstrap | null = null
let editor: MarkdownEditor | null = null
let ydoc: Y.Doc | null = null
let pendingUpdates: Uint8Array[] = []
let pendingBytes = 0
let pushInFlight: Promise<void> | null = null
let pushTimer: number | null = null
let nextClientSequence = 1n
let awarenessClock = 0
let awarenessTimer: number | null = null
let pollController: AbortController | null = null
let pollGeneration = 0
let shuttingDown = false
let connectionState: 'connecting' | 'connected' | 'reconnecting' | 'error' =
  'connecting'

app.ontoolresult = (result) => {
  const candidate = result._meta?.[UI_META_KEY]
  if (candidate !== undefined) {
    void acceptBootstrap(candidate)
  }
}

app.onhostcontextchanged = (context) => {
  applyHostContext(context)
}

app.onteardown = async () => {
  shuttingDown = true
  capturePreferences()
  cancelTransport()
  await flushPending().catch(() => undefined)
  destroyEditor()
  return {}
}

elements.authorize.addEventListener('click', () => {
  void authorizeWorkspace()
})

elements.deny.addEventListener('click', () => {
  elements.authorization.hidden = true
  setMessage('Workspace access was not granted. The project file was not opened.')
})

elements.preview.addEventListener('click', () => {
  if (!editor) return
  const enabled = !editor.isLivePreview()
  editor.setLivePreview(enabled)
  updatePreviewButton(enabled)
  capturePreferences()
  editor.view.focus()
})

elements.undo.addEventListener('click', () => {
  editor?.undo()
  editor?.view.focus()
})

elements.redo.addEventListener('click', () => {
  editor?.redo()
  editor?.view.focus()
})

elements.retry.addEventListener('click', () => {
  void recoverSession('Reconnecting at your request…')
})

window.addEventListener('pagehide', capturePreferences)

void start()

async function start(): Promise<void> {
  try {
    setConnection('connecting', 'Connecting…')
    await app.connect()
    applyHostContext(app.getHostContext())
    const available = app.getHostContext()?.availableDisplayModes
    if (!available || available.includes('fullscreen')) {
      await app.requestDisplayMode({ mode: 'fullscreen' }).catch(() => undefined)
    }
    setMessage('Connected. Waiting for the document bootstrap…')
  } catch (error) {
    setConnection('error', 'Connection failed')
    setMessage(errorMessage(error))
  }
}

async function acceptBootstrap(value: unknown): Promise<void> {
  let parsed: AppBootstrap
  try {
    parsed = parseBootstrap(value)
  } catch (error) {
    setConnection('error', 'Invalid session')
    setMessage(errorMessage(error))
    return
  }
  if (parsed.kind === 'authorization') {
    showAuthorization(parsed)
    return
  }
  await mountReady(parsed)
}

function showAuthorization(value: Extract<AppBootstrap, { kind: 'authorization' }>): void {
  destroyEditor()
  bootstrap = null
  elements.workspace.hidden = true
  elements.actions.hidden = true
  elements.authorization.hidden = false
  elements.authorizationRoot.textContent = value.workspace_root
  elements.authorizationPath.textContent = value.path
  elements.authorization.dataset.bootstrap = JSON.stringify(value)
  elements.authorize.disabled = false
  setConnection('connecting', 'Approval required')
  setMessage('Review the exact workspace and file, then approve from this panel.')
}

async function authorizeWorkspace(): Promise<void> {
  const serialized = elements.authorization.dataset.bootstrap
  if (!serialized) return
  const proposal = parseBootstrap(JSON.parse(serialized))
  if (proposal.kind !== 'authorization') return
  elements.authorize.disabled = true
  setMessage('Authorizing this exact workspace…')
  try {
    const result = await callTool('markdown_ui_authorize_workspace', {
      authorization_session_id: proposal.authorization_session_id,
      session_capability: proposal.session_capability,
      workspace_root: proposal.workspace_root,
      path: proposal.path,
      confirmed: true,
    })
    const next = result._meta?.[UI_META_KEY]
    if (next === undefined) throw new Error('Authorization returned no editor session.')
    await acceptBootstrap(next)
  } catch (error) {
    elements.authorize.disabled = false
    setConnection('error', 'Approval failed')
    setMessage(errorMessage(error))
  }
}

async function mountReady(
  next: ReadyBootstrap,
  unsentText?: string,
): Promise<void> {
  const snapshot = decodeBase64(next.snapshot_base64)
  if (await sha256(snapshot) !== next.snapshot_sha256) {
    throw new Error('The editor snapshot checksum does not match.')
  }
  capturePreferences()
  cancelTransport()
  destroyEditor()
  bootstrap = next
  nextClientSequence = 1n
  awarenessClock = 0
  pendingUpdates = []
  pendingBytes = 0

  const document = new Y.Doc()
  Y.applyUpdate(document, snapshot, REMOTE_ORIGIN)
  const ytext = document.getText('content')
  const preferences = loadPreferences(sessionStorage, next.document_id)
  const selectionAnchor = Math.min(preferences.anchor, ytext.length)
  const selectionHead = Math.min(preferences.head, ytext.length)

  const selectionExtension = EditorView.updateListener.of((update) => {
    if (update.selectionSet) scheduleAwareness()
  })
  editor = createMarkdownEditor({
    parent: elements.editorRoot,
    ytext,
    livePreview: preferences.livePreview,
    extensions: selectionExtension,
  })
  ydoc = document
  document.on('update', onDocumentUpdate)
  editor.view.dispatch({
    selection: EditorSelection.create([
      EditorSelection.range(selectionAnchor, selectionHead),
    ]),
  })
  requestAnimationFrame(() => {
    if (editor) editor.view.scrollDOM.scrollTop = preferences.scrollTop
  })
  installSafeLinkHandler(editor.view)

  elements.authorization.hidden = true
  elements.workspace.hidden = false
  elements.actions.hidden = false
  elements.title.textContent = fileName(next.path) ?? 'Workspace Markdown'
  elements.path.textContent = next.path ?? next.workspace_root ?? next.document_id
  elements.path.title = elements.path.textContent
  updatePreviewButton(preferences.livePreview)
  setConnection('connected', 'Connected')
  updateStatus(next.flush_state, 'clean', false, next.revision)
  setMessage('The editor and project Markdown file share one Yjs document.')

  if (unsentText !== undefined && unsentText !== ytext.toString()) {
    document.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, unsentText)
    }, 'human:recovered')
    setMessage('Reconnected and restored edits that had not reached the broker.')
  }
  scheduleAwareness()
  startPolling()
}

function onDocumentUpdate(update: Uint8Array, origin: unknown): void {
  if (origin === REMOTE_ORIGIN || shuttingDown) return
  pendingUpdates.push(update)
  pendingBytes += update.byteLength
  updateStatus('recovery_log_durable', 'clean', false, currentRevision())
  setMessage('Local edits are queued for the shared document…')
  if (pendingBytes >= MAX_BATCH_BYTES) {
    void flushPending()
  } else if (pushTimer === null) {
    pushTimer = window.setTimeout(() => {
      pushTimer = null
      void flushPending()
    }, BATCH_DELAY_MS)
  }
}

async function flushPending(): Promise<void> {
  if (pushInFlight) return pushInFlight
  if (!bootstrap || pendingUpdates.length === 0) return
  if (pushTimer !== null) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  const updates = pendingUpdates
  pendingUpdates = []
  pendingBytes = 0
  const merged = Y.mergeUpdates(updates)
  const sequence = nextClientSequence.toString()
  const active = bootstrap

  pushInFlight = (async () => {
    try {
      const result = await callTool('markdown_ui_sync_push', {
        ...sessionArguments(active),
        client_sequence: sequence,
        update_base64: encodeBase64(merged),
        update_sha256: await sha256(merged),
      })
      const content = result.structuredContent ?? {}
      nextClientSequence += 1n
      active.revision = requiredString(content, 'revision')
      active.flush_state = requiredString(content, 'flush_state') as ReadyBootstrap['flush_state']
      active.file_durable_revision = requiredString(content, 'file_durable_revision')
      updateStatus(active.flush_state, 'clean', false, active.revision)
      setMessage('Agent and editor now share the accepted document revision.')
    } catch (error) {
      pendingUpdates.unshift(merged)
      pendingBytes += merged.byteLength
      if (isFenceError(toolError(error)?.code)) {
        await recoverSession('The broker restarted; rebuilding this editor session…')
      } else {
        setConnection('error', 'Sync paused')
        setMessage(errorMessage(error))
      }
    } finally {
      pushInFlight = null
      if (pendingUpdates.length > 0 && !shuttingDown) {
        pushTimer = window.setTimeout(() => {
          pushTimer = null
          void flushPending()
        }, BATCH_DELAY_MS)
      }
    }
  })()
  return pushInFlight
}

function startPolling(): void {
  const generation = ++pollGeneration
  pollController = new AbortController()
  void pollLoop(generation, pollController.signal)
}

async function pollLoop(generation: number, signal: AbortSignal): Promise<void> {
  while (
    !shuttingDown &&
    generation === pollGeneration &&
    bootstrap &&
    ydoc
  ) {
    const active = bootstrap
    try {
      const result = await callTool(
        'markdown_ui_sync_pull',
        {
          ...sessionArguments(active),
          after_revision: active.revision,
          state_vector_base64: encodeBase64(Y.encodeStateVector(ydoc)),
          awareness_clock: awarenessClock,
          wait_ms: 20_000,
        },
        signal,
      )
      if (generation !== pollGeneration || !ydoc || bootstrap !== active) return
      const content = result.structuredContent ?? {}
      const update = decodeBase64(requiredString(content, 'update_base64'))
      if (await sha256(update) !== requiredString(content, 'update_sha256')) {
        throw new Error('A synchronized update failed its checksum.')
      }
      if (update.byteLength > 0) Y.applyUpdate(ydoc, update, REMOTE_ORIGIN)
      active.revision = requiredString(content, 'revision')
      active.flush_state = requiredString(content, 'flush_state') as ReadyBootstrap['flush_state']
      active.file_durable_revision = requiredString(content, 'file_durable_revision')
      awarenessClock = requiredNumber(content, 'awareness_clock')
      const externalState = optionalString(content.external_state) ?? 'clean'
      const readOnly = content.read_only === true
      setConnection('connected', 'Connected')
      updateStatus(active.flush_state, externalState, readOnly, active.revision)
      renderPresence(parsePresence(content.awareness))
    } catch (error) {
      if (signal.aborted || generation !== pollGeneration || shuttingDown) return
      if (isFenceError(toolError(error)?.code)) {
        await recoverSession('The broker session changed; reconnecting…')
        return
      }
      setConnection('reconnecting', 'Reconnecting…')
      setMessage(errorMessage(error))
      await delay(750, signal)
    }
  }
}

async function recoverSession(message: string): Promise<void> {
  if (!bootstrap) return
  setConnection('reconnecting', 'Reconnecting…')
  setMessage(message)
  const old = bootstrap
  const unsentText =
    pendingUpdates.length > 0 || pushInFlight ? ydoc?.getText('content').toString() : undefined
  cancelTransport()
  try {
    const result = await callTool('markdown_ui_refresh', sessionArguments(old))
    const next = result._meta?.[UI_META_KEY]
    if (next === undefined) throw new Error('The refreshed session returned no bootstrap.')
    const parsed = parseBootstrap(next)
    if (parsed.kind !== 'ready') throw new Error('The refreshed session is not ready.')
    await mountReady(parsed, unsentText)
  } catch (error) {
    setConnection('error', 'Reconnect failed')
    setMessage(errorMessage(error))
  }
}

function scheduleAwareness(): void {
  if (awarenessTimer !== null) clearTimeout(awarenessTimer)
  awarenessTimer = window.setTimeout(() => {
    awarenessTimer = null
    void pushAwareness()
  }, 120)
}

async function pushAwareness(): Promise<void> {
  if (!bootstrap || !editor) return
  const selection = editor.view.state.selection.main
  awarenessClock += 1
  try {
    await callTool('markdown_ui_awareness', {
      ...sessionArguments(bootstrap),
      awareness_clock: awarenessClock,
      awareness: {
        display_name: 'You',
        color: '#2563eb',
        selection_anchor: selection.anchor,
        selection_head: selection.head,
        origin_class: 'human',
      },
    })
  } catch (error) {
    if (isFenceError(toolError(error)?.code)) {
      await recoverSession('Presence session expired; reconnecting…')
    }
  }
}

function updateStatus(
  flushState: ReadyBootstrap['flush_state'],
  externalState: string,
  readOnly: boolean,
  revision: string,
): void {
  const status = presentStatus(flushState, externalState, readOnly)
  elements.connection.textContent =
    connectionState === 'connected' ? status.label : elements.connection.textContent
  elements.connection.className = `status-badge ${status.tone}`
  elements.revision.textContent = `Revision ${revision}`
  editor?.setReadOnly(status.readOnly)
  elements.conflict.hidden = flushState !== 'conflict' && externalState !== 'conflict'
  if (!elements.conflict.hidden) {
    elements.conflictMessage.textContent =
      'Both the shared and external Markdown versions are preserved. Reconnect after resolving the file conflict.'
  }
}

function setConnection(
  state: typeof connectionState,
  label: string,
): void {
  connectionState = state
  elements.connection.textContent = label
  elements.connection.className = `status-badge ${
    state === 'connected'
      ? 'ok'
      : state === 'error'
        ? 'error'
        : 'pending'
  }`
}

function renderPresence(entries: Presence[]): void {
  elements.presence.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement('li')
      item.style.setProperty('--presence-color', entry.color)
      item.textContent =
        entry.originClass === 'agent'
          ? `${entry.displayName} active`
          : entry.displayName
      item.title =
        entry.originClass === 'agent'
          ? 'Active after an accepted document transaction'
          : 'Connected editor'
      return item
    }),
  )
}

function capturePreferences(): void {
  if (!bootstrap || !editor) return
  const selection = editor.view.state.selection.main
  savePreferences(sessionStorage, bootstrap.document_id, {
    livePreview: editor.isLivePreview(),
    anchor: selection.anchor,
    head: selection.head,
    scrollTop: editor.view.scrollDOM.scrollTop,
  })
}

function destroyEditor(): void {
  editor?.destroy()
  editor = null
  ydoc?.destroy()
  ydoc = null
  elements.editorRoot.replaceChildren()
}

function cancelTransport(): void {
  pollGeneration += 1
  pollController?.abort()
  pollController = null
  if (pushTimer !== null) clearTimeout(pushTimer)
  pushTimer = null
  if (awarenessTimer !== null) clearTimeout(awarenessTimer)
  awarenessTimer = null
}

function installSafeLinkHandler(view: EditorView): void {
  view.dom.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const link = target.closest<HTMLElement>('.cm-ink-link[data-href]')
    if (!link) return
    event.preventDefault()
    const href = safeExternalUrl(link.dataset.href)
    if (!href) {
      setMessage('This Markdown link uses a blocked or invalid URL scheme.')
      return
    }
    void app.openLink({ url: href }).catch((error) => {
      setMessage(errorMessage(error))
    })
  })
}

function applyHostContext(context: ReturnType<App['getHostContext']>): void {
  if (!context) return
  if (context.theme) applyDocumentTheme(context.theme)
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables)
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts)
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const result = await app.callServerTool(
    { name, arguments: args },
    signal ? { signal } : undefined,
  ) as ToolResult
  if (result.isError || result.structuredContent?.ok === false) {
    throw result.structuredContent?.error ?? new Error(`Tool ${name} failed.`)
  }
  return result
}

function sessionArguments(value: ReadyBootstrap): Record<string, unknown> {
  return {
    document_id: value.document_id,
    generation: value.generation,
    document_epoch: value.document_epoch,
    ui_session_id: value.ui_session_id,
    session_capability: value.session_capability,
  }
}

function parsePresence(value: unknown): Presence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.uiSessionId !== 'string' ||
      typeof entry.displayName !== 'string' ||
      typeof entry.color !== 'string' ||
      !['human', 'agent'].includes(String(entry.originClass))
    ) {
      return []
    }
    return [{
      uiSessionId: entry.uiSessionId,
      displayName: entry.displayName,
      color: /^#[0-9a-fA-F]{6}$/.test(entry.color) ? entry.color : '#6b7280',
      originClass: entry.originClass as 'human' | 'agent',
    }]
  })
}

function toolError(error: unknown): ToolError | null {
  if (
    isRecord(error) &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  ) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable === true,
      details: isRecord(error.details) ? error.details : {},
    }
  }
  return null
}

function errorMessage(error: unknown): string {
  return toolError(error)?.message ??
    (error instanceof Error ? error.message : 'The editor encountered an unexpected error.')
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  if (typeof result !== 'string') throw new Error(`Missing tool result field: ${key}.`)
  return result
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const result = value[key]
  if (!Number.isSafeInteger(result)) throw new Error(`Missing tool result field: ${key}.`)
  return result as number
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function updatePreviewButton(enabled: boolean): void {
  elements.preview.setAttribute('aria-pressed', String(enabled))
  elements.preview.textContent = enabled ? 'Live preview' : 'Raw source'
}

function setMessage(message: string): void {
  elements.message.textContent = message
}

function currentRevision(): string {
  return bootstrap?.revision ?? '0'
}

function fileName(value: string | null | undefined): string | null {
  if (!value) return null
  return value.split(/[\\/]/).at(-1) ?? value
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}.`)
  return element as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
