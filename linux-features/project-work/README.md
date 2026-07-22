# Project Work Checklist Linux Feature

`project-work` is an optional, disabled-by-default feature that adds a separate
**Project work** card beneath the task summary in local-conversation sidebars.
The card reads the active workspace's `.codex/work-packages.md`, displays nested
checkboxes and open/completed counts, toggles individual markers, can hide
completed items, creates a missing file, and opens the Markdown file in the
normal desktop editor.

## File lifecycle and safety

The Markdown file is the sole authority. The Electron main process resolves a
real absolute workspace directory and permits operations only on the real
`.codex/work-packages.md` path beneath it. Symlinked or special `.codex` and
work-package paths fail closed. Reads recognize only `- [ ]`, `- [x]`,
`- [X]`, and equivalent `*` checkbox lines; every other byte remains opaque.

A toggle rereads the file, compares the rendered SHA-256 revision, validates
the target line, changes only the single checkbox marker, writes and fsyncs a
same-directory temporary file, rechecks the revision, atomically renames it,
and rereads the result. A newer edit is never knowingly overwritten: the UI
receives a conflict plus current state and can retry. Missing, empty, deleted,
recreated, malformed, oversized, watch-error, and open-error states remain
visible in the card. Main-process `fs.watch` handles observe `.codex` and the
checklist directory without an external daemon and are rebound after renames.

## Agent awareness and trust

The current request-client patch augments `turn/start` and `turn/steer` through
their typed `additionalContext`; it does not alter the visible prompt. Per task,
the renderer supplies the first revision and then only a changed revision on
the next submit or steer. A revision is acknowledged only after the app-server
request resolves successfully. Normal files use the full snapshot; files over
64 KiB use a bounded top-level summary plus their path.

Application-owned path, revision, counts, status, and change flags use context
kind `application`. Repository-controlled Markdown uses kind `untrusted`. The
feature does not auto-steer an active turn and introduces no MCP server.

The declaratively staged `project-work` skill is installed at launch under
`${CODEX_HOME:-~/.codex}/skills/project-work/`. It defines the agent's editing
and verification norms; the Markdown file remains durable data, and turn
context remains dynamic awareness. A management marker prevents later launches
from overwriting user changes. When the feature is disabled, its cleanup hook
removes only an unchanged, marker-owned copy and preserves unmanaged or modified
skills.

## Enable and verify locally

Create the ignored `linux-features/features.json` with:

```json
{
  "enabled": ["project-work"]
}
```

Rebuild from the current DMG with the normal candidate workflow and inspect the
patch report. Every `feature:project-work:*` descriptor must be `applied` or
`already-applied`; an enabled-feature skip or drift rejects promotion. Launch
the candidate rather than editing generated output.

Run focused verification with:

```bash
node --test linux-features/project-work/test.js
node --test scripts/patch-linux-window-ui.test.js
bash tests/scripts_smoke.sh
```

At runtime, open tasks in the same and different roots; create/edit/delete the
file externally; toggle an item in the card; attempt a stale-revision toggle;
submit a later turn; inspect the installed skill; then rebuild with the feature
disabled and confirm the card, bridge, and context markers are absent.

Version one intentionally omits inline renaming, reordering, rich Markdown
editing, subtree toggles, cross-worktree sharing, a global dashboard, and
multi-machine synchronization beyond ordinary file or Git workflows.
