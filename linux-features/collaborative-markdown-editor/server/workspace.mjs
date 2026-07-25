import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_FILE_BYTES,
} from './config.mjs'
import { BrokerError, assertBroker } from './errors.mjs'

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown'])

export async function canonicalizeWorkspaceRoot(inputRoot) {
  assertBroker(
    typeof inputRoot === 'string' && inputRoot.length > 0 && inputRoot.length <= 4096,
    'INVALID_ARGUMENT',
    'workspace_root must be a non-empty path of at most 4,096 characters.',
  )
  assertBroker(
    path.isAbsolute(inputRoot),
    'INVALID_ARGUMENT',
    'workspace_root must be absolute.',
  )

  const resolved = path.resolve(inputRoot)
  const stat = await safeLstat(resolved, 'WORKSPACE_AUTHORIZATION_REQUIRED')
  assertBroker(
    stat.isDirectory(),
    'WORKSPACE_AUTHORIZATION_REQUIRED',
    'The proposed workspace root is not a directory.',
  )
  assertBroker(
    !stat.isSymbolicLink(),
    'SYMLINK_UNSUPPORTED',
    'Workspace symlinks are not supported in v1.',
  )

  const canonical = await fs.realpath(resolved)
  assertBroker(
    comparablePath(resolved) === comparablePath(canonical),
    'SYMLINK_UNSUPPORTED',
    'Workspace paths containing symlinks are not supported in v1.',
  )
  await assertNoSymlinkComponents(canonical)
  return canonical
}

export function validateRelativeMarkdownPath(relativePath) {
  assertBroker(
    typeof relativePath === 'string' &&
      relativePath.length > 0 &&
      relativePath.length <= 1024,
    'INVALID_ARGUMENT',
    'path must be a non-empty root-relative path of at most 1,024 characters.',
  )
  assertBroker(
    !relativePath.includes('\0') && !relativePath.includes('\\'),
    'INVALID_ARGUMENT',
    'path must use root-relative forward-slash segments.',
  )
  assertBroker(
    !relativePath.startsWith('/') && !path.isAbsolute(relativePath),
    'WORKSPACE_ESCAPE',
    'An absolute document path is not allowed.',
  )
  const segments = relativePath.split('/')
  assertBroker(
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        decodeTraversalSafe(segment),
    ),
    'WORKSPACE_ESCAPE',
    'The document path contains an unsafe traversal segment.',
  )
  const extension = path.extname(segments.at(-1)).toLowerCase()
  assertBroker(
    MARKDOWN_EXTENSIONS.has(extension),
    'FILE_EXTENSION_UNSUPPORTED',
    'Only .md and .markdown files are supported.',
  )
  return segments
}

function decodeTraversalSafe(segment) {
  try {
    const decoded = decodeURIComponent(segment)
    return decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\\')
  } catch {
    return false
  }
}

export async function resolveMarkdownFile(workspaceRoot, relativePath) {
  const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot)
  const segments = validateRelativeMarkdownPath(relativePath)
  const candidate = path.join(canonicalRoot, ...segments)
  assertContained(canonicalRoot, candidate)
  await assertNoSymlinkComponents(candidate, canonicalRoot)
  const stat = await safeLstat(candidate, 'FILE_NOT_FOUND')
  assertBroker(
    stat.isFile() && !stat.isSymbolicLink(),
    'FILE_TYPE_UNSUPPORTED',
    'The requested Markdown path is not a regular file.',
  )
  const canonicalPath = await fs.realpath(candidate)
  assertContained(canonicalRoot, canonicalPath)
  assertBroker(
    comparablePath(candidate) === comparablePath(canonicalPath),
    'SYMLINK_UNSUPPORTED',
    'Markdown files reached through symlinks are not supported in v1.',
  )
  return {
    canonicalRoot,
    canonicalPath,
    relativePath: segments.join('/'),
    stat,
  }
}

export async function createMarkdownFile(
  workspaceRoot,
  relativePath,
  initialText,
) {
  const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot)
  const segments = validateRelativeMarkdownPath(relativePath)
  const candidate = path.join(canonicalRoot, ...segments)
  assertContained(canonicalRoot, candidate)
  const parent = path.dirname(candidate)
  await assertNoSymlinkComponents(parent, canonicalRoot)
  const parentStat = await safeLstat(parent, 'FILE_NOT_FOUND')
  assertBroker(
    parentStat.isDirectory() && !parentStat.isSymbolicLink(),
    'FILE_TYPE_UNSUPPORTED',
    'The Markdown parent path is not a regular directory.',
  )
  const text = normalizeInitialMarkdown(initialText)
  const bytes = Buffer.from(text, 'utf8')
  assertBroker(
    bytes.length <= MAX_FILE_BYTES,
    'FILE_TOO_LARGE',
    `Markdown files may not exceed ${MAX_FILE_BYTES} bytes.`,
  )
  const mode =
    process.platform === 'win32' ? undefined : 0o666 & ~process.umask()
  let handle
  try {
    handle = await fs.open(candidate, 'wx', mode)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (cause) {
    if (cause?.code === 'EEXIST') {
      throw new BrokerError(
        'FILE_EXISTS',
        'The requested Markdown file already exists.',
        { cause },
      )
    }
    throw cause
  } finally {
    await handle?.close().catch(() => {})
  }
  await syncDirectory(parent)
  return readMarkdownFile(
    await resolveMarkdownFile(canonicalRoot, segments.join('/')),
  )
}

export function normalizeInitialMarkdown(value) {
  assertBroker(
    typeof value === 'string' &&
      !value.includes('\0') &&
      !value.includes('\r') &&
      !hasIsolatedSurrogate(value),
    'INVALID_ARGUMENT',
    'initial_text must be valid Unicode with normalized LF endings.',
  )
  return value.endsWith('\n') ? value : `${value}\n`
}

export async function readMarkdownFile(resolvedFile, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES
  assertBroker(
    resolvedFile.stat.size <= maxBytes,
    'FILE_TOO_LARGE',
    `Markdown files may not exceed ${maxBytes} bytes.`,
    { details: { maxBytes, actualBytes: resolvedFile.stat.size } },
  )
  const bytes = await fs.readFile(resolvedFile.canonicalPath)
  assertBroker(
    bytes.length <= maxBytes,
    'FILE_TOO_LARGE',
    `Markdown files may not exceed ${maxBytes} bytes.`,
    { details: { maxBytes, actualBytes: bytes.length } },
  )

  const bom = bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  const content = bom ? bytes.subarray(3) : bytes
  let decoded
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch (cause) {
    throw new BrokerError(
      'INVALID_UTF8',
      'The Markdown file is not valid UTF-8.',
      { cause },
    )
  }
  assertBroker(
    !decoded.includes('\0'),
    'INVALID_UTF8',
    'Markdown containing NUL characters is not supported.',
  )

  const withoutCrLf = decoded.replaceAll('\r\n', '')
  const hasCrLf = decoded.includes('\r\n')
  const hasBareLf = withoutCrLf.includes('\n')
  const hasBareCr = withoutCrLf.includes('\r')
  assertBroker(
    !hasBareCr && !(hasCrLf && hasBareLf),
    'MIXED_LINE_ENDINGS',
    'V1 requires consistently LF or consistently CRLF line endings.',
  )

  const lineEndings = hasCrLf ? 'crlf' : 'lf'
  const text = hasCrLf ? decoded.replaceAll('\r\n', '\n') : decoded
  return {
    ...resolvedFile,
    bytes,
    text,
    byteLength: bytes.length,
    utf16Length: text.length,
    contentHash: hashBytes(bytes),
    bom,
    lineEndings,
    finalNewline: text.endsWith('\n'),
    mode: process.platform === 'win32' ? null : resolvedFile.stat.mode & 0o777,
  }
}

export function documentIdentity(canonicalRoot, canonicalPath) {
  const normalizedRoot = normalizeIdentityPath(canonicalRoot)
  const normalizedPath = normalizeIdentityPath(canonicalPath)
  const digest = crypto
    .createHash('sha256')
    .update(normalizedRoot)
    .update('\0')
    .update(normalizedPath)
    .digest('base64url')
  return `doc_v1_${digest}`
}

export function workspaceIdentity(canonicalRoot) {
  return `ws_v1_${crypto
    .createHash('sha256')
    .update(normalizeIdentityPath(canonicalRoot))
    .digest('base64url')}`
}

export function hashBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

export function hashText(value) {
  return hashBytes(Buffer.from(value, 'utf8'))
}

function normalizeIdentityPath(value) {
  const normalized = value.normalize('NFC')
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function comparablePath(value) {
  return normalizeIdentityPath(path.resolve(value))
}

function assertContained(root, target) {
  const relative = path.relative(root, target)
  assertBroker(
    relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)),
    'WORKSPACE_ESCAPE',
    'The document path escapes the authorized workspace root.',
  )
}

async function assertNoSymlinkComponents(target, stopAt = path.parse(target).root) {
  const resolvedTarget = path.resolve(target)
  const resolvedStop = path.resolve(stopAt)
  assertContained(resolvedStop, resolvedTarget)
  const relative = path.relative(resolvedStop, resolvedTarget)
  let current = resolvedStop
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = await safeLstat(current, 'FILE_NOT_FOUND')
    assertBroker(
      !stat.isSymbolicLink(),
      'SYMLINK_UNSUPPORTED',
      'Symlink path components are not supported in v1.',
    )
  }
}

async function safeLstat(target, missingCode) {
  try {
    return await fs.lstat(target)
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new BrokerError(
        missingCode,
        missingCode === 'FILE_NOT_FOUND'
          ? 'The requested Markdown file does not exist.'
          : 'The proposed workspace root does not exist.',
        { cause },
      )
    }
    if (cause?.code === 'EACCES' || cause?.code === 'EPERM') {
      throw new BrokerError(
        'PERMISSION_DENIED',
        'The path cannot be inspected with the current user permissions.',
        { cause },
      )
    }
    throw cause
  }
}

function hasIsolatedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return
  let handle
  try {
    handle = await fs.open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}
