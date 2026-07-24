# Dev Build Inverse Icon

`dev-inverse-icon` is an optional Linux feature for distinguishing the
side-by-side development app from a stock Codex installation. It inverts the
red, green, and blue channels of the current upstream application icon while
preserving every alpha value. Black becomes white, white becomes black, and
transparent edges retain their original transparency.

The feature installs its transform before the Electron main bundle loads. It
applies only when the main process opens either the packaged ChatGPT icon or the
current `app-*.png` webview icon used by the Linux tray and window patches.
Other images loaded by the app are not changed. Because the transform consumes
the icon included in the current DMG at runtime, it follows upstream logo
changes without storing a stale duplicate asset.

## Enable

Add `dev-inverse-icon` to the gitignored
`linux-features/features.json` before building the development app:

```json
{
  "enabled": ["dev-inverse-icon"]
}
```

The tracked example configuration remains empty, so production and ordinary
source builds do not receive the inverted icon unless a user opts in.

## Test

```bash
node --test linux-features/dev-inverse-icon/test.js
```

For runtime verification, build the side-by-side app, run its exact launcher
in an isolated Xvfb session, and inspect the captured window metadata and
pixels. Xvfb does not provide a desktop system tray, so tray-host behavior
requires a real desktop session or VM; the unit test directly verifies the
tray icon loader path and exact pixel transform.

## Maintenance risk

The feature prepends a fail-soft, idempotent main-process runtime. It depends
on Electron's `nativeImage` bitmap APIs and the two application-icon path
shapes supplied by the current core Linux patches. Enabled-feature drift
rejects a rebuild candidate under the repository's normal acceptance policy.
