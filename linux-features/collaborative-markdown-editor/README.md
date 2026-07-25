# Collaborative Markdown Editor

This disabled-by-default Linux feature is the repository integration boundary
for a Codex Desktop plugin that lets a person and Codex agents edit the same
workspace Markdown file through a shared Yjs document.

The Codex host and transport gates have passed. The feature packages a
production MCP App, pure-JavaScript MCP adapter, and attachable per-user
document broker as an installable Codex plugin. It needs no platform-specific
native module. The feature uses one narrow, required-upstream ASAR descriptor
to add its disabled-by-default plugin to the host's bundled-plugin eligibility
list, one declarative plugin resource, and small stage/cleanup hooks for
deterministic generated bundles and the existing bundled marketplace catalog.
The descriptor makes the plugin available on Linux but deliberately does not
auto-install it.

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

The broker prefers the platform-native user state directory. If the Codex
sandbox denies that default directory, and only when no explicit state-root
override was supplied, it falls back to the deterministic mode-0700
`/tmp/codex-collaborative-markdown-editor-<uid>` runtime directory. That
fallback preserves recovery across app and broker restarts in the same boot
but is not a reboot-persistent store. An explicit, unsafe, or malformed state
root always fails closed instead of falling back.

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

`mcp/main.mjs` is the source stdio entrypoint. It registers eight model-visible
document/render tools, five app-only synchronization/authorization tools, and
the versioned `ui://collaborative-markdown-editor/v2/index.html` resource.
All input and output schemas are closed-world, tool annotations distinguish
reads from destructive text edits, and only `markdown_render` attaches the UI
resource.

Model-visible results contain bounded text or redacted status. Broker bearers,
workspace-confirmation capabilities, UI session capabilities, snapshots, and
Yjs updates stay in app-only calls or hidden tool-result metadata. Mutations
require expected revisions and printable idempotency keys. Accepted edit and
create receipts persist for 24 hours across broker restart.

The production app requests the host's `fullscreen` mode, which the verified
Codex Desktop build presents as a persistent right-side tab. Human updates are
batched for up to 75 ms or 256 KiB through app-only MCP calls; bounded
state-vector pulls carry broker and agent changes back to the one client
`Y.Doc`. Selection, scroll, and preview state survive ordinary remounts.

## Plugin package

The tracked plugin source and local test marketplace live under
`plugin-marketplace/`. The plugin starts `node ./runtime/server.mjs` with the
plugin root as its working directory. Codex resolves `node` to its managed
runtime; no shell, `/usr/bin/env`, Python, native add-on, or user `PATH`
lookup is part of the plugin contract.

The deterministic production build emits:

```text
dist/
├── mcp/mcp-app.html
└── plugin/
    ├── server.mjs
    └── broker.mjs
```

The server bundle contains only the imported stdio MCP/Yjs graph. The current
SDK's unused Hono/HTTP server path is absent from the staged runtime. The
feature stage hook places the bundles, MIT license, third-party notices, and
deterministic CycloneDX SBOM beside the tracked plugin manifest, icon, and
narrowly scoped agent skill.

When the last stdio adapter exits, it releases all of its document and UI
leases. The last adapter causes the shared broker to flush/checkpoint open
documents, remove its descriptor, release its single-writer locks, and exit.
Removing the plugin does not remove any workspace Markdown file. Plugin-private
recovery state remains in the platform-native state directory unless the user
chooses to remove it separately.

The current Codex Desktop host unregisters an uninstalled plugin immediately
but may keep an already-started stdio server alive until the desktop
application exits. After uninstalling, close and restart Codex Desktop to
guarantee that the old adapter and broker generation have stopped. This is a
host lifecycle limitation rather than a file-retention dependency: the
Markdown file remains ordinary project data throughout. Automated staged
plugin tests additionally prove that closing stdio directly stops the last
adapter, broker, listener, and document locks.

## Lifecycle commands

The shell has dependency-free, deterministic lifecycle commands:

```bash
npm run build
npm run stage
npm test
npm run clean
```

Run `npm ci` once, then run the commands from this directory. `build` emits the
preview, production MCP App, bundled server, bundled broker, and a hash-bearing
manifest under the ignored `dist/` directory. `stage` copies those artifacts
into an isolated `dist/stage/` tree; it does not write into a generated
application. `test` typechecks the source, runs retained donor/local component
tests, validates feature staging and cleanup, exercises the source protocol,
starts the self-contained staged plugin, verifies broker exit on adapter
shutdown, and runs the persistence/security suites. `clean` removes only this
feature's `dist/`.

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

After a side-by-side development rebuild, the plugin is listed in the app's
`openai-bundled` marketplace as available, not installed by default. Install
it from the Plugins UI or with the matching Codex plugin command inside a
disposable development home. Disabling this Linux feature and rebuilding
removes its bundled source and marketplace entry. If the plugin was already
copied into a user plugin cache, uninstall that cached plugin separately.

For source-only plugin testing, `plugin-marketplace/` is an explicit local
marketplace. Add that non-default marketplace before installing from it; use a
disposable `CODEX_HOME` during development so tests do not modify the user's
normal plugin inventory. Run the plugin-creator validator against
`plugin-marketplace/plugins/collaborative-markdown-editor` before testing.

## Using the editor

1. Open **Plugins**, search for **Collaborative Markdown Editor**, and install
   it. Start a new task if the task predates installation.
2. Ask Codex to open an explicit project-relative Markdown path with the
   collaborative editor. The `markdown_render` call opens the editor as a
   persistent right-side tab.
3. For a workspace root that has not been used before, approve the exact
   canonical root in the editor. Model-facing tools cannot grant this access.
4. Edit normally. **Saved to Markdown** means the displayed revision has
   reached the project file. Codex can use `markdown_read`,
   `markdown_apply_edits`, and `markdown_flush` against the same document.
5. External editors and Git safe-write replacements remain supported. A safe
   change appears in the open editor; an ambiguous overlap becomes a visible
   read-only conflict instead of overwriting either candidate.

`markdown_create` creates a new `.md` or `.markdown` file under an already
approved root. The remaining model-facing operations are `markdown_open`,
`markdown_read`, `markdown_apply_edits`, `markdown_status`, `markdown_flush`,
`markdown_close`, and `markdown_render`. The five `markdown_ui_*` operations
are app-only synchronization and authorization calls and should not be invoked
as ordinary agent workflow.

The tested maximum is 2 MiB of UTF-8 Markdown. Files larger than that are
rejected before mutation. The editor preserves the source Markdown rather than
converting it to a proprietary document format.

## Conflicts and recovery

- **Stale revision:** read the current revision, deliberately rebase the
  intended edit, and submit it with a new idempotency key.
- **External conflict:** stop editing, retain the conflict candidates in the
  private state directory, resolve the ordinary Markdown file deliberately,
  then reconnect. The broker never silently chooses an ambiguous rewrite.
- **Disconnected or stale generation:** use **Reconnect**. A broker-generation
  change rebuilds the client `Y.Doc` from the authoritative server state.
- **Deleted or renamed file:** restore or deliberately recreate the project
  path before reopening it. An open session does not silently resurrect it.
- **Plugin does not appear in an old task:** install it, then create a new task
  or restart Codex Desktop so the task receives the current plugin inventory.
- **Uninstall still has an old process:** close and restart Codex Desktop. The
  current host can retain an already-started stdio server until app exit.

## Maintainer verification

From this feature directory, run `npm ci` and `npm test`. The owning branch
must then be built only as the side-by-side identity documented in the
repository `AGENTS.md`, and the exact launcher must be inspected on the private
Xvfb display. Detailed architecture, protocol, security, license, portability,
and acceptance evidence is retained under
`reports/collaborative-markdown-editor/`; `UPSTREAM.md` is the donor update
guide and `THIRD_PARTY_NOTICES.md` is the shipped notice source.

## Support scope

- Linux is the only v1 support target. It is verified under Node 20.19.0 and
  24.15.0 and in the side-by-side Codex Desktop Linux development app.
- macOS is an unpublished candidate. Its Node 20/24 CI jobs and official Codex
  Desktop `26.721.31836` scenario run must pass before support is claimed.
- Windows is build-only and fails fast with `PLATFORM_UNSUPPORTED`. V1 cannot
  meet the atomic replacement invariant there without a reviewed
  platform-specific replacement primitive.

The durable requirements and acceptance matrix live in
`.codex/work-packages.md`.
