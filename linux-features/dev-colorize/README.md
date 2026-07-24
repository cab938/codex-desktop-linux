# Dev Build Colorize

`dev-colorize` is an optional Linux feature for visually distinguishing a
development build from the normal application. When the feature is included,
the bottom **developer controls** popover (the rotated Help icon, or `¿`)
contains a **Colorize** toggle, a compact **Tint** color picker, and a
**Strength** slider. The feature does not add a top application menu.

Colorize is on by default for a newly built app identity. In the light theme it
colors only the 30-pixel title-bar strip containing the app menu/header and the
minimize, maximize, and close controls. The sidebar, editor, conversation, and
other application surfaces keep their normal theme colors. Changing the tint
or its strength updates the title bar immediately. Strength defaults to 40
percent so saturated custom colors remain subtle; 0 percent neutralizes the
selected tint while 100 percent uses it directly. The dark theme is
intentionally unchanged. Selecting **Colorize** again restores the normal
title-bar color immediately.

The selected state is stored in `dev-colorize.json` beside the launcher's
per-app settings file. Side-by-side app IDs therefore keep independent
selections. The feature never writes into another app identity's configuration.

## Enable

Add `dev-colorize` to the gitignored `linux-features/features.json` before
building a development app. The developer-controls host currently belongs to
`teaching-sidebar-filter`, so both features must be enabled:

```json
{
  "enabled": ["teaching-sidebar-filter", "dev-colorize"]
}
```

The tracked example configuration remains empty, so production and ordinary
source builds do not receive the menu or palette unless a user opts in.

## Test

```bash
node --test linux-features/dev-colorize/test.js
```

For runtime verification, build with a distinct `CODEX_APP_ID` and run the
generated launcher in an isolated Xvfb session. Confirm that the bottom `¿`
popover contains **Teaching view**, **Colorize**, **Tint**, and **Strength**,
that the custom rows use the same type scale as the menu items, that no top
**Dev** menu is added, and that toggling or changing either control updates only
the title bar while the application body retains its normal theme colors.

## Maintenance risk

The feature patches the current shared-object repository in the main process,
the preload bridge, and the generic developer-controls host supplied by
`teaching-sidebar-filter`. All descriptors are fail-soft and idempotent.
Enabled-feature drift rejects a rebuild candidate under the repository's normal
acceptance policy.
