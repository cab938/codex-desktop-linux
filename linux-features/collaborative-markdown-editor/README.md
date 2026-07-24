# Collaborative Markdown Editor

This disabled-by-default Linux feature is the repository integration boundary
for a Codex Desktop plugin that will let a person and Codex agents edit the same
workspace Markdown file through a shared Yjs document.

The feature is currently an intentionally inert shell. It has no ASAR patch,
staged application resource, runtime hook, package hook, or bundled plugin.
Those integration points will be added only after the current Codex plugin and
MCP App host contract has been verified in the side-by-side development app.

## Scope

The planned v1:

- binds only UTF-8 Markdown files inside authorized project or worktree roots;
- keeps the Markdown file as the durable, interoperable document;
- renders a CodeMirror/Glyphdown editor as an MCP App;
- uses a local broker-owned `Y.Doc` for UI and agent mutations; and
- remains optional and removable without deleting project Markdown.

Cloud collaboration, accounts, a generic filesystem server, Tandem code reuse,
and modification of the stock Codex installation are outside this feature's
scope.

## Lifecycle commands

The shell has dependency-free, deterministic lifecycle commands:

```bash
npm run build
npm run stage
npm test
npm run clean
```

Run them from this directory. `build` writes a canonical shell manifest to
the ignored `dist/` directory. `stage` copies that artifact into an isolated
`dist/stage/` tree; it does not write into a generated application. `test`
validates the manifest, disabled-default behavior, empty feature install plan,
and deterministic lifecycle. `clean` removes only this feature's `dist/`.

The eventual production build and declarative staging contract will replace
the shell artifact after the host and transport spikes establish the required
runtime shape.

## Local enablement

Do not commit enablement. When the feature has runtime behavior to exercise,
add its ID only to the ignored `linux-features/features.json`:

```json
{
  "enabled": [
    "collaborative-markdown-editor"
  ]
}
```

The committed `linux-features/features.example.json` must remain empty.

## Current risks and gates

- Codex Desktop must prove an acceptable persistent right-side MCP App surface.
- A sandboxed MCP App must prove a secure realtime Yjs transport to the local
  broker.
- The process lifecycle must guarantee one writable broker per canonical file.
- Linux, macOS, and Windows support claims require platform-specific evidence.

The durable requirements and acceptance matrix live in
`.codex/work-packages.md`.
