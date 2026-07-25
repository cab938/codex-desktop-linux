# WP-14 automated and actual-app acceptance

Date: 2026-07-24

Status: passed on the owning feature branch for the Linux-only v1 support
claim.

## Exact build identity

The accepted launcher resolved to:

```text
/home/brooksch/sandboxes/codex-desktop-linux-dev/codex-desktop-linux-dev-app/start.sh
```

The inspected `.codex-linux/build-info.json` recorded:

| Field | Accepted value |
| --- | --- |
| Source branch | `feature/collaborative-markdown-editor` |
| Source commit | `1281ef158e3fc7574ff35facd615b4a9a6ebb18c` |
| App ID | `codex-desktop-linux-dev` |
| Display name | `Codex Desktop Linux Dev` |
| Upstream app | `26.721.41059` |
| Electron | `42.3.0` |
| Enabled feature | `collaborative-markdown-editor` only |

The dirty marker was caused only by the repository-provided untracked,
read-only `.agents/` mount. The build was accepted with no feature drift. The
stock `codex-app/` and package-managed Codex application were not built,
promoted, launched, or modified.

## Automated suites

The final Node.js 24.15.0 feature run passed:

- strict TypeScript typecheck;
- 413 editor/component tests across 20 files;
- 7 feature, staging, lifecycle, and regression tests;
- 41 broker, persistence, concurrency, security, and platform tests;
- 3 official MCP SDK source/staged-plugin tests; and
- 1 deterministic CycloneDX SBOM test.

The official MCP SDK protocol harness exercised all thirteen tools, resource
reads, closed schemas, annotations, cancellation, timeouts, idempotency,
staleness, authorization, hidden metadata, stdio shutdown, and the
self-contained staged plugin. This is the standards-compliant MCP Apps host
equivalent for protocol acceptance; the exact Codex host supplied the visible
resource and lifecycle acceptance.

Repository-wide `scripts/patch-linux-window-ui.test.js` also passed all 387
tests. `tests/scripts_smoke.sh` reached its unrelated launcher warm-start
recovery case and then stopped because the available Python runtime lacks
`signal.pidfd_send_signal`; the launcher correctly refused to signal a
synthetic stale PID. Running that case outside the filesystem sandbox produced
the same host-runtime limitation. Its parent-death lock release, deliberately
pidfd-disabled normal-lock, and deliberately pidfd-disabled prelaunch-kill
variants all passed. No collaborative-editor code participates in that
launcher test, so it is retained as a precise host validation limitation rather
than represented as a feature failure or a passing full smoke run.

## Measured performance and bounds

An isolated Node.js 24.15.0 broker measurement used 1,992,293 bytes of
Markdown, 95 percent of the declared 2,097,152-byte limit:

| Operation | Measurement |
| --- | ---: |
| Open and construct the broker Yjs document | 14.4 ms |
| Small accepted Yjs edit transaction | 4.0 ms |
| Explicit durable atomic file flush | 19.3 ms |
| External-file watcher propagation | 80.4 ms |
| Additional resident memory after open | 13.5 MiB |
| Reject a 2,097,153-byte file | 0.4 ms, `FILE_TOO_LARGE` |

The visible human edit in the exact app updated CodeMirror immediately and
reached **Saved to Markdown** within the observation interval. The direct
transaction, watcher, and durable-flush measurements bound the underlying
keystroke, propagation, and file-write paths without including model latency.
The supported v1 maximum remains 2 MiB; above-limit input is rejected before
mutation.

## Actual Codex Desktop evidence

All visible runs used the exact launcher above, a disposable authenticated
`CODEX_HOME`, a disposable Git workspace, and the repository's authenticated
private Xvfb harness. The display and app processes were stopped, the display
failed `xdpyinfo`, and stale display sockets were removed at teardown.

The disposable project ended with one ordinary 379-byte `demo.md`, revision 8,
mode `0664`, and SHA-256
`05a682880f5db0ad45bf915e1a39aefe82885110788f8e3c8c6c7c1077f416f9`.
It contained the human, first Codex task, external-editor, second editor, and
second Codex task edits exactly once.

Retained screenshots:

| Evidence | What was inspected |
| --- | --- |
| `wp-14/screenshots/01-human-edit-durable.png` | Human CodeMirror edit and **Saved to Markdown** |
| `wp-14/screenshots/02-agent-edit-live.png` | Approved Codex tool edit visible in the still-open editor |
| `wp-14/screenshots/03-external-edit-live.png` | Ordinary file edit imported without reload |
| `wp-14/screenshots/04-restart-restored.png` | Revision and Markdown restored after service/app restart |
| `wp-14/screenshots/05-uninstalled-project-intact.png` | Plugin absent after UI uninstall; project retained |
| `wp-14/screenshots/06-reinstalled.png` | Plugin found and reinstalled through the actual Plugins UI |
| `wp-14/screenshots/07-two-ui-convergence-compact.png` | Two right-panel instances converged with two awareness entries |
| `wp-14/screenshots/08-second-agent-task.png` | A distinct Codex task accepted and durably flushed revision 8 |
| `wp-14/screenshots/09-two-task-convergence-maximized.png` | Maximized right panel shows both task edits and two UI presences |

The compact and maximized images were visually inspected, not inferred from
process exit. The accepted editor occupies the requested persistent right-side
Codex Desktop surface and preserves access to the task conversation and
composer.

## Scenario evidence map

1. **Open existing Markdown:** actual app plus official-SDK protocol test.
2. **Create Markdown:** `markdown_create` source/staged protocol cases prove
   idempotent creation under an approved disposable workspace.
3. **Human to file:** screenshot 01, byte inspection, and Git-backed fixture.
4. **Agent to UI:** screenshot 02 and revision/file equality.
5. **UI to agent context:** app-only hidden metadata and bounded-read protocol
   tests; selection never enters ordinary model-visible output.
6. **External editor:** screenshot 03 and watcher tests.
7. **Concurrent non-overlapping edits:** collaboration suite and final actual
   document containing all independent edits once.
8. **Concurrent conflicting edits:** deterministic preserved read-only
   conflict tests.
9. **Two UI instances:** screenshots 07 and 09; one broker and shared
   awareness.
10. **Two agent tasks:** screenshots 08 and 09 plus stale-revision/rebase and
    idempotency tests.
11. **Separate worktrees:** canonical identity and Local/Worktree host tests.
12. **Iframe reload:** UI session refresh and actual tab reopen evidence.
13. **Broker restart:** screenshot 04 and generation-fencing tests.
14. **Crash during flush:** child-process fault injection before rename, after
    rename, and after checkpoint.
15. **Rename/delete:** real watcher, safe-write, Git-style replacement,
    rename-away, delete, and no-resurrection tests.
16. **Out-of-scope path:** encoded traversal, canonical escape, symlink, and
    hard-link security cases.
17. **Unauthorized realtime client:** scoped app-session capability, wrong
    document, origin, and bearer rejection tests.
18. **Large document:** measurements above and exact above-limit rejection.
19. **Markdown safety:** hostile HTML/link/image and oversized-construct
    component/security tests.
20. **Disable/uninstall:** actual UI uninstall and reinstall plus staged stdio
    shutdown tests. The current host can retain an already-started stdio
    process after uninstall until Codex Desktop exits; restarting the app is
    the documented required shutdown step. App exit stopped the adapter,
    broker, and listener, while the project Markdown remained intact.

## Residual scope

The verified support statement is Linux-only. The exact macOS and Windows
operator gates remain in `wp-13-portability.md` and are not represented as
passing evidence. The current Codex host's uninstall lifecycle has no public
plugin callback for terminating an already-started stdio process; operators
must close and restart Codex Desktop after uninstall. This limitation neither
deletes nor locks the durable Markdown file after app exit.
