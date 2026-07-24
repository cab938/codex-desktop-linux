#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  CONTEXT_ASSET_PATTERN,
  SIDEBAR_ASSET_PATTERN,
  applyContextDeliveryPatch,
  applyMainProcessBridgePatch,
  applyPreloadBridgePatch,
  applySidebarPatch,
  descriptors,
} = require("./patch.js");
const {
  createQuickLauncherContextCoordinator,
  createQuickLauncherFileService,
  parseQuickLaunchYaml,
  quickLaunchRevision,
} = require("./runtime.js");

const FEATURE_ROOT = path.resolve(__dirname, "..");

function tempDirectory(prefix = "codex-quick-launcher-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createWorkspace() {
  const root = tempDirectory("codex-quick-launcher-workspace-");
  return {
    codexDir: path.join(root, ".codex"),
    file: path.join(root, ".codex", "quicklaunch.yaml"),
    root,
  };
}

function writeQuickLaunch(workspace, content) {
  fs.mkdirSync(workspace.codexDir, { recursive: true });
  fs.writeFileSync(workspace.file, content);
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Quick launcher state");
}

function withFeatureConfig(enabled, callback) {
  const temp = tempDirectory("codex-quick-launcher-features-");
  const original = process.env.CODEX_LINUX_FEATURES_CONFIG;
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(temp, "features.json");
  fs.writeFileSync(
    process.env.CODEX_LINUX_FEATURES_CONFIG,
    JSON.stringify({ enabled }, null, 2),
  );
  try {
    return callback();
  } finally {
    if (original == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = original;
    }
    fs.rmSync(temp, { force: true, recursive: true });
  }
}

function captureWarnings(callback) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...values) => warnings.push(values.map(String).join(" "));
  try {
    return { result: callback(), warnings };
  } finally {
    console.warn = original;
  }
}

function syntheticMainBundle() {
  return [
    "let electron=require('electron');",
    "function currentHost(){electron.ipcMain.handle('current',()=>{});",
    "return electron.BrowserWindow.getAllWindows().map(e=>e.getSharedObjectSnapshot())}",
  ].join("");
}

function syntheticContextBundle() {
  return "class Client{async sendRequest(e,t,n){if(this.dispatchMessage==null)throw Error(`AppServerRequestClient is missing a message dispatcher`);return e===`config/read`?this.sendConfigReadRequest(t,n):this.enqueueRequest(e,t,n)}}";
}

function syntheticSidebarBundle({ wrapped = false } = {}) {
  const root = wrapped
    ? "d;return t[0]!==e?(d=(0,tS.jsxs)(tS.Fragment,{children:[(0,tS.jsxs)(Y.Root,{shouldHideInlineImmediately:e,shouldShow:t,children:[h,c]}),(0,tS.jsx)(codexLinuxProjectWorkCard,{shouldHideInlineImmediately:e,shouldShow:t})]}),t[0]=e,t[1]=d):d=t[1],d"
    : "d=(0,tS.jsxs)(Y.Root,{shouldHideInlineImmediately:e,shouldShow:t,children:[h,c]});";
  const popoverChild = wrapped
    ? "(0,tS.jsxs)(tS.Fragment,{children:[(0,tS.jsx)(codexLinuxProjectWorkCard,{embedded:!0}),(0,tS.jsx)(Qx,{registerEnvironmentActionCommands:!1})]})"
    : "(0,tS.jsx)(Qx,{registerEnvironmentActionCommands:!1})";
  return [
    "const a='codex.localConversation.environmentSummary.title';",
    "function Plan(){let a=r(Di),b=a.value.routeKind===`local-thread`?a.value.conversationId:null,c=o(ss),d=c.cwd==null?null:ee(c.cwd);return 'codex.localConversation.plan.title'}",
    "var Ux=t(u(),1);",
    "function EnvironmentCreate(){let u=(0,tS.jsx)(At,{}),d=(0,tS.jsx)(Y.IconButton,{disabled:n,label:l,children:u}),f=(0,tS.jsx)(H,{id:`threadPage.runAction.environment.createMenuTitle`,defaultMessage:`Create environment`,description:`Title for the menu that offers local environment creation methods`});return d}",
    "function Summary({shouldHideInlineImmediately:e,shouldShow:t}){",
    "registerEnvironmentActionCommands();",
    "let c=(0,tS.jsx)(Y.Content,{children:null}),",
    root,
    wrapped ? "}" : "return d}",
    `function Popover(){let a=(0,tS.jsx)(Y.PopoverContent,{children:(0,tS.jsx)(Y.Content,{children:${popoverChild}})});return a}`,
  ].join("");
}

function spawnedProcess(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.unrefCalled = false;
  child.unref = () => {
    child.unrefCalled = true;
  };
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("parser accepts the documented schema, quoted scalars, comments, and block commands", () => {
  const entries = parseQuickLaunchYaml([
    "version: 1",
    "launches:",
    "  - label: Start # visible text",
    "    command: make run-dev-app",
    "    cwd: .",
    "  - label: 'Docs # local'",
    "    command: |",
    "      printf '%s\\n' one",
    "      printf '%s\\n' two",
    "  - label: Folded",
    "    command: >-",
    "      node --test",
    "      linux-features/quick-launcher/test.js",
  ].join("\n"));
  assert.deepEqual(entries, [
    { command: "make run-dev-app", cwd: ".", id: "0", label: "Start" },
    {
      command: "printf '%s\\n' one\nprintf '%s\\n' two",
      cwd: ".",
      id: "1",
      label: "Docs # local",
    },
    {
      command: "node --test linux-features/quick-launcher/test.js",
      cwd: ".",
      id: "2",
      label: "Folded",
    },
  ]);
  assert.deepEqual(parseQuickLaunchYaml("version: 1\nlaunches: []\n"), []);
});

test("parser rejects unsupported or ambiguous YAML and unsafe entry shapes", () => {
  assert.throws(
    () => parseQuickLaunchYaml("launches: []\n"),
    /missing required top-level version/,
  );
  assert.throws(
    () => parseQuickLaunchYaml("version: 2\nlaunches: []\n"),
    { code: "QUICK_LAUNCH_UNSUPPORTED_VERSION" },
  );
  assert.throws(
    () => parseQuickLaunchYaml("version: 1\nlaunches:\n  - label: One\n    command: echo 1\n  - label: one\n    command: echo 2\n"),
    { code: "QUICK_LAUNCH_DUPLICATE_LABEL" },
  );
  assert.throws(
    () => parseQuickLaunchYaml("version: 1\nlaunches:\n  - label: Missing\n"),
    /needs a non-empty command/,
  );
  assert.throws(
    () => parseQuickLaunchYaml("version: 1\nlaunches:\n  - label: Bad\n    commands: echo nope\n"),
    /unknown launch property/,
  );
  assert.throws(
    () => parseQuickLaunchYaml("version: 1\nlaunches:\n\t- label: Tab\n"),
    /tabs are not supported/,
  );
});

test("file service creates the missing YAML, opens it, and surfaces invalid edits", async (t) => {
  const workspace = createWorkspace();
  const opened = [];
  const service = createQuickLauncherFileService({
    openPath: async (filePath) => {
      opened.push(filePath);
      return "";
    },
  });
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });

  assert.equal((await service.read(workspace.root)).status, "missing");
  const openedResult = await service.open(workspace.root);
  assert.equal(openedResult.ok, true);
  assert.equal(openedResult.created, true);
  assert.equal(openedResult.state.status, "empty");
  assert.equal(fs.readFileSync(workspace.file, "utf8"), "version: 1\nlaunches: []\n");
  assert.deepEqual(opened, [workspace.file]);

  fs.writeFileSync(workspace.file, "version: 1\nlaunches:\n  - label: Broken\n");
  const invalid = await service.read(workspace.root);
  assert.equal(invalid.status, "invalid");
  assert.match(invalid.error.message, /needs a non-empty command/);
  assert.deepEqual(invalid.buttons, []);
});

test("file service replies without waiting for a long-running editor process", async (t) => {
  const workspace = createWorkspace();
  const service = createQuickLauncherFileService({
    openPath: async () => new Promise(() => {}),
    openResponseTimeoutMs: 10,
  });
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });

  const startedAt = Date.now();
  const openedResult = await service.open(workspace.root);
  assert.equal(openedResult.ok, true);
  assert.equal(openedResult.created, true);
  assert.ok(Date.now() - startedAt < 500);
});

test("launch rereads the revision and executes only the stored command in a contained cwd", async (t) => {
  const workspace = createWorkspace();
  let child = null;
  const calls = [];
  const service = createQuickLauncherFileService({
    spawnCommand(command, options) {
      calls.push({ command, options });
      child = spawnedProcess();
      return child;
    },
  });
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });
  fs.mkdirSync(path.join(workspace.root, "tools"));
  writeQuickLaunch(workspace, [
    "version: 1",
    "launches:",
    "  - label: Start",
    "    command: make run-dev-app",
    "    cwd: tools",
    "",
  ].join("\n"));
  const state = await service.read(workspace.root);
  const result = await service.handle({
    action: "launch",
    command: "rm -rf ignored-renderer-injection",
    id: state.buttons[0].id,
    label: state.buttons[0].label,
    revision: state.revision,
    workspaceRoot: workspace.root,
  });
  assert.equal(result.ok, true);
  assert.equal(result.label, "Start");
  assert.equal(result.pid, 1234);
  assert.equal(child.unrefCalled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "make run-dev-app");
  assert.equal(calls[0].options.cwd, path.join(workspace.root, "tools"));
  assert.equal(calls[0].options.shell, "/bin/bash");
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.env.CODEX_QUICK_LAUNCHER, "1");
  assert.equal(calls[0].options.env.CODEX_QUICK_LAUNCH_LABEL, "Start");
});

test("launch rejects stale revisions, escaped cwd paths, and process start failures", async (t) => {
  const workspace = createWorkspace();
  const outside = tempDirectory("codex-quick-launcher-outside-");
  const service = createQuickLauncherFileService({
    spawnCommand() {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn exploded")));
      return child;
    },
  });
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
    fs.rmSync(outside, { force: true, recursive: true });
  });
  writeQuickLaunch(workspace, "version: 1\nlaunches:\n  - label: One\n    command: echo one\n");
  const stale = await service.read(workspace.root);
  fs.writeFileSync(workspace.file, "version: 1\nlaunches:\n  - label: Two\n    command: echo two\n");
  const conflict = await service.handle({
    action: "launch",
    id: stale.buttons[0].id,
    label: stale.buttons[0].label,
    revision: stale.revision,
    workspaceRoot: workspace.root,
  });
  assert.equal(conflict.code, "QUICK_LAUNCH_CONFLICT");
  assert.equal(conflict.state.buttons[0].label, "Two");

  fs.writeFileSync(workspace.file, "version: 1\nlaunches:\n  - label: Escape\n    command: echo no\n    cwd: ..\n");
  const escaped = await service.read(workspace.root);
  const escapedResult = await service.handle({
    action: "launch",
    id: escaped.buttons[0].id,
    label: escaped.buttons[0].label,
    revision: escaped.revision,
    workspaceRoot: workspace.root,
  });
  assert.equal(escapedResult.code, "QUICK_LAUNCH_UNSAFE_CWD");

  fs.writeFileSync(workspace.file, "version: 1\nlaunches:\n  - label: Failure\n    command: false\n");
  const failed = await service.read(workspace.root);
  const failureResult = await service.handle({
    action: "launch",
    id: failed.buttons[0].id,
    label: failed.buttons[0].label,
    revision: failed.revision,
    workspaceRoot: workspace.root,
  });
  assert.equal(failureResult.code, "QUICK_LAUNCH_START_FAILED");
  assert.match(failureResult.message, /spawn exploded/);
});

test("file service watcher converges after edit, delete, and recreate", async (t) => {
  const workspace = createWorkspace();
  const service = createQuickLauncherFileService();
  const events = [];
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });
  writeQuickLaunch(workspace, "version: 1\nlaunches:\n  - label: One\n    command: echo one\n");
  const initial = await service.watch(workspace.root, "test-renderer", (event) => events.push(event));
  assert.equal(initial.buttons[0].label, "One");

  fs.writeFileSync(workspace.file, "version: 1\nlaunches:\n  - label: Two\n    command: echo two\n");
  await waitFor(() => events.find((event) => event.state?.buttons?.[0]?.label === "Two"));

  fs.unlinkSync(workspace.file);
  await waitFor(() => events.find((event) => event.state?.status === "missing"));

  fs.writeFileSync(workspace.file, "version: 1\nlaunches: []\n");
  await waitFor(() => events.find((event) => event.state?.status === "empty"));
  await service.unwatch(workspace.root, "test-renderer");
});

test("file service fails closed for unsafe roots and symlinked project paths", async (t) => {
  const workspace = createWorkspace();
  const outside = tempDirectory("codex-quick-launcher-outside-");
  const service = createQuickLauncherFileService();
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
    fs.rmSync(outside, { force: true, recursive: true });
  });
  assert.equal(
    (await service.handle({ action: "read", workspaceRoot: "relative" })).code,
    "QUICK_LAUNCH_UNSAFE_ROOT",
  );
  fs.symlinkSync(outside, workspace.codexDir);
  const linked = await service.handle({ action: "open", workspaceRoot: workspace.root });
  assert.equal(linked.code, "QUICK_LAUNCH_UNSAFE_PATH");
  assert.equal(fs.existsSync(path.join(outside, "quicklaunch.yaml")), false);
});

test("context coordinator supplies trusted schema metadata and untrusted project YAML once per revision", async () => {
  let state = {
    buttons: [{ id: "0", label: "Start" }],
    content: "version: 1\nlaunches:\n  - label: Start\n    command: make run-dev-app\n",
    path: "/project/.codex/quicklaunch.yaml",
    revision: "r1",
    status: "ready",
  };
  const coordinator = createQuickLauncherContextCoordinator({
    read: async () => ({ ok: true, state }),
  });
  const first = await coordinator.prepare("turn/start", {
    additionalContext: { existing: { kind: "application", value: "keep" } },
    cwd: "/project",
    threadId: "task",
  });
  assert.equal(first.params.additionalContext.existing.value, "keep");
  assert.equal(
    first.params.additionalContext["codex.quickLauncher.yaml.v1"].kind,
    "untrusted",
  );
  assert.equal(
    first.params.additionalContext["codex.quickLauncher.yaml.v1"].value,
    state.content,
  );
  const metadata = JSON.parse(
    first.params.additionalContext["codex.quickLauncher.metadata.v1"].value,
  );
  assert.equal(
    first.params.additionalContext["codex.quickLauncher.metadata.v1"].kind,
    "application",
  );
  assert.equal(metadata.buttonCount, 1);
  assert.match(metadata.instructions, /Infer the command from the checked-out project/);
  assert.match(metadata.schemaExample, /make run-dev-app/);
  assert.equal(coordinator.inspect("task").lastDelivered, null);
  first.acknowledge();
  assert.equal(coordinator.inspect("task").lastDelivered, "r1");
  assert.equal(await coordinator.prepare("turn/steer", { threadId: "task" }), null);

  state = {
    ...state,
    buttons: [{ id: "0", label: "Tests" }],
    content: "version: 1\nlaunches:\n  - label: Tests\n    command: npm test\n",
    revision: "r2",
  };
  const changed = await coordinator.prepare("turn/steer", { threadId: "task" });
  const changedMetadata = JSON.parse(
    changed.params.additionalContext["codex.quickLauncher.metadata.v1"].value,
  );
  assert.equal(changedMetadata.changedSinceLastTurn, true);
});

test("context bounds large YAML and ignores remote hosts", async () => {
  const content = `version: 1\nlaunches:\n${"  # long\n".repeat(100)}`;
  const state = {
    buttons: [],
    content,
    path: "/project/.codex/quicklaunch.yaml",
    revision: quickLaunchRevision(content),
    status: "empty",
  };
  const coordinator = createQuickLauncherContextCoordinator({
    maxSnapshotBytes: 32,
    read: async () => ({ ok: true, state }),
  });
  const local = await coordinator.prepare("turn/start", {
    cwd: "/project",
    threadId: "task",
  });
  assert.match(
    local.params.additionalContext["codex.quickLauncher.yaml.v1"].value,
    /larger than 32 bytes/,
  );
  assert.equal(local.metadata.boundedSnapshot, true);
  assert.equal(
    await coordinator.prepare(
      "turn/start",
      { cwd: "/project", threadId: "remote" },
      "remote-host",
    ),
    null,
  );
});

test("patches Quick Launcher only into the right-side section list", () => {
  const main = syntheticMainBundle();
  const patchedMain = applyMainProcessBridgePatch(main);
  assert.notEqual(patchedMain, main);
  assert.match(patchedMain, /codexLinuxQuickLauncherMainBridgeV1/);
  assert.equal(applyMainProcessBridgePatch(patchedMain), patchedMain);

  const context = syntheticContextBundle();
  const patchedContext = applyContextDeliveryPatch(context);
  assert.notEqual(patchedContext, context);
  assert.match(patchedContext, /codexLinuxQuickLauncherContextV1/);
  assert.match(patchedContext, /codexLinuxQuickLauncherPrepared/);
  assert.equal(applyContextDeliveryPatch(patchedContext), patchedContext);

  for (const wrapped of [false, true]) {
    const sidebar = syntheticSidebarBundle({ wrapped });
    const patchedSidebar = applySidebarPatch(sidebar);
    assert.notEqual(patchedSidebar, sidebar);
    assert.match(patchedSidebar, /codexLinuxQuickLauncherSidebarV1/);
    assert.match(patchedSidebar, /data-quick-launcher-status/);
    assert.match(patchedSidebar, /data-quick-launcher-edit/);
    assert.match(patchedSidebar, /Open \.codex\/quicklaunch\.yaml/);
    assert.match(patchedSidebar, /Y\.IconButton/);
    assert.match(patchedSidebar, /\(0,tS\.jsx\)\(At,\{\}\)/);
    assert.doesNotMatch(patchedSidebar, /inline-flex size-6/);
    assert.match(patchedSidebar, /Quick launcher/);
    assert.match(patchedSidebar, /Ux\.useState/);
    assert.match(patchedSidebar, /o\(ss\)/);
    assert.match(patchedSidebar, /ee\(environment\.cwd\)/);
    assert.match(patchedSidebar, /Y\.Section/);
    assert.equal(
      [...patchedSidebar.matchAll(
        /\(0,tS\.jsx\)\(codexLinuxQuickLauncherCard,\{embedded:!0,shouldHideInlineImmediately:!1,shouldShow:!0\}\)/g,
      )].length,
      1,
    );
    assert.doesNotMatch(
      patchedSidebar,
      /\(0,tS\.jsx\)\(codexLinuxQuickLauncherCard,\{shouldHideInlineImmediately:/,
    );
    assert.equal(applySidebarPatch(patchedSidebar), patchedSidebar);
  }
});

test("turn context patch composes with the Project Work request middleware", () => {
  const projectWorkPatched =
    "var marker='codexLinuxProjectWorkContextV1';" +
    "class Client{async sendRequest(e,t,n){return this.enqueueRequest(e,t,n)}}";
  const patched = applyContextDeliveryPatch(projectWorkPatched);
  assert.match(patched, /codexLinuxQuickLauncherContextV1/);
  assert.match(patched, /codexLinuxQuickLauncherComposed/);
  assert.doesNotMatch(patched, /codexLinuxQuickLauncherPrepared/);
  assert.match(patched, /codexLinuxProjectWorkContextV1/);
});

test("preload patch exposes a scoped quickLauncher bridge and preserves existing bridge properties", (t) => {
  const root = tempDirectory("codex-quick-launcher-preload-");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const build = path.join(root, ".vite", "build");
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(
    path.join(build, "preload.js"),
    "let e=require(\"electron\");var L=new Map,R=new Map,z={projectWork:{},getSharedObjectSnapshotValue(){}};e.contextBridge.exposeInMainWorld(`electronBridge`,z);",
  );
  assert.deepEqual(applyPreloadBridgePatch(root), { changed: true, matched: true });
  const content = fs.readFileSync(path.join(build, "preload.js"), "utf8");
  assert.match(content, /quickLauncher:codexLinuxQuickLauncherPreloadBridge/);
  assert.match(content, /projectWork:\{\}/);
  assert.match(content, /ipcRenderer\.invoke/);
  assert.deepEqual(applyPreloadBridgePatch(root), { changed: false, matched: true });
});

test("patch drift is fail-soft and reports actionable current-anchor failures", () => {
  const main = captureWarnings(() => applyMainProcessBridgePatch("let stale=true"));
  assert.equal(main.result, "let stale=true");
  assert.match(main.warnings.join("\n"), /Could not verify the current Electron IPC host bundle/);

  const context = captureWarnings(() => applyContextDeliveryPatch("let stale=true"));
  assert.equal(context.result, "let stale=true");
  assert.match(context.warnings.join("\n"), /Expected one current AppServerRequestClient/);

  const sidebar = captureWarnings(() => applySidebarPatch("let stale=true"));
  assert.equal(sidebar.result, "let stale=true");
  assert.match(sidebar.warnings.join("\n"), /semantic anchors were not present/);
});

test("asset patterns select only the current intended chunk families", () => {
  assert.equal(
    CONTEXT_ASSET_PATTERN.test(
      "app-initial-BTphDPeq.js",
    ),
    true,
  );
  assert.equal(
    CONTEXT_ASSET_PATTERN.test(
      "app-prefetch-impl-BmB2QJVt.js",
    ),
    false,
  );
  assert.equal(SIDEBAR_ASSET_PATTERN.test("local-conversation-thread-hash.js"), true);
  assert.equal(SIDEBAR_ASSET_PATTERN.test("local-conversation-thread-hash.css"), false);
});

test("feature is disabled by default and stages no global resources or hooks", () => {
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8")).defaultEnabled,
    false,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(FEATURE_ROOT, "features.example.json"), "utf8")).enabled,
    [],
  );
  withFeatureConfig([], () => {
    assert.equal(enabledLinuxFeatureIds({ featuresRoot: FEATURE_ROOT }).includes("quick-launcher"), false);
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURE_ROOT })
        .some((patch) => patch.featureId === "quick-launcher"),
      false,
    );
  });
  withFeatureConfig(["quick-launcher"], () => {
    assert.equal(enabledLinuxFeatureIds({ featuresRoot: FEATURE_ROOT }).includes("quick-launcher"), true);
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURE_ROOT })
        .filter((patch) => patch.featureId === "quick-launcher")
        .map((patch) => [patch.id, patch.phase]),
      [
        ["feature:quick-launcher:main-process-quick-launcher-bridge", "main-bundle"],
        ["feature:quick-launcher:preload-quick-launcher-bridge", "extracted-app:pre-webview"],
        ["feature:quick-launcher:turn-quick-launcher-context", "webview-asset"],
        ["feature:quick-launcher:sidebar-quick-launcher-card", "webview-asset"],
      ],
    );
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot: FEATURE_ROOT });
    assert.deepEqual(plan.resources, []);
    assert.deepEqual(plan.runtimeHooks, []);
  });
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.phase),
    ["main-bundle", "extracted-app:pre-webview", "webview-asset", "webview-asset"],
  );
});
