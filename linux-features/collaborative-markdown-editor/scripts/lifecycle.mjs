#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const featureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = process.env.CODEX_COLLABORATIVE_MARKDOWN_BUILD_ROOT
  ? path.resolve(process.env.CODEX_COLLABORATIVE_MARKDOWN_BUILD_ROOT)
  : path.join(featureRoot, "dist");
const buildArtifact = path.join(buildRoot, "feature-shell.json");
const stageArtifact = path.join(buildRoot, "stage", "feature-shell.json");
const webBundle = path.join(buildRoot, "web", "editor-preview.html");
const stagedWebBundle = path.join(
  buildRoot,
  "stage",
  "web",
  "editor-preview.html",
);

function writeIfChanged(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === contents) {
    return;
  }
  fs.writeFileSync(filePath, contents, { encoding: "utf8", mode: 0o644 });
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function buildManifest() {
  if (!fs.existsSync(webBundle)) {
    throw new Error(`Missing built editor bundle: ${webBundle}`);
  }
  const bundle = fs.readFileSync(webBundle);
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      featureId: "collaborative-markdown-editor",
      status: "editor-integrated",
      runtimeFiles: [
        {
          path: "web/editor-preview.html",
          bytes: bundle.length,
          sha256: sha256(bundle),
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function build() {
  writeIfChanged(buildArtifact, buildManifest());
}

function stage() {
  build();
  writeIfChanged(stageArtifact, fs.readFileSync(buildArtifact, "utf8"));
  writeIfChanged(stagedWebBundle, fs.readFileSync(webBundle));
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
