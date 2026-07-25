import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { RESOURCE_URI } from './server.mjs'

const MCP_ROOT = path.dirname(fileURLToPath(import.meta.url))
const FEATURE_ROOT = path.dirname(MCP_ROOT)
const PLUGIN_SOURCE = path.join(
  FEATURE_ROOT,
  'plugin-marketplace',
  'plugins',
  'collaborative-markdown-editor',
)

test('staged plugin is self-contained and releases its broker on uninstall', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'collaborative-markdown-staged-plugin-'),
  )
  const pluginRoot = path.join(root, 'collaborative-markdown-editor')
  const workspaceRoot = path.join(root, 'workspace')
  const stateRoot = path.join(root, 'state')
  await fs.cp(PLUGIN_SOURCE, pluginRoot, { recursive: true })
  await fs.mkdir(path.join(pluginRoot, 'runtime'), { recursive: true })
  await fs.mkdir(path.join(pluginRoot, 'dist', 'mcp'), { recursive: true })
  await fs.copyFile(
    path.join(FEATURE_ROOT, 'dist', 'plugin', 'server.mjs'),
    path.join(pluginRoot, 'runtime', 'server.mjs'),
  )
  await fs.copyFile(
    path.join(FEATURE_ROOT, 'dist', 'plugin', 'broker.mjs'),
    path.join(pluginRoot, 'runtime', 'broker.mjs'),
  )
  await fs.copyFile(
    path.join(FEATURE_ROOT, 'dist', 'mcp', 'mcp-app.html'),
    path.join(pluginRoot, 'dist', 'mcp', 'mcp-app.html'),
  )
  await fs.mkdir(workspaceRoot)
  const markdownPath = path.join(workspaceRoot, 'notes.md')
  await fs.writeFile(markdownPath, '# Durable project file\n')
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const serverBundle = await fs.readFile(
    path.join(pluginRoot, 'runtime', 'server.mjs'),
    'utf8',
  )
  assert.doesNotMatch(serverBundle, /@hono\/node-server/)
  assert.doesNotMatch(serverBundle, /\bserveStatic\b/)
  assert.doesNotMatch(serverBundle, /\bexpress-rate-limit\b/)
  assert.equal(
    await pathExists(path.join(pluginRoot, 'node_modules')),
    false,
  )

  const resourceHtml = await fs.readFile(
    path.join(pluginRoot, 'dist', 'mcp', 'mcp-app.html'),
    'utf8',
  )
  assert.doesNotMatch(resourceHtml, /<script[^>]+src=/i)
  assert.doesNotMatch(resourceHtml, /<link[^>]+rel=["']stylesheet/i)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['./runtime/server.mjs'],
    cwd: pluginRoot,
    env: {
      PATH: process.env.PATH ?? '',
      CODEX_COLLABORATIVE_MARKDOWN_STATE_ROOT: stateRoot,
    },
    stderr: 'pipe',
  })
  const client = new Client({
    name: 'staged-plugin-test',
    version: '1.0.0',
  })
  await client.connect(transport)
  assert.equal((await client.listTools()).tools.length, 13)
  const resource = await client.readResource({ uri: RESOURCE_URI })
  assert.equal(
    resource.contents[0].mimeType,
    'text/html;profile=mcp-app',
  )
  assert.equal(resource.contents[0].text.length, resourceHtml.length)

  const render = await client.callTool({
    name: 'markdown_render',
    arguments: {
      workspace_root: workspaceRoot,
      path: 'notes.md',
    },
  })
  assert.equal(
    render.structuredContent.state,
    'authorization_required',
  )
  const descriptorPath = path.join(
    stateRoot,
    'broker-v1',
    'descriptor.json',
  )
  await waitFor(() => pathExists(descriptorPath))

  await client.close()
  await waitFor(async () => !(await pathExists(descriptorPath)))
  await fs.rm(pluginRoot, { recursive: true })
  assert.equal(await fs.readFile(markdownPath, 'utf8'), '# Durable project file\n')
})

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for staged plugin lifecycle state.')
}
