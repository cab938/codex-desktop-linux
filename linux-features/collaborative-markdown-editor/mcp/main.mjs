#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCollaborativeMarkdownMcpServer } from './server.mjs'

const { server, broker } = createCollaborativeMarkdownMcpServer()
const transport = new StdioServerTransport()
let releasePromise

function releaseAdapter() {
  releasePromise ??= broker
    .releaseAdapter()
    .catch(() => undefined)
  return releasePromise
}

process.stdin.once('end', () => {
  void releaseAdapter()
})
process.once('SIGTERM', () => {
  void releaseAdapter().finally(() => process.exit(0))
})
process.once('SIGINT', () => {
  void releaseAdapter().finally(() => process.exit(0))
})

await server.connect(transport)
