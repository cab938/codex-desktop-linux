import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const featureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const generator = path.join(featureRoot, 'scripts', 'generate-sbom.mjs')
const sbomPath = path.join(featureRoot, 'SBOM.cdx.json')

test('CycloneDX inventory is deterministic and matches staged bundles', () => {
  const first = generate()
  const second = generate()
  assert.equal(second, first)
  const sbom = JSON.parse(first)
  assert.equal(sbom.bomFormat, 'CycloneDX')
  assert.equal(sbom.specVersion, '1.5')
  assert.ok(sbom.components.length > 100)
  assert.ok(sbom.components.some(
    (component) => component.name === 'yjs' && component.version === '13.6.31',
  ))
  assert.ok(sbom.components.some(
    (component) => component.name === '@modelcontextprotocol/sdk',
  ))
  assert.ok(sbom.components.every(
    (component) =>
      component.type === 'file' ||
      component.licenses?.[0]?.license?.id ||
      component.licenses?.[0]?.license?.name,
  ))
  for (const relativePath of [
    'dist/mcp/mcp-app.html',
    'dist/plugin/server.mjs',
    'dist/plugin/broker.mjs',
  ]) {
    const component = sbom.components.find(
      (entry) =>
        entry.properties?.some(
          (property) =>
            property.name === 'codex:staged-path' &&
            property.value === relativePath,
        ),
    )
    assert.ok(component, relativePath)
    assert.equal(
      component.hashes[0].content,
      crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(featureRoot, relativePath)))
        .digest('hex'),
    )
  }
})

function generate() {
  const result = spawnSync(process.execPath, [generator], {
    cwd: featureRoot,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return fs.readFileSync(sbomPath, 'utf8')
}
