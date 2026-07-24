#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  discoverLinuxFeatureManifests,
  enabledLinuxFeatureInstallPlan,
  enabledLinuxFeaturePackageHooks,
  enabledLinuxFeatureStageHooks,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");

const featureRoot = __dirname;
const featureId = "collaborative-markdown-editor";
const lifecycleScript = path.join(featureRoot, "scripts", "lifecycle.mjs");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runLifecycle(command, buildRoot) {
  const result = spawnSync(process.execPath, [lifecycleScript, command], {
    cwd: featureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_COLLABORATIVE_MARKDOWN_BUILD_ROOT: buildRoot,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function makeIsolatedFeaturesRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-collaborative-markdown-feature-"));
  fs.writeFileSync(
    path.join(root, "features.example.json"),
    `${JSON.stringify({ enabled: [] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "features.json"),
    `${JSON.stringify({ enabled: [featureId] }, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(root, featureId), { recursive: true });
  for (const fileName of ["feature.json", "README.md"]) {
    fs.copyFileSync(path.join(featureRoot, fileName), path.join(root, featureId, fileName));
  }
  return root;
}

test("manifest is a disabled feature shell without premature integration hooks", () => {
  const manifest = readJson(path.join(featureRoot, "feature.json"));
  assert.equal(manifest.id, featureId);
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.requires, []);
  assert.deepEqual(manifest.conflicts, []);

  for (const key of ["entrypoints", "resources", "runtimeHooks", "packageHooks"]) {
    assert.equal(manifest[key], undefined);
  }

  const exampleConfig = readJson(path.resolve(featureRoot, "..", "features.example.json"));
  assert.deepEqual(exampleConfig.enabled, []);
});

test("repository feature discovery finds the shell and required README", () => {
  const features = discoverLinuxFeatureManifests({
    featuresRoot: path.resolve(featureRoot, ".."),
  });
  const feature = features.find((candidate) => candidate.id === featureId);
  assert.ok(feature);
  assert.equal(feature.manifest.defaultEnabled, false);
  assert.equal(fs.existsSync(feature.readmePath), true);
});

test("enabled shell has an empty framework install and patch plan", () => {
  const root = makeIsolatedFeaturesRoot();
  try {
    assert.deepEqual(enabledLinuxFeatureInstallPlan({ featuresRoot: root }), {
      resources: [],
      runtimeHooks: [],
    });
    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), []);
    assert.deepEqual(enabledLinuxFeaturePackageHooks({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("build and stage are deterministic and clean is feature-scoped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-collaborative-markdown-build-"));
  const unrelated = path.join(path.dirname(root), `${path.basename(root)}-unrelated`);
  try {
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "keep"), "keep\n");

    runLifecycle("build", root);
    const first = fs.readFileSync(path.join(root, "feature-shell.json"), "utf8");
    runLifecycle("build", root);
    const second = fs.readFileSync(path.join(root, "feature-shell.json"), "utf8");
    assert.equal(second, first);

    runLifecycle("stage", root);
    assert.equal(
      fs.readFileSync(path.join(root, "stage", "feature-shell.json"), "utf8"),
      first,
    );

    runLifecycle("clean", root);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.readFileSync(path.join(unrelated, "keep"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unrelated, { recursive: true, force: true });
  }
});
