# WP-10 plugin packaging

Date: 2026-07-24

Status: package implementation and isolated lifecycle acceptance complete; the
exact Codex Desktop install remains gated on the side-by-side development
rebuild.

## Package shape

The tracked source marketplace is:

```text
linux-features/collaborative-markdown-editor/plugin-marketplace/
├── .agents/plugins/marketplace.json
└── plugins/collaborative-markdown-editor/
    ├── .codex-plugin/plugin.json
    ├── .mcp.json
    ├── assets/icon.svg
    └── skills/collaborative-markdown-editor/
        ├── SKILL.md
        └── agents/openai.yaml
```

The manifest has the stable plugin name
`collaborative-markdown-editor`, valid semantic version `0.1.0`, accurate local
file and interactive-write capabilities, and a single companion MCP
configuration. The configuration runs:

```text
node ./runtime/server.mjs
```

with `cwd: "."`. It uses no shell, `/usr/bin/env`, Python, native add-on, or
user-selected runtime. WP-02 proved that the Codex Desktop plugin host resolves
this direct `node` command to its app-managed Node runtime.

The plugin-creator validator passed. The companion skill also passed the
skill-creator validator and has matching `agents/openai.yaml` metadata.

## Deterministic build and staged payload

The source builds three production files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `dist/mcp/mcp-app.html` | 3,796,652 | `2eb7ae24ce1ace9451e8a76b7d18c9ebe3c784a8b28f8d2e22d6c716bed95819` |
| `dist/plugin/server.mjs` | 373,073 | `e0cb98957dca49d3d5e321d678b0d82577efe38003dca31320a553ce039dbb52` |
| `dist/plugin/broker.mjs` | 157,303 | `987f5e7b5ab5cdd7f637ac7811999226dba29895848ac3d17699d9f251abe283` |

Two consecutive builds produced the same hashes. The existing independent
editor preview remains in the lifecycle manifest as non-plugin development
evidence, but it is not copied into the plugin.

The plugin has no staged `node_modules`. Vite/Rolldown bundles only reachable
ESM dependencies while leaving Node built-ins external. A runtime inspection
and staged-plugin test prove that `@hono/node-server`, `serveStatic`, and
`express-rate-limit` are absent.

`npm audit --omit=dev` still reports three moderate entries for the current
MCP SDK's transitive `@hono/node-server <2.0.5` Windows path-traversal advisory,
with no fix available. This is a lockfile/development-graph finding, not a
shipped reachable path: the staged runtime excludes that package and provides
no Hono or HTTP static-file server.

## Linux feature staging

The feature remains disabled by default and adds no ASAR patch, runtime hook,
or package hook.

- One declarative resource copies the tracked plugin source into the app's
  existing `openai-bundled` plugin tree.
- `stage.sh` installs locked build dependencies only when absent, runs the
  deterministic production build, copies the three generated files plus the
  repository MIT license and third-party notices, and appends an `AVAILABLE`
  / `ON_INSTALL` marketplace entry.
- `cleanup.sh` removes only this plugin and its marketplace entry.
- Both hooks pass `bash -n`.
- A temporary-install test preserves an unrelated marketplace entry while
  staging and cleaning every owned payload file.
- `features.example.json` remains empty and no local enablement is committed.

No generic Codex or launcher touchpoint was required.

## Process and uninstall lifecycle

Every MCP stdio process has an opaque adapter identity. UI sessions now record
their owning adapter. When stdin closes or the process receives SIGTERM/SIGINT,
the adapter sends an authenticated release to the shared broker.

The broker then:

1. removes that adapter's leases and UI sessions from every document;
2. flushes and checkpoints documents with no remaining clients;
3. preserves other live adapters and their documents; and
4. when the last adapter leaves, removes its private descriptor, releases
   document and broker locks, closes the loopback listener, and exits.

The multi-process test proves the first adapter does not stop a two-adapter
broker and the second does. The self-contained staged-plugin test starts the
bundled server and broker, reads the production UI resource, triggers a real
authorization render, closes stdio, waits for the broker descriptor to
disappear, deletes the plugin, and confirms the workspace Markdown bytes are
unchanged.

Plugin-private recovery state intentionally remains in the platform-native
state root. It is not required to read the Markdown and is not deleted during
uninstall.

## Automated evidence

Environment: Node.js 20.19.0.

- Strict typecheck: passed.
- Editor/component suite: 411 tests passed.
- Feature/stage/cleanup suite: 5 tests passed.
- Broker/file/multi-process/concurrency suite: 30 tests passed.
- Official SDK source and self-contained staged-plugin suite: 3 tests passed.
- Plugin validator: passed.
- Skill validator: passed.
- Stage and cleanup shell syntax checks: passed.
- Deterministic hashes: passed across two builds.

## Remaining acceptance gate

The WP-10 parent remains open until the exact side-by-side development app is
rebuilt with the feature enabled, its `build-info.json` is verified, and a
disposable Codex home installs/starts the staged plugin through the real
marketplace UI or CLI. That run also closes the remaining WP-08 and WP-09 host
gates. It must use the authenticated private Xvfb harness and must not touch the
stock application.
