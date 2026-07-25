import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BROKER_PROTOCOL_VERSION,
  ensurePrivateStateRoot,
  resolveStateRoot,
} from './config.mjs'
import { BrokerError, assertBroker } from './errors.mjs'

const MAIN_PATH = fileURLToPath(new URL('./broker-main.mjs', import.meta.url))

export class BrokerClient {
  constructor(options = {}) {
    this.stateRoot = resolveStateRoot({ override: options.stateRoot })
    this.adapterId =
      options.adapterId ?? crypto.randomBytes(24).toString('base64url')
    this.spawnBroker = options.spawnBroker ?? defaultSpawnBroker
    this.descriptor = null
  }

  async ensure(options = {}) {
    await ensurePrivateStateRoot(this.stateRoot)
    const deadline = Date.now() + (options.timeoutMs ?? 5_000)
    const existing = await this.tryAttach()
    if (existing) return existing
    this.spawnBroker(this.stateRoot)
    while (Date.now() < deadline) {
      await delay(25)
      const descriptor = await this.tryAttach()
      if (descriptor) return descriptor
    }
    throw new BrokerError(
      'BROKER_UNAVAILABLE',
      'The collaborative Markdown broker did not become ready.',
      { retryable: true },
    )
  }

  async tryAttach() {
    let descriptor
    try {
      descriptor = JSON.parse(
        await fs.readFile(
          path.join(this.stateRoot, 'broker-v1', 'descriptor.json'),
          'utf8',
        ),
      )
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
    if (
      descriptor?.schemaVersion !== 1 ||
      descriptor?.protocolVersion !== BROKER_PROTOCOL_VERSION ||
      descriptor.host !== '127.0.0.1' ||
      !Number.isInteger(descriptor.port) ||
      typeof descriptor.bearer !== 'string'
    ) {
      throw new BrokerError(
        'STATE_VERSION_UNSUPPORTED',
        'The existing broker descriptor is incompatible.',
      )
    }
    try {
      const health = await request(descriptor, 'GET', '/health')
      assertBroker(
        health.ok &&
          health.protocolVersion === BROKER_PROTOCOL_VERSION &&
          health.generation === descriptor.generation,
        'BROKER_UNAVAILABLE',
        'The broker health response does not match its descriptor.',
        { retryable: true },
      )
      this.descriptor = descriptor
      return descriptor
    } catch (error) {
      if (
        error instanceof BrokerError &&
        error.code !== 'BROKER_UNAVAILABLE'
      ) {
        throw error
      }
      return null
    }
  }

  async rpc(kind, method, params = {}, options = {}) {
    const descriptor = this.descriptor ?? await this.ensure()
    const response = await request(descriptor, 'POST', '/rpc', {
      kind,
      method,
      adapterId: this.adapterId,
      params,
    }, options)
    if (!response.ok) {
      throw new BrokerError(
        response.error?.code ?? 'BROKER_UNAVAILABLE',
        response.error?.message ?? 'The broker request failed.',
        {
          retryable: response.error?.retryable,
          details: response.error?.details,
        },
      )
    }
    return response.result
  }
}

function defaultSpawnBroker(stateRoot) {
  const child = spawn(
    process.execPath,
    [MAIN_PATH, '--state-root', stateRoot],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  child.unref()
}

async function request(descriptor, method, route, body, options = {}) {
  let response
  try {
    response = await fetch(
      `http://${descriptor.host}:${descriptor.port}${route}`,
      {
        method,
        headers: {
          authorization: `Bearer ${descriptor.bearer}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: combinedSignal(
          options.signal,
          options.timeoutMs ?? 1_000,
        ),
      },
    )
  } catch (cause) {
    throw new BrokerError(
      'BROKER_UNAVAILABLE',
      'The existing broker endpoint is unavailable.',
      { retryable: true, cause },
    )
  }
  let payload
  try {
    payload = await response.json()
  } catch (cause) {
    throw new BrokerError(
      'BROKER_UNAVAILABLE',
      'The broker returned an invalid response.',
      { retryable: true, cause },
    )
  }
  return payload
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
