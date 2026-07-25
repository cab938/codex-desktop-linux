import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  assertSupportedRuntimePlatform,
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
