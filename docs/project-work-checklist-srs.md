# Project Work Checklist for Codex Desktop

## Software Requirements Specification

Status: Proposed for implementation  
Target: Current `codex-desktop-linux` checkout and this Linux workstation  
Delivery model: Optional Linux feature, disabled by default in committed configuration

## 1. Purpose

Implement a durable, project-level work checklist in Codex Desktop. The checklist
must give a person and the Codex agent a shared view of the meaningful work
packages that remain open for a project and those that have been completed.

The checklist is not a replacement for the existing task Plan. A Plan remains a
transient, task-specific execution aid. Project work is durable project state,
shared by every Codex task associated with the same project workspace root.

The feature must be designed, implemented, tested, rebuilt, and verified against
the actual Codex Desktop runtime on this machine. A source-only implementation or
design document is not sufficient for completion.

## 2. User Model and Terminology

Codex currently groups multiple tasks or conversations under a project. In this
specification:

- **Project** means the Codex project associated with a workspace root.
- **Task** means an individual Codex task, chat, or conversation under a project.
- **Work package** means a durable project outcome represented by a top-level
  Markdown checkbox.
- **Checklist item** means either a top-level work package or a nested checkbox
  describing a step, subtask, or acceptance condition.
- **Project work file** means `<workspace-root>/.codex/work-packages.md`.

All tasks whose resolved project workspace root is the same must display and edit
the same project work file.

## 3. Source of Truth

The sole source of truth is:

```text
<workspace-root>/.codex/work-packages.md
```

No database, MCP server, sidecar state file, or separate checklist service should
be introduced. The normal Markdown file must remain directly editable by users,
agents, editors, and ordinary command-line tools.

The supported convention is:

```markdown
- [ ] Add project work sidebar
  - [x] Establish Markdown convention
  - [ ] Implement file bridge
  - [ ] Render nested checkboxes
- [ ] Repair teaching window defaults
  - [ ] Confirm startup size
  - [ ] Rebuild and visually verify
```

Top-level checkbox items represent durable work packages. Nested checkbox items
represent steps, subtasks, or acceptance conditions. Other Markdown may coexist
in the file and must be preserved.

## 4. User Interface

### 4.1 Placement

Add a card titled **Project work** to the right sidebar of the local conversation
view. It should appear beneath the existing task summary card that currently
contains sections such as Environment, Plan, Subagents, and Sources. The separate
card and title must make its project scope visually distinguishable from the
task-scoped Plan.

### 4.2 Rendering

The card must:

- Render checked and unchecked Markdown checklist items.
- Render nested items with clear visual indentation.
- Show concise open and completed counts.
- Allow individual items to be checked or unchecked.
- Update when the project work file changes outside the application.
- Display an appropriate empty state if the file is missing or has no recognized
  checklist items.
- Offer a way to create the file from the missing-file empty state.
- Allow completed work to be collapsed if this can be implemented without making
  the initial integration fragile.
- Surface read, write, watch, and concurrent-edit failures without discarding or
  concealing newer file content.

When users switch between tasks under the same project, the displayed checklist
must remain the same. Switching to a task under another project must resolve and
display that project's own file.

## 5. Markdown Parsing and Mutation

Implement a deliberately narrow parser. It should recognize checkbox list lines
such as:

```text
- [ ] Text
- [x] Text
- [X] Text
```

It should derive nesting from indentation. Supporting the equivalent `*` marker
is optional unless doing so is straightforward and well tested.

All unrecognized Markdown must be preserved exactly. The application must not
parse and serialize the entire document through a general Markdown AST merely to
toggle a checkbox. In particular, preserve headings, prose, comments, blank
lines, list ordering, indentation, trailing text, and user-authored notes.

For a UI checkbox toggle, the application must:

1. Reread the current file.
2. Compare it with the revision or content hash from which the UI was rendered.
3. Locate and validate the targeted checkbox in the current content.
4. Change only the checkbox marker from `[ ]` to `[x]` or from `[x]`/`[X]` to
   `[ ]`.
5. Write the new content safely and atomically.
6. Refresh the rendered state from the resulting file.

If the file changed concurrently, the application must not overwrite the newer
content. It should reload the current file and expose a retry or conflict state.
The implementation must also handle deletion, recreation, an empty file,
malformed lines, rapid changes, and watcher failure without crashing the task
view.

File operations must be confined to `.codex/work-packages.md` beneath the
resolved workspace root. A malformed path, unexpected project object, or unsafe
resolution must fail closed.

## 6. File Watching and State

Use existing Codex Desktop file-watching infrastructure where practical. The
feature should not introduce a continuously running external daemon.

The UI must converge on the current file contents after:

- An agent edits the file.
- A user edits the file in an editor.
- A user toggles an item in the sidebar.
- The file is created, removed, or recreated.
- The active task changes to another task in the same or a different project.

Any in-memory state must be a cache of the Markdown file, not an independent
authority.

## 7. Agent Awareness

The agent must become aware of current project work without changing the visible
user message and without adding an MCP server. Confirm the exact interface in the
current upstream bundle, but prefer the existing typed `additionalContext`
mechanism used by turn start and turn steer.

Required behavior:

- On the first relevant turn in a task, supply the current checklist snapshot,
  file path, and revision.
- Track the last checklist revision successfully delivered for each task.
- When the file changes, mark the task's project context as dirty.
- On the next user submit or steer, supply the current snapshot and indicate that
  it changed since the last accepted turn.
- Do not interrupt or automatically steer an active agent merely because the
  checklist changed.
- Do not acknowledge a revision as delivered until the turn request is accepted.
- Send the complete current snapshot for normal-sized files; impose a reasonable
  size bound and use a compact summary plus path when the file is unusually
  large.
- Do not silently rewrite the user's visible prompt.

Application-generated metadata, such as the resolved path, content revision, and
`changedSinceLastTurn` state, may use application context. Repository-controlled
Markdown contents must be treated as untrusted data rather than privileged
instructions. Confirm and test the trust classifications supported by the current
app-server schema.

## 8. Agent Skill

Ship a focused Codex skill with the feature and make it available through the
least invasive existing skill or plugin integration used by this repository. No
MCP server is needed.

The skill must establish these norms:

- Consult Project work at the beginning of substantive project work.
- Treat top-level items as durable project outcomes, not conversational
  microsteps.
- Add newly discovered work packages when appropriate.
- Modify only entries relevant to the current work.
- Preserve user-authored entries, hierarchy, notes, wording, and ordering.
- Reread the file before editing and make surgical changes.
- Mark an item complete only after the corresponding work has been verified.
- Mark a parent complete only after its relevant children are complete.
- Reconcile the checklist before giving a final response.

The skill supplies behavioral policy. The Markdown file supplies durable data.
Turn `additionalContext` supplies dynamic awareness. These roles must remain
separate.

## 9. Repository Integration

Implement the capability as an optional Linux feature under a directory such as:

```text
linux-features/project-work/
```

The feature must remain disabled by default in committed configuration and must
include the repository-required `README.md` and `feature.json`. Add colocated
patch code, resources, runtime hooks, and tests as needed.

Follow these repository constraints:

- Use only `entrypoints.patchDescriptors` for feature patching.
- Prefer declarative feature resources and runtime hooks over ad hoc staging.
- Do not make the durable change by editing `codex-app/`, extracted ASAR output,
  generated launchers, or other generated artifacts.
- Keep feature-specific logic in the feature directory.
- Add only the smallest generic core extension point if one is genuinely needed.
- Make patches idempotent and produce actionable drift reporting.
- Use stable semantic or translation anchors instead of relying on transient
  minified function names wherever possible.
- Treat enabled-feature patch drift as a failed candidate acceptance condition,
  in accordance with repository policy.

Potential current semantic anchors in the conversation sidebar include:

```text
codex.localConversation.environmentSummary.title
codex.localConversation.plan.title
codex.localConversation.backgroundTasks.title.subagents
codex.localConversation.sources.title
```

These are discovery hints, not guaranteed interfaces. Inspect and verify the
current upstream bundle before using them.

## 10. Version-One Boundaries

The following are intentionally outside version one:

- MCP tools or servers.
- A checklist database or background service.
- Task-specific checklist files.
- A durable project home or global project dashboard.
- Inline item renaming in the sidebar.
- Drag-and-drop or arbitrary reordering.
- Rich Markdown editing in the sidebar.
- Toggling a whole subtree at once.
- Synchronizing one canonical checklist across separate Git worktrees.
- Multi-machine synchronization beyond whatever normal file or Git workflows
  already provide.

For version one, sharing is guaranteed for tasks that resolve to the same project
workspace root.

## 11. Automated Verification

Add automated tests for at least:

- Nested checked and unchecked item parsing.
- Case-tolerant checked markers.
- Preservation of unrelated Markdown.
- Surgical checkbox mutation.
- Line-ending and final-newline preservation where applicable.
- Missing, empty, malformed, deleted, and recreated files.
- Concurrent modification or content-hash mismatch behavior.
- File-watcher refresh behavior.
- Task changes within one project and between different projects.
- Initial checklist context delivery.
- Changed-checklist context delivery on submit and steer.
- Correct metadata and Markdown trust classifications.
- Revision acknowledgement only after accepted turn requests.
- Prevention of duplicate or stale context delivery.
- Patch application and idempotence.
- Actionable upstream-drift reporting.
- Disabled/default feature behavior.
- Feature resources and skill packaging.

Run the new feature test, existing ASAR patcher tests, and any other suites
implicated by shared framework changes. Run broader repository smoke validation
if shared feature, launcher, packaging, or runtime code is modified.

## 12. Rebuild and Runtime Verification

Enable the feature only in the local ignored `linux-features/features.json`.
Build a fresh candidate from the current DMG through the repository-supported
candidate or update workflow. Do not hand-edit the generated candidate. Inspect
the patch report and verify that the enabled feature is accepted rather than
missing, skipped, or drifted.

Install or launch the rebuilt application on this machine and verify the actual
runtime the user will use. Demonstrate that:

1. The Project work card appears in the intended sidebar location.
2. Two tasks under the same project display the same checklist.
3. Tasks under different projects resolve different files.
4. An external edit updates the visible card.
5. A UI toggle changes only the targeted Markdown marker.
6. A concurrent edit is not overwritten.
7. A later user turn receives the current changed project context.
8. The skill is discoverable and communicates the intended norms.
9. Disabling the feature restores normal upstream behavior.

If final promotion is blocked solely because Codex is running or an elevation
prompt requires human action, complete all preceding work and name that one gate
precisely. Do not report runtime verification as complete without evidence from
the rebuilt application.

## 13. Completion Criteria

The work is complete only when all of the following are true:

- Durable source changes exist on the assigned branch.
- The optional feature is disabled by default in committed configuration.
- Automated tests covering the critical parser, synchronization, context, patch,
  and packaging behavior pass.
- A current Codex candidate has been rebuilt with the feature locally enabled.
- Candidate patch acceptance has succeeded.
- The rebuilt runtime has been exercised on this machine, or exactly one
  unavoidable machine-level operator gate has been identified.
- The implementation documentation explains the UI integration, file lifecycle,
  conflict behavior, agent context delivery, skill packaging, local enablement,
  and verification procedure.
- The final report lists changed files, commands and tests run, build and runtime
  evidence, deferred version-one limitations, and any remaining operator gate.

The primary success criterion is a reliable project-scoped checklist that a
human and Codex agent can both use through ordinary Markdown, that is visible
consistently across the project's tasks, and that avoids MCP infrastructure and
destructive whole-file rewrites.
