import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.dirname(new URL(import.meta.url).pathname);

test("manifest advertises the bundled MCP server", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, ".codex-plugin", "plugin.json"),
    "utf8"
  ));
  assert.equal(manifest.name, "collaborative-markdown-host-probe");
  assert.equal(manifest.mcpServers, "./.mcp.json");
});

test("MCP config launches the server from the plugin root", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  const entry = config.mcpServers["collaborative-markdown-host-probe"];
  assert.equal(entry.command, "node");
  assert.deepEqual(entry.args, ["./server.mjs"]);
  assert.equal(entry.cwd, ".");
});

test("built app is a single self-contained HTML resource", () => {
  const html = fs.readFileSync(path.join(root, "dist", "mcp-app.html"), "utf8");
  assert.match(html, /Right-panel MCP App/);
  assert.equal(html.includes('src="/src/'), false);
  assert.equal(html.includes('href="/src/'), false);
});
