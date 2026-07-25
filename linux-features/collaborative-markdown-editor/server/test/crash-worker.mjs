import path from 'node:path'
import { DocumentRegistry } from '../document-registry.mjs'
import { WorkspaceRegistry } from '../workspace-registry.mjs'

const [stateRoot, workspaceRoot, phase] = process.argv.slice(2)
const workspaceRegistry = new WorkspaceRegistry(stateRoot)
await workspaceRegistry.initialize()
const registry = new DocumentRegistry({
  stateRoot,
  workspaceRegistry,
  filePersistenceOptions: {
    flushDebounceMs: 60_000,
    watchFactory: () => ({ on() {}, close() {} }),
    fault(point) {
      if (point === phase) {
        process.exit(phase === 'after-temp-sync' ? 92 : 91)
      }
    },
  },
})
const adapterId = 'crash_worker_adapter_123'
const opened = await registry.open(
  { workspaceRoot, path: 'notes.md' },
  adapterId,
)
await registry.applyTextEdits({
  documentId: opened.documentId,
  expectedRevision: '0',
  edits: [{ start: 5, end: 5, replacement: ' crash' }],
}, adapterId)
await registry.flush({
  documentId: opened.documentId,
  expectedRevision: '1',
}, adapterId)
process.exit(90)
