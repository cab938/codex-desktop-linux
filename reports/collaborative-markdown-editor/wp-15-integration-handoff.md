# WP-15 integration and handoff

Date: 2026-07-24

Status: complete for Linux v1.

## Branch integration

The owning branch was verified at:

```text
feature/collaborative-markdown-editor
dc76fdd551a305ce55e40d78289a144fa75693ab
```

It was merged with ancestry preserved into:

```text
dev/combined
06202ce54943132e63c5d63cedcceddbec447fb1
```

The merge parents are the previous `dev/combined` head
`8d71a32541bed62194c4b1a785fef4a05f496009` and the actual owning feature
branch head above. Four current-main integration conflicts were reconciled in
the existing core patch/test files; the merged core suite passed 388 tests.

The session-provided `.agents/` directory is a read-only untracked mount in the
primary worktree, so Git correctly refused to overwrite it during a branch
checkout. Integration and its exact build were therefore performed in the
clean linked worktree `/tmp/codex-collab-dev-combined`. The real
`dev/combined` branch reference and merge ancestry are updated; no mounted
agent files were moved, removed, staged, or committed.

## Combined validation

The ignored local feature configuration enabled:

1. `dev-colorize`
2. `dev-inverse-icon`
3. `teaching-sidebar-filter`
4. `project-work`
5. `quick-launcher`
6. `collaborative-markdown-editor`

The combined focused integration run passed 71 tests. The merged core patch
suite passed 388 tests. The complete collaborative-editor suite passed 413
editor/component, 7 feature, 41 broker/security/platform, 3 official-SDK MCP,
and 1 SBOM tests.

`tests/scripts_smoke.sh` has the precise unrelated host limitation recorded in
`wp-14-acceptance.md`: this Python runtime lacks `signal.pidfd_send_signal`, so
the launcher safely refuses the synthetic stale-PID termination case. Three
parent-death, normal-lock, and deliberately pidfd-disabled variants passed.

## Exact combined build

The build command was:

```bash
NPM_CONFIG_CACHE=/tmp/codex-collab-wp15-npm-cache \
  make build-dev-app \
    DEV_APP_ID=codex-desktop-linux-dev \
    DEV_APP_NAME='Codex Desktop Linux Dev'
```

The supported launcher resolves to:

```text
/tmp/codex-collab-dev-combined/codex-desktop-linux-dev-app/start.sh
```

The inspected build metadata records:

| Field | Value |
| --- | --- |
| Branch | `dev/combined` |
| Commit | `06202ce54943132e63c5d63cedcceddbec447fb1` |
| App ID | `codex-desktop-linux-dev` |
| Display name | `Codex Desktop Linux Dev` |
| Upstream app | `26.721.41059` |
| Electron | `42.3.0` |
| Source dirty | `false` |
| Acceptance | `accepted`, no warnings or blockers |

All six intended features appear in `build-info.json` and the acceptance
report. The stock `codex-app/`, package-managed application, and user's normal
Codex plugin inventory were not built, promoted, launched, or modified.

## Visible integrated smoke

The exact combined launcher passed the authenticated private Xvfb harness. The
visible task and right-side production MCP App restored the accepted revision
8 Markdown document with **Saved to Markdown** and the human, agent,
external-editor, second-editor, and second-task changes exactly once.

The inspected screenshot is:

```text
reports/collaborative-markdown-editor/wp-15/combined-editor.png
```

SHA-256:
`7f7da371d541a66ee625c522daf38eaabc21e9c43be1d331f302bdb6b6941f55`.
The app, window manager, Xvfb, and display socket were removed after capture.
The host's NVIDIA EGL provider crashed Xvfb during two initial startup attempts;
pinning the harness process to the installed Mesa EGL vendor allowed the
private software-rendered display to start. This is host graphics plumbing, not
a Codex or editor runtime dependency.

## Operator documentation

- Install, use, recover, uninstall, and support guide:
  `docs/collaborative-markdown-editor.md`
- Feature architecture and maintainer commands:
  `linux-features/collaborative-markdown-editor/README.md`
- Pinned donor update guide:
  `linux-features/collaborative-markdown-editor/UPSTREAM.md`
- Licenses and notices:
  `linux-features/collaborative-markdown-editor/THIRD_PARTY_NOTICES.md`
- Protocol:
  `reports/collaborative-markdown-editor/wp-08-mcp-surface.md`
- Security and SBOM:
  `reports/collaborative-markdown-editor/wp-12-security.md`
- Full scenario and performance evidence:
  `reports/collaborative-markdown-editor/wp-14-acceptance.md`

## Remaining external gates

No Linux v1 implementation or operator gate remains.

- macOS is an unverified unpublished candidate. Run the exact Node 20/24 and
  official Codex Desktop `26.721.31836` gates in `wp-13-portability.md` before
  claiming support.
- Windows remains build-only and fails closed with
  `PLATFORM_UNSUPPORTED` until a reviewed atomic replacement primitive and the
  exact Windows runtime/UI matrix pass.
- Public marketplace publication, push, pull request, and package-managed
  installation were not authorized and were not performed.

After uninstalling in the current Codex Desktop host, close and restart Codex
Desktop to guarantee termination of an already-started stdio adapter and
broker. Project Markdown remains intact and readable throughout.
