# WP-12 security and trust-boundary verification

Date: 2026-07-24

Status: complete for the implemented plugin boundary. Exact Codex host
enforcement of MCP App visibility and hidden metadata remains an explicit
WP-14 actual-app acceptance check.

## Trust model

Trusted:

- the user who explicitly approves one canonical workspace root in the MCP App;
- the Codex Desktop host and its MCP Apps bridge;
- the direct Node MCP adapter and private broker process;
- the current operating-system user and ordinary local filesystem semantics.

Untrusted:

- model-supplied tool arguments;
- Markdown text and rendered syntax;
- Yjs updates and UI awareness payloads;
- external editor writes, safe-write replacements, and watcher events;
- HTTP clients on the local machine;
- stale, wrong-document, or replayed UI capabilities;
- dependency and generated-bundle inputs until audited.

Out of scope:

- compromise of the current OS account, privileged bind-mount manipulation, or
  a hostile Codex Desktop host;
- confidentiality from another process already running as the same user;
- encryption of the ordinary project Markdown or plugin-private recovery state.

## Authorization and containment

The broker separates `public`, `app`, and `admin` dispatch classes. Public
model-facing calls cannot propose, authorize, revoke, or invoke UI sync
operations. Workspace authorization requires an app-created proposal, a
32-byte random confirmation capability, the exact canonical root, and
`confirmed: true`.

Revocation persists the approval removal, destroys every open document session
under that root, invalidates UI sessions and adapter leases, and leaves
project Markdown unchanged. A fenced document cannot be read or reopened until
the user approves the root again.

Every document path must:

- be root-relative, forward-slash separated, and Markdown-suffixed;
- contain no empty, dot, dot-dot, NUL, backslash, decoded slash, decoded
  backslash, or encoded traversal segment;
- remain contained after path resolution and `realpath`;
- contain no symlink component;
- resolve to one regular file with exactly one hard link; and
- pass strict UTF-8, line-ending, size, and NUL checks.

Rejecting multiple hard links closes the otherwise invisible case in which a
contained regular path aliases an outside file. Tests cover POSIX/Windows-style
absolute forms, mixed-case percent encoding, encoded separators, double
encoding, directories, Unix sockets, symlinks, hard links, invalid UTF-8,
isolated UTF-16 surrogates, and oversized sparse files.

The isolated-surrogate test found and fixed a real validation defect: a lone
high surrogate at end-of-string previously compared an undefined next code
unit as `NaN` and could be silently encoded as U+FFFD. Both file creation and
agent-edit validation now reject it before mutation.

## Broker and capability boundary

The broker now refuses any bind host other than `127.0.0.1`. It uses an
unpredictable 32-byte bearer stored only in a mode-0600 descriptor under the
mode-0700 state root. Missing/wrong bearers return 401, browser-origin requests
return 403 even with the bearer, responses send `cache-control: no-store`, and
no CORS allowance is emitted.

The MCP App never connects to the broker. Its declared CSP has no connect or
resource domains; synchronization goes through app-only MCP tools. UI session
capabilities are 32 random bytes, document/session/generation/epoch scoped,
constant-time compared, expired after inactivity, rotated on refresh, and
invalid across documents or generations. Capabilities stay in hidden MCP
metadata and are absent from model-visible content, structured status,
process arguments, process environment, and broker responses.

The raw MCP protocol itself cannot prove a human click. That property depends
on the trusted Codex host enforcing `ui.visibility: ["app"]` and not exposing
hidden result metadata to the model. The production server also requires the
one-time hidden authorization capability, but a malicious MCP client that owns
the entire transport is equivalent to a hostile host. WP-14 therefore retains
an exact-app check that the model cannot see or invoke the authorization tool.

## Resource and input bounds

Retained and newly exercised limits include:

| Resource | Limit |
| --- | ---: |
| Markdown file | 2 MiB |
| Open documents | 16 |
| Adapter leases per document | 32 |
| UI sessions per document | 8 |
| Agent edits per transaction | 256 |
| Replacement/UI update bytes | 512 KiB |
| Broker HTTP request | 1 MiB |
| UI updates per session | 200 / 10 s |
| Awareness events per session | 200 / 10 s |
| Outstanding long polls per UI session | 1 |
| UI sequence receipts | 256 |
| Idempotency receipts | 4,096 / 24 h |
| Recovery log before compaction | 4,096 records or 8 MiB |

Yjs updates are applied to an isolated probe first, may change only the shared
`content` type, must retain LF-normalized valid text, and cannot exceed the
document limit. Agent edits require valid non-overlapping UTF-16 ranges and
valid Unicode. Atomic persistence re-checks regular-file type and expected
content identity immediately before replacement; a symlink swap is rejected
and the outside target is not modified.

## Markdown and UI safety

The production component is a self-contained single-file resource with no
remote script, stylesheet, frame, or image dependency. Raw HTML remains
Markdown source. Image syntax is inert in the production editor. External
links are opened only through the host and only for parsed `http`, `https`, or
`mailto` URLs. Tests reject JavaScript (including embedded-NUL spelling), data,
VBScript, file, and relative schemes. UI text and presence names are assigned
with text APIs rather than HTML injection.

## Supply chain and SBOM

`scripts/generate-sbom.mjs` deterministically emits and stages
`SBOM.cdx.json` in CycloneDX 1.5 format. It inventories 152 unique libraries in
the locked production dependency graph plus the exact three self-contained
runtime files and their SHA-256 hashes. Every inventoried library has an SPDX
identifier or retained license name. `THIRD_PARTY_NOTICES.md` and the vendored
license texts remain staged beside it.

`npm ci` runs with `--ignore-scripts`; the feature has no native dependency.
`npm ls --omit=dev --all` passes. `npm audit --omit=dev` reports three moderate
entries for the current MCP SDK/ext-apps path through
`@hono/node-server` and GHSA-frvp-7c67-39w9, with no fix available. This
package is present in the locked build graph but absent from the staged
server/broker bundles; the staged-plugin test rejects any Hono,
`serveStatic`, or Express rate-limit code.

## Automated evidence

Environment: Node.js 20.19.0.

- Strict typecheck: passed.
- Editor/component suite: 411 tests passed.
- Feature/stage/cleanup suite: 5 tests passed.
- Broker/file/concurrency/security/platform suite: 38 tests passed.
- Official SDK source and self-contained staged-plugin suite: 3 tests passed.
- Deterministic SBOM suite: 1 test passed.
- Full `npm test`: passed.
- `npm ls --omit=dev --all`: passed.
- Stage/cleanup shell syntax: passed.
- `git diff --check`: passed.

Production artifacts:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `dist/mcp/mcp-app.html` | 3,796,652 | `2eb7ae24ce1ace9451e8a76b7d18c9ebe3c784a8b28f8d2e22d6c716bed95819` |
| `dist/plugin/server.mjs` | 373,094 | `cdf11a08d485bf8581077a91a8b25aa7858ef0aea2de8ef790f2540c589b8b08` |
| `dist/plugin/broker.mjs` | 158,589 | `511717eff9d44dcaf8e0c0c3ba3868e090547913c7b2e52e27cb0ded27fb2ce1` |
| `SBOM.cdx.json` | 94,983 | `34d7333299c798cc74225342b8aef9a5e806db8f4815e698475eb597a812f794` |

## Residual risks and later gates

- Exact host enforcement of app-only visibility and hidden metadata is tested
  in WP-14, because a raw MCP client controls both sides of that trust boundary.
- macOS and Windows filesystem semantics remain WP-13 external/runtime gates;
  no parity claim is inferred from Linux.
- A same-user malicious process can read same-user project files and may read
  mode-0600 state. This plugin does not claim to sandbox the OS account.
- Privileged mount replacement can invalidate ordinary pathname assumptions
  and is outside the plugin's authority.
