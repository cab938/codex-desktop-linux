# WP-09 production MCP App

Date: 2026-07-24

Status: complete, including package-installed Codex Desktop inspection.

## Outcome

The feature now builds a production MCP App at the cache-versioned resource
URI `ui://collaborative-markdown-editor/v2/index.html`. The resource is one
self-contained HTML file containing the adapted Glyphdown CodeMirror editor,
one client-owned `Y.Doc`, the MCP Apps bridge, styling, and all runtime
JavaScript. Its resource metadata keeps both `connectDomains` and
`resourceDomains` empty.

The app requests the host's `fullscreen` presentation mode. WP-02 established
that the current Codex Desktop host maps this mode to the desired persistent
right-side panel while retaining the task conversation and composer.

## User authorization and trust boundary

- An unauthorized render receives only an authorization bootstrap.
- The UI displays the exact requested workspace root and relative Markdown
  path.
- Only a click on the `Allow workspace` button calls
  `markdown_ui_authorize_workspace` with `confirmed: true`.
- The denial button performs no server mutation.
- Model-facing tools cannot call the app-only authorization path.
- The broker re-canonicalizes and authorizes the root before opening the file.

## Shared document and transport

- The initial Yjs snapshot is SHA-256 verified before it is decoded.
- The adapted Glyphdown editor is mounted over the same `Y.Text`; it does not
  create a second rich-document model or a CodeMirror history.
- Human Yjs updates are merged for up to 75 ms or 256 KiB, assigned a
  monotonic client sequence, hashed, and sent through
  `markdown_ui_sync_push`.
- A bounded 20-second `markdown_ui_sync_pull` loop sends the current Yjs state
  vector and applies only the returned state-vector diff.
- Update sequences are safe to retry and the server fences stale broker
  generations, stale document epochs, and invalid capabilities.
- The app sends bounded cursor awareness and renders human collaborators plus
  the broker's short-lived `Codex agent active` indicator. The indicator is
  explicitly described as activity after an accepted document transaction,
  not token streaming.

## Restart recovery

The original WP-08 client cached the prior broker descriptor indefinitely.
After a broker shutdown, a UI refresh could therefore reach a process that was
already shutting down and never discover the replacement generation.

The broker client now:

1. treats retryable `BROKER_UNAVAILABLE` responses and transport failures as a
   generation transition;
2. waits for the old generation to release its descriptor and owner lock;
3. starts or attaches to a fresh broker exactly once; and
4. retries the idempotent internal RPC against that fresh generation.

The document registry can reopen a persisted `document_id` only after reading
its stored canonical identity and revalidating the still-approved workspace.
It then issues a new UI session and scoped capability. A test shuts down the
real child broker through MCP, calls the UI refresh tool with stale generation
metadata, and verifies a new generation, unchanged document revision, restored
path, and restored workspace root.

If a human edit was locally pending at the moment of fencing, the app retains
the visible Markdown text, rebuilds from the authoritative recovered snapshot,
and reapplies the pending text as a new human Yjs transaction.

## Presentation and accessibility

- Host theme, font CSS, and semantic color/radius variables are applied through
  the current MCP Apps SDK.
- System colors remain the fallback, including forced-colors mode.
- The layout supports narrow panels, wrapping controls, browser zoom, keyboard
  editing, reduced motion, light and dark color schemes, and an independently
  scrolling editor.
- The status output is an `aria-live` region; the collaborator list and editor
  have explicit accessible names; controls use semantic buttons and expose
  pressed state and keyboard shortcuts.
- Selection, scroll offset, and raw/live-preview preference are stored in
  per-document `sessionStorage` and restored with bounds checks.
- Connection, durable-file, recovery-log, saving, conflict, deleted, renamed,
  read-only, recovery-required, and error states are visible without replacing
  the editor.

## Untrusted Markdown

- Raw Markdown HTML remains source text; it is not inserted as executable DOM.
- The imported Glyphdown image resolver is deny-by-default, so image syntax
  produces inert placeholders and cannot fetch local or remote resources.
- Link clicks are intercepted. Only `http:`, `https:`, and `mailto:` URLs are
  handed to the host's link-opening API. JavaScript, data, file, relative, and
  malformed URLs remain inert.
- The MCP App resource declares no network or external resource origins.

## Automated evidence

Environment: Node.js 20.19.0.

- TypeScript strict typecheck: passed.
- Glyphdown/editor and application component suite: 411 tests passed across 20
  files.
- Feature/lifecycle suite: 4 tests passed.
- Broker/persistence suite: 27 tests passed.
- Official MCP SDK protocol suite: 2 tests passed, including resource serving,
  authorization, app-only isolation, Yjs push/pull, awareness, stale
  capability rejection, cancellation, timeout, child-broker restart and
  session reconstruction, and stdio shutdown.
- Two consecutive MCP App builds were byte-identical.
- Built resource:
  `linux-features/collaborative-markdown-editor/dist/mcp/mcp-app.html`
- Built bytes: `3,796,652`
- SHA-256:
  `2eb7ae24ce1ace9451e8a76b7d18c9ebe3c784a8b28f8d2e22d6c716bed95819`

The jsdom environment emits its known `HTMLCanvasElement.getContext` warning
for CodeMirror measurement. It does not fail or skip any test.

## Exact-app acceptance

The final staged resource rendered in compact and maximized right-side tabs in
the exact side-by-side app. A keyboard-driven human edit reached **Saved to
Markdown**, accepted agent transactions appeared without remounting, an
external file write appeared live, two UI instances converged with awareness,
and restart restored the current document generation. Inspected screenshots
and the full scenario map are retained in `wp-14-acceptance.md`. The stock
Codex installation remained untouched.
