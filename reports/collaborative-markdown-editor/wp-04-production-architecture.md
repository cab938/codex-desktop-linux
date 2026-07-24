# WP-04 production architecture freeze

Date: 2026-07-24

Status: accepted for implementation

This document resolves the production decisions left by the WP-02 host probe
and WP-03 transport spike. The implementation may refine internal types, but a
change to a trust boundary, persistence guarantee, protocol field, or v1 limit
requires updating this decision and the work-package contract.

## ADR-01: product and component boundary

The deliverable is a Codex **plugin** whose user-facing component is an MCP
App. The Linux repository feature stages that plugin into the side-by-side
development app; it is not a Linux-only renderer or an ASAR patch.

The editor uses the pinned Glyphdown source extraction defined in
`wp-04-glyphdown-audit.md`. CodeMirror remains a view over one client `Y.Doc`
and one `Y.Text("content")`. `y-codemirror.next` is the only CodeMirror
document synchronization and undo binding. CodeMirror `history()` and a second
rich-document model are prohibited.

The feature owns the provider, broker, file codec, persistence, MCP schemas,
authorization, and lifecycle. No Glyphdown hosted-server, auth, cloud, CLI,
analytics, or deployment code is used.

## ADR-02: explicit workspace authorization

WP-02 proved that the MCP subprocess receives no active task cwd, Local versus
Worktree identity, or authorized workspace roots. A model-supplied
`workspace_root` is context, not authority.

V1 therefore has a user-approved workspace registry:

1. `markdown_render` may propose an absolute workspace root and relative
   Markdown path.
2. If the canonical root is not approved, the MCP App displays that exact root
   and requires a user click.
3. The click calls app-only `markdown_ui_authorize_workspace` with a
   render-session capability delivered only in hidden tool metadata.
4. The broker canonicalizes the root, records the approval in plugin-private
   state, and opens only paths contained by an approved root.
5. Agent-facing tools may name a root, but cannot add or broaden an approval.
6. The UI can revoke a root. Revocation makes its documents read-only, flushes
   accepted state, closes sessions, and releases locks; it never deletes
   project files.

Approval is per canonical worktree root. A parent directory does not imply
approval of arbitrary sibling roots. The registry is local user state, not a
project file an agent can create.

## ADR-03: one attachable per-user broker

Every Codex stdio MCP process is a thin adapter. All adapters attach to one
per-user broker for the feature and protocol major version. The first adapter
starts it; later adapters never create an independent registry.

The broker:

- is a pure Node ESM process with no native add-ons;
- binds an ephemeral loopback HTTP port for adapter-to-broker RPC only;
- stores the port, generation, PID, protocol version, and a 256-bit adapter
  bearer in a user-private descriptor written with mode `0600` where POSIX
  modes exist and user-only ACL expectations on Windows;
- never places the bearer in argv, model-visible MCP content, UI metadata, or
  normal logs;
- uses an atomic, stable-root startup lock so plugin versions and Codex homes
  cannot start parallel brokers;
- uses a stable per-document lock keyed by canonical identity;
- attaches to a compatible owner or returns `BROKER_INCOMPATIBLE`/`LOCKED`
  rather than starting a second writer; and
- treats an owner as stale only after both endpoint liveness and process
  liveness fail. It never steals a lock merely because a heartbeat is late.

Each adapter registers a lease and heartbeat. UI sessions are renewed by their
long poll. When there are no adapter leases, UI sessions, dirty documents, or
pending flushes, the broker performs a durable checkpoint and exits after a
60-second idle grace. Shutdown fences clients by generation, cancels polls,
flushes or retains recovery-log durability, closes the listener, and releases
locks. An incompatible update must stop or attach to the old broker; it cannot
run beside it.

This topology guarantees one in-memory write authority for a canonical path
across tasks, windows, plugin-cache versions, and multiple Codex homes under
the same OS user.

## ADR-04: host-authenticated bridge transport

The iframe does not connect to loopback. WP-03 showed that a narrowly declared
`ws://127.0.0.1` endpoint was blocked before broker ingress. V1 uses app-only
MCP tools over the host bridge:

- `markdown_ui_sync_push` sends one merged Yjs update after 75 ms or 256 KiB,
  whichever comes first;
- `markdown_ui_sync_pull` long-polls for up to 20 seconds and returns a Yjs
  diff against the supplied state vector plus current awareness;
- `markdown_ui_refresh` recovers a fenced session from a compact snapshot;
- `markdown_ui_awareness` updates ephemeral cursor/presence state; and
- `markdown_ui_authorize_workspace` is the user-gesture authorization path.

Every call includes `document_id`, broker `generation`, `document_epoch`,
`ui_session_id`, and a hidden 256-bit session capability. Pushes additionally
include a decimal `client_sequence`, decoded update bytes, and an update hash.
The broker remembers the latest 256 sequence/hash results per live UI session:
an exact retry returns the prior result and sequence reuse with different bytes
returns `IDEMPOTENCY_REUSE`.

The resource and app-only tools are invisible to the model. The session
capability is not the broker's loopback bearer and grants access to exactly one
document epoch. It expires after 60 seconds without a pull or awareness
heartbeat and is replaced on render/refresh. A generation or epoch mismatch
returns `GENERATION_STALE` or `DOCUMENT_EPOCH_STALE` and forces the UI to
destroy and rebuild its local `Y.Doc`.

Pull responses use `Y.encodeStateAsUpdate(serverDoc, clientStateVector)`, not a
full snapshot per revision. Awareness is bounded, non-persistent, and never
part of the Markdown file or recovery log. Cancellation aborts a poll without
changing session or document state. No iframe `connect-src` permission is
required.

## ADR-05: state root, identity, and persisted layout

Because WP-02 observed no `PLUGIN_DATA`, the server computes one stable,
version-independent user state root, with a test-only explicit override:

| Platform | Default |
| --- | --- |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/codex/collaborative-markdown-editor` |
| macOS | `~/Library/Application Support/Codex/collaborative-markdown-editor` |
| Windows | `%LOCALAPPDATA%\\Codex\\collaborative-markdown-editor` |

The code uses native platform APIs/environment and `os.homedir()`, not an
interactive shell. If a safe user-private root cannot be established, startup
fails closed.

Layout:

```text
state-root/
├── broker-v1/
│   ├── owner.lock/
│   └── descriptor.json
├── workspaces-v1.json
├── locks-v1/<document-id>.lock/
└── documents-v1/<document-id>/
    ├── metadata.json
    ├── snapshot.yjs
    ├── updates.log
    ├── conflict/
    └── recovery/
```

`document_id` is `doc_v1_` plus base64url SHA-256 of:

```text
platform-normalized canonical workspace root NUL
platform-normalized canonical file path
```

`realpath.native` supplies existing path casing. Windows comparison keys are
Unicode-normalized and case-folded; POSIX keys preserve case. The canonical
root remains in metadata so a hash collision is checked rather than trusted.
The same relative path in separate worktrees therefore has different IDs.

Each document also has a random `document_epoch`. It remains stable while a
compatible Yjs history is retained and changes after an intentional state
reset, incompatible migration, or sidecar cleanup. Broker `generation` changes
on every process start.

Metadata records schema version, canonical identity, epoch, file content hash,
UTF-8 BOM state, line-ending style, final-newline state, mode, last accepted
revision, last file-durable revision, snapshot/log generation, and cleanup
timestamps. It contains no document text or capability.

## ADR-06: revision, recovery log, compaction, and cleanup

Revision is a per-document unsigned 64-bit logical counter serialized as a
decimal string. Initial load is revision `"0"`. Each accepted human, agent, or
external-file transaction increments it exactly once. Transport retries,
awareness, reads, render, status, and flush do not increment it.

Before an accepted mutation is acknowledged, its Yjs update, revision,
origin class, content hash, and checksum are appended to `updates.log` and the
log is synchronized. A successful acknowledgement is therefore at least
`recovery_log` durable even when the Markdown file is in a 150 ms debounce
window. Agent callers may request `durability: "file"` to wait for the atomic
file barrier.

`snapshot.yjs`, `metadata.json`, and log replacement use write-temp,
synchronize, and atomic rename. Compaction occurs at 4,096 update records,
8 MiB of log data, explicit close, or idle checkpoint. It writes and
synchronizes a new snapshot and metadata before atomically starting a new log;
the old generation remains recoverable until the new generation validates.

On startup, a valid snapshot plus checksum-valid updates is replayed exactly
once. A file hash mismatch is treated as an external edit and imported, never
overwritten as a watcher echo. Corrupt state is quarantined. If all acknowledged
revisions are already file-durable, the broker may rebuild from the Markdown
file with a new epoch; otherwise it enters `RECOVERY_REQUIRED` and preserves
both recovery state and file.

Schema 1 migrations are copy-on-write. Older recognized schemas are migrated
into a new directory and swapped only after validation. Newer schemas return
`STATE_VERSION_UNSUPPORTED`. Closed state with no recovery-only revisions or
conflicts is eligible for cleanup after 90 days. Cleanup never deletes the
Markdown file and changes the epoch on next open.

## ADR-07: file codec and external edits

V1 accepts regular UTF-8 `.md` and `.markdown` files, optionally with a UTF-8
BOM, using consistent LF or CRLF line endings. Mixed line endings, invalid
UTF-8, directories, symlinks, device files, sockets, and files above the size
limit are rejected without mutation.

The Y.Text uses LF internally. The file codec preserves the original BOM,
consistent line-ending style, final-newline state, and permission mode. A
newly created file defaults to no BOM, LF, one final newline, and mode derived
from the process umask.

Ordinary file flush is debounced 150 ms. A flush writes a unique same-directory
temporary regular file opened exclusively, applies the supported metadata,
synchronizes it, atomically replaces the target, and synchronizes the parent
directory where supported. It never removes the target as a precondition for
rename. The watcher identifies self-writes by expected content identity and
file generation, not time alone.

An external change is diffed from the last file baseline to the observed
bytes, merged against current Y.Text with the selected Glyphdown core
primitive, and landed as one attributed transaction when every hunk applies.
Failed/ambiguous hunks or concurrent replacement/rename enter a visible
conflict state containing both candidates. The broker stops automatic writes
until the user chooses current, external, or a merged resolution. Delete and
rename never cause silent recreation.

## ADR-08: Node runtime and portability claim

The server and build output target standard Node.js 20+ ESM and contain no
native Node add-ons, shell scripts, post-install compilation, or platform-
specific filesystem library. `.mcp.json` invokes `node` directly from
`PLUGIN_ROOT`; it does not use `/usr/bin/env`, `bash`, PowerShell, or a user
shell `PATH`.

The Codex plugin host is responsible for resolving that command to its managed
runtime. The exact Linux app did so with
`resources/node-runtime/bin/node`. The same pure-JavaScript bundle is the
candidate for macOS and Windows, but WP-13 must prove that those official
desktop hosts provide the same managed command resolution and must exercise
their filesystem behavior. If either host does not, the release must narrow
support or add verified per-platform self-contained launch artifacts; it must
not silently fall back to a user's PATH.

The support statement remains **Linux verified; macOS and Windows candidate,
not yet verified** until WP-13. This is a portability decision, not a claim of
untested parity.

## ADR-09: agent-facing MCP contract

All public tools return:

```json
{
  "structuredContent": {
    "ok": true,
    "...": "tool-specific fields"
  },
  "content": [
    { "type": "text", "text": "short model-appropriate summary" }
  ]
}
```

Failures are normal MCP tool results with `isError: true` and:

```json
{
  "ok": false,
  "error": {
    "code": "STALE_REVISION",
    "message": "actionable text",
    "retryable": true,
    "details": {}
  }
}
```

No result text contains capabilities, broker endpoints, bulk Yjs bytes, or
unrequested full document text. JSON Schemas use `additionalProperties:
false`. Paths are absolute workspace roots plus root-relative POSIX-style
document paths; tool inputs never accept a second arbitrary absolute file
path.

### Public tools

| Tool | Required inputs | Success-specific result | MCP annotations |
| --- | --- | --- | --- |
| `markdown_open` | `workspace_root`, `path` | identity, canonical display path, revision, generation, epoch, encoding/EOL metadata, status | read-only, idempotent, closed-world |
| `markdown_create` | root, path, `initial_text`, `idempotency_key` | same plus file durability | mutating, non-destructive, idempotent, closed-world |
| `markdown_read` | `document_id`, `revision`, optional UTF-16 `from`/`to` | bounded text, returned range, total UTF-16 length, revision | read-only, idempotent, closed-world |
| `markdown_apply_edits` | ID, `expected_revision`, `idempotency_key`, ordered edits, optional `durability` | new revision, changed UTF-16 range, durability/flush state | mutating, destructive, idempotent, closed-world |
| `markdown_status` | ID | revision, generation, epoch, connections, durability, external/conflict/read-only state | read-only, idempotent, closed-world |
| `markdown_flush` | ID, `expected_revision`, `idempotency_key` | file-durable revision and content hash | mutating, non-destructive, idempotent, closed-world |
| `markdown_close` | ID, `expected_revision`, `idempotency_key` | lease release and remaining connections | mutating, non-destructive, idempotent, closed-world |
| `markdown_render` | root, path | attached right-panel resource or authorization-required state | read-only, idempotent, closed-world |

`markdown_apply_edits.edits` is 1–256 non-overlapping objects:

```json
{ "start": 12, "end": 18, "replacement": "text" }
```

Offsets are zero-based UTF-16 code units into the exact `expected_revision`
returned by `markdown_read`. Ranges are validated and applied from highest to
lowest offset in one Yjs transaction. Clients must read again after
`STALE_REVISION`; the server never guesses an edit's new position. Replacement
text is valid Unicode, contains no isolated surrogate, and contributes at most
512 KiB UTF-8 per call.

Every mutating public tool requires an idempotency key of 16–128 printable
ASCII characters. The broker stores key, normalized request hash, and result
for 24 hours or 4,096 entries per document. Exact replay returns the prior
result. Reuse with a different request returns `IDEMPOTENCY_REUSE`.

`markdown_read` returns at most 64 Ki UTF-16 code units per call. An omitted
range returns the entire document only when it fits. `markdown_open` never
returns file text. `markdown_render` is the only public tool with
`_meta.ui.resourceUri`; edit/read/status calls never remount the component.

### Schema vocabulary and exact field contract

The implementation schemas use these shared definitions:

| Name | JSON representation |
| --- | --- |
| `workspace_root` | absolute native path string, 1–4,096 characters |
| `path` | root-relative `/`-separated path, 1–1,024 characters, no empty, `.`, `..`, NUL, or encoded traversal segment |
| `document_id` | `^doc_v1_[A-Za-z0-9_-]{43}$` |
| `revision` / `expected_revision` | decimal string `^(0|[1-9][0-9]{0,19})$` |
| `generation` / `document_epoch` / `ui_session_id` | lowercase canonical UUID string |
| `idempotency_key` | 16–128 printable ASCII characters |
| `durability` | `"recovery_log"` or `"file"` |
| `flush_state` | `"file_durable"`, `"recovery_log_durable"`, `"flushing"`, `"conflict"`, `"read_only"`, or `"recovery_required"` |
| UTF-16 position | integer from 0 through 2,097,152, bounded again by current document length |
| content hash | lowercase `sha256:` plus 64 hexadecimal characters |

The successful `markdown_open` and `markdown_create` document object contains
exactly:

```json
{
  "document_id": "doc_v1_...",
  "workspace_root": "/canonical/root",
  "path": "notes/file.md",
  "revision": "0",
  "generation": "uuid",
  "document_epoch": "uuid",
  "byte_length": 123,
  "utf16_length": 123,
  "encoding": "utf-8",
  "bom": false,
  "line_endings": "lf",
  "final_newline": true,
  "mode": 420,
  "flush_state": "file_durable",
  "file_durable_revision": "0"
}
```

`line_endings` is `"lf"` or `"crlf"`. `mode` is an integer permission mask on
POSIX and `null` where the platform cannot provide equivalent semantics.
Canonical absolute roots appear only after authorization; failure details use
the caller's root and root-relative path without exposing other approvals.

Tool inputs and results are frozen as follows:

- `markdown_open`: `{workspace_root, path}`. It opens an existing regular
  Markdown file and returns `{ok:true, document}`.
- `markdown_create`: `{workspace_root, path, initial_text,
  idempotency_key}`. `initial_text` is a Unicode string whose UTF-8
  representation is at most 2 MiB and contains no isolated surrogate. It uses
  exclusive create and returns `{ok:true, document, durability:"file"}`.
- `markdown_read`: `{document_id, expected_revision?, from?, to?}`. `from`
  defaults to 0; `to` defaults to the lesser of document length and the read
  cap. `from` and `to` must be supplied together when either is supplied.
  A supplied stale expected revision is rejected. Result:
  `{ok:true, document_id, revision, from, to, total_utf16_length, text,
  truncated}`.
- `markdown_apply_edits`: `{document_id, expected_revision, idempotency_key,
  edits, durability?}` where durability defaults to `"recovery_log"`.
  Result: `{ok:true, document_id, previous_revision, revision, changed_from,
  changed_to, durability, flush_state, file_durable_revision}`.
- `markdown_status`: `{document_id}`. Result:
  `{ok:true, document_id, revision, generation, document_epoch, flush_state,
  file_durable_revision, ui_sessions, adapter_leases, read_only,
  external_state, conflict_id}`. `external_state` is `"clean"`, `"changed"`,
  `"deleted"`, `"renamed"`, or `"conflict"`; `conflict_id` is a UUID only in
  conflict state and otherwise `null`.
- `markdown_flush`: `{document_id, expected_revision, idempotency_key}`.
  Result: `{ok:true, document_id, revision, file_durable_revision,
  content_hash, flush_state:"file_durable"}`.
- `markdown_close`: `{document_id, expected_revision, idempotency_key}`.
  Close releases only the calling adapter lease. Result:
  `{ok:true, document_id, revision, released, remaining_adapter_leases,
  remaining_ui_sessions, eviction_scheduled}`.
- `markdown_render` accepts exactly one selector:
  `{document_id}` or `{workspace_root, path}`. Result:
  `{ok:true, state, document_id?, revision?, generation,
  document_epoch?}` where `state` is `"ready"` or
  `"authorization_required"`. Its hidden metadata contains the versioned
  resource URI and one scoped render/session bootstrap object.

`markdown_open` and `markdown_create` establish an adapter lease.
`markdown_read`, edit, status, flush, close, and render by ID require that the
calling adapter has opened the document; guessing a valid ID is insufficient.

The literal MCP annotation objects are:

```json
{
  "read": {
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "create_or_flush_or_close": {
    "readOnlyHint": false,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "apply_edits": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": true,
    "openWorldHint": false
  }
}
```

`markdown_open`, read, status, and render use `read`; create, flush, and close
use `create_or_flush_or_close`; edit uses `apply_edits`.

### App-only schema

All app-only inputs require the exact hidden `session_capability` (base64url,
43 characters), plus `document_id`, `generation`, `document_epoch`, and
`ui_session_id`. They have `visibility: ["app"]`, `openWorldHint: false`, and
no model-visible bulk result.

- `markdown_ui_sync_push` additionally requires `client_sequence` as a
  decimal string, `update_base64`, and `update_sha256`. Result:
  `{ok:true, revision, accepted_sequence, durability, flush_state,
  file_durable_revision}`.
- `markdown_ui_sync_pull` additionally requires `after_revision`,
  `state_vector_base64`, `awareness_clock`, and `wait_ms` from 0–20,000.
  Result: `{ok:true, revision, update_base64, update_sha256, awareness,
  awareness_clock, flush_state, file_durable_revision}`. A timeout is a
  successful empty update at the current revision.
- `markdown_ui_awareness` requires `awareness_clock` and a JSON awareness
  object restricted to display name, color, selection anchor/head, and origin
  class. Result: `{ok:true, awareness_clock}`.
- `markdown_ui_refresh` requires no additional fields. It invalidates the old
  session capability and returns a new hidden bootstrap with compact snapshot,
  state vector, revision, generation, epoch, and capability.
- `markdown_ui_authorize_workspace` is scoped to an authorization render
  session, takes the proposed `workspace_root` plus `confirmed:true`, consumes
  its one-use capability, and returns the canonical approved root and a fresh
  document-session bootstrap in hidden metadata.

Binary fields are canonical unpadded base64 and are rejected before allocation
when their encoded length could exceed the decoded limit. Hidden results are
still schema-validated and size-bounded.

### Stable error codes

```text
INVALID_ARGUMENT          WORKSPACE_AUTHORIZATION_REQUIRED
WORKSPACE_REVOKED         WORKSPACE_ESCAPE
SYMLINK_UNSUPPORTED       FILE_NOT_FOUND
FILE_EXISTS               FILE_TYPE_UNSUPPORTED
FILE_EXTENSION_UNSUPPORTED INVALID_UTF8
MIXED_LINE_ENDINGS        FILE_TOO_LARGE
PERMISSION_DENIED         DOCUMENT_NOT_OPEN
LOCKED                    BROKER_UNAVAILABLE
BROKER_INCOMPATIBLE       STALE_REVISION
IDEMPOTENCY_REUSE         GENERATION_STALE
DOCUMENT_EPOCH_STALE      UPDATE_TOO_LARGE
CONFLICT                  READ_ONLY
FLUSH_FAILED              RECOVERY_REQUIRED
STATE_CORRUPT             STATE_VERSION_UNSUPPORTED
CANCELLED                 TIMEOUT
INTERNAL
```

Errors include only safe details such as current revision, allowed size, or a
workspace-relative path. `INTERNAL` carries a correlation ID, not a stack or
environment dump.

## ADR-10: v1 resource limits and unsupported operations

| Boundary | V1 limit |
| --- | --- |
| File size | 2 MiB UTF-8 bytes at open and after any accepted edit |
| Encoding | UTF-8, optional BOM; consistent LF or CRLF |
| Open documents | 16 per broker |
| UI sessions | 8 per document, 32 per broker |
| Adapter leases | 32 per broker |
| Agent edits | 256 ranges and 512 KiB replacement bytes per call |
| UI update | 512 KiB decoded per push; 75 ms/256 KiB client batching |
| Read result | 64 Ki UTF-16 code units |
| Long poll | 20 seconds; one outstanding pull per UI session |
| Awareness | 8 KiB per client; 10 updates/second |
| Update log | compact at 4,096 records or 8 MiB |
| Idempotency cache | 4,096 entries/document, retained 24 hours |
| Idle shutdown | 60 seconds when fully quiescent |
| Closed-state cleanup | 90 days when no recovery/conflict state exists |

V1 does not support mixed line endings, non-UTF-8 files, symlink targets,
directories, devices, named pipes, sockets, files outside approved roots,
binary embeds, workspace image loading, arbitrary HTML rendering, remote
collaboration, cloud accounts, comments/suggestions, multi-file tabs, file
rename from the plugin, or token-by-token agent typing. Agent edits are atomic
semantic patches. External rename/delete is detected and surfaced but not
automatically reversed.

The 2 MiB limit is provisional until WP-14 measures it in the actual app. A
lower published limit requires updating this ADR with evidence; a higher limit
requires the same security and responsiveness tests.

## ADR-11: security controls and residual risk

| Threat | Control | Required verification |
| --- | --- | --- |
| Model invents a root | user-only app authorization registry | model cannot call authorization tool; revocation test |
| `..`, encoded, case, or prefix escape | decode once, reject NUL, canonicalize root/parent/target, relative containment check | traversal matrix on all claimed platforms |
| Symlink/junction race | v1 rejects symlink components; re-lstat before read and replace; verify identity after open | race/fault tests |
| Second writer process | stable startup lock, one broker registry, per-document lock, never timeout-steal live owner | multi-process tests |
| Loopback attacker | adapter endpoint loopback-only, random bearer in private descriptor, constant-time auth, size/rate limits | wrong/missing token tests |
| Stale iframe/client | generation + document epoch + scoped session capability; destroy/rebuild local Y.Doc | restart/reload tests |
| Malicious Yjs update | decoded-size cap, session/doc scope, Yjs decode exception handling, resulting file-size cap | fuzz/property tests |
| Malicious Markdown | CodeMirror source model; no raw HTML execution; remote/workspace images disabled; deny-by-default CSP | hostile Markdown actual-app test |
| Link exfiltration | links are inert source/live-preview decorations in v1; no automatic fetch/navigation | CSP and click behavior test |
| Credential leakage | hidden session metadata only; broker bearer never enters UI; redacted structured logs | log/process/screenshot inspection |
| Recovery-state disclosure | user-private state root, restrictive creation mode/ACL, hashes not plaintext names | permission tests |
| Resource exhaustion | limits above, per-session long-poll limit, update/rate bounds, idle eviction | stress tests |
| Unsafe external overwrite | content identity, minimal merge, visible conflict, no timeout echo suppression | external editor matrix |
| Partial file replacement | same-directory exclusive temp, fsync, atomic replace, recovery log | fault injection |
| Dependency compromise | frozen lock, deterministic bundle, retained licenses, audit/SBOM, no install scripts in runtime | WP-12 supply-chain review |

The MCP App resource declares a deny-by-default CSP with no `connect-src`.
Bundled code, CSS, fonts, and icons are self-contained. Inline script/style
requirements are limited to the single-file resource shape accepted by the
host; no remote domains are allowed.

Residual risks to verify rather than conceal:

- The current public host contract does not provide a cryptographic active
  workspace identity, so explicit user approval is required.
- User-private file mode does not by itself define Windows ACL behavior; WP-13
  must inspect it.
- Node's platform atomic-replace and watcher behavior differs; only claimed
  platforms may be documented as supported.
- A privileged process under the same OS account can read broker state and is
  outside the plugin's threat boundary.
- MCP App `fullscreen` maps to the desired right panel in the tested Linux
  build, but geometry on official macOS/Windows remains unverified.

## Implementation consequence

WP-05 may now import only the audited source seam. WP-06 owns the authorization
registry, broker, identity, locks, state layout, update log, and lifecycle.
WP-07 owns the file codec, atomic persistence, watcher, merge, and conflict
state. WP-08 implements the frozen public and app-only schemas. WP-09 builds
the capability-detecting right-panel MCP App. Later work packages test each
residual risk before any support claim expands.
