# Collaborative Markdown Editor

The Collaborative Markdown Editor is an optional, disabled-by-default Linux
feature that packages a Codex plugin. The plugin opens a workspace Markdown
file in Codex Desktop's persistent right-side MCP App region. Human edits,
Codex tool edits, and safe external file changes converge through one
broker-owned Yjs document while the ordinary `.md` file remains the durable
source of truth.

## Verify the owning feature branch

Enable only `collaborative-markdown-editor` in the ignored
`linux-features/features.json`, then build a feature-specific development
identity:

```bash
make build-dev-app \
  DEV_APP_ID=codex-collaborative-markdown-editor-lab \
  DEV_APP_NAME='Codex Collaborative Markdown Editor Lab'
```

Launch `./bin/codex-collaborative-markdown-editor-lab`, open **Plugins**, search for
**Collaborative Markdown Editor**, and install it. The committed example
feature configuration remains empty, and none of these steps modifies the
stock or package-managed Codex application.

After merging the owning branch, enable the complete integration feature set
in the ignored config on `dev/combined` and run
`make build-combined-dev-app`. Only `dev/combined` may produce
`./bin/codex-desktop-linux-dev`. When integration is performed in a temporary
linked worktree, set `COMBINED_DEV_ROOT` to the durable development checkout.

For isolated source testing, the feature's `plugin-marketplace/` directory is
a local marketplace. Use a disposable `CODEX_HOME`; do not add development
inventory to a user's normal Codex home.

## Open and edit a file

Ask Codex to open an explicit workspace root and root-relative `.md` or
`.markdown` path with the collaborative Markdown editor. The
`markdown_render` operation creates a right-side tab. The first use of a
canonical workspace root requires a human confirmation in that tab.

The editor reports:

- **Saved to Markdown** when the displayed revision is durable in the file;
- connection and generation state at the bottom of the tab;
- visible human or agent presence without claiming token-by-token model
  generation; and
- a read-only conflict state when an external overlap cannot be merged safely.

CodeMirror is a view over Markdown source. Live preview, raw source, Yjs undo,
selection, scroll position, and reconnection state do not create another
proprietary document tree.

## Agent tool workflow

The public operations are:

| Tool | Purpose |
| --- | --- |
| `markdown_render` | Open or restore the right-side editor |
| `markdown_open` | Attach to an approved existing document without UI |
| `markdown_create` | Create a permitted Markdown file under an approved root |
| `markdown_read` | Read a bounded snapshot or range and its revision |
| `markdown_apply_edits` | Apply one atomic semantic patch at an expected revision |
| `markdown_status` | Inspect revision, durability, connection, and conflict state |
| `markdown_flush` | Wait for an accepted revision to reach the file |
| `markdown_close` | Release the task's lease without deleting the file |

Every mutation uses an expected revision and an idempotency key. On
`STALE_REVISION`, read again and deliberately rebase; do not replay old
offsets. The five `markdown_ui_*` operations are private app synchronization
calls. Workspace authorization and transport capabilities never appear in
ordinary model-visible tool results.

## External tools, Git, and recovery

Git, shell tools, and other editors can continue to use the Markdown file.
Watcher imports become Yjs transactions. Disjoint changes merge; ambiguous
overlaps retain current, baseline, and external candidates in private state and
make the session read-only.

A broker restart changes its generation and fences stale UI clients. Use
**Reconnect** to rebuild the client document. Deleting or renaming an open file
produces an explicit state; the broker does not silently recreate it.

The current Codex Desktop host can retain an already-started plugin stdio
process after uninstall. Uninstall unregisters the plugin and preserves project
files, but close and restart Codex Desktop to guarantee that the old adapter,
broker, loopback listener, and locks have stopped. Plugin-private recovery
state is intentionally retained unless it is removed separately after all
Codex Desktop instances have exited.

## Limits and platform support

- Linux is the only verified v1 runtime.
- UTF-8 Markdown up to 2 MiB is accepted; larger or invalid files fail before
  mutation.
- Files must remain under a human-approved canonical workspace root.
- Windows is build-only and fails closed because v1 lacks a reviewed atomic
  replacement primitive.
- macOS remains an unverified candidate until its official Codex Desktop and
  Node 20/24 gates pass.

## Maintainer references

- Feature architecture and lifecycle:
  `linux-features/collaborative-markdown-editor/README.md`
- Donor pin and update procedure:
  `linux-features/collaborative-markdown-editor/UPSTREAM.md`
- Shipped licenses and notices:
  `linux-features/collaborative-markdown-editor/THIRD_PARTY_NOTICES.md`
- Production architecture and threat model:
  `reports/collaborative-markdown-editor/wp-04-production-architecture.md`
- MCP protocol:
  `reports/collaborative-markdown-editor/wp-08-mcp-surface.md`
- Security and SBOM:
  `reports/collaborative-markdown-editor/wp-12-security.md`
- Linux acceptance and screenshots:
  `reports/collaborative-markdown-editor/wp-14-acceptance.md`
