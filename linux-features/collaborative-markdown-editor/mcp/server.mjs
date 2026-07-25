import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { BrokerClient } from '../server/broker-client.mjs'
import { BrokerError, toSafeError } from '../server/errors.mjs'

export const MCP_SERVER_NAME = 'collaborative-markdown-editor'
export const MCP_SERVER_VERSION = '0.1.0'
export const RESOURCE_URI =
  'ui://collaborative-markdown-editor/v1/index.html'
export const UI_META_KEY = 'collaborativeMarkdownEditor'

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DOCUMENT_ID = /^doc_v1_[A-Za-z0-9_-]{43}$/
const REVISION = /^(0|[1-9][0-9]{0,19})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^sha256:[0-9a-f]{64}$/
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/
const IDEMPOTENCY = /^[\x20-\x7e]{16,128}$/

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const MUTATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const EDIT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
}

export function createCollaborativeMarkdownMcpServer(options = {}) {
  const broker = options.brokerClient ?? new BrokerClient({
    stateRoot: options.stateRoot,
  })
  const authorizationSessions = new Map()
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      instructions:
        'Open only user-approved workspace Markdown. Read the current revision ' +
        'before editing, use a unique idempotency key for every intended ' +
        'mutation, and retry stale edits only after reading again. Use ' +
        'markdown_render only when the user wants the right-panel editor.',
    },
  )

  registerModelTool(server, 'markdown_open', {
    title: 'Open Markdown document',
    description:
      'Open an existing Markdown file under a user-approved workspace root. ' +
      'Returns metadata, never the document text.',
    inputSchema: {
      workspace_root: rootSchema(),
      path: relativePathSchema(),
    },
    outputSchema: documentResultSchema(),
    annotations: READ_ANNOTATIONS,
  }, async (input) => {
    const document = await broker.rpc('public', 'document.open', {
      workspaceRoot: input.workspace_root,
      path: input.path,
    })
    return success(
      `Opened ${document.path} at revision ${document.revision}.`,
      { ok: true, document: snakeDocument(document) },
    )
  })

  registerModelTool(server, 'markdown_create', {
    title: 'Create Markdown document',
    description:
      'Exclusively create a UTF-8 Markdown file under an approved workspace.',
    inputSchema: {
      workspace_root: rootSchema(),
      path: relativePathSchema(),
      initial_text: z.string().max(2 * 1024 * 1024),
      idempotency_key: z.string().regex(IDEMPOTENCY),
    },
    outputSchema: {
      ok: z.literal(true),
      document: z.object(documentShape()),
      durability: z.literal('file'),
    },
    annotations: MUTATE_ANNOTATIONS,
  }, async (input) => {
    const document = await broker.rpc('public', 'document.create', {
      workspaceRoot: input.workspace_root,
      path: input.path,
      initialText: input.initial_text,
      idempotencyKey: input.idempotency_key,
    })
    return success(
      `Created ${document.path} as a durable Markdown file.`,
      { ok: true, document: snakeDocument(document), durability: 'file' },
    )
  })

  registerModelTool(server, 'markdown_read', {
    title: 'Read Markdown range',
    description:
      'Read at most 65,536 UTF-16 code units from an opened document.',
    inputSchema: {
      document_id: documentIdSchema(),
      expected_revision: revisionSchema().optional(),
      from: z.number().int().min(0).max(2_097_152).optional(),
      to: z.number().int().min(0).max(2_097_152).optional(),
    },
    outputSchema: {
      ok: z.literal(true),
      document_id: documentIdSchema(),
      revision: revisionSchema(),
      from: z.number().int(),
      to: z.number().int(),
      total_utf16_length: z.number().int(),
      text: z.string(),
      truncated: z.boolean(),
    },
    annotations: READ_ANNOTATIONS,
  }, async (input) => {
    const result = await broker.rpc('public', 'document.read', {
      documentId: input.document_id,
      expectedRevision: input.expected_revision,
      from: input.from,
      to: input.to,
    })
    const structuredContent = {
      ok: true,
      document_id: result.documentId,
      revision: result.revision,
      from: result.from,
      to: result.to,
      total_utf16_length: result.totalUtf16Length,
      text: result.text,
      truncated: result.truncated,
    }
    return success(
      `Read UTF-16 range ${result.from}–${result.to} at revision ${result.revision}.`,
      structuredContent,
    )
  })

  registerModelTool(server, 'markdown_apply_edits', {
    title: 'Apply Markdown edits',
    description:
      'Apply 1–256 non-overlapping UTF-16 edits to the exact expected revision.',
    inputSchema: {
      document_id: documentIdSchema(),
      expected_revision: revisionSchema(),
      idempotency_key: z.string().regex(IDEMPOTENCY),
      edits: z.array(z.object({
        start: z.number().int().min(0).max(2_097_152),
        end: z.number().int().min(0).max(2_097_152),
        replacement: z.string(),
      }).strict()).min(1).max(256),
      durability: z.enum(['recovery_log', 'file']).optional(),
    },
    outputSchema: {
      ok: z.literal(true),
      document_id: documentIdSchema(),
      previous_revision: revisionSchema(),
      revision: revisionSchema(),
      changed_from: z.number().int(),
      changed_to: z.number().int(),
      durability: z.enum(['recovery_log', 'file']),
      flush_state: flushStateSchema(),
      file_durable_revision: revisionSchema(),
    },
    annotations: EDIT_ANNOTATIONS,
  }, async (input) => {
    const result = await broker.rpc('public', 'document.applyText', {
      documentId: input.document_id,
      expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key,
      edits: input.edits,
      durability: input.durability ?? 'recovery_log',
    }, { timeoutMs: input.durability === 'file' ? 10_000 : 2_000 })
    return success(
      `Applied ${input.edits.length} edit(s); revision is now ${result.revision}.`,
      {
        ok: true,
        document_id: result.documentId,
        previous_revision: result.previousRevision,
        revision: result.revision,
        changed_from: result.changedFrom,
        changed_to: result.changedTo,
        durability: result.durability ?? 'recovery_log',
        flush_state: result.flushState,
        file_durable_revision: result.fileDurableRevision,
      },
    )
  })

  registerModelTool(server, 'markdown_status', {
    title: 'Read Markdown status',
    description:
      'Read revision, durability, connection, external-change, and conflict status.',
    inputSchema: { document_id: documentIdSchema() },
    outputSchema: statusResultSchema(),
    annotations: READ_ANNOTATIONS,
  }, async (input) => {
    const status = await broker.rpc('public', 'document.status', {
      documentId: input.document_id,
    })
    return success(
      `Document ${status.documentId} is at revision ${status.revision} (${status.flushState}).`,
      { ok: true, ...snakeStatus(status) },
    )
  })

  registerModelTool(server, 'markdown_flush', {
    title: 'Flush Markdown file',
    description:
      'Wait for the exact revision to become durable in the workspace Markdown file.',
    inputSchema: {
      document_id: documentIdSchema(),
      expected_revision: revisionSchema(),
      idempotency_key: z.string().regex(IDEMPOTENCY),
    },
    outputSchema: {
      ok: z.literal(true),
      document_id: documentIdSchema(),
      revision: revisionSchema(),
      file_durable_revision: revisionSchema(),
      content_hash: z.string().regex(HASH),
      flush_state: z.literal('file_durable'),
    },
    annotations: MUTATE_ANNOTATIONS,
  }, async (input) => {
    const result = await broker.rpc('public', 'document.flush', {
      documentId: input.document_id,
      expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key,
    }, { timeoutMs: 10_000 })
    return success(
      `Revision ${result.revision} is durable in the Markdown file.`,
      {
        ok: true,
        document_id: result.documentId,
        revision: result.revision,
        file_durable_revision: result.fileDurableRevision,
        content_hash: result.contentHash,
        flush_state: result.flushState,
      },
    )
  })

  registerModelTool(server, 'markdown_close', {
    title: 'Close Markdown lease',
    description:
      'Release only this task adapter’s lease on the opened Markdown document.',
    inputSchema: {
      document_id: documentIdSchema(),
      expected_revision: revisionSchema(),
      idempotency_key: z.string().regex(IDEMPOTENCY),
    },
    outputSchema: {
      ok: z.literal(true),
      document_id: documentIdSchema(),
      revision: revisionSchema(),
      released: z.boolean(),
      remaining_adapter_leases: z.number().int(),
      remaining_ui_sessions: z.number().int(),
      eviction_scheduled: z.boolean(),
    },
    annotations: MUTATE_ANNOTATIONS,
  }, async (input) => {
    const result = await broker.rpc('public', 'document.close', {
      documentId: input.document_id,
      expectedRevision: input.expected_revision,
      idempotencyKey: input.idempotency_key,
    })
    return success(
      result.released ? 'Released this task’s document lease.' : 'The lease was already released.',
      {
        ok: true,
        document_id: result.documentId,
        revision: result.revision,
        released: result.released,
        remaining_adapter_leases: result.remainingAdapterLeases,
        remaining_ui_sessions: result.remainingUiSessions,
        eviction_scheduled: result.evictionScheduled,
      },
    )
  })

  registerAppTool(server, 'markdown_render', {
    title: 'Open collaborative Markdown editor',
    description:
      'Open an existing workspace Markdown document in the Codex right-panel editor.',
    inputSchema: z.object({
      document_id: documentIdSchema().optional(),
      workspace_root: rootSchema().optional(),
      path: relativePathSchema().optional(),
    }).strict(),
    outputSchema: resultSchema({
      ok: z.literal(true),
      state: z.enum(['ready', 'authorization_required']),
      document_id: documentIdSchema().optional(),
      revision: revisionSchema().optional(),
      generation: z.string().regex(UUID),
      document_epoch: z.string().regex(UUID).optional(),
    }),
    annotations: READ_ANNOTATIONS,
    _meta: {
      ui: {
        resourceUri: RESOURCE_URI,
        visibility: ['app', 'model'],
      },
      'openai/ui': { entrypoints: [{ type: 'thread' }] },
    },
  }, safeHandler(async (input) => {
    validateRenderSelector(input)
    let document
    if (input.document_id) {
      const status = await broker.rpc('public', 'document.status', {
        documentId: input.document_id,
      })
      document = {
        documentId: status.documentId,
        revision: status.revision,
        generation: status.generation,
        documentEpoch: status.documentEpoch,
      }
    } else {
      try {
        document = await broker.rpc('public', 'document.open', {
          workspaceRoot: input.workspace_root,
          path: input.path,
        })
      } catch (error) {
        if (error?.code !== 'WORKSPACE_AUTHORIZATION_REQUIRED') throw error
        const proposal = await broker.rpc('app', 'workspace.propose', {
          workspaceRoot: input.workspace_root,
        })
        const authorizationSessionId = crypto.randomUUID()
        const sessionCapability = crypto.randomBytes(32).toString('base64url')
        authorizationSessions.set(authorizationSessionId, {
          sessionCapability,
          proposal,
          workspaceRoot: input.workspace_root,
          path: input.path,
          expiresAt: Date.now() + 5 * 60_000,
        })
        const descriptor = await broker.ensure()
        return success(
          'Workspace approval is required in the editor before this file can be opened.',
          {
            ok: true,
            state: 'authorization_required',
            generation: descriptor.generation,
          },
          {
            [UI_META_KEY]: {
              kind: 'authorization',
              authorization_session_id: authorizationSessionId,
              session_capability: sessionCapability,
              workspace_root: input.workspace_root,
              path: input.path,
            },
          },
        )
      }
    }
    const bootstrap = await broker.rpc('app', 'document.createUiSession', {
      documentId: document.documentId,
    })
    return readyRender(document, bootstrap)
  }))

  registerAppOnlyTool(server, 'markdown_ui_authorize_workspace', {
    title: 'Authorize collaborative Markdown workspace',
    description: 'App-only user-gesture path for approving one exact workspace root.',
    inputSchema: {
      authorization_session_id: z.string().regex(UUID),
      session_capability: z.string().regex(CAPABILITY),
      workspace_root: rootSchema(),
      path: relativePathSchema(),
      confirmed: z.literal(true),
    },
    outputSchema: {
      ok: z.literal(true),
      state: z.literal('ready'),
      document_id: documentIdSchema(),
      revision: revisionSchema(),
      generation: z.string().regex(UUID),
      document_epoch: z.string().regex(UUID),
    },
    annotations: MUTATE_ANNOTATIONS,
  }, async (input) => {
    pruneAuthorizationSessions(authorizationSessions)
    const session = authorizationSessions.get(input.authorization_session_id)
    if (
      !session ||
      !safeEqual(session.sessionCapability, input.session_capability) ||
      session.workspaceRoot !== input.workspace_root ||
      session.path !== input.path
    ) {
      throw new BrokerError(
        'PERMISSION_DENIED',
        'The workspace authorization session is invalid or expired.',
      )
    }
    authorizationSessions.delete(input.authorization_session_id)
    await broker.rpc('app', 'workspace.authorize', {
      proposalId: session.proposal.proposalId,
      confirmationToken: session.proposal.confirmationToken,
      workspaceRoot: input.workspace_root,
      confirmed: true,
    })
    const document = await broker.rpc('public', 'document.open', {
      workspaceRoot: input.workspace_root,
      path: input.path,
    })
    const bootstrap = await broker.rpc('app', 'document.createUiSession', {
      documentId: document.documentId,
    })
    return readyRender(document, bootstrap)
  })

  registerAppOnlyTool(server, 'markdown_ui_sync_push', {
    title: 'Push collaborative Markdown update',
    description: 'App-only batched Yjs update transport.',
    inputSchema: uiSessionShape({
      client_sequence: revisionSchema(),
      update_base64: z.string().min(1).max(768 * 1024),
      update_sha256: z.string().regex(HASH),
    }),
    outputSchema: {
      ok: z.literal(true),
      revision: revisionSchema(),
      accepted_sequence: revisionSchema(),
      durability: z.literal('recovery_log').optional(),
      flush_state: flushStateSchema(),
      file_durable_revision: revisionSchema(),
    },
    annotations: MUTATE_ANNOTATIONS,
  }, async (input) => {
    const result = await broker.rpc('app', 'document.uiPush', uiParams(input, {
      clientSequence: input.client_sequence,
      updateBase64: input.update_base64,
      updateSha256: input.update_sha256,
    }))
    return success('Accepted a batched editor update.', {
      ok: true,
      revision: result.revision,
      accepted_sequence: result.acceptedSequence,
      ...(result.durability ? { durability: result.durability } : {}),
      flush_state: result.flushState,
      file_durable_revision: result.fileDurableRevision,
    })
  })

  registerAppOnlyTool(server, 'markdown_ui_sync_pull', {
    title: 'Pull collaborative Markdown update',
    description: 'App-only bounded long-poll for a Yjs state-vector diff.',
    inputSchema: uiSessionShape({
      after_revision: revisionSchema(),
      state_vector_base64: z.string().max(4 * 1024 * 1024),
      awareness_clock: z.number().int().min(0),
      wait_ms: z.number().int().min(0).max(20_000),
    }),
    outputSchema: {
      ok: z.literal(true),
      revision: revisionSchema(),
      update_base64: z.string(),
      update_sha256: z.string().regex(HASH),
      awareness: z.array(z.record(z.string(), z.unknown())),
      awareness_clock: z.number().int(),
      flush_state: flushStateSchema(),
      file_durable_revision: revisionSchema(),
    },
    annotations: READ_ANNOTATIONS,
  }, async (input, extra) => {
    const result = await broker.rpc('app', 'document.uiPull', uiParams(input, {
      afterRevision: input.after_revision,
      stateVectorBase64: input.state_vector_base64,
      awarenessClock: input.awareness_clock,
      waitMs: input.wait_ms,
    }), {
      timeoutMs: input.wait_ms + 2_000,
      signal: extra?.signal,
    })
    return success('Collaborative editor poll completed.', {
      ok: true,
      revision: result.revision,
      update_base64: result.updateBase64,
      update_sha256: result.updateSha256,
      awareness: result.awareness,
      awareness_clock: result.awarenessClock,
      flush_state: result.flushState,
      file_durable_revision: result.fileDurableRevision,
    })
  })

  registerAppOnlyTool(server, 'markdown_ui_awareness', {
    title: 'Update collaborative Markdown presence',
    description: 'App-only ephemeral cursor and presence update.',
    inputSchema: uiSessionShape({
      awareness_clock: z.number().int().min(1),
      awareness: z.object({
        display_name: z.string().min(1).max(80),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        selection_anchor: z.number().int().min(0).max(2_097_152),
        selection_head: z.number().int().min(0).max(2_097_152),
        origin_class: z.enum(['human', 'agent']),
      }).strict(),
    }),
    outputSchema: {
      ok: z.literal(true),
      awareness_clock: z.number().int(),
    },
    annotations: MUTATE_ANNOTATIONS,
  }, async (input) => {
    const result = await broker.rpc('app', 'document.uiAwareness', uiParams(input, {
      awarenessClock: input.awareness_clock,
      awareness: {
        displayName: input.awareness.display_name,
        color: input.awareness.color,
        selectionAnchor: input.awareness.selection_anchor,
        selectionHead: input.awareness.selection_head,
        originClass: input.awareness.origin_class,
      },
    }))
    return success('Updated editor presence.', {
      ok: true,
      awareness_clock: result.awarenessClock,
    })
  })

  registerAppOnlyTool(server, 'markdown_ui_refresh', {
    title: 'Refresh collaborative Markdown session',
    description: 'App-only capability rotation and compact state refresh.',
    inputSchema: uiSessionShape(),
    outputSchema: {
      ok: z.literal(true),
      document_id: documentIdSchema(),
      revision: revisionSchema(),
      generation: z.string().regex(UUID),
      document_epoch: z.string().regex(UUID),
    },
    annotations: READ_ANNOTATIONS,
  }, async (input) => {
    const bootstrap = await broker.rpc(
      'app',
      'document.uiRefresh',
      uiParams(input),
    )
    return success('Refreshed the editor session capability.', {
      ok: true,
      document_id: bootstrap.documentId,
      revision: bootstrap.revision,
      generation: bootstrap.generation,
      document_epoch: bootstrap.documentEpoch,
    }, { [UI_META_KEY]: { kind: 'ready', ...snakeBootstrap(bootstrap) } })
  })

  registerAppResource(
    server,
    'Collaborative Markdown Editor v1',
    RESOURCE_URI,
    {
      title: 'Collaborative Markdown Editor',
      description: 'Right-panel workspace Markdown editor.',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
        },
      },
    },
    async () => ({
      contents: [{
        uri: RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await fs.readFile(
          path.join(ROOT_DIR, 'resource-v1.html'),
          'utf8',
        ),
        _meta: {
          ui: {
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
        },
      }],
    }),
  )

  return { server, broker, authorizationSessions }
}

function registerModelTool(server, name, config, handler) {
  registerAppTool(server, name, {
    ...config,
    inputSchema: z.object(config.inputSchema).strict(),
    outputSchema: resultSchema(config.outputSchema),
    _meta: { ui: { visibility: ['model'] } },
  }, safeHandler(handler))
}

function registerAppOnlyTool(server, name, config, handler) {
  registerAppTool(server, name, {
    ...config,
    inputSchema: z.object(config.inputSchema).strict(),
    outputSchema: resultSchema(config.outputSchema),
    _meta: { ui: { visibility: ['app'] } },
  }, safeHandler(handler))
}

function safeHandler(handler) {
  return async (input, extra) => {
    try {
      return await handler(input, extra)
    } catch (error) {
      const safe = toSafeError(error)
      if (safe.code === 'INTERNAL') {
        safe.details = { correlationId: crypto.randomUUID() }
      }
      return {
        isError: true,
        content: [{ type: 'text', text: safe.message }],
        structuredContent: { ok: false, error: safe },
      }
    }
  }
}

function success(summary, structuredContent, meta) {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent,
    ...(meta ? { _meta: meta } : {}),
  }
}

function resultSchema(successShape) {
  const optionalSuccess = Object.fromEntries(
    Object.entries(successShape)
      .filter(([key]) => key !== 'ok')
      .map(([key, schema]) => [key, schema.optional()]),
  )
  return z.object({
    ok: z.boolean(),
    ...optionalSuccess,
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.unknown()),
    }).strict().optional(),
  }).strict()
}

function readyRender(document, bootstrap) {
  return success(
    `Opened ${document.path ?? 'the Markdown document'} in the collaborative editor at revision ${document.revision}.`,
    {
      ok: true,
      state: 'ready',
      document_id: document.documentId,
      revision: document.revision,
      generation: document.generation,
      document_epoch: document.documentEpoch,
    },
    { [UI_META_KEY]: { kind: 'ready', ...snakeBootstrap(bootstrap) } },
  )
}

function snakeBootstrap(value) {
  return {
    document_id: value.documentId,
    generation: value.generation,
    document_epoch: value.documentEpoch,
    ui_session_id: value.uiSessionId,
    session_capability: value.sessionCapability,
    revision: value.revision,
    snapshot_base64: value.snapshotBase64,
    snapshot_sha256: value.snapshotSha256,
    state_vector_base64: value.stateVectorBase64,
    flush_state: value.flushState,
    file_durable_revision: value.fileDurableRevision,
  }
}

function uiParams(input, extra = {}) {
  return {
    documentId: input.document_id,
    generation: input.generation,
    documentEpoch: input.document_epoch,
    uiSessionId: input.ui_session_id,
    sessionCapability: input.session_capability,
    ...extra,
  }
}

function uiSessionShape(extra = {}) {
  return {
    document_id: documentIdSchema(),
    generation: z.string().regex(UUID),
    document_epoch: z.string().regex(UUID),
    ui_session_id: z.string().regex(UUID),
    session_capability: z.string().regex(CAPABILITY),
    ...extra,
  }
}

function documentResultSchema() {
  return { ok: z.literal(true), document: z.object(documentShape()) }
}

function documentShape() {
  return {
    document_id: documentIdSchema(),
    workspace_root: rootSchema(),
    path: relativePathSchema(),
    revision: revisionSchema(),
    generation: z.string().regex(UUID),
    document_epoch: z.string().regex(UUID),
    byte_length: z.number().int(),
    utf16_length: z.number().int(),
    encoding: z.literal('utf-8'),
    bom: z.boolean(),
    line_endings: z.enum(['lf', 'crlf']),
    final_newline: z.boolean(),
    mode: z.number().int().nullable(),
    flush_state: flushStateSchema(),
    file_durable_revision: revisionSchema(),
  }
}

function statusResultSchema() {
  return {
    ok: z.literal(true),
    document_id: documentIdSchema(),
    revision: revisionSchema(),
    generation: z.string().regex(UUID),
    document_epoch: z.string().regex(UUID),
    flush_state: flushStateSchema(),
    file_durable_revision: revisionSchema(),
    ui_sessions: z.number().int(),
    adapter_leases: z.number().int(),
    read_only: z.boolean(),
    external_state: z.enum([
      'clean',
      'changed',
      'deleted',
      'renamed',
      'conflict',
    ]),
    conflict_id: z.string().regex(UUID).nullable(),
  }
}

function snakeDocument(value) {
  return {
    document_id: value.documentId,
    workspace_root: value.workspaceRoot,
    path: value.path,
    revision: value.revision,
    generation: value.generation,
    document_epoch: value.documentEpoch,
    byte_length: value.byteLength,
    utf16_length: value.utf16Length,
    encoding: value.encoding,
    bom: value.bom,
    line_endings: value.lineEndings,
    final_newline: value.finalNewline,
    mode: value.mode,
    flush_state: value.flushState,
    file_durable_revision: value.fileDurableRevision,
  }
}

function snakeStatus(value) {
  return {
    document_id: value.documentId,
    revision: value.revision,
    generation: value.generation,
    document_epoch: value.documentEpoch,
    flush_state: value.flushState,
    file_durable_revision: value.fileDurableRevision,
    ui_sessions: value.uiSessions,
    adapter_leases: value.adapterLeases,
    read_only: value.readOnly,
    external_state: value.externalState,
    conflict_id: value.conflictId,
  }
}

function validateRenderSelector(input) {
  const byId = input.document_id !== undefined
  const byPath =
    input.workspace_root !== undefined || input.path !== undefined
  if (
    (byId && byPath) ||
    (!byId && !byPath) ||
    (byPath &&
      (input.workspace_root === undefined || input.path === undefined))
  ) {
    throw new BrokerError(
      'INVALID_ARGUMENT',
      'Select exactly one document_id or one workspace_root plus path.',
    )
  }
}

function pruneAuthorizationSessions(sessions) {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id)
  }
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function rootSchema() {
  return z.string().min(1).max(4_096)
}

function relativePathSchema() {
  return z.string().min(1).max(1_024)
}

function documentIdSchema() {
  return z.string().regex(DOCUMENT_ID)
}

function revisionSchema() {
  return z.string().regex(REVISION)
}

function flushStateSchema() {
  return z.enum([
    'file_durable',
    'recovery_log_durable',
    'flushing',
    'conflict',
    'read_only',
    'recovery_required',
  ])
}
