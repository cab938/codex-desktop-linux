# WP-06 — Workspace-scoped local document broker

Status: complete on 2026-07-24.

## Implemented boundary

The feature now has a pure Node.js 20+ ESM broker core under
`linux-features/collaborative-markdown-editor/server/`.

- `workspace-registry.mjs` implements a persisted user-approval registry. An
  app-only proposal returns a short-lived 256-bit confirmation capability; the
  exact canonical root and explicit `confirmed: true` are required to consume
  it. Public document calls can require an approval but cannot create one.
- `workspace.mjs` canonicalizes roots, rejects root or path-component
  symlinks, accepts only root-relative `.md`/`.markdown` paths, proves
  containment, requires a regular file, and validates the 2 MiB UTF-8 and
  consistent LF/CRLF contract.
- `document-registry.mjs` owns exactly one `Y.Doc`, `Y.Text`, awareness
  instance, generation, document epoch, unsigned 64-bit revision sequence,
  flush state, adapter lease set, and lock for each open canonical document.
  It serializes mutations and rejects an expected revision again inside that
  serialization boundary, so two concurrent writes cannot both consume one
  revision.
- `state-store.mjs` initializes a document from its Markdown file once, then
  reopens from its Yjs snapshot plus contiguous checksum-validated update log.
  It synchronizes an accepted update before acknowledging it, compacts by
  record/byte thresholds and on close, rejects newer schemas, and quarantines
  an incomplete final log record.
- `lock.mjs` uses an atomic private directory plus PID/token owner record. A
  live owner fences a second writer. A dead or incomplete owner is recovered
  without stealing from a live process.
- `broker-service.mjs`, `broker-main.mjs`, and `broker-client.mjs` provide one
  attachable per-user loopback HTTP authority. The mode-0600 descriptor
  contains a 256-bit bearer; every route including health requires it. The
  service binds only `127.0.0.1`, enforces a 1 MiB request limit, hard-separates
  public/app/admin dispatch tables, and removes its descriptor and locks on
  graceful shutdown.

No endpoint, bearer, authorization capability, or Yjs update appears in
redacted document status. The stable state root follows platform conventions
and supports the explicit
`CODEX_COLLABORATIVE_MARKDOWN_STATE_ROOT` test override; it does not assume
host-injected `PLUGIN_DATA`.

## Durability boundary

WP-06 guarantees `recovery_log` durability: a successful mutation response
means its contiguous revision and Yjs update were appended and synchronized.
The Markdown file itself is intentionally unchanged in this package.
Crash-safe file replacement, flush barriers, watcher import, and conflicts are
WP-07. Public MCP idempotency caches and scoped UI session capabilities are
WP-08; this broker supplies their underlying authority.

## Verification

The complete feature suite passed on both Node.js 24.15.0 and the minimum
supported Node.js 20.19.0:

```text
TypeScript typecheck: passed
Glyphdown/editor test files: 18 passed
Glyphdown/editor tests: 402 passed
Feature/lifecycle tests: 4 passed
Broker tests: 9 passed
```

The broker tests prove:

1. two clients launched concurrently attach to the same detached broker PID
   and generation;
2. both adapters attach to one document and observe the same accepted edit;
3. a public caller cannot invoke the app-only workspace proposal method and an
   unauthenticated loopback request receives HTTP 401;
4. the descriptor is mode 0600 and status does not expose its bearer;
5. a competing document registry cannot take a live writer's lock;
6. dead and incomplete locks recover, while live locks remain fenced;
7. simultaneous edits with the same expected revision yield one accepted
   revision and one `STALE_REVISION`;
8. snapshot/log restart recovery reproduces the text once, compaction does not
   duplicate it, and an incomplete tail is quarantined;
9. a newer state schema fails closed;
10. expired adapter leases permit checkpointed idle eviction;
11. canonical roots for separate worktrees produce distinct document IDs; and
12. traversal, encoded traversal, symlink, invalid UTF-8, mixed-EOL, unexpected
    Yjs shared-type, and bounded-input checks reject unsafe input.

The process integration test also waits for graceful shutdown and verifies the
descriptor is removed. A post-suite process check found no surviving broker.
The stock/default Codex app was not built, modified, installed, or launched.
