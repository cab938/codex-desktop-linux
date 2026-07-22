# Teaching View

Optional presentation-oriented mode for Codex Desktop.

When the feature is built in and Electron starts with `--teaching-mode`, project
groups and pinned items are filtered using a configured regular expression. The
primary window also opens at 1920x1080 with the exact title `Codex (teaching
mode)`. A saved maximized state is ignored for this initial Teaching view
window so it does not override the requested dimensions. The feature calls
this **Teaching view** because it reduces accidental visual disclosure but does
not isolate or remove application data. Search, direct routes, notifications,
open tasks, or future upstream surfaces may still expose filtered projects.

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

Then regenerate or rebuild the application. Start a reliable separate teaching
window with:

```bash
./codex-app/start.sh --new-instance --teaching-mode
```

A normal launch remains unfiltered and retains the normal title and saved window
bounds. `--new-instance` avoids handing the flag to an already-running process,
whose startup mode and initial window geometry cannot be changed retroactively.

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
