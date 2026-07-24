# Testing A Dev App Headlessly

Xvfb provides a host-invisible X11 desktop for side-by-side Codex dev builds.
It has its own framebuffer and virtual pointer, so automated clicks and
screenshots cannot open a window or move the pointer on the physical desktop.

There are two different success levels:

- A **launch smoke** proves that Electron mapped a window and painted.
- A **feature acceptance test** opens a representative task, exercises the
  relevant layout and state, and verifies the rendered pixels or another
  visible state change.

A home-screen screenshot or a healthy process is not feature acceptance.

The private-display harness starts all of the following as temporary,
uninstalled processes:

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

On the Thelio, use the authenticated harness from the local
`testing-native-xwindows-apps-on-thelio` skill for unattended acceptance tests.
It creates an Xauthority cookie and requires that cookie for every later UI
command. Do not use Xephyr or point `xdotool`, `import`, or another UI tool at
the inherited physical `DISPLAY`.

Install the Ubuntu/Debian runtime dependency once if it is not already present:

```bash
sudo apt-get install xvfb
```

## Automated Smoke Test

Build the requested side-by-side app first. The repository Make target is
useful as a basic launch smoke on an otherwise idle test host:

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

This smoke does not prove that a feature appears in the layout used by a real
task. On the Thelio, use the authenticated local skill harness for the feature
acceptance procedure below.

## Realistic Right-Panel Acceptance

Right-panel and sidebar changes must cover both upstream presentation
surfaces:

| Surface | Test geometry | Required observation |
| --- | --- | --- |
| Compact summary | A non-maximized window around `1280x820` | Open the compact summary and confirm the feature is a section inside the existing summary content. |
| Wide inline panel | A maximized window on a `1920x1080` Xvfb screen | Confirm the feature appears in the persistent right-hand panel, in the expected order, with upstream dividers and without overlapping the conversation. |

Use a real local task rooted at the project under test. Before capturing
evidence:

1. ensure the project contains representative project-scoped files, such as
   `.codex/quicklaunch.yaml` and `.codex/work-packages.md`;
2. open or create a disposable task in that project and complete one harmless
   turn so the task summary is mounted;
3. open the right-hand summary control;
4. verify the expected feature sections and at least one normal upstream
   section in the same panel; and
5. inspect the screenshot itself. Bundle markers, patch reports, and process
   state are supporting evidence, not visible acceptance.

For Quick Launcher, use a harmless fixture command during interaction tests;
do not click this repository's `Rebuild dev` action merely to prove button
click handling. For Project Work, include at least one open and one completed
item so counts, nesting, and completed styling are visible.

## Isolate A Live Codex Profile

The XDG directories are isolated, but the local skill intentionally inherits
`CODEX_HOME`. Two simultaneously running apps can therefore race over mutable
global plugin staging under `.codex/.tmp`. If the physical Codex app remains
open, give the private test a temporary `CODEX_HOME` and create a disposable
test task instead of sharing the live mutable profile.

Create the private profile without printing credential contents:

```bash
source_codex_home="${CODEX_HOME:-$HOME/.codex}"
test_codex_home="$(mktemp -d "${XDG_RUNTIME_DIR}/codex-ui-test-home.XXXXXX")"
chmod 700 "$test_codex_home"
install -m 600 "$source_codex_home/auth.json" "$test_codex_home/auth.json"
install -m 600 "$source_codex_home/config.toml" "$test_codex_home/config.toml"
```

Do not copy the whole sessions directory or live SQLite databases. Select the
project in the isolated app and create a disposable task there. Delete the
temporary `CODEX_HOME` after teardown because it contains an authentication
copy.

## Interactive Private-Display Run

Resolve the authenticated local skill before overriding `CODEX_HOME`, then
launch a wide interactive run:

```bash
skill_dir="${source_codex_home}/skills/testing-native-xwindows-apps-on-thelio"

env CODEX_HOME="$test_codex_home" \
  "$skill_dir/scripts/run-headless-x11-app.sh" \
  --interactive \
  --screen 1920x1080 \
  --timeout 120 \
  --settle 10 \
  --window-class codex-desktop-linux-dev \
  -- \
  "$PWD/bin/codex-desktop-linux-dev" --new-instance
```

The harness prints the selected `DISPLAY`, window id, and artifact directory,
then stays open until the app exits or the caller presses Ctrl-C. Every UI tool
must explicitly target the printed headless display **and** Xauthority file.
For example:

```bash
env DISPLAY=:90 XAUTHORITY=/tmp/example/Xauthority \
  xdotool key --window "$APP_WINDOW_ID" alt+F10
env DISPLAY=:90 XAUTHORITY=/tmp/example/Xauthority \
  import -window "$APP_WINDOW_ID" "$ARTIFACT_DIR/wide-inline-panel.png"
```

Capture the compact window before maximizing it, then maximize with `Alt+F10`
and capture the wide inline panel. Never omit `DISPLAY=:N` or `XAUTHORITY` from
an automation command. An omitted display could target the physical desktop
session instead.

On NVIDIA hosts, if Xvfb itself aborts while loading the NVIDIA EGL vendor,
retry the harness with software rendering scoped to the private test:

```bash
env -u LD_LIBRARY_PATH \
  __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json \
  LIBGL_ALWAYS_SOFTWARE=1 \
  MESA_LOADER_DRIVER_OVERRIDE=llvmpipe \
  CODEX_HOME="$test_codex_home" \
  "$skill_dir/scripts/run-headless-x11-app.sh" \
  --interactive --screen 1920x1080 \
  --window-class codex-desktop-linux-dev \
  -- "$PWD/bin/codex-desktop-linux-dev" --new-instance
```

## Evidence And Teardown

Retain:

- compact and maximized screenshots;
- the matched window id/class and geometry;
- the build commit and enabled-feature patch report;
- the exact project/task state exercised; and
- the artifact directory.

After sending Ctrl-C to the harness, confirm that the selected X socket, Xvfb,
window manager, and app processes are gone. Remove the temporary
credential-bearing `CODEX_HOME`. Do not report completion while a display
socket or test process remains; deterministic Xvfb teardown is part of the
acceptance result.

## Scope And Limitations

Xvfb is appropriate for app launch, window, menu, dialog, focus, and ordinary
pointer/keyboard testing. It is not a full VM: host kernel services remain
shared, GPU behavior normally uses a software rendering path, and desktop
portals, tray integration, multi-monitor behavior, and compositor-specific
behavior may differ from a real workstation. Use a dedicated VM when one of
those boundaries is the behavior under test.
