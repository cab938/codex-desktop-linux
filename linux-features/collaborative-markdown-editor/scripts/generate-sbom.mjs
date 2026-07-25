#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const featureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const packageJson = readJson(path.join(featureRoot, 'package.json'))
const packageLock = readJson(path.join(featureRoot, 'package-lock.json'))
const directDependencies = new Set(Object.keys(packageJson.dependencies ?? {}))
const packageComponents = new Map()

for (const [lockPath, entry] of Object.entries(packageLock.packages ?? {})) {
  if (
    lockPath === '' ||
    entry.dev === true ||
    typeof entry.version !== 'string'
  ) {
    continue
  }
  const name = packageName(lockPath)
  const key = `${name}@${entry.version}`
  const existing = packageComponents.get(key)
  const sourcePaths = [...(existing?.sourcePaths ?? []), lockPath].sort()
  packageComponents.set(key, {
    type: 'library',
    'bom-ref': `pkg:npm/${purlName(name)}@${entry.version}`,
    name,
    version: entry.version,
    licenses: [{
      license: licenseValue(entry.license),
    }],
    properties: [
      {
        name: 'codex:inventory-scope',
        value: 'locked-production-dependency-graph',
      },
      {
        name: 'codex:direct-dependency',
        value: String(directDependencies.has(name)),
      },
      {
        name: 'codex:package-lock-paths',
        value: sourcePaths.join(','),
      },
    ],
    sourcePaths,
  })
}

const artifactComponents = [
  ['mcp-app.html', 'dist/mcp/mcp-app.html'],
  ['server.mjs', 'dist/plugin/server.mjs'],
  ['broker.mjs', 'dist/plugin/broker.mjs'],
].map(([name, relativePath]) => {
  const contents = fs.readFileSync(path.join(featureRoot, relativePath))
  return {
    type: 'file',
    'bom-ref': `file:${relativePath}`,
    name,
    hashes: [{
      alg: 'SHA-256',
      content: crypto.createHash('sha256').update(contents).digest('hex'),
    }],
    properties: [
      { name: 'codex:staged-path', value: relativePath },
      { name: 'codex:bytes', value: String(contents.length) },
      { name: 'codex:self-contained-bundle', value: 'true' },
    ],
  }
})

const components = [
  ...[...packageComponents.values()]
    .sort((left, right) =>
      left['bom-ref'].localeCompare(right['bom-ref']))
    .map(({ sourcePaths: _sourcePaths, ...component }) => component),
  ...artifactComponents,
]
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      'bom-ref': `pkg:npm/${purlName(packageJson.name)}@${packageJson.version}`,
      name: packageJson.name,
      version: packageJson.version,
    },
    properties: [
      {
        name: 'codex:inventory-note',
        value:
          'Package components are the locked production dependency graph; ' +
          'the three file components are the complete staged runtime bundles.',
      },
    ],
  },
  components,
}

fs.writeFileSync(
  path.join(featureRoot, 'SBOM.cdx.json'),
  `${JSON.stringify(bom, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o644 },
)

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function packageName(lockPath) {
  const marker = 'node_modules/'
  return lockPath.slice(lockPath.lastIndexOf(marker) + marker.length)
}

function purlName(name) {
  return name.startsWith('@')
    ? `%40${name.slice(1).replace('/', '/')}`
    : name
}

function licenseValue(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { name: 'UNKNOWN' }
  }
  return /^[A-Za-z0-9-.+]+$/.test(value)
    ? { id: value }
    : { name: value }
}
