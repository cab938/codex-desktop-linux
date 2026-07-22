# Teaching View

Optional presentation-oriented mode for Codex Desktop.

When the feature is built in, a circled `¿` button appears beside Help in the
sidebar footer. Its menu toggles **Teaching view** without launch flags. While
active, project groups and pinned items are filtered using a configured regular
expression, and the primary window uses the exact title `Codex (teaching mode)`
at 1920x1080. If the window is maximized when Teaching view is enabled, it is
unmaximized first so the requested dimensions take effect.

Teaching view reduces accidental visual disclosure but does not isolate or
remove application data. Search, direct routes, notifications, open tasks, or
future upstream surfaces may still expose filtered projects.

## Enable and configure

Add the feature to the gitignored `linux-features/features.json` before
rebuilding:

```json
{
  "enabled": [
    "teaching-sidebar-filter"
  ],
  "settings": {
    "teaching-sidebar-filter": {
      "projectPattern": "^teaching-",
      "flags": "i"
    }
  }
}
```

Then regenerate or rebuild the application and launch it normally:

```bash
./codex-app/start.sh
```

Open the `¿` menu beside Help and select **Teaching view**. The selection is
written immediately, the current window title and size are updated, and the
renderer reloads so the sidebar filter changes at once. Selecting it again
restores the unfiltered sidebar and normal window title. The selected state also
applies on later normal launches.

The state is stored as `teaching-view.json` beside the launcher's existing
settings file. For the side-by-side development build this is normally
`~/.config/codex-desktop-dev/teaching-view.json`. Deleting that file restores
the default inactive state on the next launch.

The default filter is case-insensitive `^teaching-`. Invalid overrides warn and
fall back to that safe default. Pinned Codex tasks are matched through their
owning project; projectless pinned tasks are hidden. Pinned ChatGPT items are
matched by their displayed project name or conversation title.

## Maintenance risk

This feature patches current upstream main-process and renderer bundles. Its
descriptors are atomic, idempotent, and fail-soft. Because an enabled feature is
part of local update acceptance, upstream marker drift rejects the new candidate
instead of replacing the working application with an unfiltered build.

The authoritative requirements are in
[`docs/teaching-sidebar-filter-srs.md`](../../docs/teaching-sidebar-filter-srs.md).

## Test

```bash
node --test linux-features/teaching-sidebar-filter/test.js
```
