import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import {
  BROKER_PROTOCOL_VERSION,
  ensurePrivateStateRoot,
} from './config.mjs'
import { DocumentRegistry } from './document-registry.mjs'
import { BrokerError, assertBroker, toSafeError } from './errors.mjs'
import { acquireDirectoryLock } from './lock.mjs'
import { WorkspaceRegistry } from './workspace-registry.mjs'

const REQUEST_BYTES_LIMIT = 1024 * 1024

export class BrokerService {
  constructor(options) {
    this.stateRoot = options.stateRoot
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 0
    this.generation = options.generation ?? crypto.randomUUID()
    this.bearer = options.bearer ?? crypto.randomBytes(32).toString('base64url')
    this.workspaceRegistry =
      options.workspaceRegistry ?? new WorkspaceRegistry(this.stateRoot, options)
    this.documentRegistry =
      options.documentRegistry ??
      new DocumentRegistry({
        stateRoot: this.stateRoot,
        workspaceRegistry: this.workspaceRegistry,
        generation: this.generation,
        ...options,
      })
    this.server = null
    this.ownerLock = null
    this.stopping = false
    this.adapters = new Set()
    this.descriptorPath = path.join(
      this.stateRoot,
      'broker-v1',
      'descriptor.json',
    )
  }

  async start() {
    await ensurePrivateStateRoot(this.stateRoot)
    this.ownerLock = await acquireDirectoryLock(
      path.join(this.stateRoot, 'broker-v1', 'owner.lock'),
      { kind: 'broker', label: 'the collaborative Markdown broker' },
    )
    try {
      await this.workspaceRegistry.initialize()
      this.server = http.createServer((request, response) => {
        this.handleRequest(request, response).catch((error) => {
          this.respondError(response, error)
        })
      })
      this.server.on('clientError', (_error, socket) => socket.destroy())
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.port, this.host, resolve)
      })
      this.server.removeAllListeners('error')
      const address = this.server.address()
      assertBroker(
        address && typeof address === 'object',
        'BROKER_UNAVAILABLE',
        'The broker did not receive a loopback address.',
      )
      await writePrivateAtomic(
        this.descriptorPath,
        `${JSON.stringify({
          schemaVersion: 1,
          protocolVersion: BROKER_PROTOCOL_VERSION,
          pid: process.pid,
          host: this.host,
          port: address.port,
          generation: this.generation,
          bearer: this.bearer,
          startedAt: new Date().toISOString(),
        }, null, 2)}\n`,
      )
      return {
        pid: process.pid,
        host: this.host,
        port: address.port,
        generation: this.generation,
      }
    } catch (error) {
      await this.closeServer()
      await this.ownerLock?.release()
      this.ownerLock = null
      throw error
    }
  }

  async handleRequest(request, response) {
    if (!this.authorized(request.headers.authorization)) {
      throw new BrokerError(
        'PERMISSION_DENIED',
        'The broker bearer capability is missing or invalid.',
        { httpStatus: 401 },
      )
    }
    if (request.method === 'GET' && request.url === '/health') {
      return respondJson(response, 200, {
        ok: true,
        protocolVersion: BROKER_PROTOCOL_VERSION,
        pid: process.pid,
        generation: this.generation,
      })
    }
    if (request.method !== 'POST' || request.url !== '/rpc') {
      throw new BrokerError('NOT_FOUND', 'The broker route does not exist.', {
        httpStatus: 404,
      })
    }
    const body = await readJsonBody(request)
    const cancellation = new AbortController()
    response.once('close', () => {
      if (!response.writableEnded) cancellation.abort()
    })
    const result = await this.dispatch(body, {
      signal: cancellation.signal,
    })
    respondJson(response, 200, { ok: true, result })
    if (
      body.kind === 'admin' &&
      (
        body.method === 'broker.shutdown' ||
        (body.method === 'adapter.release' && result.stopping)
      )
    ) {
      setImmediate(() => this.stop().catch(() => {}))
    }
  }

  async dispatch(body, context = {}) {
    assertBroker(
      body && typeof body === 'object' && !Array.isArray(body),
      'INVALID_ARGUMENT',
      'The RPC body must be an object.',
    )
    const params = body.params ?? {}
    if (body.kind === 'app' || body.kind === 'public') {
      assertBroker(
        typeof body.adapterId === 'string' &&
          /^[A-Za-z0-9_-]{16,128}$/.test(body.adapterId),
        'INVALID_ARGUMENT',
        'adapter_id must be a 16–128 character opaque identifier.',
      )
      this.adapters.add(body.adapterId)
    }
    if (body.kind === 'app') {
      switch (body.method) {
        case 'workspace.propose':
          return this.workspaceRegistry.propose(params.workspaceRoot)
        case 'workspace.authorize':
          return this.workspaceRegistry.authorize(params)
        case 'workspace.revoke':
          return this.documentRegistry.revokeWorkspace(params.workspaceRoot)
        case 'document.applyYUpdate':
          return this.documentRegistry.applyYUpdate(params, body.adapterId)
        case 'document.createUiSession':
          return this.documentRegistry.createUiSession(
            params.documentId,
            body.adapterId,
          )
        case 'document.uiPush':
          return this.documentRegistry.applyUiUpdate(params, body.adapterId)
        case 'document.uiPull':
          return this.documentRegistry.pullUiUpdate(
            params,
            body.adapterId,
            context,
          )
        case 'document.uiAwareness':
          return this.documentRegistry.updateUiAwareness(
            params,
            body.adapterId,
          )
        case 'document.uiRefresh':
          return this.documentRegistry.refreshUiSession(
            params,
            body.adapterId,
          )
        default:
          break
      }
    } else if (body.kind === 'public') {
      switch (body.method) {
        case 'document.open':
          return this.documentRegistry.open(params, body.adapterId)
        case 'document.create':
          requireIdempotencyKey(params.idempotencyKey)
          return this.documentRegistry.create(params, body.adapterId)
        case 'document.read':
          return this.documentRegistry.read(params, body.adapterId)
        case 'document.applyText':
          requireIdempotencyKey(params.idempotencyKey)
          return this.documentRegistry.applyTextEdits(params, body.adapterId)
        case 'document.status':
          return this.documentRegistry.status(params.documentId, body.adapterId)
        case 'document.flush':
          requireIdempotencyKey(params.idempotencyKey)
          return this.documentRegistry.flush(params, body.adapterId)
        case 'document.reconcile':
          return this.documentRegistry.reconcile(
            params.documentId,
            body.adapterId,
          )
        case 'document.close':
          requireIdempotencyKey(params.idempotencyKey)
          return this.documentRegistry.close(params, body.adapterId)
        default:
          break
      }
    } else if (body.kind === 'admin') {
      if (body.method === 'broker.shutdown') {
        return { stopping: true, pid: process.pid }
      }
      if (body.method === 'adapter.release') {
        const released = await this.documentRegistry
          .releaseAdapterEverywhere(body.adapterId)
        this.adapters.delete(body.adapterId)
        return {
          ...released,
          stopping: this.adapters.size === 0,
          remainingAdapters: this.adapters.size,
          pid: process.pid,
        }
      }
    }
    throw new BrokerError(
      'METHOD_NOT_FOUND',
      'The requested broker method is not available to this caller class.',
      { httpStatus: 404 },
    )
  }

  authorized(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const supplied = Buffer.from(header.slice('Bearer '.length))
    const expected = Buffer.from(this.bearer)
    return supplied.length === expected.length &&
      crypto.timingSafeEqual(supplied, expected)
  }

  respondError(response, error) {
    if (response.headersSent || response.destroyed) return
    respondJson(
      response,
      error instanceof BrokerError ? error.httpStatus : 500,
      { ok: false, error: toSafeError(error) },
    )
  }

  async stop() {
    if (this.stopping) return
    this.stopping = true
    let shutdownError
    try {
      try {
        await this.documentRegistry.shutdown()
      } catch (error) {
        shutdownError = error
      }
      await this.closeServer()
      await removeDescriptorIfOwned(this.descriptorPath, this.bearer)
    } finally {
      await this.ownerLock?.release()
      this.ownerLock = null
    }
    if (shutdownError) throw shutdownError
  }

  async closeServer() {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise((resolve) => server.close(resolve))
  }
}

async function readJsonBody(request) {
  const chunks = []
  let received = 0
  for await (const chunk of request) {
    received += chunk.length
    if (received > REQUEST_BYTES_LIMIT) {
      throw new BrokerError(
        'REQUEST_TOO_LARGE',
        `Broker RPC requests may not exceed ${REQUEST_BYTES_LIMIT} bytes.`,
        { httpStatus: 413 },
      )
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (cause) {
    throw new BrokerError('INVALID_ARGUMENT', 'The RPC body is not valid JSON.', {
      cause,
    })
  }
}

function respondJson(response, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  response.end(body)
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

async function removeDescriptorIfOwned(descriptorPath, bearer) {
  try {
    const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'))
    if (descriptor.bearer === bearer) await fs.unlink(descriptorPath)
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
}

function requireIdempotencyKey(value) {
  assertBroker(
    typeof value === 'string' &&
      value.length >= 16 &&
      value.length <= 128 &&
      /^[\x20-\x7e]+$/.test(value),
    'INVALID_ARGUMENT',
    'Mutating RPC methods require a 16–128 character idempotency key.',
  )
}
