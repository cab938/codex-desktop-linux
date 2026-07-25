#!/usr/bin/env bash
set -Eeuo pipefail

: "${INSTALL_DIR:?INSTALL_DIR is required}"
: "${SCRIPT_DIR:?SCRIPT_DIR is required}"

feature_dir="$SCRIPT_DIR/linux-features/collaborative-markdown-editor"
target_plugin="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/collaborative-markdown-editor"
target_marketplace="$INSTALL_DIR/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"

if [ ! -x "$feature_dir/node_modules/.bin/vite" ]; then
    npm ci \
        --prefix "$feature_dir" \
        --ignore-scripts \
        --no-audit \
        --no-fund
fi

npm run --prefix "$feature_dir" build:plugin
npm run --prefix "$feature_dir" sbom

mkdir -p \
    "$target_plugin/runtime" \
    "$target_plugin/dist/mcp"
install -m 0644 \
    "$feature_dir/dist/plugin/server.mjs" \
    "$target_plugin/runtime/server.mjs"
install -m 0644 \
    "$feature_dir/dist/plugin/broker.mjs" \
    "$target_plugin/runtime/broker.mjs"
install -m 0644 \
    "$feature_dir/dist/mcp/mcp-app.html" \
    "$target_plugin/dist/mcp/mcp-app.html"
install -m 0644 "$SCRIPT_DIR/LICENSE" "$target_plugin/LICENSE"
install -m 0644 \
    "$feature_dir/THIRD_PARTY_NOTICES.md" \
    "$target_plugin/THIRD_PARTY_NOTICES.md"
install -m 0644 \
    "$feature_dir/SBOM.cdx.json" \
    "$target_plugin/SBOM.cdx.json"

node - "$target_marketplace" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const marketplacePath = process.argv[2];
let marketplace = {
  name: "openai-bundled",
  interface: { displayName: "ChatGPT Official" },
  plugins: [],
};
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (!Array.isArray(marketplace.plugins)) marketplace.plugins = [];
marketplace.plugins = marketplace.plugins.filter(
  (plugin) => plugin?.name !== "collaborative-markdown-editor",
);
marketplace.plugins.push({
  name: "collaborative-markdown-editor",
  source: {
    source: "local",
    path: "./plugins/collaborative-markdown-editor",
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  },
  category: "Productivity",
});
fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE

echo "Collaborative Markdown Editor plugin staged" >&2
