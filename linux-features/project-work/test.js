#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
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
  createProjectWorkContextCoordinator,
  createProjectWorkFileService,
  mutateCheckboxContent,
  parseChecklist,
  revisionForContent,
} = require("./runtime.js");

const FEATURE_ROOT = path.resolve(__dirname, "..");

function tempDirectory(prefix = "codex-project-work-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createWorkspace() {
  const root = tempDirectory("codex-project-workspace-");
  return {
    codexDir: path.join(root, ".codex"),
    file: path.join(root, ".codex", "work-packages.md"),
    root,
  };
}

function writeProjectWork(workspace, content) {
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
  throw new Error("Timed out waiting for Project work state");
}

function withFeatureConfig(enabled, callback) {
  const temp = tempDirectory("codex-project-work-features-");
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
    ? "d;return t[0]!==e?(d=(0,tS.jsxs)(tS.Fragment,{children:[(0,tS.jsxs)(Y.Root,{shouldHideInlineImmediately:e,shouldShow:t,children:[h,c]}),(0,tS.jsx)(codexLinuxQuickLauncherCard,{shouldHideInlineImmediately:e,shouldShow:t})]}),t[0]=e,t[1]=d):d=t[1],d"
    : "d=(0,tS.jsxs)(Y.Root,{shouldHideInlineImmediately:e,shouldShow:t,children:[h,c]});";
  const popoverChild = wrapped
    ? "(0,tS.jsxs)(tS.Fragment,{children:[(0,tS.jsx)(codexLinuxQuickLauncherCard,{embedded:!0}),(0,tS.jsx)(Qx,{registerEnvironmentActionCommands:!1})]})"
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

test("parser recognizes nested, case-tolerant dash and star checkboxes", () => {
  const content = [
    "# Project work",
    "",
    "- [ ] Parent",
    "  - [x] Child one",
    "  * [X] Child two",
    "- [ ] Sibling",
    "not a checkbox [x]",
  ].join("\n");
  const items = parseChecklist(content);
  assert.deepEqual(
    items.map(({ checked, depth, line, parentLine, text }) => ({ checked, depth, line, parentLine, text })),
    [
      { checked: false, depth: 0, line: 2, parentLine: null, text: "Parent" },
      { checked: true, depth: 1, line: 3, parentLine: 2, text: "Child one" },
      { checked: true, depth: 1, line: 4, parentLine: 2, text: "Child two" },
      { checked: false, depth: 0, line: 5, parentLine: null, text: "Sibling" },
    ],
  );
});

test("mutation changes only one marker and preserves unrelated Markdown and line endings", () => {
  const original = "# Heading\r\n\r\n<!-- keep -->\r\n- [ ] Target  \r\nprose\r\n- [X] Other";
  const changed = mutateCheckboxContent(original, {
    checked: true,
    expectedChecked: false,
    expectedText: "Target  ",
    line: 3,
  });
  assert.equal(changed, "# Heading\r\n\r\n<!-- keep -->\r\n- [x] Target  \r\nprose\r\n- [X] Other");
  assert.equal(changed.endsWith("\n"), false);
  assert.equal(mutateCheckboxContent(changed, {
    checked: false,
    expectedChecked: true,
    expectedText: "Target  ",
    line: 3,
  }), original);
});

test("mutation rejects stale line text and state", () => {
  const content = "- [ ] A\n";
  assert.throws(
    () => mutateCheckboxContent(content, { checked: true, expectedText: "B", line: 0 }),
    { code: "PROJECT_WORK_TARGET_CHANGED" },
  );
  assert.throws(
    () => mutateCheckboxContent(content, { checked: true, expectedChecked: true, line: 0 }),
    { code: "PROJECT_WORK_TARGET_CHANGED" },
  );
});

test("file service handles missing, create, empty, malformed, and surgical toggle states", async (t) => {
  const workspace = createWorkspace();
  const service = createProjectWorkFileService();
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });

  assert.equal((await service.read(workspace.root)).status, "missing");
  const created = await service.create(workspace.root);
  assert.equal(created.created, true);
  assert.equal(created.state.status, "empty");
  assert.equal(fs.readFileSync(workspace.file, "utf8"), "# Project work\n\n");

  fs.writeFileSync(workspace.file, "prose only\n- [maybe] malformed\n");
  assert.equal((await service.read(workspace.root)).status, "empty");

  const content = "intro\n- [ ] Keep exact text  \n  - [X] Done\nend\n";
  fs.writeFileSync(workspace.file, content);
  const before = await service.read(workspace.root);
  const result = await service.toggle({
    checked: true,
    expectedChecked: false,
    expectedText: "Keep exact text  ",
    line: 1,
    revision: before.revision,
    workspaceRoot: workspace.root,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(workspace.file, "utf8"), "intro\n- [x] Keep exact text  \n  - [X] Done\nend\n");
  assert.equal(result.state.completedCount, 2);
});

test("file service rejects hash mismatch without overwriting newer content", async (t) => {
  const workspace = createWorkspace();
  const service = createProjectWorkFileService();
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });
  writeProjectWork(workspace, "- [ ] Original\n");
  const stale = await service.read(workspace.root);
  fs.writeFileSync(workspace.file, "- [ ] Original\n\nNewer note\n");
  const result = await service.toggle({
    checked: true,
    expectedChecked: false,
    expectedText: "Original",
    line: 0,
    revision: stale.revision,
    workspaceRoot: workspace.root,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_WORK_CONFLICT");
  assert.match(result.message, /changed outside Codex/);
  assert.equal(result.state.content, "- [ ] Original\n\nNewer note\n");
  assert.equal(fs.readFileSync(workspace.file, "utf8"), result.state.content);
});

test("file service watcher converges after edit, delete, and recreate", async (t) => {
  const workspace = createWorkspace();
  const service = createProjectWorkFileService();
  const events = [];
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });
  writeProjectWork(workspace, "- [ ] One\n");
  const initial = await service.watch(workspace.root, "test-renderer", (event) => events.push(event));
  assert.equal(initial.openCount, 1);

  fs.writeFileSync(workspace.file, "- [x] One\n- [ ] Two\n");
  await waitFor(() => events.find((event) => event.state?.openCount === 1 && event.state?.completedCount === 1));

  fs.unlinkSync(workspace.file);
  await waitFor(() => events.find((event) => event.state?.status === "missing"));

  fs.writeFileSync(workspace.file, "- [ ] Recreated\n");
  await waitFor(() => events.find((event) => event.state?.content === "- [ ] Recreated\n"));
  await service.unwatch(workspace.root, "test-renderer");
});

test("watch failures surface in state without crashing reads", async (t) => {
  const workspace = createWorkspace();
  const watchers = [];
  const service = createProjectWorkFileService({
    watchFactory() {
      const watcher = {
        close() {},
        on(event, listener) {
          if (event === "error") {
            watchers.push(listener);
          }
          return watcher;
        },
      };
      return watcher;
    },
  });
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });
  writeProjectWork(workspace, "- [ ] One\n");
  const events = [];
  await service.watch(workspace.root, "test-renderer", (event) => events.push(event));
  watchers[0](new Error("watch exploded"));
  await waitFor(() => events.find((event) => event.state?.watchError === "watch exploded"));
  assert.equal((await service.read(workspace.root)).status, "ready");
});

test("file service fails closed for unsafe roots and symlinked project paths", async (t) => {
  const workspace = createWorkspace();
  const outside = tempDirectory("codex-project-work-outside-");
  const service = createProjectWorkFileService();
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
    fs.rmSync(outside, { force: true, recursive: true });
  });
  assert.equal((await service.handle({ action: "read", workspaceRoot: "relative" })).code, "PROJECT_WORK_UNSAFE_ROOT");
  fs.symlinkSync(outside, workspace.codexDir);
  const linked = await service.handle({ action: "read", workspaceRoot: workspace.root });
  assert.equal(linked.ok, false);
  assert.equal(linked.code, "PROJECT_WORK_UNSAFE_PATH");
  assert.equal(fs.existsSync(path.join(outside, "work-packages.md")), false);
});

test("file service exposes no desktop-open action", async (t) => {
  const workspace = createWorkspace();
  const service = createProjectWorkFileService();
  t.after(() => {
    service.dispose();
    fs.rmSync(workspace.root, { force: true, recursive: true });
  });
  writeProjectWork(workspace, "- [ ] One\n");
  assert.equal(service.open, undefined);
  const result = await service.handle({ action: "open", workspaceRoot: workspace.root });
  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_WORK_BAD_REQUEST");
});

test("context coordinator isolates tasks and projects and avoids duplicate revisions", async () => {
  const states = new Map([
    ["/project/a", { completedCount: 0, content: "- [ ] A\n", openCount: 1, path: "/project/a/.codex/work-packages.md", revision: "a1", status: "ready" }],
    ["/project/b", { completedCount: 1, content: "- [x] B\n", openCount: 0, path: "/project/b/.codex/work-packages.md", revision: "b1", status: "ready" }],
  ]);
  const coordinator = createProjectWorkContextCoordinator({ read: async (root) => ({ ok: true, state: states.get(root) }) });

  const taskOne = await coordinator.prepare("turn/start", { cwd: "/project/a", threadId: "task-1" });
  assert.equal(taskOne.state.revision, "a1");
  taskOne.acknowledge();
  assert.equal(await coordinator.prepare("turn/start", { cwd: "/project/a", threadId: "task-1" }), null);

  const taskTwo = await coordinator.prepare("turn/start", { cwd: "/project/a", threadId: "task-2" });
  assert.equal(taskTwo.state.content, "- [ ] A\n");
  taskTwo.acknowledge();

  const otherProject = await coordinator.prepare("turn/start", { cwd: "/project/b", threadId: "task-3" });
  assert.equal(otherProject.state.content, "- [x] B\n");
  otherProject.acknowledge();
  assert.equal(coordinator.inspect("task-1").workspaceRoot, "/project/a");
  assert.equal(coordinator.inspect("task-3").workspaceRoot, "/project/b");

  coordinator.associate("existing-task", "/project/b");
  const firstSteer = await coordinator.prepare("turn/steer", { threadId: "existing-task" });
  assert.equal(firstSteer.state.revision, "b1");
});

test("context sends initial and changed snapshots on submit and steer with correct trust", async () => {
  let state = {
    completedCount: 0,
    content: "- [ ] Initial\n",
    openCount: 1,
    path: "/project/.codex/work-packages.md",
    revision: "r1",
    status: "ready",
  };
  const coordinator = createProjectWorkContextCoordinator({ read: async () => ({ ok: true, state }) });
  const first = await coordinator.prepare("turn/start", {
    additionalContext: { existing: { kind: "application", value: "keep" } },
    cwd: "/project",
    threadId: "task",
  });
  assert.deepEqual(first.params.additionalContext["codex.projectWork.markdown.v1"], {
    kind: "untrusted",
    value: "- [ ] Initial\n",
  });
  const firstMetadata = JSON.parse(first.params.additionalContext["codex.projectWork.metadata.v1"].value);
  assert.equal(first.params.additionalContext["codex.projectWork.metadata.v1"].kind, "application");
  assert.equal(firstMetadata.changedSinceLastTurn, false);
  assert.equal(first.params.additionalContext.existing.value, "keep");
  assert.equal(coordinator.inspect("task").lastDelivered, null);
  first.acknowledge();
  assert.equal(coordinator.inspect("task").lastDelivered, "r1");

  state = { ...state, content: "- [x] Initial\n- [ ] Added\n", revision: "r2" };
  coordinator.markDirty("/project", "r2");
  const changed = await coordinator.prepare("turn/steer", {
    expectedTurnId: "turn-1",
    input: [],
    threadId: "task",
  });
  const changedMetadata = JSON.parse(changed.params.additionalContext["codex.projectWork.metadata.v1"].value);
  assert.equal(changedMetadata.changedSinceLastTurn, true);
  assert.equal(changed.params.additionalContext["codex.projectWork.markdown.v1"].value, state.content);
  changed.acknowledge();
  assert.equal(await coordinator.prepare("turn/steer", { threadId: "task" }), null);
});

test("context acknowledges only accepted requests and bounds unusually large snapshots", async () => {
  const content = "- [ ] Top\n" + "note\n".repeat(100);
  const state = {
    completedCount: 0,
    content,
    items: [{ checked: false, depth: 0, text: "Top" }],
    openCount: 1,
    path: "/project/.codex/work-packages.md",
    revision: revisionForContent(content),
    status: "ready",
  };
  const coordinator = createProjectWorkContextCoordinator({
    maxSnapshotBytes: 32,
    read: async () => ({ ok: true, state }),
  });
  const pending = await coordinator.prepare("turn/start", { cwd: "/project", threadId: "task" });
  assert.equal(coordinator.inspect("task").lastDelivered, null);
  const markdown = pending.params.additionalContext["codex.projectWork.markdown.v1"].value;
  assert.match(markdown, /bounded top-level summary/);
  assert.match(markdown, /- \[ \] Top/);
  assert.equal(pending.metadata.boundedSnapshot, true);

  const retry = await coordinator.prepare("turn/start", { cwd: "/project", threadId: "task" });
  retry.acknowledge();
  assert.equal(coordinator.inspect("task").lastDelivered, state.revision);
  pending.acknowledge();
  assert.equal(coordinator.inspect("task").lastDelivered, state.revision);
  assert.equal(await coordinator.prepare("turn/start", { cwd: "/project", threadId: "task" }), null);
  assert.equal(await coordinator.prepare("turn/start", { cwd: "/project", threadId: "remote" }, "remote-host"), null);
});

test("patches Project Work only into the right-side section list", () => {
  const main = syntheticMainBundle();
  const patchedMain = applyMainProcessBridgePatch(main);
  assert.notEqual(patchedMain, main);
  assert.match(patchedMain, /codexLinuxProjectWorkMainBridgeV1/);
  assert.equal(applyMainProcessBridgePatch(patchedMain), patchedMain);

  const context = syntheticContextBundle();
  const patchedContext = applyContextDeliveryPatch(context);
  assert.notEqual(patchedContext, context);
  assert.match(patchedContext, /codexLinuxProjectWorkContextV1/);
  assert.match(patchedContext, /codexLinuxProjectWorkPrepared/);
  assert.equal(applyContextDeliveryPatch(patchedContext), patchedContext);

  for (const wrapped of [false, true]) {
    const sidebar = syntheticSidebarBundle({ wrapped });
    const patchedSidebar = applySidebarPatch(sidebar);
    assert.notEqual(patchedSidebar, sidebar);
    assert.match(patchedSidebar, /codexLinuxProjectWorkSidebarV1/);
    assert.match(patchedSidebar, /data-project-work-status/);
    assert.match(patchedSidebar, /data-project-work-create/);
    assert.match(patchedSidebar, /Create Project work file/);
    assert.match(patchedSidebar, /\.SectionActions/);
    assert.match(patchedSidebar, /Y\.IconButton/);
    assert.match(patchedSidebar, /\(0,tS\.jsx\)\(At,\{\}\)/);
    assert.doesNotMatch(patchedSidebar, /inline-flex size-6/);
    assert.match(patchedSidebar, /after: createAction/);
    assert.equal(
      [
        ...patchedSidebar.matchAll(
          /\(0,tS\.jsx\)\(codexLinuxProjectWorkCard,\{embedded:!0,shouldHideInlineImmediately:!1,shouldShow:!0\}\)/g,
        ),
      ].length,
      1,
    );
    assert.doesNotMatch(
      patchedSidebar,
      /\(0,tS\.jsx\)\(codexLinuxProjectWorkCard,\{shouldHideInlineImmediately:/,
    );
    assert.doesNotMatch(patchedSidebar, /Create file/);
    assert.doesNotMatch(patchedSidebar, /Open Markdown|openMarkdown|action:"open"/);
    assert.match(patchedSidebar, /Project work/);
    assert.match(patchedSidebar, /Ux\.useState/);
    assert.match(patchedSidebar, /r\(Di\)/);
    assert.match(patchedSidebar, /o\(ss\)/);
    assert.match(patchedSidebar, /ee\(environment\.cwd\)/);
    assert.match(patchedSidebar, /Y\.Section/);
    assert.equal(applySidebarPatch(patchedSidebar), patchedSidebar);
  }
  assert.doesNotMatch(patchedMain, /PROJECT_WORK_OPEN_FAILED|shell\.openPath/);
});

test("preload patch exposes a scoped projectWork bridge and is idempotent", (t) => {
  const root = tempDirectory("codex-project-work-preload-");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const build = path.join(root, ".vite", "build");
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(
    path.join(build, "preload.js"),
    "let e=require(\"electron\");var L=new Map,R=new Map,z={getSharedObjectSnapshotValue(){}};e.contextBridge.exposeInMainWorld(`electronBridge`,z);",
  );
  assert.deepEqual(applyPreloadBridgePatch(root), { changed: true, matched: true });
  const content = fs.readFileSync(path.join(build, "preload.js"), "utf8");
  assert.match(content, /projectWork:codexLinuxProjectWorkPreloadBridge/);
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

test("asset patterns select the intended current chunk families narrowly", () => {
  assert.equal(CONTEXT_ASSET_PATTERN.test("app-initial-BTphDPeq.js"), true);
  assert.equal(CONTEXT_ASSET_PATTERN.test("app-prefetch-impl-BmB2QJVt.js"), false);
  assert.equal(SIDEBAR_ASSET_PATTERN.test("local-conversation-thread-hash.js"), true);
  assert.equal(SIDEBAR_ASSET_PATTERN.test("local-conversation-thread-hash.css"), false);
});

test("feature is disabled by default and exposes descriptors only when locally enabled", () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(FEATURE_ROOT, "features.example.json"), "utf8")).enabled, []);
  withFeatureConfig([], () => {
    assert.equal(enabledLinuxFeatureIds({ featuresRoot: FEATURE_ROOT }).includes("project-work"), false);
    assert.equal(loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURE_ROOT }).some((patch) => patch.featureId === "project-work"), false);
  });
  withFeatureConfig(["project-work"], () => {
    assert.equal(enabledLinuxFeatureIds({ featuresRoot: FEATURE_ROOT }).includes("project-work"), true);
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURE_ROOT })
        .filter((patch) => patch.featureId === "project-work")
        .map((patch) => [patch.id, patch.phase]),
      [
        ["feature:project-work:main-process-project-work-bridge", "main-bundle"],
        ["feature:project-work:preload-project-work-bridge", "extracted-app:pre-webview"],
        ["feature:project-work:turn-project-work-context", "webview-asset"],
        ["feature:project-work:sidebar-project-work-card", "webview-asset"],
      ],
    );
  });
  assert.deepEqual(descriptors.map((descriptor) => descriptor.phase), [
    "main-bundle",
    "extracted-app:pre-webview",
    "webview-asset",
    "webview-asset",
  ]);
});

test("skill draft stays in the worktree without automatic installation", () => {
  withFeatureConfig(["project-work"], () => {
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot: FEATURE_ROOT });
    assert.deepEqual(plan.resources, []);
    assert.deepEqual(plan.runtimeHooks, []);
  });
  const draftRoot = path.join(__dirname, "skill-draft", "project-work");
  assert.match(fs.readFileSync(path.join(draftRoot, "SKILL.md"), "utf8"), /^name: project-work$/m);
  assert.match(fs.readFileSync(path.join(draftRoot, "agents", "openai.yaml"), "utf8"), /display_name: "Project Work"/);
});
