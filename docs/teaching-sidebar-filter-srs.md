# Teaching View Software Requirements Specification

Status: UI-controlled implementation baseline

## 1. Purpose

Teaching view provides a presentation-oriented Codex Desktop mode that is easy
to identify and reduces unrelated project and pinned-item clutter during
demonstrations. The user controls it from a small personal-controls menu beside
Help, and the selected state persists across ordinary launches.

The feature is called **Teaching view** in the user interface. It is not a
security or confidentiality boundary: filtered data remains available to the
running application and may still be reachable through search, direct routes,
notifications, already-open tasks, or future upstream UI surfaces.

## 2. Scope

The feature shall:

- ship as a disabled-by-default Linux feature;
- accept a project-name regular expression and flags from the gitignored Linux
  feature configuration;
- add a circled `¿` personal-controls button beside the existing Help control;
- toggle Teaching view from that menu without launch flags;
- persist the active state locally and apply it on later launches;
- filter current local and remote project rows before they are rendered;
- filter pinned Codex tasks by their owning project and pinned ChatGPT projects
  and conversations by their displayed labels;
- hide projectless pinned Codex tasks;
- expose the active state without adding a persistent disclosure badge;
- use 1920x1080 and the exact title `Codex (teaching mode)` while activated;
- preserve the underlying project, task, order, and pin state; and
- reject an update candidate when the enabled feature no longer patches the
  current upstream bundles cleanly.

The feature shall not add search filtering, route blocking, notification
filtering, data isolation, or automatic profile/account separation.

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

The UI-selected state shall be stored as schema-versioned JSON in
`teaching-view.json` beside the launcher's settings file. Missing, unreadable,
or invalid state shall mean inactive.

## 5. Functional Requirements

### FR-1: Opt-in build

The feature shall remain disabled unless its id is listed in the local feature
configuration. No committed configuration shall enable it.

### FR-2: UI activation

An enabled build shall add a compact `¿` button beside the desktop Help control.
The button shall open a menu containing a **Teaching view** checkbox-style item
whose On/Off label reflects the current state. Selecting the item shall persist
the opposite state and apply it immediately. No command-line activation path is
required or supported by this feature.

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
Disabling Teaching view shall restore the complete sidebar after the renderer
refreshes, without a data migration.

### FR-6: Mode state

An active renderer shall set `data-codex-linux-teaching-view="active"` on the
document root, and the personal-controls menu shall report the state as **On**.
The feature shall not add a persistent disclosure badge, overlay, or watermark.

### FR-7: Window identity and dimensions

When Teaching view is already active at startup, a primary window shall be
created at 1920x1080 with the exact title `Codex (teaching mode)`, overriding a
saved maximized state. When the user activates it in a running primary window,
the window shall be unmaximized if needed, resized to 1920x1080, and retitled.

When the user disables it, the normal title shall be restored. Disabling shall
not attempt to reconstruct the earlier window geometry; the user may resize the
window normally. Inactive startup and non-primary windows shall retain upstream
window-state behavior.

### FR-8: Live update and persistence

After a successful state change, the main process shall publish the new shared
state and reload the requesting renderer so project and pin filtering changes
immediately. A later normal launch shall read and apply the persisted selection.
A failed state write shall leave the active state unchanged and return an error
to the renderer.

### FR-9: Runtime failure behavior

If the shared configuration reports the mode active but its regular expression
cannot be compiled, filter helpers shall return no matching items. The renderer
shall not fall back to showing all projects or pins. Build-time preload patching
shall prevent promotion if the state setter or snapshot getter can no longer be
installed safely.

## 6. Architecture Requirements

### AR-1: Linux feature boundary

All feature-specific behavior shall live under
`linux-features/teaching-sidebar-filter/`. Core launcher and generated app files
shall not be modified.

### AR-2: Main-process state and IPC

A main-bundle patch shall read and write the schema-versioned local state,
publish the active mode and normalized filter through the application's existing
shared-object repository, handle one feature-scoped IPC channel, and update the
requesting window. A preload patch shall add only the narrow Teaching view setter
beside the existing snapshot getter.

### AR-3: Renderer integration

Renderer patches shall add the personal-controls button by reusing the current
Help button, popover, and menu component family. They shall filter project and
pin arrays before row rendering. CSS selectors and DOM observers shall not be
the authoritative filter.

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
- nonvisual active-state marking without a disclosure badge;
- persisted main-process state and shared-object publication;
- the preload state setter and renderer personal-controls menu;
- Teaching view title, dimensions, and maximized-state suppression;
- live enable, disable, renderer reload, and normal-title restoration;
- atomic behavior on upstream marker drift;
- descriptor asset targeting; and
- idempotent second application.

The implementation shall also be exercised against the current supported DMG
and visually verified in the rebuilt development app.

## 8. Acceptance Criteria

The work is accepted when:

1. a normal enabled-feature launch requires no teaching-specific flag;
2. the circled `¿` control appears beside Help and opens its menu;
3. selecting **Teaching view** writes the persisted state, changes the title to
   `Codex (teaching mode)`, uses 1920x1080, and refreshes the renderer;
4. only matching project groups and pins are shown while active;
5. nested tasks within a matching project remain usable;
6. projectless pinned tasks are absent while active;
7. the menu reports On while active and no disclosure badge is rendered;
8. selecting **Teaching view** again restores the full sidebar and normal title;
9. no feature configuration is committed as enabled; and
10. all targeted automated, current-DMG patch, and runtime checks pass.
