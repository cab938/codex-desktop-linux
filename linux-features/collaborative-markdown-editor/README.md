# Collaborative Markdown Editor

This disabled-by-default Linux feature is the repository integration boundary
for a Codex Desktop plugin that lets a person and Codex agents edit the same
workspace Markdown file through a shared Yjs document.

The Codex host and transport gates have passed. The current implementation
contains the pinned, audited Glyphdown editor/core extraction and an
independently buildable one-Y.Text editor preview. It also contains the
workspace authorization, document registry, recovery state, and attachable
per-user broker core. It deliberately has no ASAR patch, install resource,
runtime hook, package hook, or production MCP adapter yet; those arrive after
the MCP/App surfaces pass their work packages.

## Scope

The v1 contract:

- binds only UTF-8 Markdown files inside authorized project or worktree roots;
- keeps the Markdown file as the durable, interoperable document;
- renders a CodeMirror/Glyphdown editor as an MCP App;
- uses a local broker-owned `Y.Doc` for UI and agent mutations; and
- remains optional and removable without deleting project Markdown.

Cloud collaboration, accounts, a generic filesystem server, Tandem code reuse,
and modification of the stock Codex installation are outside this feature's
scope.

## Editor source boundary

`web/vendor/glyphdown/` contains only the selected MIT-licensed editor and
merge sources. `UPSTREAM.md` records the exact commit, pristine hashes, local
patches, excluded product code, and update procedure.

`web/src/editor.ts` is the application-owned composition layer. It binds one
CodeMirror view to one caller-owned `Y.Text`, uses Yjs undo, and switches
between live preview and raw Markdown without constructing a second document
model. Remote images are inert by default, and no wiki, hosted collaboration,
annotation, suggestion, auth, analytics, database, CLI, or Cloudflare provider
code is included.

## Broker boundary

`server/` is a pure Node.js 20+ ESM implementation. One detached loopback
broker owns each open document's `Y.Doc`, awareness state, revision sequence,
recovery log, and document lock. Independent adapter processes discover it
through a mode-0600 descriptor and authenticate with its private bearer.
Iframe code never receives that endpoint or bearer.

Workspace roots are persisted only after an app-only proposal and explicit
confirmation exchange. Model-facing document calls cannot approve a root.
Every Markdown path is root-relative and is checked for canonical containment,
symlinks, regular-file type, UTF-8 encoding, line endings, and the v1 size
bound. Separate canonical worktrees produce separate document identities.

Accepted Yjs changes are synchronized to a checksum-bearing recovery log before
acknowledgement. A 150 ms debounce and explicit barrier then use a
same-directory exclusive temporary file, file synchronization, atomic rename,
and directory synchronization to make the ordinary Markdown file durable.
UTF-8 BOM, LF/CRLF style, final-newline content, and POSIX mode are retained.

A directory watcher handles editor safe-writes and Git-style replacement.
Exact external edits become one attributed Yjs revision; disjoint in-memory
and external edits merge through the pinned Glyphdown diff primitive.
Ambiguous rewrites, invalid files, delete, rename-away, and unsupported target
changes become read-only conflicts with current, baseline, and external
candidates retained under private state. A deleted or renamed project file is
never silently recreated.

## MCP boundary

`mcp/main.mjs` is the stdio entrypoint. It registers eight model-visible
document/render tools, five app-only synchronization/authorization tools, and
the versioned `ui://collaborative-markdown-editor/v1/index.html` resource.
All input and output schemas are closed-world, tool annotations distinguish
reads from destructive text edits, and only `markdown_render` attaches the UI
resource.

Model-visible results contain bounded text or redacted status. Broker bearers,
workspace-confirmation capabilities, UI session capabilities, snapshots, and
Yjs updates stay in app-only calls or hidden tool-result metadata. Mutations
require expected revisions and printable idempotency keys. Accepted edit and
create receipts persist for 24 hours across broker restart.

The resource currently contains the protocol shell used to validate resource
registration. The production CodeMirror bridge and interaction states replace
that shell in the next work package without changing the frozen document-tool
contract.

## Lifecycle commands

The shell has dependency-free, deterministic lifecycle commands:

```bash
npm run build
npm run stage
npm test
npm run clean
```

Run `npm ci` once, then run the commands from this directory. `build` emits a
deterministic single-file editor preview plus a hash-bearing manifest under
the ignored `dist/` directory. `stage` copies those artifacts into an isolated
`dist/stage/` tree; it does not write into a generated application. `test`
typechecks the source, runs retained donor/local component tests, and validates
the disabled-default feature, deterministic lifecycle, broker security,
multi-process convergence, locking, and restart recovery. `clean` removes only
this feature's `dist/`. The server suite also fault-tests atomic persistence
with real child-process exits before and after replacement.

The eventual production build and declarative staging contract will replace
the preview artifact after the broker and MCP App are implemented.

## Local enablement

Do not commit enablement. When the feature has runtime behavior to exercise,
add its ID only to the ignored `linux-features/features.json`:

```json
{
  "enabled": [
    "collaborative-markdown-editor"
  ]
}
```

The committed `linux-features/features.example.json` must remain empty.

## Current risks and gates

- The production MCP schemas and user-only workspace authorization flow need
  their final CodeMirror application and exact-app acceptance run.
- Linux filesystem behavior is verified; macOS and Windows remain candidates
  until their atomic-replace, watcher, and host-runtime matrices pass.

The durable requirements and acceptance matrix live in
`.codex/work-packages.md`.
