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
file persistence and the MCP/App surfaces pass their work packages.

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
acknowledgement. Snapshot compaction, crash-safe Markdown replacement, watcher
reconciliation, conflicts, and public/app-only MCP schemas are separate
layers completed by later work packages.

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
this feature's `dist/`.

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

- Recovery-log-durable transactions still need atomic Markdown-file durability,
  external-change import, and conflict handling.
- The production MCP schemas and user-only workspace authorization flow need
  wiring into the host-facing adapter and MCP App.
- Linux, macOS, and Windows support claims require platform-specific evidence.

The durable requirements and acceptance matrix live in
`.codex/work-packages.md`.
