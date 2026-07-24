# Quick Launcher Linux Feature

`quick-launcher` is an optional, disabled-by-default Linux feature that adds a
**Quick launcher** card to the right-hand local-task summary. Each configured
entry appears as a button. Clicking a button starts its command with the
project as the default working directory.

The `+` action is always present. It creates `.codex/quicklaunch.yaml` when the
file is missing, then opens the file with the normal desktop editor. External
edits are watched and reflected in the card without restarting Codex.

## Configuration

The project file uses schema version 1:

```yaml
version: 1
launches:
  - label: Start
    command: make run-dev-app
    cwd: .
  - label: Tests
    command: node --test linux-features/quick-launcher/test.js
```

`label` and `command` are required. `cwd` is optional and defaults to `.`. It
must be relative and must resolve to a directory inside the project. Labels
are unique, one-line strings of at most 80 characters. The file permits up to
50 entries.

The parser intentionally accepts a small, readable YAML subset: the root
`version` and `launches` keys, block-sequence entries, plain or quoted scalars,
comments, and literal or folded block commands. Anchors, aliases, flow
mappings, and arbitrary YAML tags are not supported. Invalid files remain
visible as an error in the card and no commands are made runnable.

## Agent workflow

On the first local turn and after the file changes, the feature adds typed
`additionalContext` describing the path and schema. The application-owned
metadata tells the agent that a request such as “Add a quick launch called
Start that fires up the dev build” means:

1. inspect the checked-out project to determine the correct command;
2. create or edit `.codex/quicklaunch.yaml`;
3. add the requested label and command without running it merely to create the
   button.

The repository-controlled YAML snapshot is marked `untrusted`. The feature
does not alter the visible prompt, auto-steer a turn, install a global skill,
or run a command in response to an agent edit.

## Execution and safety

Command strings execute through `/bin/bash` only after the user clicks the
corresponding button. The renderer sends only the button id, label, project,
and displayed file revision; the main process rereads the current file,
rejects a stale revision, resolves the stored entry, validates the working
directory, and then starts the stored command. Renderer requests cannot
substitute a different command.

The Electron main process permits operations only on a real absolute workspace
and its real `.codex/quicklaunch.yaml`. Symlinked or special `.codex` and YAML
paths fail closed. Relative working directories that escape the project,
including through symlinks, are rejected. Commands inherit the app environment
plus `CODEX_QUICK_LAUNCHER=1` and `CODEX_QUICK_LAUNCH_LABEL`.

Quick launches are intentionally powerful local actions. Review repository
changes before clicking a button whose YAML came from an untrusted branch.
Command output is not shown in the sidebar in version 1.

## Repository self-rebuild button

This repository includes a guarded development-app workflow for a
project-scoped Quick Launcher button:

```yaml
version: 1
launches:
  - label: Rebuild dev
    command: make rebuild-relaunch-dev-app
    cwd: .
```

The Make target dispatches `scripts/dev/rebuild-relaunch-dev-app.sh` into a
transient user-systemd unit before the current Electron window is stopped. The
worker selects only the main process whose executable belongs to
`codex-desktop-linux-dev-app`, waits for it to exit, builds from
`dev/combined`, verifies the promoted build identity and source commit, and
then relaunches. Production Codex processes and unrelated Electron helpers are
not selected. Concurrent clicks are locked, a failed build is not relaunched,
and details remain in
`~/.local/state/codex-desktop-linux-dev/rebuild-relaunch.log`.

Inspect the target without changing app or filesystem state:

```bash
./scripts/dev/rebuild-relaunch-dev-app.sh --dry-run
```

## Enable and verify locally

Create the ignored `linux-features/features.json` with:

```json
{
  "enabled": ["quick-launcher"]
}
```

Rebuild from the current DMG and inspect the patch report. Every
`feature:quick-launcher:*` descriptor must be `applied` or `already-applied`;
enabled feature drift rejects candidate promotion.

Run focused verification with:

```bash
node --test linux-features/quick-launcher/test.js
node --test scripts/patch-linux-window-ui.test.js
bash tests/scripts_smoke.sh
```

For visible validation on the Thelio, launch the generated app only through the
authenticated private Xvfb harness documented by the local
`testing-native-xwindows-apps-on-thelio` skill. A home-screen launch smoke is
not sufficient. Open a disposable local task rooted at a project containing a
representative `.codex/quicklaunch.yaml`, then verify both presentation
surfaces:

- in a non-maximized window around `1280x820`, Quick Launcher is a section
  inside the compact summary content; and
- after maximizing on a `1920x1080` Xvfb screen, Quick Launcher is a section in
  the persistent right-hand panel, separated from Project Work and upstream
  sections by the normal dividers and without covering the conversation.

Capture and inspect both screenshots. Verify the `+` action and a harmless
fixture command; do not click this repository's `Rebuild dev` action merely as
a UI smoke. When a physical Codex app is running, use a temporary private
`CODEX_HOME` to avoid sharing mutable plugin staging state, delete its copied
credentials after the test, and confirm deterministic Xvfb teardown. See
[Testing A Dev App Headlessly](../../docs/headless-dev-app-testing.md).
