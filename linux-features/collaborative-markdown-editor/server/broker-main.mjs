#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { BrokerService } from './broker-service.mjs'
import { resolveStateRoot } from './config.mjs'
import { toSafeError } from './errors.mjs'

const { values } = parseArgs({
  options: {
    'state-root': { type: 'string' },
  },
  strict: true,
})

const service = new BrokerService({
  stateRoot: resolveStateRoot({ override: values['state-root'] }),
})

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await service.stop()
}

process.on('SIGTERM', () => stop().finally(() => process.exit(0)))
process.on('SIGINT', () => stop().finally(() => process.exit(0)))

try {
  await service.start()
} catch (error) {
  process.stderr.write(`${JSON.stringify(toSafeError(error))}\n`)
  process.exitCode = error?.code === 'LOCKED' ? 2 : 1
}
