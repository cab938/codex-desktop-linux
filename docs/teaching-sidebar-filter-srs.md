# Teaching View Software Requirements Specification

Status: implementation baseline

## 1. Purpose

Teaching view provides a presentation-oriented Codex Desktop mode that is easy
to identify and reduces unrelated project and pinned-item clutter during
demonstrations. When the mode is active, the primary window uses a teaching
title and initial size, while sidebar project groups and pinned items are
limited by a locally configured regular expression.

The feature is called **Teaching view** in the user interface. It is not a
security or confidentiality boundary: filtered data remains available to the
running application and may still be reachable through search, direct routes,
notifications, already-open tasks, or future upstream UI surfaces.

## 2. Scope

The first release shall:

- ship as a disabled-by-default Linux feature;
- accept a project-name regular expression and flags from the gitignored Linux
  feature configuration;
- activate only when Electron starts with `--teaching-mode`;
- filter current local and remote project rows before they are rendered;
- filter pinned Codex tasks by their owning project and pinned ChatGPT projects
  and conversations by their displayed labels;
- hide projectless pinned Codex tasks;
- show a persistent Teaching view indicator;
- open the primary window at 1920x1080 with the exact title `Codex (teaching
  mode)`;
- preserve the underlying project, task, order, and pin state; and
- reject an update candidate when the enabled feature no longer patches the
  current upstream bundles cleanly.

The first release shall not add an in-app settings toggle, File menu command,
search filtering, route blocking, notification filtering, data isolation, or
automatic profile/account separation.

## 3. Definitions

- **Matching project**: a project whose displayed label matches the configured
  regular expression. If no explicit label exists, the displayed path or
  workspace name is used.
- **Pinned Codex task**: an individually pinned task. It is visible only when a
  matching owning project can be identified.
- **Pinned ChatGPT item**: a pinned ChatGPT project or conversation. Its
  displayed project name or conversation title is matched directly.
- **Fail closed**: when active filtering cannot evaluate an item safely, the
  item is hidden rather than exposed.

## 4. Configuration

The feature id is `teaching-sidebar-filter`. The tracked defaults are:

```json
{
  "projectPattern": "^teaching-",
  "flags": "i"
}
```

User overrides live only in `linux-features/features.json`:

```json
{
  "enabled": ["teaching-sidebar-filter"],
  "settings": {
    "teaching-sidebar-filter": {
      "projectPattern": "^teaching-",
      "flags": "i"
    }
  }
}
```

`projectPattern` must be a non-empty string no longer than 256 characters.
`flags` may contain unique `i`, `m`, `s`, and `u` flags. Invalid overrides shall
emit a build warning and use the tracked safe default; they shall never produce
an allow-all filter.

## 5. Functional Requirements

### FR-1: Opt-in build

The feature shall remain disabled unless its id is listed in the local feature
configuration. No committed configuration shall enable it.

### FR-2: Startup activation

An enabled build shall remain behaviorally unchanged unless the Electron
process receives `--teaching-mode`. The reliable demonstration command is:

```bash
./codex-app/start.sh --new-instance --teaching-mode
```

`--new-instance` is required when another Codex window may already be running,
because warm-start argument handoff does not change the startup mode of the
existing Electron process.

### FR-3: Project filtering

While Teaching view is active, every project-group renderer targeted by the
feature shall receive only matching project groups. A matching project retains
all of its nested tasks. Connection groups and pending worktree rows shall use
the same fail-closed label filter.

### FR-4: Pinned filtering

While Teaching view is active:

- pinned project groups shall be visible only when their project matches;
- individually pinned Codex tasks shall be visible only when their owning
  project matches;
- projectless or unresolvable pinned Codex tasks shall be hidden; and
- pinned ChatGPT projects and conversations shall be visible only when their
  displayed label matches.

When no pinned items remain, the Pinned section shall not be rendered merely
because hidden items exist.

### FR-5: Non-destructive behavior

Filtering shall be presentation-only. It shall not mutate stored pins, project
order, task order, project membership, project metadata, or conversation data.
Disabling Teaching view and starting normally shall restore the complete
sidebar without a data migration.

### FR-6: Mode indicator

An active window shall display a persistent, non-interactive `Teaching view`
badge and set `data-codex-linux-teaching-view="active"` on the document root.
The badge shall expose the active pattern in its tooltip.

### FR-7: Teaching window identity and initial size

While Teaching view is active, the primary window shall be created at
1920x1080 and its title shall be exactly `Codex (teaching mode)`. The Teaching
view startup size shall override saved width, height, and maximized state. The
user may resize the window after creation. Normal launches and non-primary
windows shall retain upstream title and window-state behavior.

### FR-8: Runtime failure behavior

If the shared configuration reports the mode active but its regular expression
cannot be compiled, filter helpers shall return no matching items. The renderer
shall not fall back to showing all projects or pins. Build-time bridge
validation shall prevent promotion if the renderer can no longer read the
shared state.

## 6. Architecture Requirements

### AR-1: Linux feature boundary

All feature-specific behavior shall live under
`linux-features/teaching-sidebar-filter/`. Core launcher and generated app files
shall not be modified for the first release.

### AR-2: Main-process bridge

A main-bundle patch shall publish the startup mode and normalized pattern using
the packaged application's existing shared-object repository and configure the
primary Teaching view window at its current creation path. The feature shall
reuse the existing preload snapshot getter and shall not add custom IPC.
An extracted-app validation descriptor shall reject enabled-feature promotion
if that preload getter is no longer present.

### AR-3: Renderer data filtering

Renderer patches shall filter project and pin arrays before row rendering.
CSS selectors and DOM observers shall not be the authoritative filter.

### AR-4: Current-upstream policy

Patches shall target the current supported DMG only. Each patch shall use
semantic markers, require exactly one current insertion point, apply atomically,
be idempotent, and warn without modifying the asset when markers drift.

### AR-5: Update acceptance

Because the feature is user-enabled, missing, skipped, partially applied, or
warning-bearing descriptors shall cause upstream candidate acceptance to reject
promotion and retain the working installation.

## 7. Verification Requirements

Automated tests shall cover:

- disabled and enabled feature discovery;
- default, overridden, and invalid regex configuration;
- inactive runtime identity behavior;
- matching and nonmatching project groups;
- pinned task membership and projectless pins;
- pinned ChatGPT labels;
- mode indicator installation;
- main-process shared-object injection;
- Teaching view title, initial dimensions, and saved-maximized suppression;
- unchanged normal-mode title and saved dimensions;
- atomic behavior on upstream marker drift;
- descriptor asset targeting; and
- idempotent second application.

The implementation shall also be exercised against the currently generated
main bundle and webview assets before handoff.

## 8. Acceptance Criteria

The work is accepted when:

1. a normal enabled-feature launch shows the unfiltered sidebar;
2. `--new-instance --teaching-mode` shows only matching project groups and pins;
3. nested tasks within a matching project remain usable;
4. a projectless pinned task is absent;
5. the Teaching view badge is visible in the active window;
6. the primary Teaching view window title is exactly `Codex (teaching mode)`
   and initially opens at 1920x1080 rather than restoring a saved maximized
   state;
7. the next normal launch restores the complete sidebar and normal window
   title/state behavior;
8. no feature configuration is committed as enabled; and
9. all targeted automated and current-bundle patch checks pass.
