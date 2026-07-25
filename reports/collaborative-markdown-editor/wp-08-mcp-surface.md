# WP-08 — MCP document tools and UI resource

Status: implementation and equivalent protocol-harness verification complete
on 2026-07-24; exact Codex Desktop acceptance remains open until the production
WP-09 UI and WP-10 staged plugin exist.

## Registered contract

`linux-features/collaborative-markdown-editor/mcp/main.mjs` starts the official
MCP SDK over stdio with stable identity
`collaborative-markdown-editor@0.1.0`. The server instructions tell agents to
read revisions, use unique idempotency keys, retry stale edits only after a new
read, and invoke render only for the requested right-panel experience.

Model-visible tools:

| Tool | Purpose |
| --- | --- |
| `markdown_open` | attach to an approved existing file without returning text |
| `markdown_create` | exclusively create a new Markdown file |
| `markdown_read` | read at most 65,536 UTF-16 code units |
| `markdown_apply_edits` | apply 1–256 edits to one exact revision |
| `markdown_status` | read redacted connection/durability/conflict state |
| `markdown_flush` | wait for an exact file-durability barrier |
| `markdown_close` | release only the calling adapter lease |
| `markdown_render` | attach the versioned MCP App resource |

App-only tools:

| Tool | Purpose |
| --- | --- |
| `markdown_ui_authorize_workspace` | consume one user-gesture authorization session |
| `markdown_ui_sync_push` | apply one bounded, hashed, sequence-idempotent Yjs batch |
| `markdown_ui_sync_pull` | long-poll for a state-vector diff and awareness |
| `markdown_ui_awareness` | update bounded ephemeral presence |
| `markdown_ui_refresh` | rotate a scoped capability and return a compact bootstrap |

Every schema is closed-world. Every output schema accepts the shared structured
error envelope while retaining the exact documented success fields. Read,
non-destructive mutation, and destructive text-edit annotations match the
frozen WP-04 contract. Data tools have no resource URI; only render attaches
`ui://collaborative-markdown-editor/v1/index.html`. App-only tools declare
`visibility: ["app"]`.

## Authorization and secret isolation

An unapproved render call asks the broker for a short-lived canonical-root
proposal, then stores that proposal behind a second adapter-local 256-bit
authorization session. Only hidden `_meta.collaborativeMarkdownEditor`
contains the session ID/capability. The app-only authorization call must repeat
the exact root/path and `confirmed: true`. Public tools cannot invoke the
approval transition.

Ready render metadata contains one document/epoch-scoped UI capability,
snapshot, state vector, and generation. None appear in model-visible content
or structured status. Capabilities expire after 60 seconds of inactivity,
rotate on refresh, and fail closed on generation, epoch, session, or
capability mismatch.

## Revision and retry behavior

Agent edits are serialized in the broker and recheck `expected_revision`
inside that serialization boundary. Concurrent callers using the same
revision therefore produce one accepted mutation and one `STALE_REVISION`.
All model-visible mutations require 16–128 printable-ASCII idempotency keys.
Accepted document receipts and create receipts are retained for 24 hours
(bounded to 4,096 entries) and survive broker restart; exact replay returns
the prior result and changed-input reuse returns `IDEMPOTENCY_REUSE`.

UI pushes use a per-session decimal client sequence plus decoded-update hash.
The latest 256 sequence results are retained. Exact replay is a no-op; changed
bytes under an old sequence are rejected. State-vector pulls wait at most 20
seconds, allow only one outstanding poll per UI session, and remove the broker
waiter when the MCP caller cancels.

## Verification

The full feature suite passed under Node.js 20.19.0:

```text
TypeScript typecheck: passed
Glyphdown/editor test files: 18 passed
Glyphdown/editor tests: 402 passed
Feature/lifecycle tests: 4 passed
Broker/file tests: 26 passed
MCP protocol tests: 2 passed
```

The in-memory official-SDK client/server harness:

- listed all 13 tools with closed input/output schemas and correct annotations;
- listed and read the exact MCP Apps MIME type and deny-by-default CSP;
- exercised authorization-required render, invalid capability, successful
  approval, ready render, open, create, read, edit, status, flush, close,
  UI push/pull, awareness, and capability refresh;
- verified no full text on open and no capability in model-visible results;
- verified traversal and unapproved-root rejection;
- verified strict-schema invalid input;
- verified exact edit/create retry replay across broker state, changed-input
  idempotency rejection, concurrent stale fencing, and old-capability and
  stale-generation rejection;
- cancelled a 20-second long poll and then completed a bounded 25 ms timeout;
  and
- read the versioned resource through MCP.

A separate `StdioClientTransport` test launched the actual `mcp/main.mjs`
process, listed all 13 tools, read the resource, closed the transport, and
verified the child process exited. The broker descriptor and detached broker
were removed after each harness run.

## Dependency finding

The current official releases are `@modelcontextprotocol/sdk@1.29.0`,
`@modelcontextprotocol/ext-apps@1.7.5`, and `zod@4.4.3`, matching the versions
used by the successful WP-02/WP-03 host probes. `npm audit --omit=dev` reports
the already-recorded moderate `@hono/node-server <2.0.5` Windows
`serve-static` traversal advisory through the SDK, with no available fix.
This server uses stdio and imports no Hono or static-file server. WP-10 must
bundle only the reachable stdio graph and prove the vulnerable package/code is
absent from the staged runtime before release; a source-tree audit result is
not being mislabeled as zero vulnerabilities.

## Remaining acceptance

WP-02 and WP-03 already prove that this exact Codex Desktop host starts an
installed stdio plugin, reads a versioned resource, invokes app-only bridge
tools, and maps an app `fullscreen` request to the desired right-side tab.
They do not prove this new production server binary. The WP-08 parent remains
open until WP-09 replaces the protocol shell with the production CodeMirror
client, WP-10 stages the installable plugin, and the exact side-by-side Codex
app invokes every applicable production path through the private Xvfb
harness. This is one named acceptance gate, not an implementation gap.
