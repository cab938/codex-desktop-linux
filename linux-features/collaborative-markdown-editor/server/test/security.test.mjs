import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import * as Y from 'yjs'
import {
  MAX_ADAPTER_LEASES,
  MAX_FILE_BYTES,
  MAX_UI_SESSIONS_PER_DOCUMENT,
} from '../config.mjs'
import { BrokerService } from '../broker-service.mjs'
import { DocumentRegistry } from '../document-registry.mjs'
import { atomicReplaceMarkdown } from '../file-persistence.mjs'
import {
  createMarkdownFile,
  hashBytes,
  readMarkdownFile,
  resolveMarkdownFile,
  validateRelativeMarkdownPath,
} from '../workspace.mjs'
import { approveWorkspace, makeFixture } from './helpers.mjs'

const ADAPTER = 'security_adapter_123456789'
const NO_WATCHER = () => ({ on() {}, close() {} })

test('only the app authorization path can approve and revocation fences sessions', async (t) => {
  const fixture = await makeFixture(t, 'authorization-security')
  const target = path.join(fixture.workspaceRoot, 'notes.md')
  await fs.writeFile(target, 'safe\n')
  await fs.writeFile(path.join(fixture.workspaceRoot, 'other.md'), 'other\n')
  const service = new BrokerService({
    stateRoot: fixture.stateRoot,
    filePersistenceOptions: { watchFactory: NO_WATCHER },
  })
  await service.start()
  t.after(() => service.stop().catch(() => {}))

  await assert.rejects(
    service.dispatch({
      kind: 'public',
      method: 'workspace.propose',
      adapterId: ADAPTER,
      params: { workspaceRoot: fixture.workspaceRoot },
    }),
    { code: 'METHOD_NOT_FOUND' },
  )
  await assert.rejects(
    service.dispatch({
      kind: 'public',
      method: 'workspace.authorize',
      adapterId: ADAPTER,
      params: {
        workspaceRoot: fixture.workspaceRoot,
        confirmed: true,
      },
    }),
    { code: 'METHOD_NOT_FOUND' },
  )
  const proposal = await service.dispatch({
    kind: 'app',
    method: 'workspace.propose',
    adapterId: ADAPTER,
    params: { workspaceRoot: fixture.workspaceRoot },
  })
  await service.dispatch({
    kind: 'app',
    method: 'workspace.authorize',
    adapterId: ADAPTER,
    params: {
      proposalId: proposal.proposalId,
      confirmationToken: proposal.confirmationToken,
      workspaceRoot: fixture.workspaceRoot,
      confirmed: true,
    },
  })
  const opened = await open(service, fixture.workspaceRoot, 'notes.md')
  const other = await open(service, fixture.workspaceRoot, 'other.md')
  const firstUi = await service.dispatch({
    kind: 'app',
    method: 'document.createUiSession',
    adapterId: ADAPTER,
    params: { documentId: opened.documentId },
  })
  const secondUi = await service.dispatch({
    kind: 'app',
    method: 'document.createUiSession',
    adapterId: ADAPTER,
    params: { documentId: other.documentId },
  })
  assert.notEqual(firstUi.sessionCapability, secondUi.sessionCapability)
  assert.equal(firstUi.sessionCapability.length, 43)

  const firstDoc = new Y.Doc()
  Y.applyUpdate(firstDoc, decodeBase64(firstUi.snapshotBase64))
  let update
  firstDoc.on('update', (value, origin) => {
    if (origin === 'security-test') update = value
  })
  firstDoc.transact(() => {
    firstDoc.getText('content').insert(0, 'human ')
  }, 'security-test')
  await assert.rejects(
    service.dispatch({
      kind: 'app',
      method: 'document.uiPush',
      adapterId: ADAPTER,
      params: {
        documentId: other.documentId,
        generation: secondUi.generation,
        documentEpoch: secondUi.documentEpoch,
        uiSessionId: firstUi.uiSessionId,
        sessionCapability: firstUi.sessionCapability,
        clientSequence: '1',
        updateBase64: encodeBase64(update),
        updateSha256: hashBytes(update),
      },
    }),
    { code: 'PERMISSION_DENIED' },
  )
  assert.equal(
    service.documentRegistry.read({
      documentId: other.documentId,
    }, ADAPTER).text,
    'other\n',
  )
  firstDoc.destroy()

  const edited = await service.dispatch({
    kind: 'public',
    method: 'document.applyText',
    adapterId: ADAPTER,
    params: {
      documentId: opened.documentId,
      expectedRevision: '0',
      idempotencyKey: 'security-edit-idempotency-0001',
      edits: [{ start: 0, end: 0, replacement: 'agent ' }],
      durability: 'file',
    },
  })
  assert.equal(edited.revision, '1')
  assert.equal(await fs.readFile(target, 'utf8'), 'agent safe\n')
  const status = service.documentRegistry.status(opened.documentId, ADAPTER)
  assert.equal(
    JSON.stringify(status).includes(firstUi.sessionCapability),
    false,
  )

  const revoked = await service.dispatch({
    kind: 'app',
    method: 'workspace.revoke',
    adapterId: ADAPTER,
    params: { workspaceRoot: fixture.workspaceRoot },
  })
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.fencedDocuments, 2)
  assert.equal(await fs.readFile(target, 'utf8'), 'agent safe\n')
  assert.throws(
    () => service.documentRegistry.read({
      documentId: opened.documentId,
    }, ADAPTER),
    { code: 'DOCUMENT_NOT_OPEN' },
  )
  await assert.rejects(open(
    service,
    fixture.workspaceRoot,
    'notes.md',
  ), {
    code: 'WORKSPACE_AUTHORIZATION_REQUIRED',
  })
})

test('private broker is loopback-only, bearer-gated, originless, and bounded', async (t) => {
  const fixture = await makeFixture(t, 'broker-security')
  assert.throws(
    () => new BrokerService({
      stateRoot: fixture.stateRoot,
      host: '0.0.0.0',
    }),
    { code: 'INVALID_ARGUMENT' },
  )
  const service = new BrokerService({ stateRoot: fixture.stateRoot })
  const address = await service.start()
  t.after(() => service.stop().catch(() => {}))
  assert.equal(address.host, '127.0.0.1')
  const url = `http://${address.host}:${address.port}`
  const unauthorized = await fetch(`${url}/health`)
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.text()).includes(service.bearer), false)
  const authorized = await fetch(`${url}/health`, {
    headers: { authorization: `Bearer ${service.bearer}` },
  })
  assert.equal(authorized.status, 200)
  assert.equal((await authorized.text()).includes(service.bearer), false)
  const browserOrigin = await fetch(`${url}/health`, {
    headers: {
      authorization: `Bearer ${service.bearer}`,
      origin: 'https://attacker.invalid',
    },
  })
  assert.equal(browserOrigin.status, 403)
  assert.equal(browserOrigin.headers.get('access-control-allow-origin'), null)
  const oversized = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${service.bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
  })
  assert.equal(oversized.status, 413)
})

test('path, file-type, Unicode, and replacement-target attacks fail safely', async (t) => {
  const fixture = await makeFixture(t, 'path-security')
  const target = path.join(fixture.workspaceRoot, 'good.md')
  const outside = path.join(fixture.parent, 'outside.md')
  await fs.writeFile(target, 'safe\n')
  await fs.writeFile(outside, 'safe\n')
  for (const unsafe of [
    '../outside.md',
    '..%2foutside.md',
    '%2e%2e/outside.md',
    '%2E%2E/outside.md',
    '%2fetc/passwd.md',
    '%5c%5cserver%5cshare.md',
    '/etc/passwd.md',
    'C:\\Windows\\system.md',
    'nested/../outside.md',
    'nested//outside.md',
    'nested/./outside.md',
    'nul\u0000byte.md',
  ]) {
    assert.throws(() => validateRelativeMarkdownPath(unsafe), {
      code: /^(INVALID_ARGUMENT|WORKSPACE_ESCAPE)$/,
    })
  }
  await assert.rejects(
    resolveMarkdownFile(fixture.workspaceRoot, '%252e%252e/outside.md'),
    { code: 'FILE_NOT_FOUND' },
  )

  await fs.mkdir(path.join(fixture.workspaceRoot, 'directory.md'))
  await assert.rejects(
    resolveMarkdownFile(fixture.workspaceRoot, 'directory.md'),
    { code: 'FILE_TYPE_UNSUPPORTED' },
  )
  const socketPath = path.join(fixture.workspaceRoot, 'socket.md')
  const socket = net.createServer()
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(socketPath, resolve)
  })
  t.after(() => new Promise((resolve) => socket.close(resolve)))
  await assert.rejects(
    resolveMarkdownFile(fixture.workspaceRoot, 'socket.md'),
    { code: 'FILE_TYPE_UNSUPPORTED' },
  )
  await fs.symlink(outside, path.join(fixture.workspaceRoot, 'device.md'))
  await assert.rejects(
    resolveMarkdownFile(fixture.workspaceRoot, 'device.md'),
    { code: 'SYMLINK_UNSUPPORTED' },
  )
  await fs.link(outside, path.join(fixture.workspaceRoot, 'hardlink.md'))
  await assert.rejects(
    resolveMarkdownFile(fixture.workspaceRoot, 'hardlink.md'),
    { code: 'HARDLINK_UNSUPPORTED' },
  )

  const oversizedPath = path.join(fixture.workspaceRoot, 'oversized.md')
  await fs.writeFile(oversizedPath, '')
  await fs.truncate(oversizedPath, MAX_FILE_BYTES + 1)
  await assert.rejects(
    readMarkdownFile(
      await resolveMarkdownFile(fixture.workspaceRoot, 'oversized.md'),
    ),
    { code: 'FILE_TOO_LARGE' },
  )
  await assert.rejects(
    createMarkdownFile(
      fixture.workspaceRoot,
      'invalid.md',
      '\ud800',
    ),
    { code: 'INVALID_ARGUMENT' },
  )
  await assert.rejects(
    fs.stat(path.join(fixture.workspaceRoot, 'invalid.md')),
    { code: 'ENOENT' },
  )

  await assert.rejects(
    atomicReplaceMarkdown({
      target,
      expectedHash: hashBytes(Buffer.from('safe\n')),
      contents: Buffer.from('updated\n'),
      mode: 0o644,
      documentId: `doc_v1_${'a'.repeat(43)}`,
      generation: '11111111-1111-4111-8111-111111111111',
      fault: async (point) => {
        if (point !== 'after-temp-sync') return
        await fs.unlink(target)
        await fs.symlink(outside, target)
      },
    }),
    { code: 'FILE_TYPE_UNSUPPORTED' },
  )
  assert.equal((await fs.lstat(target)).isSymbolicLink(), true)
  assert.equal(await fs.readFile(outside, 'utf8'), 'safe\n')
})

test('document, adapter, UI, rate, edit, and update ceilings are enforced', async (t) => {
  const fixture = await makeFixture(t, 'resource-security')
  await fs.writeFile(path.join(fixture.workspaceRoot, 'notes.md'), 'safe\n')
  await fs.writeFile(path.join(fixture.workspaceRoot, 'second.md'), 'second\n')
  const workspaceRegistry = await approveWorkspace(
    fixture.stateRoot,
    fixture.workspaceRoot,
  )
  const registry = new DocumentRegistry({
    stateRoot: fixture.stateRoot,
    workspaceRegistry,
    maxDocuments: 1,
    filePersistenceOptions: { watchFactory: NO_WATCHER },
  })
  const opened = await registry.open({
    workspaceRoot: fixture.workspaceRoot,
    path: 'notes.md',
  }, ADAPTER)
  t.after(() => registry.shutdown().catch(() => {}))
  await assert.rejects(
    registry.open({
      workspaceRoot: fixture.workspaceRoot,
      path: 'second.md',
    }, ADAPTER),
    { code: 'RESOURCE_LIMIT' },
  )

  for (let index = 1; index < MAX_ADAPTER_LEASES; index += 1) {
    await registry.open({
      workspaceRoot: fixture.workspaceRoot,
      path: 'notes.md',
    }, `security_adapter_${String(index).padStart(3, '0')}`)
  }
  await assert.rejects(
    registry.open({
      workspaceRoot: fixture.workspaceRoot,
      path: 'notes.md',
    }, 'security_adapter_overflow'),
    { code: 'RESOURCE_LIMIT' },
  )

  const sessions = []
  for (let index = 0; index < MAX_UI_SESSIONS_PER_DOCUMENT; index += 1) {
    sessions.push(registry.createUiSession(opened.documentId, ADAPTER))
  }
  assert.throws(
    () => registry.createUiSession(opened.documentId, ADAPTER),
    { code: 'RESOURCE_LIMIT' },
  )
  const active = sessions[0]
  for (let clock = 1; clock <= 200; clock += 1) {
    registry.updateUiAwareness(uiInput(active, {
      awarenessClock: clock,
      awareness: {
        displayName: 'Human',
        color: '#336699',
        selectionAnchor: 0,
        selectionHead: 0,
        originClass: 'human',
      },
    }), ADAPTER)
  }
  assert.throws(
    () => registry.updateUiAwareness(uiInput(active, {
      awarenessClock: 201,
      awareness: {
        displayName: 'Human',
        color: '#336699',
        selectionAnchor: 0,
        selectionHead: 0,
        originClass: 'human',
      },
    }), ADAPTER),
    { code: 'RESOURCE_LIMIT' },
  )

  const before = registry.read({
    documentId: opened.documentId,
  }, ADAPTER).text
  await assert.rejects(
    registry.applyTextEdits({
      documentId: opened.documentId,
      expectedRevision: '0',
      edits: Array.from({ length: 257 }, () => ({
        start: 0,
        end: 0,
        replacement: 'x',
      })),
    }, ADAPTER),
    { code: 'INVALID_ARGUMENT' },
  )
  await assert.rejects(
    registry.applyTextEdits({
      documentId: opened.documentId,
      expectedRevision: '0',
      edits: [{
        start: 0,
        end: 0,
        replacement: '\ud800',
      }],
    }, ADAPTER),
    { code: 'INVALID_ARGUMENT' },
  )
  await assert.rejects(
    registry.applyYUpdate({
      documentId: opened.documentId,
      expectedRevision: '0',
      update: Buffer.alloc(512 * 1024 + 1),
    }, ADAPTER),
    { code: 'INVALID_ARGUMENT' },
  )
  assert.equal(registry.read({
    documentId: opened.documentId,
  }, ADAPTER).text, before)
})

async function open(service, workspaceRoot, relativePath) {
  return service.dispatch({
    kind: 'public',
    method: 'document.open',
    adapterId: ADAPTER,
    params: {
      workspaceRoot,
      path: relativePath,
    },
  })
}

function uiInput(bootstrap, fields) {
  return {
    documentId: bootstrap.documentId,
    generation: bootstrap.generation,
    documentEpoch: bootstrap.documentEpoch,
    uiSessionId: bootstrap.uiSessionId,
    sessionCapability: bootstrap.sessionCapability,
    ...fields,
  }
}

function encodeBase64(value) {
  return Buffer.from(value).toString('base64')
}

function decodeBase64(value) {
  return Buffer.from(value, 'base64')
}
