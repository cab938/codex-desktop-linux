# WP-02: Codex Desktop plugin and MCP App host contract

Date: 2026-07-24

Outcome: **host gate passed** for the installed side-by-side Linux development
application. A locally installed Codex plugin can render an MCP App and request
`fullscreen`; this Codex Desktop host maps that request to a native right-side
tab while retaining the task conversation and composer. No Codex host patch is
required for v1.

## Exact system under test

- Development launcher:
  `./bin/codex-desktop-linux-dev --new-instance`
- App identity: `codex-desktop-linux-dev` /
  `Codex Desktop Linux Dev`
- Installed app version: `26.721.31836`
- Electron: `42.3.0`
- Upstream DMG SHA-256:
  `ff6e8ac9985aec44caa305787552e4ea517a7c745aef283bd4cbcab992de64b7`
- Installed development build source:
  `8d71a32541bed62194c4b1a785fef4a05f496009` on `dev/combined`
- Investigation branch and probe source:
  `feature/collaborative-markdown-editor`, commit
  `020c06388610b247b50b536a828e402dbbfb28ad`
- Plugin home: a disposable `CODEX_HOME` rooted at
  `/tmp/codex-collab-markdown-wp02-home.773wHL`
- Display: authenticated, host-invisible Xvfb displays `:97` and `:90`; no
  stock app, inherited display, or physical pointer was used.

The installed development app predates this feature branch. That is deliberate
for this host probe: it tests the current unmodified host. WP-14 will rebuild
the side-by-side app from the final feature commit and verify its new
`build-info.json`.

## Official contract

The official sources refreshed for this investigation were:

- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Build plugins](https://developers.openai.com/codex/plugins/build)
- [ChatGPT UI in plugins](https://developers.openai.com/plugins/build/chatgpt-ui)
- [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- [Build an MCP App](https://modelcontextprotocol.io/extensions/apps/build)
- [MCP Apps client matrix](https://modelcontextprotocol.io/extensions/apps/client-matrix)

The locally installed probe follows the documented shape:

```text
plugin/
├── .codex-plugin/plugin.json
├── .mcp.json
├── server.mjs
└── dist/mcp-app.html
```

The manifest points `mcpServers` to `.mcp.json`. The MCP configuration starts
`node ./server.mjs` over stdio with `cwd: "."`. The server registers:

- one render tool with `_meta.ui.resourceUri`;
- one versioned `ui://` resource;
- MIME type `text/html;profile=mcp-app`;
- a deny-by-default resource CSP; and
- an MCP Apps `postMessage` bridge client.

The plugin was added through a disposable local marketplace, installed into
that disposable home, and reported enabled by `codex plugin list --json`.
Codex copied it into its versioned plugin cache. A new app process discovered
and started the bundled server without a separate development terminal.

## Installed-host implementation check

Static inspection of the installed webview bundle confirmed that the host
recognizes all of:

- `_meta.ui.resourceUri` and `_meta["ui/resourceUri"]`;
- the legacy `_meta["openai/outputTemplate"]`;
- `text/html;profile=mcp-app` and the legacy Skybridge MIME type;
- `openai/ui` thread, global, and file entrypoint metadata; and
- the MCP App display-mode bridge.

The host advertises the `fullscreen` feature. Its current display-mode handler
accepts `inline` and `fullscreen`; the fullscreen path creates or moves the MCP
App into a right-side capability tab. An unsupported request returns the
current granted mode.

An `openai/ui` thread entrypoint with `visibility: ["app"]` did not appear in
the right-panel new-tab catalog in this account. That catalog path is gated in
the installed bundle. V1 must therefore not rely on the entrypoint being
visible. The reliable path is a dedicated render tool whose MCP App
capability-detects `requestDisplayMode`, requests `fullscreen`, and remains
usable inline if the request is unavailable or denied.

## Observed presentation behavior

The probe was first rendered by calling `open_host_probe`.

| Request | Granted result | Visible host behavior |
| --- | --- | --- |
| `inline` | `inline` | Component remains in the task transcript |
| `fullscreen` | `fullscreen` | Component moves to a persistent native right-side tab; conversation and composer remain on the left |
| `pip` | current `fullscreen` | No picture-in-picture surface; host safely retains the existing right-side mode |

In this Codex Desktop build, “fullscreen” is host protocol terminology for the
desired right-side editor placement. The tab also exposes the native
expand-to-full-width control. The feature should call the product surface a
right-panel editor while treating `fullscreen` as the currently required host
request, not as a portable guarantee that every MCP Apps client uses the same
geometry.

Resource behavior was also observable: the host read
`ui://collaborative-markdown-host-probe/v1/index.html` once for the initial
render. Repeated inline/fullscreen/PiP transitions moved the existing
component and produced no additional resource read. Incompatible UI changes
must therefore use a new resource URI.

## Project context and process lifecycle

The actual bundled server was launched with the app's managed Node runtime:

```text
codex-desktop-linux-dev-app/resources/node-runtime/bin/node
```

Its process working directory was the versioned plugin cache directory. The
following probed environment variables were all absent:

```text
CODEX_HOME PLUGIN_ROOT PLUGIN_DATA PWD
XDG_CONFIG_HOME XDG_DATA_HOME XDG_RUNTIME_DIR XDG_STATE_HOME
```

Neither the active project root, task cwd, Local/Worktree mode, nor secondary
project folders are automatically injected into the stdio server process. A
Local task and a Worktree task called the same plugin through different server
PIDs. Production tools must accept an explicit authorized workspace root and
document path, canonicalize both, and must not infer project context from the
plugin process cwd. Secondary roots require the same explicit treatment.

One app session produced:

- a short-lived catalog/preflight server;
- multiple simultaneously live stdio server instances;
- distinct tool-serving PIDs for the Local and Worktree tasks; and
- additional catalog/UI connection processes.

All five live stdio processes exited cleanly when the app harness stopped.
A new exact-app launch then started a new process generation (PID `1481541`)
and stopped it cleanly during harness teardown. Consequently, an in-process
document map inside one MCP stdio server cannot provide the one-writer
invariant. Production architecture needs an attachable, single-instance
broker/daemon shared by all stdio MCP adapters, with generation fencing and a
machine-local ownership lock per canonical document.

## Security and portability conclusions

- Stdio is the correct Codex-to-plugin tool transport.
- Realtime CodeMirror/Yjs traffic still needs a separate bounded channel; one
  MCP tool call per keystroke is unsuitable.
- The MCP App must use a narrow CSP and capability-detect any OpenAI-specific
  display request.
- Dynamic realtime credentials must remain outside model-visible content.
- The installed server receives no reliable `PLUGIN_DATA` environment value.
  The production plugin must establish its state root through a tested,
  explicit mechanism rather than assuming that documentation variable reaches
  the MCP subprocess.
- This report proves Linux Codex Desktop behavior only. MCP Apps and
  `requestDisplayMode` are portable protocols, but the precise right-panel
  geometry remains unverified on official macOS and Windows desktop builds.
- `npm audit --omit=dev` reports the current SDK's transitive
  `@hono/node-server <2.0.5` Windows static-file traversal advisory
  (GHSA-frvp-7c67-39w9), with no available package-manager fix. The probe uses
  stdio and no Hono static-file server, so the vulnerable path is not exercised.
  Production dependency review must nevertheless resolve or formally exclude
  the path before release.

No missing-host architecture decision is required: the target surface exists.
The remaining transport and single-writer questions intentionally advance to
WP-03 and WP-04.

## Retained evidence

- Probe marketplace and source:
  `wp-02/host-probe-marketplace/`
- Full lifecycle event log:
  `wp-02/plugin-process-lifecycle.jsonl`
- Initial inline render:
  `wp-02/xvfb-session-2/probe-tool-result.png`
- Compact right-panel render:
  `wp-02/xvfb-session-2/mode-fullscreen-2.png`
- Unsupported PiP fallback:
  `wp-02/xvfb-session-2/mode-pip.png`
- Return to inline:
  `wp-02/xvfb-session-2/mode-inline.png`
- Inspected maximized 1920x1080 right-panel render:
  `wp-02/xvfb-session-2/maximized-right-panel.png`
- First-session app/Xvfb logs:
  `wp-02/xvfb-session-2/app.log`, `wp-02/xvfb-session-2/xvfb.log`
- Fresh restart smoke:
  `wp-02/restart-smoke/`

Automated evidence:

```text
node --test .../test.mjs
3 tests, 3 passed

npm run build
148 modules transformed
dist/mcp-app.html 343.74 kB (82.11 kB gzip)

MCP protocol harness
listed both tools; read the versioned resource with exact MIME type;
called the render tool successfully
```

Visible evidence was inspected, not inferred from process exit. The private
display sockets were absent after teardown.
