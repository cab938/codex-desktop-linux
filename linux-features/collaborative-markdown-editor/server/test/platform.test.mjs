import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertSupportedRuntimePlatform,
  ensureBrokerStateRoot,
  ensurePrivateStateRoot,
  resolveStateRoot,
} from '../config.mjs'
import {
  documentIdentity,
  validateRelativeMarkdownPath,
  workspaceIdentity,
} from '../workspace.mjs'

test('platform-native private state roots are deterministic', () => {
  assert.equal(
    resolveStateRoot({
      platform: 'linux',
      environment: { XDG_STATE_HOME: '/state' },
      userHome: '/home/editor',
    }),
    path.join('/state', 'codex', 'collaborative-markdown-editor'),
  )
  assert.equal(
    resolveStateRoot({
      platform: 'darwin',
      environment: {},
      userHome: '/Users/editor',
    }),
    path.join(
      '/Users/editor',
      'Library',
      'Application Support',
      'Codex',
      'collaborative-markdown-editor',
    ),
  )
  assert.equal(
    resolveStateRoot({
      platform: 'win32',
      environment: { LOCALAPPDATA: 'C:\\Users\\editor\\AppData\\Local' },
      userHome: 'C:\\Users\\editor',
      pathApi: path.win32,
    }),
    'C:\\Users\\editor\\AppData\\Local\\Codex\\collaborative-markdown-editor',
  )
})

test('runtime support fails closed outside verified atomic-replace families', () => {
  assert.equal(assertSupportedRuntimePlatform('linux'), 'linux')
  assert.equal(assertSupportedRuntimePlatform('darwin'), 'darwin')
  assert.throws(
    () => assertSupportedRuntimePlatform('win32'),
    { code: 'PLATFORM_UNSUPPORTED' },
  )
})

test('sandboxed runtimes fall back to a deterministic user-private runtime root', async () => {
  const calls = []
  const resolved = await ensureBrokerStateRoot({
    preferredRoot: '/state/codex/collaborative-markdown-editor',
    temporaryRoot: '/tmp',
    userId: 1234,
    ensureRoot: async (candidate) => {
      calls.push(candidate)
      if (calls.length === 1) {
        const error = new Error('read-only platform state')
        error.code = 'EROFS'
        throw error
      }
    },
  })
  assert.deepEqual(resolved, {
    path: '/tmp/codex-collaborative-markdown-editor-1234',
    persistence: 'runtime',
  })
  assert.deepEqual(calls, [
    '/state/codex/collaborative-markdown-editor',
    '/tmp/codex-collaborative-markdown-editor-1234',
  ])
})

test('explicit or unsafe state roots fail closed instead of falling back', async () => {
  await assert.rejects(
    ensureBrokerStateRoot({
      preferredRoot: '/state/explicit',
      allowRuntimeFallback: false,
      ensureRoot: async () => {
        const error = new Error('read-only explicit root')
        error.code = 'EROFS'
        throw error
      },
    }),
    { code: 'EROFS' },
  )
  await assert.rejects(
    ensureBrokerStateRoot({
      preferredRoot: '/state/unsafe',
      ensureRoot: async () => {
        const error = new Error('unsafe root')
        error.code = 'BROKER_UNAVAILABLE'
        throw error
      },
    }),
    { code: 'BROKER_UNAVAILABLE' },
  )
})

test('private state roots reject symbolic links', async (t) => {
  if (process.platform === 'win32') return
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), 'collaborative-markdown-state-root-'),
  )
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const target = path.join(parent, 'target')
  const link = path.join(parent, 'state')
  await fs.mkdir(target)
  await fs.symlink(target, link)
  await assert.rejects(
    ensurePrivateStateRoot(link),
    { code: 'BROKER_UNAVAILABLE' },
  )
})

test('identity casing and Unicode normalization follow platform semantics', () => {
  assert.equal(
    documentIdentity(
      'C:\\Users\\Editor\\Repo',
      'C:\\Users\\Editor\\Repo\\Notes.md',
      'win32',
    ),
    documentIdentity(
      'c:\\users\\editor\\repo',
      'c:\\users\\editor\\repo\\notes.md',
      'win32',
    ),
  )
  assert.notEqual(
    documentIdentity('/workspace/Repo', '/workspace/Repo/Notes.md', 'linux'),
    documentIdentity('/workspace/repo', '/workspace/repo/notes.md', 'linux'),
  )
  assert.equal(
    workspaceIdentity('/workspace/Caf\u00e9', 'linux'),
    workspaceIdentity('/workspace/Cafe\u0301', 'linux'),
  )
})

test('portable document syntax rejects host-specific separator bypasses', () => {
  assert.deepEqual(
    validateRelativeMarkdownPath('notes/\u6587\u7a3f.md'),
    ['notes', '\u6587\u7a3f.md'],
  )
  for (const value of [
    'notes\\escape.md',
    'C:\\escape.md',
    '\\\\server\\share\\escape.md',
    '../escape.md',
  ]) {
    assert.throws(() => validateRelativeMarkdownPath(value))
  }
})
