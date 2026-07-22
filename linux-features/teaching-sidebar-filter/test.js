#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const {
  DEFAULT_FLAGS,
  DEFAULT_PROJECT_PATTERN,
  INDICATOR_ID,
  MAIN_PAGE_ASSET_PATTERN,
  MAIN_PAGE_PATCH_MARKER,
  MAIN_PROCESS_MARKER,
  PROJECTS_PATCH_MARKER,
  PROJECTS_SIDEBAR_ASSET_PATTERN,
  RUNTIME_MARKER,
  SHARED_OBJECT_KEY,
  WINDOW_PATCH_MARKER,
  applyMainPagePatch,
  applyMainProcessPatch,
  applyProjectsSidebarPatch,
  descriptors,
  normalizedFilterSettings,
  runtimeSource,
  validatePreloadBridge,
} = require("./patch.js");

const manifest = {
  filter: {
    projectPattern: DEFAULT_PROJECT_PATTERN,
    flags: DEFAULT_FLAGS,
  },
};

function featureContext(settings = {}) {
  return { feature: { manifest, settings } };
}

function captureWarns(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function withFeatureConfig(enabled, settings, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teaching-sidebar-filter-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(
      process.env.CODEX_LINUX_FEATURES_CONFIG,
      JSON.stringify({ enabled, settings }),
    );
    return fn();
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function mainBundleFixture() {
  return [
    "var n={l:class{set(){}}},od={id:`local`};",
    "class App{constructor(){",
    "this.sharedObjectRepository=new n.l,",
    "this.sharedObjectRepository.set(`host_config`,od),",
    "this.sharedObjectRepository.set(`remote_ssh_connections`,[])",
    "}}",
    "class WindowManager{",
    "restorePrimaryWindowBounds(){return this.savedBounds??null}",
    "persistPrimaryWindowBounds(){}",
    "async createWindow(e={}){let{title:t,width:r=1280,height:i=820,appearance:o=`primary`,show:s=!0,initialRoute:l,hostId:d=V,parent:f,focusable:m,lockTitle:h=!1}=e,g=Date.now(),_=o===`primary`?V:d,v=o===`primary`,y=v?this.restorePrimaryWindowBounds():null,b=y?.width??r,x=y?.height??i,S=y?.x,C=y?.y,w=y?.isMaximized===!0,M=new c.BrowserWindow({width:b,height:x,...S===void 0||C===void 0?{}:{x:S,y:C},title:t??c.app.getName(),show:s});",
    "w&&M.once(`ready-to-show`,()=>{M.isDestroyed()||M.maximize()}),",
    "(h||o===`primary`)&&M.on(`page-title-updated`,e=>{e.preventDefault(),M.isDestroyed()||M.setTitle(M.getTitle())}),",
    "v&&M.on(`close`,()=>{this.persistPrimaryWindowBounds(M)});return M}",
    "}",
  ].join("");
}

async function createFixtureWindow(source, argv, savedBounds) {
  const context = {
    V: "primary-host",
    c: {
      app: { getName: () => "Codex" },
      BrowserWindow: class {
        constructor(options) {
          this.options = options;
          this.onceEvents = [];
        }
        getTitle() {
          return this.options.title;
        }
        isDestroyed() {
          return false;
        }
        maximize() {}
        on() {}
        once(name) {
          this.onceEvents.push(name);
        }
        setTitle(title) {
          this.options.title = title;
        }
      },
    },
    process: { argv, platform: "linux" },
  };
  vm.runInNewContext(`${source};globalThis.TestWindowManager=WindowManager`, context);
  const manager = new context.TestWindowManager();
  manager.savedBounds = savedBounds;
  return manager.createWindow();
}

function projectsBundleFixture() {
  return [
    "var Kg=[];",
    "function tg(e){",
    "let t=0,{pendingStableWorktrees:i,shouldAnimateGroups:o,allowProjectReorder:s,allowThreadReorder:c,threadOrderIsPrecomputed:l,activeProjectId:u,projectRowBehavior:d,showProjectHoverCard:f,showProjectPinAction:p,showPinActionOnHover:m,...w}=e,",
    "T=i===void 0?Kg:i,E=s===void 0?!0:s,z=w.organizeMode===`connection`?w.connectionGroups?.map(og)??[]:w.groups.map(ng),",
    "K=w.groups.filter(t=>t.projectId),O=`group/folder-row`;",
    "return [T,z,K,O,f,p,o,E,t]}",
  ].join("");
}

function mainPageBundleFixture() {
  return [
    "function Gq(){let{allProjectGroups:S,allSidebarItems:C}=K(wD,{canStartProjectlessChat:o,localProjectActionsEnabled:c,sidebarMode:r});return[S,C]}",
    "function hq(e){",
    "let t=cache(),{showPinnedProjectGroups:s}=e,d=s===void 0?!0:s,p=!0,m=!0,y={canStartProjectlessChat:p,localProjectActionsEnabled:m,sidebarMode:`codex`};",
    "let{isWorkspaceRootOptionsLoading:b,pinnedProjectGroups:S,pinnedThreadKeys:C}=K(CD,y),w=K(wi,`pinned`);",
    "return {b,S,C,w,d,locationIdPrefix:`pinned-project`}}",
    "function TK({codexFeaturesAllowed:e}){",
    "let t=!0,n=!0,l=[],u=K(qM,`chatgpt`),{chatSortMode:d,projectSortMode:f}=P(zx),m=K(WM,`chatgpt`),g=Hm({codexFeaturesAllowed:e}),_=`tasks`,",
    "{pinnedProjectGroups:v,pinnedThreadKeys:y}=K(CD,{canStartProjectlessChat:t,localProjectActionsEnabled:n,sidebarMode:`chatgpt`}),",
    "b=K(yC,y),x=K(yC,u.threadKeys),N=GV({conversationFilter:_,flatConversationHistory:m===`list`||g===`codex`}),{data:L,isLoading:R}=Km(data),",
    "T=u.projectGroups,D=new Map([...T,...u.connectionGroups]);",
    "return {b,x,N,T,D,conversationByKey:new Map,projectByKey:new Map,threadContainerId:`pinned`}}",
  ].join("");
}

function runtimeContext(config, document = undefined) {
  const context = {
    electronBridge: {
      getSharedObjectSnapshotValue(key) {
        assert.equal(key, SHARED_OBJECT_KEY);
        return config;
      },
    },
    ...(document == null ? {} : { document }),
  };
  vm.runInNewContext(runtimeSource(), context);
  return context;
}

function fakeDocument() {
  const elements = new Map();
  const rootAttributes = new Map();
  const documentElement = {
    appendChild(element) {
      elements.set(element.id, element);
    },
    removeAttribute(name) {
      rootAttributes.delete(name);
    },
    setAttribute(name, value) {
      rootAttributes.set(name, value);
    },
  };
  const body = {
    appendChild(element) {
      elements.set(element.id, element);
    },
  };
  return {
    body,
    documentElement,
    elements,
    rootAttributes,
    readyState: "complete",
    addEventListener() {},
    createElement() {
      return {
        id: "",
        style: {},
        attributes: new Map(),
        setAttribute(name, value) {
          this.attributes.set(name, value);
        },
        remove() {
          elements.delete(this.id);
        },
      };
    },
    getElementById(id) {
      return elements.get(id) ?? null;
    },
  };
}

test("feature is disabled until selected and exposes four descriptors when enabled", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], {}, () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).some((descriptor) =>
        descriptor.id.startsWith("feature:teaching-sidebar-filter:"),
      ),
      false,
    );
  });

  withFeatureConfig(
    ["teaching-sidebar-filter"],
    { "teaching-sidebar-filter": { projectPattern: "^class-", flags: "i" } },
    () => {
      const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot }).filter((descriptor) =>
        descriptor.id.startsWith("feature:teaching-sidebar-filter:"),
      );
      assert.deepEqual(
        loaded.map(({ id }) => id),
        [
          "feature:teaching-sidebar-filter:startup-mode",
          "feature:teaching-sidebar-filter:preload-bridge",
          "feature:teaching-sidebar-filter:project-groups",
          "feature:teaching-sidebar-filter:pinned-items",
        ],
      );
      assert.equal(loaded[0].featureId, "teaching-sidebar-filter");
    },
  );
});

test("settings use tracked defaults and accept a valid local override", () => {
  assert.deepEqual(normalizedFilterSettings(featureContext()), {
    projectPattern: DEFAULT_PROJECT_PATTERN,
    flags: DEFAULT_FLAGS,
  });
  assert.deepEqual(
    normalizedFilterSettings(featureContext({ projectPattern: "^demo-(one|two)$", flags: "mu" })),
    { projectPattern: "^demo-(one|two)$", flags: "mu" },
  );
});

test("invalid settings warn and never become an allow-all filter", () => {
  const invalidCases = [
    { projectPattern: "", flags: "i" },
    { projectPattern: "[", flags: "i" },
    { projectPattern: ".*", flags: "gg" },
  ];
  for (const settings of invalidCases) {
    const { value, warnings } = captureWarns(() =>
      normalizedFilterSettings(featureContext(settings)),
    );
    assert.deepEqual(value, {
      projectPattern: DEFAULT_PROJECT_PATTERN,
      flags: DEFAULT_FLAGS,
    });
    assert.ok(warnings.length > 0);
  }
});

test("runtime filtering is identity-preserving while inactive", () => {
  const context = runtimeContext({
    active: false,
    projectPattern: DEFAULT_PROJECT_PATTERN,
    flags: DEFAULT_FLAGS,
  });
  const groups = [{ label: "private-project", threadKeys: ["private"] }];
  const keys = ["private"];
  assert.equal(context.codexLinuxTeachingSidebarFilterGroups(groups), groups);
  assert.equal(context.codexLinuxTeachingSidebarFilterPinnedThreadKeys(keys, groups), keys);
});

test("runtime keeps matching projects and their pinned tasks while failing closed", () => {
  const context = runtimeContext({
    active: true,
    projectPattern: "^teaching-",
    flags: "i",
  });
  const groups = [
    { label: "Teaching-Demo", threadKeys: ["allowed-a", "allowed-b"] },
    { label: "private-research", threadKeys: ["private"] },
    { path: "/tmp/teaching-path", threadKeys: ["allowed-path"] },
  ];
  assert.deepEqual(
    Array.from(context.codexLinuxTeachingSidebarFilterGroups(groups), ({ threadKeys }) =>
      Array.from(threadKeys),
    ),
    [["allowed-a", "allowed-b"], ["allowed-path"]],
  );
  assert.deepEqual(
    Array.from(
      context.codexLinuxTeachingSidebarFilterPinnedThreadKeys(
        ["private", "allowed-b", "projectless", "allowed-path"],
        groups,
      ),
    ),
    ["allowed-b", "allowed-path"],
  );

  const invalid = runtimeContext({ active: true, projectPattern: "[", flags: "i" });
  assert.deepEqual(Array.from(invalid.codexLinuxTeachingSidebarFilterGroups(groups)), []);
});

test("runtime filters pinned ChatGPT labels", () => {
  const context = runtimeContext({
    active: true,
    projectPattern: "^teaching-",
    flags: "i",
  });
  const source = {
    pinnedTargets: [
      { conversation: { title: "teaching-exercise" } },
      { conversation: { title: "private-notes" } },
    ],
    pinnedProjects: [
      { gizmo: { display: { name: "Teaching-Course" } } },
      { gizmo: { display: { name: "Personal" } } },
    ],
    chatTargets: [{ conversationId: "unchanged" }],
  };
  const filtered = context.codexLinuxTeachingSidebarFilterChatGptSource(source);
  assert.equal(filtered.pinnedTargets.length, 1);
  assert.equal(filtered.pinnedProjects.length, 1);
  assert.equal(filtered.chatTargets, source.chatTargets);
  assert.equal(source.pinnedTargets.length, 2);
});

test("runtime installs an active Teaching view indicator", () => {
  const document = fakeDocument();
  runtimeContext(
    { active: true, projectPattern: "^teaching-", flags: "i" },
    document,
  );
  const indicator = document.getElementById(INDICATOR_ID);
  assert.equal(indicator.textContent, "Teaching view");
  assert.equal(indicator.title, "Project filter: ^teaching-");
  assert.equal(
    document.rootAttributes.get("data-codex-linux-teaching-view"),
    "active",
  );
});

test("main process patch publishes startup mode and configures the Teaching view window", async () => {
  const source = mainBundleFixture();
  const patched = applyMainProcessPatch(
    source,
    featureContext({ projectPattern: "^class-", flags: "m" }),
  );
  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(MAIN_PROCESS_MARKER));
  assert.match(patched, new RegExp(WINDOW_PATCH_MARKER));
  assert.match(patched, /process\.argv\.includes\(`--teaching-mode`\)/);
  assert.match(patched, /projectPattern:"\^class-",flags:"m"/);
  assert.match(patched, /codexLinuxTeachingWindowActive\?1920:/);
  assert.match(patched, /codexLinuxTeachingWindowActive\?1080:/);
  assert.match(
    patched,
    /title:codexLinuxTeachingWindowActive\?`Codex \(teaching mode\)`:/,
  );
  assert.match(patched, /w=!codexLinuxTeachingWindowActive&&y\?\.isMaximized===!0/);
  assert.equal(applyMainProcessPatch(patched, featureContext()), patched);
  assert.doesNotThrow(() => new vm.Script(patched));

  const teachingWindow = await createFixtureWindow(
    patched,
    ["electron", "--teaching-mode"],
    { x: 40, y: 50, width: 1400, height: 900, isMaximized: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(teachingWindow.options)),
    {
      x: 40,
      y: 50,
      width: 1920,
      height: 1080,
      title: "Codex (teaching mode)",
      show: true,
    },
  );
  assert.deepEqual(Array.from(teachingWindow.onceEvents), []);

  const normalWindow = await createFixtureWindow(
    patched,
    ["electron"],
    { x: 40, y: 50, width: 1400, height: 900, isMaximized: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalWindow.options)),
    { x: 40, y: 50, width: 1400, height: 900, title: "Codex", show: true },
  );
  assert.deepEqual(Array.from(normalWindow.onceEvents), ["ready-to-show"]);
});

test("preload bridge validation accepts the current getter and warns on drift", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teaching-sidebar-filter-preload-"));
  try {
    const buildDir = path.join(tempDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const preloadPath = path.join(buildDir, "preload.js");
    fs.writeFileSync(
      preloadPath,
      "const channel=`get-shared-object-snapshot`;const bridge={getSharedObjectSnapshotValue(){}};",
    );
    assert.deepEqual(validatePreloadBridge(tempDir), { changed: false });

    fs.writeFileSync(preloadPath, "const bridge={};");
    const { value, warnings } = captureWarns(() => validatePreloadBridge(tempDir));
    assert.deepEqual(value, { changed: false });
    assert.equal(warnings.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("projects renderer patch filters data before group calculation", () => {
  const source = projectsBundleFixture();
  const patched = applyProjectsSidebarPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.match(patched, new RegExp(PROJECTS_PATCH_MARKER));
  assert.match(
    patched,
    /groups:codexLinuxTeachingSidebarFilterGroups\([A-Za-z_$][\w$]*\.groups\)/,
  );
  assert.match(patched, /codexLinuxTeachingSidebarFilterGroups\(T\)/);
  assert.equal(applyProjectsSidebarPatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("main page patch filters alternate and unified pinned data atomically", () => {
  const source = mainPageBundleFixture();
  const patched = applyMainPagePatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(MAIN_PAGE_PATCH_MARKER));
  assert.match(patched, /codexLinuxTeachingSidebarFilterAllProjectGroups/);
  assert.match(patched, /codexLinuxTeachingSidebarFilterUnifiedAllProjectGroups/);
  assert.match(
    patched,
    /codexLinuxTeachingSidebarFilterPinnedThreadKeys\([^,]+,codexLinuxTeachingSidebarFilterUnifiedAllProjectGroups\)/,
  );
  assert.match(patched, /codexLinuxTeachingSidebarFilterPinnedThreadKeys/);
  assert.match(patched, /codexLinuxTeachingSidebarFilterChatGptSource/);
  assert.equal(applyMainPagePatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("upstream marker drift leaves each target byte-identical", () => {
  const driftCases = [
    [applyMainProcessPatch, mainBundleFixture().replace("host_config", "host-config")],
    [applyMainProcessPatch, mainBundleFixture().replace("page-title-updated", "title-updated")],
    [
      applyProjectsSidebarPatch,
      projectsBundleFixture().replace("showProjectPinAction", "projectPinAction"),
    ],
    [
      applyMainPagePatch,
      mainPageBundleFixture().replace("threadContainerId:`pinned`", "threadContainerId:`other`"),
    ],
  ];
  for (const [apply, source] of driftCases) {
    const { value, warnings } = captureWarns(() => apply(source, featureContext()));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("webview descriptors target only their current semantic chunks", () => {
  assert.equal(
    PROJECTS_SIDEBAR_ASSET_PATTERN.test(
      "app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~lpx9dmpy-current.js",
    ),
    true,
  );
  assert.equal(
    PROJECTS_SIDEBAR_ASSET_PATTERN.test("app-initial~app-main~settings-page-current.js"),
    false,
  );
  assert.equal(
    MAIN_PAGE_ASSET_PATTERN.test(
      "app-initial~app-main~appgen-settings-page~page~appgen-library-page~appgen-page~appgen-setti~ogh9jurw-current.js",
    ),
    true,
  );
  assert.equal(MAIN_PAGE_ASSET_PATTERN.test("page-current.js"), false);
});

test("asset patching reports one changed projects and main-page bundle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "teaching-sidebar-filter-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(
        assetsDir,
        "app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~lpx9dmpy-current.js",
      ),
      projectsBundleFixture(),
    );
    fs.writeFileSync(
      path.join(
        assetsDir,
        "app-initial~app-main~appgen-settings-page~page~appgen-library-page~appgen-page~appgen-setti~ogh9jurw-current.js",
      ),
      mainPageBundleFixture(),
    );

    const projectsResult = patchAssetFiles(
      tempDir,
      descriptors[2].pattern,
      descriptors[2].apply,
      "missing projects",
    );
    const pageResult = patchAssetFiles(
      tempDir,
      descriptors[3].pattern,
      descriptors[3].apply,
      "missing page",
    );
    assert.deepEqual(projectsResult, { matched: 1, changed: 1 });
    assert.deepEqual(pageResult, { matched: 1, changed: 1 });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
