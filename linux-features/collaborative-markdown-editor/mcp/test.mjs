import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as Y from 'yjs'
import {
  RESOURCE_URI,
  UI_META_KEY,
  createCollaborativeMarkdownMcpServer,
} from './server.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.join(ROOT, 'main.mjs')

test('MCP tools enforce schemas, authorization, revisions, idempotency, and UI isolation', async (t) => {
  const fixture = await makeFixture(t)
  const { server, broker } = createCollaborativeMarkdownMcpServer({
    stateRoot: fixture.stateRoot,
  })
  const client = new Client({
    name: 'collaborative-markdown-test-client',
    version: '1.0.0',
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  t.after(async () => {
    try {
      await broker.rpc('admin', 'broker.shutdown')
    } catch {}
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  })

  const listed = await client.listTools()
  const expectedNames = [
    'markdown_open',
    'markdown_create',
    'markdown_read',
    'markdown_apply_edits',
    'markdown_status',
    'markdown_flush',
    'markdown_close',
    'markdown_render',
    'markdown_ui_authorize_workspace',
    'markdown_ui_sync_push',
    'markdown_ui_sync_pull',
    'markdown_ui_awareness',
    'markdown_ui_refresh',
  ]
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    expectedNames.sort(),
  )
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.ok(tool.outputSchema)
    assert.equal(tool.annotations?.openWorldHint, false)
  }
  assert.equal(
    listed.tools.find((tool) => tool.name === 'markdown_apply_edits')
      .annotations.destructiveHint,
    true,
  )
  assert.equal(
    listed.tools.find((tool) => tool.name === 'markdown_read')
      .annotations.readOnlyHint,
    true,
  )
  assert.equal(
    listed.tools.find((tool) => tool.name === 'markdown_render')
      ._meta.ui.resourceUri,
    RESOURCE_URI,
  )
  assert.deepEqual(
    listed.tools.find((tool) => tool.name === 'markdown_ui_sync_push')
      ._meta.ui.visibility,
    ['app'],
  )

  const resources = await client.listResources()
  assert.equal(resources.resources[0].uri, RESOURCE_URI)
  assert.deepEqual(
    resources.resources[0]._meta.ui.csp,
    { connectDomains: [], resourceDomains: [] },
  )
  const resource = await client.readResource({ uri: RESOURCE_URI })
  assert.equal(
    resource.contents[0].mimeType,
    'text/html;profile=mcp-app',
  )
  assert.match(resource.contents[0].text, /Collaborative Markdown Editor/)

  const unauthorizedOpen = await call(client, 'markdown_open', {
    workspace_root: fixture.workspaceRoot,
    path: 'notes.md',
  })
  assertError(unauthorizedOpen, 'WORKSPACE_AUTHORIZATION_REQUIRED')

  const render = await call(client, 'markdown_render', {
    workspace_root: fixture.workspaceRoot,
    path: 'notes.md',
  })
  assert.equal(render.structuredContent.state, 'authorization_required')
  const authorization = render._meta[UI_META_KEY]
  assert.equal(
    JSON.stringify({
      content: render.content,
      structuredContent: render.structuredContent,
    }).includes(authorization.session_capability),
    false,
  )
  const authorizationArguments = {
    authorization_session_id: authorization.authorization_session_id,
    session_capability: authorization.session_capability,
    workspace_root: authorization.workspace_root,
    path: authorization.path,
  }
  const denied = await call(client, 'markdown_ui_authorize_workspace', {
    ...authorizationArguments,
    session_capability: 'a'.repeat(43),
    confirmed: true,
  })
  assertError(denied, 'PERMISSION_DENIED')

  const authorized = await call(client, 'markdown_ui_authorize_workspace', {
    ...authorizationArguments,
    confirmed: true,
  })
  assert.equal(authorized.structuredContent.state, 'ready')
  const bootstrap = authorized._meta[UI_META_KEY]
  assert.equal(bootstrap.kind, 'ready')
  const documentId = authorized.structuredContent.document_id

  const opened = await call(client, 'markdown_open', {
    workspace_root: fixture.workspaceRoot,
    path: 'notes.md',
  })
  assert.equal(opened.structuredContent.document.document_id, documentId)
  assert.equal(opened.structuredContent.document.revision, '0')
  assert.equal(opened.content[0].text.includes('hello'), false)
  const readyRenderResult = await call(client, 'markdown_render', {
    document_id: documentId,
  })
  assert.equal(readyRenderResult.structuredContent.state, 'ready')
  assert.equal(
    readyRenderResult._meta[UI_META_KEY].document_id,
    documentId,
  )
  const traversal = await call(client, 'markdown_open', {
    workspace_root: fixture.workspaceRoot,
    path: '../outside.md',
  })
  assertError(traversal, 'WORKSPACE_ESCAPE')
  const schemaInvalid = await client.callTool({
    name: 'markdown_read',
    arguments: {
      document_id: documentId,
      unexpected: true,
    },
  })
  assert.equal(schemaInvalid.isError, true)
  assert.match(schemaInvalid.content[0].text, /validation error/i)

  const editArguments = {
    document_id: documentId,
    expected_revision: '0',
    idempotency_key: 'mcp-edit-idempotency-0001',
    edits: [{ start: 5, end: 5, replacement: ' agent' }],
  }
  const hostTaskId = 'task-private-identity-0001'
  const edited = await call(
    client,
    'markdown_apply_edits',
    editArguments,
    {
      'io.modelcontextprotocol/related-task': { taskId: hostTaskId },
    },
  )
  assert.equal(edited.structuredContent.revision, '1')
  const updateLogPath = path.join(
    fixture.stateRoot,
    'documents-v1',
    documentId,
    'updates.log',
  )
  const attributedRecords = (await fs.readFile(updateLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(
    attributedRecords[0].attribution.identitySource,
    'host-related-task',
  )
  assert.match(
    attributedRecords[0].attribution.identityHash,
    /^sha256:[0-9a-f]{64}$/,
  )
  assert.equal(
    JSON.stringify(attributedRecords[0]).includes(hostTaskId),
    false,
  )
  const replayed = await call(
    client,
    'markdown_apply_edits',
    editArguments,
    {
      'io.modelcontextprotocol/related-task': { taskId: hostTaskId },
    },
  )
  assert.deepEqual(replayed.structuredContent, edited.structuredContent)
  const reused = await call(client, 'markdown_apply_edits', {
    ...editArguments,
    edits: [{ start: 0, end: 0, replacement: 'different' }],
  })
  assertError(reused, 'IDEMPOTENCY_REUSE')
  const stale = await call(client, 'markdown_apply_edits', {
    ...editArguments,
    idempotency_key: 'mcp-edit-idempotency-0002',
    edits: [{ start: 0, end: 0, replacement: 'stale' }],
  })
  assertError(stale, 'STALE_REVISION')

  const concurrent = await Promise.all([
    call(client, 'markdown_apply_edits', {
      document_id: documentId,
      expected_revision: '1',
      idempotency_key: 'mcp-concurrent-edit-0001',
      edits: [{ start: 0, end: 0, replacement: 'A' }],
    }),
    call(client, 'markdown_apply_edits', {
      document_id: documentId,
      expected_revision: '1',
      idempotency_key: 'mcp-concurrent-edit-0002',
      edits: [{ start: 0, end: 0, replacement: 'B' }],
    }),
  ])
  assert.equal(concurrent.filter((result) => result.isError).length, 1)
  assert.equal(
    concurrent.filter((result) => !result.isError)[0]
      .structuredContent.revision,
    '2',
  )
  const allAttributedRecords = (await fs.readFile(updateLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(allAttributedRecords.some(
    (record) =>
      record.attribution?.identitySource === 'mcp-adapter' &&
      /^sha256:[0-9a-f]{64}$/.test(record.attribution.identityHash),
  ))

  const read = await call(client, 'markdown_read', {
    document_id: documentId,
    expected_revision: '2',
    from: 0,
    to: 13,
  })
  assert.equal(read.structuredContent.total_utf16_length, 13)
  assert.match(read.structuredContent.text, /hello agent/)

  const localDoc = new Y.Doc()
  Y.applyUpdate(localDoc, decodeBase64(bootstrap.snapshot_base64))
  let localUpdate
  localDoc.on('update', (update, origin) => {
    if (origin === 'human-test') localUpdate = update
  })
  localDoc.transact(() => {
    localDoc.getText('content').insert(
      localDoc.getText('content').length,
      ' UI',
    )
  }, 'human-test')
  const updateHash = sha256(localUpdate)
  const uiBase = {
    document_id: bootstrap.document_id,
    generation: bootstrap.generation,
    document_epoch: bootstrap.document_epoch,
    ui_session_id: bootstrap.ui_session_id,
    session_capability: bootstrap.session_capability,
  }
  const pushed = await call(client, 'markdown_ui_sync_push', {
    ...uiBase,
    client_sequence: '1',
    update_base64: encodeBase64(localUpdate),
    update_sha256: updateHash,
  })
  assert.equal(pushed.structuredContent.revision, '3')
  const pushedReplay = await call(client, 'markdown_ui_sync_push', {
    ...uiBase,
    client_sequence: '1',
    update_base64: encodeBase64(localUpdate),
    update_sha256: updateHash,
  })
  assert.deepEqual(
    pushedReplay.structuredContent,
    pushed.structuredContent,
  )
  const pushedReuse = await call(client, 'markdown_ui_sync_push', {
    ...uiBase,
    client_sequence: '1',
    update_base64: encodeBase64(Uint8Array.from([0, 0])),
    update_sha256: sha256(Uint8Array.from([0, 0])),
  })
  assertError(pushedReuse, 'IDEMPOTENCY_REUSE')

  const presence = await call(client, 'markdown_ui_awareness', {
    ...uiBase,
    awareness_clock: 1,
    awareness: {
      display_name: 'Human',
      color: '#336699',
      selection_anchor: 0,
      selection_head: 2,
      origin_class: 'human',
    },
  })
  assert.equal(presence.structuredContent.awareness_clock, 1)

  const pulled = await call(client, 'markdown_ui_sync_pull', {
    ...uiBase,
    after_revision: '0',
    state_vector_base64: bootstrap.state_vector_base64,
    awareness_clock: 0,
    wait_ms: 0,
  })
  assert.equal(pulled.structuredContent.revision, '3')
  assert.ok(pulled.structuredContent.update_base64.length > 0)
  assert.equal(pulled.structuredContent.awareness.length, 2)
  assert.deepEqual(
    pulled.structuredContent.awareness
      .map((entry) => entry.originClass)
      .sort(),
    ['agent', 'human'],
  )

  const refreshed = await call(client, 'markdown_ui_refresh', uiBase)
  const refreshedBootstrap = refreshed._meta[UI_META_KEY]
  assert.notEqual(
    refreshedBootstrap.session_capability,
    bootstrap.session_capability,
  )
  const oldCapability = await call(client, 'markdown_ui_awareness', {
    ...uiBase,
    awareness_clock: 2,
    awareness: {
      display_name: 'Human',
      color: '#336699',
      selection_anchor: 0,
      selection_head: 0,
      origin_class: 'human',
    },
  })
  assertError(oldCapability, 'PERMISSION_DENIED')
  const staleGeneration = await call(client, 'markdown_ui_awareness', {
    ...uiBase,
    generation: crypto.randomUUID(),
    session_capability: refreshedBootstrap.session_capability,
    awareness_clock: 2,
    awareness: {
      display_name: 'Human',
      color: '#336699',
      selection_anchor: 0,
      selection_head: 0,
      origin_class: 'human',
    },
  })
  assertError(staleGeneration, 'GENERATION_STALE')

  const currentStatus = await call(client, 'markdown_status', {
    document_id: documentId,
  })
  const currentRevision = currentStatus.structuredContent.revision
  assert.equal(
    JSON.stringify(currentStatus).includes(
      refreshedBootstrap.session_capability,
    ),
    false,
  )
  const currentDoc = new Y.Doc()
  Y.applyUpdate(currentDoc, decodeBase64(refreshedBootstrap.snapshot_base64))
  const pollArguments = {
    document_id: refreshedBootstrap.document_id,
    generation: refreshedBootstrap.generation,
    document_epoch: refreshedBootstrap.document_epoch,
    ui_session_id: refreshedBootstrap.ui_session_id,
    session_capability: refreshedBootstrap.session_capability,
    after_revision: currentRevision,
    state_vector_base64: encodeBase64(Y.encodeStateVector(currentDoc)),
    awareness_clock: 1,
    wait_ms: 20_000,
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(
    client.callTool(
      { name: 'markdown_ui_sync_pull', arguments: pollArguments },
      undefined,
      { signal: controller.signal, timeout: 1_000 },
    ),
  )
  const started = Date.now()
  const timedPoll = await call(client, 'markdown_ui_sync_pull', {
    ...pollArguments,
    wait_ms: 25,
  })
  assert.equal(timedPoll.structuredContent.revision, currentRevision)
  assert.ok(Date.now() - started < 500)

  const priorGeneration = refreshedBootstrap.generation
  await broker.rpc('admin', 'broker.shutdown')
  const restarted = await call(client, 'markdown_ui_refresh', {
    document_id: refreshedBootstrap.document_id,
    generation: refreshedBootstrap.generation,
    document_epoch: refreshedBootstrap.document_epoch,
    ui_session_id: refreshedBootstrap.ui_session_id,
    session_capability: refreshedBootstrap.session_capability,
  })
  assert.notEqual(restarted.isError, true, JSON.stringify(restarted))
  const restartedBootstrap = restarted._meta[UI_META_KEY]
  assert.notEqual(restartedBootstrap.generation, priorGeneration)
  assert.equal(restartedBootstrap.document_id, documentId)
  assert.equal(restartedBootstrap.revision, currentRevision)
  assert.equal(restartedBootstrap.path, 'notes.md')
  assert.equal(restartedBootstrap.workspace_root, fixture.workspaceRoot)

  const flushed = await call(client, 'markdown_flush', {
    document_id: documentId,
    expected_revision: currentRevision,
    idempotency_key: 'mcp-flush-idempotency-001',
  })
  assert.equal(flushed.structuredContent.flush_state, 'file_durable')
  assert.match(await fs.readFile(
    path.join(fixture.workspaceRoot, 'notes.md'),
    'utf8',
  ), /agent/)

  const created = await call(client, 'markdown_create', {
    workspace_root: fixture.workspaceRoot,
    path: 'created.md',
    initial_text: '# Created',
    idempotency_key: 'mcp-create-idempotency-01',
  })
  assert.equal(created.structuredContent.durability, 'file')
  assert.equal(
    await fs.readFile(path.join(fixture.workspaceRoot, 'created.md'), 'utf8'),
    '# Created\n',
  )
  const createReplay = await call(client, 'markdown_create', {
    workspace_root: fixture.workspaceRoot,
    path: 'created.md',
    initial_text: '# Created',
    idempotency_key: 'mcp-create-idempotency-01',
  })
  assert.deepEqual(
    createReplay.structuredContent,
    created.structuredContent,
  )
  const createReuse = await call(client, 'markdown_create', {
    workspace_root: fixture.workspaceRoot,
    path: 'created.md',
    initial_text: '# Different',
    idempotency_key: 'mcp-create-idempotency-01',
  })
  assertError(createReuse, 'IDEMPOTENCY_REUSE')

  const outOfScope = await call(client, 'markdown_open', {
    workspace_root: fixture.parent,
    path: 'workspace/notes.md',
  })
  assertError(outOfScope, 'WORKSPACE_AUTHORIZATION_REQUIRED')

  const closeArguments = {
    document_id: documentId,
    expected_revision: currentRevision,
    idempotency_key: 'mcp-close-idempotency-001',
  }
  const closed = await call(client, 'markdown_close', closeArguments)
  assert.equal(closed.structuredContent.released, true)
  const closeReplay = await call(client, 'markdown_close', closeArguments)
  assert.deepEqual(closeReplay.structuredContent, closed.structuredContent)
  localDoc.destroy()
  currentDoc.destroy()
})

test('stdio protocol process lists tools, reads the resource, and exits on transport close', async (t) => {
  const fixture = await makeFixture(t)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN],
    cwd: path.dirname(ROOT),
    env: {
      PATH: process.env.PATH ?? '',
      CODEX_COLLABORATIVE_MARKDOWN_STATE_ROOT: fixture.stateRoot,
    },
    stderr: 'pipe',
  })
  const client = new Client({
    name: 'stdio-lifecycle-test',
    version: '1.0.0',
  })
  await client.connect(transport)
  const pid = transport.pid
  assert.ok(Number.isInteger(pid))
  assert.equal((await client.listTools()).tools.length, 13)
  assert.equal(
    (await client.readResource({ uri: RESOURCE_URI }))
      .contents[0].mimeType,
    'text/html;profile=mcp-app',
  )
  await client.close()
  await waitFor(() => !processIsAlive(pid))
})

async function call(client, name, arguments_, meta) {
  return client.callTool({
    name,
    arguments: arguments_,
    ...(meta ? { _meta: meta } : {}),
  })
}

function assertError(result, code) {
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.ok, false)
  assert.equal(result.structuredContent.error.code, code)
}

function encodeBase64(value) {
  return Buffer.from(value).toString('base64')
}

function decodeBase64(value) {
  return Buffer.from(value, 'base64')
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

async function makeFixture(t) {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), 'collaborative-markdown-mcp-'),
  )
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const stateRoot = path.join(parent, 'state')
  const workspaceRoot = path.join(parent, 'workspace')
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.writeFile(path.join(workspaceRoot, 'notes.md'), 'hello\n')
  return { parent, stateRoot, workspaceRoot }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for condition')
}
