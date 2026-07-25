# WP-11 collaboration hardening

Date: 2026-07-24

Status: implementation and deterministic concurrency acceptance complete; the
exact Codex Desktop multi-task demonstration remains gated on the side-by-side
development rebuild.

## Agent workflow contract

The packaged companion skill tells agents to:

1. open or render only an explicit project/worktree-relative Markdown path;
2. let the human approve a new workspace root in the rendered app;
3. read the current revision before editing;
4. submit one bounded semantic patch with a unique idempotency key;
5. re-read and deliberately rebase after a stale-revision response; and
6. use the durability barrier when the user needs file-level confirmation.

Ordinary filesystem tools remain supported. The instructions explicitly tell
agents that an external write is imported by the watcher or preserved as a
visible conflict, and forbid bypassing authorization or a read-only/conflict
state.

V1 intentionally does not expose a multi-call incremental agent edit session.
Each `markdown_apply_edits` call is one atomic Yjs transaction. This gives
retries, cancellation, interrupted turns, and process exits an unambiguous
boundary: the transaction is either rejected before mutation or accepted with
an idempotency receipt. Streaming generation can be added later as a distinct
protocol only if it can preserve those guarantees.

## Private stable attribution

The MCP SDK exposes optional request metadata at:

```text
io.modelcontextprotocol/related-task.taskId
```

When present, the adapter converts that opaque host task identifier into a
plugin-scoped SHA-256 identity and records:

```json
{
  "identitySource": "host-related-task",
  "identityHash": "sha256:<64 lowercase hex characters>",
  "displayName": "Codex task"
}
```

The raw task identifier is never sent to the UI or persisted. When the host
does not provide related-task metadata, the same construction hashes the
MCP adapter's random lifetime identity and records `mcp-adapter` / `Codex
agent`. The broker validates this closed shape before mutation. Recovery-log
records retain the attribution next to the accepted Yjs update, and live
awareness uses only the non-sensitive display name.

The official SDK protocol test supplies a private task ID, verifies the
persisted source and hash, proves the raw ID is absent, and also exercises the
fallback path.

## Deterministic collaboration evidence

`server/test/collaboration.test.mjs` adds three end-to-end broker cases:

- **Two UI clients:** two independent client `Y.Doc`s start from the same
  snapshot, make concurrent edits, push them under separate UI sessions, pull
  missing state-vector updates, and converge byte-for-byte with the one
  broker-owned `Y.Text`. Both awareness records are visible.
- **Two agent tasks:** both submit against revision zero; exactly one wins and
  one receives `STALE_REVISION`. The losing task re-reads and rebases. An
  idempotent retry does not duplicate text, a rejected stale patch changes no
  bytes, and releasing one agent adapter preserves the other agent's view.
- **Human + agent + external editor:** a UI Yjs update, a revision-aware agent
  patch, and a disjoint ordinary file write merge into one three-edit document,
  which is then flushed and compared byte-for-byte with the project file.

Existing retained cases complete the failure matrix:

- MCP cancellation aborts a long poll without mutation.
- Idempotency receipts survive broker restart.
- UI client sequences reject changed-byte reuse and replay accepted bytes once.
- Stdio close and signal shutdown release adapters; a multi-process test proves
  one agent exit cannot stop another and the last exit checkpoints and stops
  the broker.
- Persistence fault tests kill the process before rename, after rename, and
  after checkpoint without duplicate, missing, or partial text.
- Ambiguous overlapping external rewrites preserve current, baseline, and
  external candidates in a read-only conflict.

## Automated evidence

Environment: Node.js 20.19.0.

- Strict typecheck: passed.
- Editor/component suite: 411 tests passed.
- Feature/stage/cleanup suite: 5 tests passed.
- Broker/file/concurrency/security/platform suite: 38 tests passed.
- Official SDK source and self-contained staged-plugin suite: 3 tests passed.
- Full `npm test`: passed.
- `git diff --check`: passed.

The rebuilt production artifacts are:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `dist/mcp/mcp-app.html` | 3,796,652 | `2eb7ae24ce1ace9451e8a76b7d18c9ebe3c784a8b28f8d2e22d6c716bed95819` |
| `dist/plugin/server.mjs` | 373,094 | `cdf11a08d485bf8581077a91a8b25aa7858ef0aea2de8ef790f2540c589b8b08` |
| `dist/plugin/broker.mjs` | 158,589 | `511717eff9d44dcaf8e0c0c3ba3868e090547913c7b2e52e27cb0ded27fb2ce1` |

## Remaining acceptance gate

The WP-11 parent remains open until the exact side-by-side development app
demonstrates two rendered UI instances and two Codex tasks against the staged
production plugin. That retained actual-app run must show convergence and
attributed agent presence on private Xvfb. The automated concurrency contract
is complete.
