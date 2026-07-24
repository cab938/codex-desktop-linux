# Collaborative Markdown transport spike

This disposable local marketplace is retained as WP-03 feasibility evidence.
It is not the production plugin.

The plugin starts an MCP stdio adapter through Codex. Each adapter attaches to
one user-private loopback broker. The render tool passes a scoped WebSocket
capability in tool-result `_meta`, outside model-visible content. The MCP App
binds CodeMirror to one `Y.Text` and exchanges Yjs updates over that channel.

Stop the spike broker after testing:

```bash
npm run stop-broker --prefix plugins/collaborative-markdown-transport-spike
```
