---
name: collaborative-markdown-editor
description: Open and safely edit an authorized project Markdown file in the Codex Desktop right-panel collaborative editor.
---

# Collaborative Markdown Editor

Use the plugin's Markdown tools when the user wants a project `.md` or
`.markdown` file opened in the collaborative Codex Desktop editor.

1. Call `markdown_render` with the explicit project or worktree root and a
   root-relative Markdown path. The user must approve a new root from the
   rendered editor; do not claim that a model-facing tool can grant access.
2. Use the returned `document_id` for subsequent operations.
3. Read the current revision before editing. Apply bounded semantic edits with
   `markdown_apply_edits`, the exact expected revision, and a new idempotency
   key for each intended mutation.
4. If an edit is stale, read again and deliberately rebase it. Do not repeat
   the old offsets blindly.
5. Use `markdown_flush` when the user needs confirmation that the accepted
   revision is durable in the ordinary workspace file.

The Markdown file remains usable by Git, shell tools, other editors, and
Codex's normal filesystem tools. If a normal filesystem edit is more
appropriate, make it in the project and then check `markdown_status`; the
broker's watcher will import a safe external change or preserve a visible
conflict. Never work around workspace authorization or a read-only/conflict
state.
