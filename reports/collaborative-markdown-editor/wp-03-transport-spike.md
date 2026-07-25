# WP-03: host-and-transport feasibility spike

Date: 2026-07-24

Decision: **GO**, using batched app-only MCP bridge tools for the production
realtime channel. Do not use a direct loopback WebSocket in the current Codex
Desktop iframe.

## Scope and exact host

The disposable plugin is retained under
`wp-03/transport-spike-marketplace/`. It was installed from that local
marketplace into the same disposable `CODEX_HOME` used for WP-02 and was
started only by the exact side-by-side launcher:

```text
./bin/codex-desktop-linux-dev --new-instance
```

Final accepted spike version: `0.3.1`.

The app used the packaged managed Node runtime. No development-terminal server
was used. All visible testing ran on authenticated, host-invisible Xvfb
displays. The stock Codex app and physical desktop were untouched.

## Implemented spike

The plugin contains:

- a valid `.codex-plugin/plugin.json` and `.mcp.json`;
- a versioned `ui://` resource with exact MIME type
  `text/html;profile=mcp-app`;
- CodeMirror 6 bound through `y-codemirror.next` to one `Y.Text`;
- one render tool and app-only transport tools;
- an attachable user-private broker started by the first MCP adapter;
- an atomic starter lock and user-only broker descriptor;
- loopback admin authentication between MCP adapters and the broker;
- a direct authenticated WebSocket experiment; and
- a merged-update push plus long-poll snapshot fallback over the MCP Apps
  bridge.

The first stdio adapter starts a detached broker. Later adapters read its
mode-`0600` descriptor, authenticate on loopback, and attach to the same broker
PID and generation. The UI ticket is returned only in tool-result `_meta`.
Model-visible content contains the document ID and generation but no bearer
value or loopback credential.

## Direct WebSocket result

The MCP App resource declared the exact dynamic
`ws://127.0.0.1:<port>` origin in its CSP. The render tool minted a valid,
document- and generation-scoped 256-bit capability and the UI received it in
hidden metadata.

The browser raised the WebSocket error, but the broker observed no HTTP
upgrade, no origin header, and no rejected capability event. Therefore the
current Codex iframe/Chromium policy blocks the insecure loopback WebSocket
before it reaches the local service. The failure was not caused by broker
origin validation or token validation.

Self-signed `wss://` would create an unshipped trust-store dependency and is
not a reasonable cross-platform plugin contract. The direct WebSocket branch
is a no-go for v1.

## Accepted MCP bridge transport

The fallback uses only host-proxied app-to-server calls:

- `transport_spike_push` is app-only and receives one merged Yjs update batch
  after an 80 ms debounce;
- `transport_spike_pull` is app-only and long-polls the broker for up to five
  seconds, returning immediately when any shared revision changes;
- the broker returns a complete Yjs snapshot in this spike;
- the UI applies remote snapshots with a non-local transaction origin, so they
  are not echoed back;
- `refresh_transport_spike` returns a fresh hidden ticket after generation
  fencing; and
- no CodeMirror keystroke becomes an individual MCP call.

This channel is authenticated by the MCP Apps host bridge, needs no iframe
network permission, and gives every stdio adapter access to the same broker.
The UI visibly reports `MCP bridge connected` and the host moves it into the
right panel through the proven `fullscreen` request.

Production should retain merged pushes and long-poll wakeups but replace full
snapshots on every revision with state vectors or a bounded incremental update
log.

## Actual-app results

The accepted v0.3.1 run proved:

1. The initial broker Markdown appears in CodeMirror with one `Y.Text`.
2. Typing `Human bridge edit.` produced one bridge push and revision `1`.
3. A server-side Yjs insertion appeared in the already-open editor at revision
   `2` without iframe remount.
4. Changing generation from `78de3e3f…` to `601b6c4e…` caused the old pull to
   return `staleGeneration`, minted a fresh hidden ticket, destroyed the stale
   client document, rebuilt from a new snapshot, and retained all text.
5. Reopening the render tool created UI instance `7d1e6125` while instance
   `e8df3103` remained attached. An edit from the new instance reached revision
   `3` and appeared in the first instance.
6. A second Codex task opened UI instance `f543a194` through adapter PID
   `1580544`, while the first task used PID `1573309`. Both attached to broker
   PID `1571338` and generation `601b6c4e…`.
7. The second task's edit reached revision `4` and appeared when the first task
   was reopened through another adapter.
8. All app-owned adapter processes exited during desktop shutdown. The
   detached spike broker stopped through its explicit shutdown command, its
   descriptor disappeared, the private display socket disappeared, and no
   spike process remained.

The final text was exactly one converged sequence:

```markdown
# WP-03 transport spike

Edit this Markdown from CodeMirror or an MCP server tool.

Human bridge edit.
Server update from UI e8df3103 at 2026-07-24T23:16:45.270Z

Second UI edit.
Second task edit.
```

## Automated and protocol evidence

```text
npm test
1 test, 1 passed
```

The broker integration test proves:

- an invalid WebSocket capability is rejected with HTTP 401;
- a valid origin and scoped capability connect;
- browser-style Yjs update and broker-side update converge;
- app-bridge push and pull converge;
- generation change closes the old socket with code 4009;
- a stale bridge pull is explicitly fenced; and
- a fresh generation snapshot contains every prior accepted edit.

```text
npm run build
213 modules transformed
dist/mcp-app.html 1,042.83 kB (317.89 kB gzip)

plugin validator
passed
```

An independent stdio MCP client listed all seven tools, called the render tool,
and confirmed that the model-visible result excluded the ticket while `_meta`
contained the single transport metadata key.

## Retained evidence

- Final plugin source:
  `wp-03/transport-spike-marketplace/`
- Redacted broker and adapter events:
  `wp-03/runtime-evidence/`
- Connected right-panel editor with initial Markdown:
  `wp-03/xvfb-session-v031/connected.png`
- Human-to-broker update:
  `wp-03/xvfb-session-v031/human-edit.png`
- Broker-to-UI update:
  `wp-03/xvfb-session-v031/server-edit.png`
- Fenced generation rebuild:
  `wp-03/xvfb-session-v031/generation-rebuild.png`
- Iframe/tool reopen:
  `wp-03/xvfb-session-v031/reopened.png`
- Two UI instances converged:
  `wp-03/xvfb-session-v031/two-ui-convergence.png`
- Second task attached:
  `wp-03/xvfb-session-v031/second-task.png`
- Second task edit visible in first task:
  `wp-03/xvfb-session-v031/first-task-after-second-edit.png`
- Inspected 1920x1080 final layout:
  `wp-03/xvfb-session-v031/maximized-convergence.png`

Earlier versioned Xvfb directories retain the failed direct-WebSocket and
view-initialization experiments. They are evidence of the discarded paths,
not production inputs.

## Spike shortcuts quarantined from production

The entire implementation lives under `reports/` and is not referenced by the
Linux feature build or staging entrypoints. It is therefore quarantined.

The following spike behaviors must not be promoted:

- runtime state under the temporary directory;
- a detached broker without a production reaper or persisted document state;
- full Yjs snapshots on every changed pull;
- five-second idle polls;
- a global revision shared by all documents;
- no awareness payload;
- an unused WebSocket bearer after fallback;
- a broad experimental iframe-origin allowlist;
- one observed adapter exit code `1` when desktop shutdown raced an outstanding
  long poll; and
- a 1 MiB unoptimized UI bundle.

WP-04 must freeze the cancellation protocol, lifecycle ownership, incremental
update format, state root, and production dependency set before code moves
into the feature.
