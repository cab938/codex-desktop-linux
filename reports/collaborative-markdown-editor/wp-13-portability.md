# WP-13 runtime portability and support statement

Date: 2026-07-24

Status: complete with a deliberately narrow v1 support claim. Linux is the
only supported/verified runtime. macOS is a candidate with exact external
gates. Windows is build-only and fails closed at runtime.

## Runtime decision

The plugin uses the Codex host-managed `node` executable directly:

```json
{
  "command": "node",
  "args": ["./runtime/server.mjs"],
  "cwd": "."
}
```

The minimum runtime is Node.js 20. The current managed-runtime contract is also
tested on Node.js 24. No Python service, shell wrapper, native Node add-on,
platform-specific executable, globally installed package, or inherited user
`PATH` dependency is required.

The production payload is three self-contained JavaScript/HTML files. Node
built-ins remain external and are provided by the managed runtime. The plugin
contains no `node_modules` at runtime.

## Support tiers

| Platform | V1 status | Evidence or reason |
| --- | --- | --- |
| Linux x64, Ubuntu 24.04/GNOME development host | Supported after WP-14 exact-app acceptance | Full source, protocol, broker, persistence, security, plugin lifecycle, and SBOM suites pass on Node 20.19.0 and 24.15.0; side-by-side Codex build is next |
| macOS | Candidate, not supported or published | Pure Node/POSIX design and a full candidate CI job exist, but neither the workflow nor official Codex Desktop installation has run in this checkout |
| Windows | Unsupported, build-only | Node can build/typecheck/test the web and portable contract, but replacing an existing file with `fs.rename` does not provide the required atomic-replacement invariant on Windows without a native/platform helper |

The broker calls `assertSupportedRuntimePlatform` before initialization.
Windows returns `PLATFORM_UNSUPPORTED` rather than opening a document and
failing later during durability. macOS is allowed to run for candidate
testing, but documentation does not claim support until the gates below pass.

## Cross-platform CI contract

`.github/workflows/collaborative-markdown-editor.yml` defines six independent
jobs:

| Runner | Node | Contract |
| --- | ---: | --- |
| `ubuntu-latest` | 20, 24 | full `npm test` |
| `macos-latest` | 20, 24 | `npm run test:portable` (all plugin tests except Linux feature staging) |
| `windows-latest` | 20, 24 | `npm run test:build-contract` (typecheck, 411 component tests, deterministic builds/SBOM, portable platform tests) |

All jobs install with `npm ci --ignore-scripts --no-audit --no-fund`. The
workflow is path-scoped to this feature and can be run manually. It records
the support tier explicitly in the GitHub job summary so a green Windows
build cannot be mistaken for persistence support.

This workflow is committed but cannot be reported as run until the branch
exists on GitHub; no push or remote workflow dispatch was authorized by the
project contract.

## Portable semantics covered

The retained suites and `server/test/platform.test.mjs` cover:

- Linux, macOS, and Windows private state-root construction;
- case-folded Windows and case-sensitive Linux document identity;
- Unicode NFC identity and Unicode relative filenames;
- rejection of Windows separators, UNC-like paths, traversal, symlinks, and
  hard links;
- LF/CRLF codec behavior and final-newline preservation;
- POSIX mode preservation on supporting hosts and an explicit `null` mode on
  Windows;
- directory-lock ownership, stale-lock recovery, adapter shutdown, and broker
  restart;
- safe-write watcher import, rename/delete detection, atomic replacement,
  directory synchronization, and crash points on Linux;
- deterministic browser, MCP server, broker, and SBOM builds without native
  modules.

Linux tests run on the real host filesystem. Simulated path/state-root tests
are not presented as macOS or Windows runtime evidence.

## Exact external gates

### macOS CI gate

After the branch is pushed by an authorized maintainer:

1. Dispatch `.github/workflows/collaborative-markdown-editor.yml` at the exact
   candidate commit.
2. Require both `macos-latest` jobs (Node 20 and 24) to pass
   `test:portable`.
3. Retain the workflow URL, run ID, commit SHA, runner image, Node versions,
   and test summaries in this report.

Expected result: 411 component tests, 38 broker/file/platform/security tests,
3 MCP/staged-plugin tests, and 1 SBOM test pass on each macOS runner.

### official macOS Codex Desktop gate

Use official Codex Desktop `26.721.31836`, the same upstream app version as the
Linux side-by-side baseline:

1. Install the local marketplace into a disposable Codex home.
2. Install and enable plugin `collaborative-markdown-editor` version `0.1.0`.
3. Confirm the direct `node ./runtime/server.mjs` process starts with the host
   managed runtime.
4. Run scenarios 1–20 from `.codex/work-packages.md`, including two UI
   instances, two tasks, watcher import, crash/restart, and uninstall.
5. Return the app version, macOS version/architecture, plugin diagnostics,
   exact file hashes, screenshots, and scenario manifest.

Expected result: behavior matches the Linux accepted manifest. Until that
evidence exists, macOS remains unverified and unsupported.

### Windows implementation and official-app gate

The exact upstream baseline is Codex Desktop `26.721.31836`. Before any
official Windows app test:

1. implement a Windows replacement primitive that atomically replaces an
   existing target, preserves crash guarantees, and adds no unreviewed broad
   filesystem capability;
2. run the full persistence/crash/watcher suite on Windows Node 20 and 24;
3. remove the `PLATFORM_UNSUPPORTED` fence only after that suite passes; and
4. then run scenarios 1–20 in the official Windows Codex Desktop build of that
   version with a disposable home.

Expected result: prior-or-complete file visibility at every crash point and no
missing-target window. Build-only CI is not sufficient. Windows remains
unsupported until all four steps are evidenced.

## Local evidence

Linux host:

- Node.js 20.19.0: full suite passed.
- Node.js 24.15.0: full suite passed.
- Editor/component tests: 411 passed per runtime.
- Linux feature/stage/cleanup tests: 5 passed per runtime.
- Broker/file/concurrency/security/platform tests: 38 passed per runtime.
- Official SDK source/staged-plugin tests: 3 passed per runtime.
- Deterministic SBOM tests: 1 passed per runtime.
- Windows build-contract command: passed locally as a contract simulation, not
  as a Windows runtime.
- Workflow YAML parse: passed.

Production artifacts:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `dist/mcp/mcp-app.html` | 3,796,652 | `2eb7ae24ce1ace9451e8a76b7d18c9ebe3c784a8b28f8d2e22d6c716bed95819` |
| `dist/plugin/server.mjs` | 373,094 | `cdf11a08d485bf8581077a91a8b25aa7858ef0aea2de8ef790f2540c589b8b08` |
| `dist/plugin/broker.mjs` | 158,589 | `511717eff9d44dcaf8e0c0c3ba3868e090547913c7b2e52e27cb0ded27fb2ce1` |
| `SBOM.cdx.json` | 94,983 | `34d7333299c798cc74225342b8aef9a5e806db8f4815e698475eb597a812f794` |
