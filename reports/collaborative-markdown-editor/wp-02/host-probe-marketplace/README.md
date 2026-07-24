# Disposable Codex Desktop host probe

This local marketplace exists only to verify WP-02 and WP-03 host behavior in
the exact side-by-side Codex Desktop build. It is not production plugin code.

The probe deliberately records only selected non-secret process context. Its
runtime log defaults to
`/tmp/codex-collaborative-markdown-host-probe.log`.

The `open_host_probe` tool advertises both the standard MCP App resource
metadata and the installed Codex Desktop `openai/ui` thread entrypoint. The
latter is the current host-specific path that places a tool-backed MCP App in
the right panel.
