#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCollaborativeMarkdownMcpServer } from './server.mjs'

const { server } = createCollaborativeMarkdownMcpServer()
const transport = new StdioServerTransport()
await server.connect(transport)
