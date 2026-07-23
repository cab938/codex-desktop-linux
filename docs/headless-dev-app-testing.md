# Testing A Dev App Headlessly

Xvfb provides a host-invisible X11 desktop for side-by-side Codex dev builds.
It has its own framebuffer and virtual pointer, so automated clicks and
screenshots cannot open a window or move the pointer on the physical desktop.

The harness starts all of the following as temporary, uninstalled processes:

- a private Xvfb display on the first free display from `:90` through `:119`;
- an `xfwm4` window manager and private D-Bus sessions;
- the generated dev launcher with `--new-instance`; and
- temporary XDG config, state, cache, and runtime directories.

The temporary XDG directories keep test settings, launcher sockets, logs, and
Teaching view state separate from a dev app already running on the physical
desktop. XDG data and D-Bus are isolated as well. The user's normal `HOME` and
`CODEX_HOME` remain available so the test app can use
the existing Codex CLI authentication and absolute project paths. Files outside
the temporary XDG directories are therefore not a filesystem sandbox; use a VM
when that boundary is required.

Install the Ubuntu/Debian runtime dependency once if it is not already present:

```bash
sudo apt-get install xvfb
```

## Automated Smoke Test

Build the requested side-by-side app first, then run the smoke test with the
same app id:

```bash
make build-dev-app DEV_APP_ID=codex-desktop-dev DEV_APP_NAME='ChatGPT Dev'
make test-dev-app-headless DEV_APP_ID=codex-desktop-dev
```

The command waits for the app's X11 window and gives its renderer five seconds
to paint. It writes a screenshot, window metadata, and component logs under a
printed `/tmp/codex-desktop-headless-*` artifact directory, probes its virtual
pointer, and cleans up the app, window manager, Xvfb server, and temporary XDG
state. Override the paint delay with `HEADLESS_SETTLE=10` when a slower startup
needs more time.

## Longer UI Automation

For targeted UI automation that needs the display to remain alive:

```bash
make run-dev-app-headless DEV_APP_ID=codex-desktop-dev
```

The harness prints the selected `DISPLAY`, window id, and artifact directory,
then stays open until the app exits or the caller presses Ctrl-C. Every UI tool
must explicitly target the printed headless display. For example, if the
harness prints `DISPLAY=:90`:

```bash
DISPLAY=:90 xdotool search --onlyvisible --class codex-desktop-dev
DISPLAY=:90 xdotool mousemove 240 975 click 1
DISPLAY=:90 import -window root /tmp/codex-headless-desktop.png
```

Never omit `DISPLAY=:N` from an automation command. An omitted display could
target the physical desktop session instead.

## Scope And Limitations

Xvfb is appropriate for app launch, window, menu, dialog, focus, and ordinary
pointer/keyboard testing. It is not a full VM: host kernel services remain
shared, GPU behavior normally uses a software rendering path, and desktop
portals, tray integration, multi-monitor behavior, and compositor-specific
behavior may differ from a real workstation. Use a dedicated VM when one of
those boundaries is the behavior under test.
