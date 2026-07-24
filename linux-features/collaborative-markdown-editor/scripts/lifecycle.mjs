#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const featureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = process.env.CODEX_COLLABORATIVE_MARKDOWN_BUILD_ROOT
  ? path.resolve(process.env.CODEX_COLLABORATIVE_MARKDOWN_BUILD_ROOT)
  : path.join(featureRoot, "dist");
const buildArtifact = path.join(buildRoot, "feature-shell.json");
const stageArtifact = path.join(buildRoot, "stage", "feature-shell.json");

const artifact = `${JSON.stringify(
  {
    schemaVersion: 1,
    featureId: "collaborative-markdown-editor",
    status: "host-contract-pending",
    runtimeFiles: [],
  },
  null,
  2,
)}\n`;

function writeIfChanged(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === contents) {
    return;
  }
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o644 });
}

function build() {
  writeIfChanged(buildArtifact, artifact);
}

function stage() {
  build();
  writeIfChanged(stageArtifact, fs.readFileSync(buildArtifact, "utf8"));
}

function clean() {
  fs.rmSync(buildRoot, { recursive: true, force: true });
}

const command = process.argv[2];
if (command === "build") {
  build();
} else if (command === "stage") {
  stage();
} else if (command === "clean") {
  clean();
} else {
  process.stderr.write("Usage: lifecycle.mjs <build|stage|clean>\n");
  process.exitCode = 2;
}
