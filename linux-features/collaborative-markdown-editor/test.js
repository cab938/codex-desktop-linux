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
const stageScript = path.join(featureRoot, "stage.sh");
const cleanupScript = path.join(featureRoot, "cleanup.sh");
const patchModule = require("./patch.js");

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

function writeFixtureBundle(buildRoot) {
  for (const relativePath of [
    "web/editor-preview.html",
    "mcp/mcp-app.html",
    "plugin/server.mjs",
    "plugin/broker.mjs",
  ]) {
    const bundle = path.join(buildRoot, relativePath);
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, `fixture:${relativePath}\n`);
  }
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
  for (const fileName of [
    "feature.json",
    "README.md",
    "patch.js",
    "stage.sh",
    "cleanup.sh",
  ]) {
    fs.copyFileSync(path.join(featureRoot, fileName), path.join(root, featureId, fileName));
  }
  fs.cpSync(
    path.join(featureRoot, "plugin-marketplace"),
    path.join(root, featureId, "plugin-marketplace"),
    { recursive: true },
  );
  return root;
}

test("manifest remains disabled and stages only the packaged plugin", () => {
  const manifest = readJson(path.join(featureRoot, "feature.json"));
  assert.equal(manifest.id, featureId);
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.requires, []);
  assert.deepEqual(manifest.conflicts, []);

  assert.equal(manifest.entrypoints.patchDescriptors, "./patch.js");
  assert.equal(manifest.entrypoints.stageHook, "./stage.sh");
  assert.equal(manifest.entrypoints.cleanupHook, "./cleanup.sh");
  assert.deepEqual(manifest.resources, [{
    source: "plugin-marketplace/plugins/collaborative-markdown-editor",
    target:
      "resources/plugins/openai-bundled/plugins/collaborative-markdown-editor",
  }]);
  assert.equal(manifest.runtimeHooks, undefined);
  assert.equal(manifest.packageHooks, undefined);

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

test("enabled feature has one plugin resource and one required gate patch", () => {
  const root = makeIsolatedFeaturesRoot();
  try {
    const installPlan = enabledLinuxFeatureInstallPlan({ featuresRoot: root });
    assert.equal(installPlan.resources.length, 1);
    assert.match(
      installPlan.resources[0].target,
      /resources\/plugins\/openai-bundled\/plugins\/collaborative-markdown-editor$/,
    );
    assert.deepEqual(installPlan.runtimeHooks, []);
    assert.equal(enabledLinuxFeatureStageHooks({ featuresRoot: root }).length, 1);
    assert.deepEqual(enabledLinuxFeaturePackageHooks({ featuresRoot: root }), []);
    const descriptors = loadLinuxFeaturePatchDescriptors({
      featuresRoot: root,
    });
    assert.equal(descriptors.length, 1);
    assert.equal(
      descriptors[0].id,
      "feature:collaborative-markdown-editor:" +
        "collaborative-markdown-editor-plugin-gate",
    );
    assert.equal(descriptors[0].ciPolicy, "required-upstream");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin gate makes the editor available on Linux without auto-installing it", () => {
  const source = [
    "var n={bc:e=>e,_c:`sites`,lc:`browser`,uc:`chrome-internal`,fc:`computer-use`,gc:`record-and-replay`,mc:`latex-tectonic`,hc:`plugin-eval`,pc:`deep-research`,vc:`visualize`};",
    "var Xo=[{autoInstallOptOutKey:n.bc(n._c),installWhenMissing:!0,name:n._c,isAvailable:({features:e})=>e.sites},{autoInstallOptOutKey:n.bc(n.lc),installWhenMissing:!0,name:n.lc,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{autoInstallOptOutKey:n.bc(n.fc),installWhenMissing:!0,name:n.fc,isAvailable:({features:e,platform:t})=>t===`linux`||t===`darwin`&&e.computerUse},{name:n.gc,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.recordAndReplay},{name:n.mc,isAvailable:()=>!0},{installWhenMissing:!0,name:n.pc,isAvailable:({features:e})=>e.deepResearch},{installWhenMissing:!0,name:n.vc,isAvailable:({features:e})=>e.visualize}];",
  ].join("");
  const patched = patchModule.applyCollaborativeMarkdownPluginGate(source);
  assert.match(
    patched,
    /\{name:`collaborative-markdown-editor`,isAvailable:\(\{platform:e\}\)=>e===`linux`\},\{name:n\.mc,isAvailable:\(\)=>!0\}/,
  );
  assert.doesNotMatch(
    patched,
    /installWhenMissing:!0,name:`collaborative-markdown-editor`/,
  );
  assert.equal(
    patchModule.applyCollaborativeMarkdownPluginGate(patched),
    patched,
  );
});

test("plugin gate fails required-upstream when a recognizable bundle drifts", () => {
  assert.throws(
    () =>
      patchModule.applyCollaborativeMarkdownPluginGate(
        "function drift(e){return e.computerUse}",
      ),
    /could not find bundled plugin descriptor array/,
  );
});

test("build and stage are deterministic and clean is feature-scoped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-collaborative-markdown-build-"));
  const unrelated = path.join(path.dirname(root), `${path.basename(root)}-unrelated`);
  try {
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "keep"), "keep\n");

    writeFixtureBundle(root);
    runLifecycle("build", root);
    const first = fs.readFileSync(path.join(root, "feature-shell.json"), "utf8");
    const manifest = JSON.parse(first);
    assert.equal(manifest.status, "plugin-packaged");
    assert.deepEqual(
      manifest.runtimeFiles.map((entry) => entry.path),
      [
        "web/editor-preview.html",
        "mcp/mcp-app.html",
        "plugin/server.mjs",
        "plugin/broker.mjs",
      ],
    );
    runLifecycle("build", root);
    const second = fs.readFileSync(path.join(root, "feature-shell.json"), "utf8");
    assert.equal(second, first);

    runLifecycle("stage", root);
    assert.equal(
      fs.readFileSync(path.join(root, "stage", "feature-shell.json"), "utf8"),
      first,
    );
    for (const relativePath of manifest.runtimeFiles.map((entry) => entry.path)) {
      assert.equal(
        fs.readFileSync(path.join(root, "stage", relativePath), "utf8"),
        `fixture:${relativePath}\n`,
      );
    }

    runLifecycle("clean", root);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.readFileSync(path.join(unrelated, "keep"), "utf8"), "keep\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(unrelated, { recursive: true, force: true });
  }
});

test("feature hook stages and removes only its bundled plugin", () => {
  const installDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-collaborative-markdown-install-"),
  );
  const pluginDir = path.join(
    installDir,
    "resources/plugins/openai-bundled/plugins",
    featureId,
  );
  const marketplacePath = path.join(
    installDir,
    "resources/plugins/openai-bundled/.agents/plugins/marketplace.json",
  );
  try {
    fs.mkdirSync(path.dirname(pluginDir), { recursive: true });
    fs.cpSync(
      path.join(
        featureRoot,
        "plugin-marketplace/plugins/collaborative-markdown-editor",
      ),
      pluginDir,
      { recursive: true },
    );
    fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
    fs.writeFileSync(
      marketplacePath,
      `${JSON.stringify({
        name: "openai-bundled",
        interface: { displayName: "ChatGPT Official" },
        plugins: [{ name: "unrelated" }],
      }, null, 2)}\n`,
    );

    const staged = spawnSync("bash", [stageScript], {
      cwd: path.resolve(featureRoot, "../.."),
      encoding: "utf8",
      env: {
        ...process.env,
        INSTALL_DIR: installDir,
        SCRIPT_DIR: path.resolve(featureRoot, "../.."),
      },
    });
    assert.equal(staged.status, 0, staged.stderr || staged.stdout);
    for (const relativePath of [
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "runtime/server.mjs",
      "runtime/broker.mjs",
      "dist/mcp/mcp-app.html",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "SBOM.cdx.json",
    ]) {
      assert.equal(fs.existsSync(path.join(pluginDir, relativePath)), true);
    }
    assert.deepEqual(
      readJson(marketplacePath).plugins.map((plugin) => plugin.name),
      ["unrelated", featureId],
    );

    const cleaned = spawnSync("bash", [cleanupScript], {
      encoding: "utf8",
      env: { ...process.env, INSTALL_DIR: installDir },
    });
    assert.equal(cleaned.status, 0, cleaned.stderr || cleaned.stdout);
    assert.equal(fs.existsSync(pluginDir), false);
    assert.deepEqual(
      readJson(marketplacePath).plugins.map((plugin) => plugin.name),
      ["unrelated"],
    );
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});
