#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  enabledLinuxFeatureIds,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  CONTROLS_MARKER,
  DEFAULT_COLOR,
  DEFAULT_STRENGTH,
  IPC_CHANNEL,
  MAIN_MARKER,
  MAIN_PAGE_ASSET_PATTERN,
  PRELOAD_MARKER,
  SHARED_OBJECT_KEY,
  STATE_FILE_NAME,
  STATE_CHANNEL,
  TITLEBAR_HEIGHT,
  applyControlsPatch,
  applyMainProcessPatch,
  applyPreloadBridgePatch,
  applyTitlebarHelperPatch,
  controlsRuntimeSource,
  descriptors,
  mainRuntimeSource,
  titlebarColor,
  titlebarCss,
  validColor,
  validStrength,
} = require("./patch.js");

const FEATURE_ROOT = path.resolve(__dirname, "..");

function tempDirectory(prefix = "codex-dev-colorize-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withFeatureConfig(enabled, callback) {
  const temp = tempDirectory("codex-dev-colorize-features-");
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
    "let e=require(`electron`);",
    "let lightBackground=`#ffffff`,lightSymbol=`#ffffff`,darkSymbol=`#000000`;",
    "function codexLinuxTitleBarOverlay(e=1){return{color:" +
      "electron.nativeTheme.shouldUseDarkColors?`#111111`:lightBackground," +
      "symbolColor:electron.nativeTheme.shouldUseDarkColors?lightSymbol:darkSymbol," +
      "height:Math.round(30*e)}}",
    "class Host{boot(h){",
    "this.sharedObjectRepository=new R.Store,",
    "this.sharedObjectRepository.set(`host_config`,h),",
    "e.BrowserWindow.getAllWindows();",
    "}}",
  ].join("");
}

function syntheticControlsBundle() {
  return [
    "var codexLinuxTeachingSidebarFilterControlsPatch=!0;",
    "function codexLinuxTeachingControlsMenu(){",
    "return Array.isArray(globalThis.codexLinuxDeveloperControls)",
    "?globalThis.codexLinuxDeveloperControls:[]",
    "}",
  ].join("");
}

test("main-process patch installs only the Colorize runtime and shared-state binding", () => {
  const source = syntheticMainBundle();
  const patched = applyMainProcessPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(MAIN_MARKER));
  assert.match(
    patched,
    /codexLinuxDevColorizeBindRepository\(this\.sharedObjectRepository\)/,
  );
  assert.match(
    patched,
    /typeof codexLinuxDevColorizeTitlebarColor==="function"&&codexLinuxDevColorizeState\?\.active/,
  );
  assert.match(patched, new RegExp(IPC_CHANNEL));
  assert.doesNotMatch(patched, /label:"Dev"/);
  assert.doesNotMatch(patched, /setApplicationMenu/);
  assert.equal(applyMainProcessPatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));
});

test("title-bar controls use the selected color at window creation", () => {
  const source =
    "function codexLinuxTitleBarOverlay(e=1){return{color:" +
    "electron.nativeTheme.shouldUseDarkColors?`#111111`:lightBackground," +
    "symbolColor:electron.nativeTheme.shouldUseDarkColors?lightSymbol:darkSymbol," +
    "height:Math.round(30*e)}}";
  const patched = applyTitlebarHelperPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxDevColorizeTitlebarColor\(\):lightBackground/);
  assert.equal(applyTitlebarHelperPatch(patched), patched);
});

test("title bar blends the selected tint toward white", () => {
  assert.equal(validColor(DEFAULT_COLOR), true);
  assert.equal(validColor("#aBc123"), true);
  assert.equal(validColor("#abc"), false);
  assert.equal(validColor("red"), false);
  assert.equal(validStrength(DEFAULT_STRENGTH), true);
  assert.equal(validStrength(0), true);
  assert.equal(validStrength(100), true);
  assert.equal(validStrength(101), false);
  assert.equal(validStrength(49.5), false);
  assert.equal(titlebarColor("#e4f2ff", 0), "#ffffff");
  assert.equal(titlebarColor("#e4f2ff", 100), "#e4f2ff");
  assert.equal(titlebarColor("#e4f2ff", 35), "#f6faff");
  assert.equal(titlebarColor("invalid"), "#fffefc");
  assert.equal(titlebarColor("#e4f2ff", 101), "#f2f9ff");
  assert.match(titlebarCss("#e4f2ff", 35), new RegExp(`height: ${TITLEBAR_HEIGHT}px`));
  assert.match(titlebarCss("#e4f2ff", 35), /background: #f6faff/);
  assert.match(titlebarCss("#e4f2ff", 35), /pointer-events: none/);
  assert.match(titlebarCss("#e4f2ff", 35), /mix-blend-mode: multiply/);
  assert.doesNotMatch(titlebarCss("#e4f2ff", 35), /--gray-|--color-background|html::before/);
});

test("runtime defaults on, migrates old state, persists tint strength, and refreshes only title bars", async (t) => {
  const root = tempDirectory("codex-dev-colorize-runtime-");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const settingsFile = path.join(root, "settings.json");
  fs.writeFileSync(
    path.join(root, STATE_FILE_NAME),
    JSON.stringify({ schemaVersion: 2, active: true, color: "#dff6e8" }),
  );
  const overlays = [];
  const inserted = [];
  const removed = [];
  const sent = [];
  const listeners = new Map();
  let ipcHandler;
  const published = [];
  const webContents = {
    id: 42,
    getZoomFactor: () => 1,
    insertCSS(css, options) {
      inserted.push([css, options]);
      return Promise.resolve(`css-${inserted.length}`);
    },
    isDestroyed: () => false,
    on(event, listener) {
      listeners.set(event, listener);
    },
    once(event, listener) {
      listeners.set(event, listener);
    },
    removeInsertedCSS(key) {
      removed.push(key);
    },
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  const windows = [{
    webContents,
    isDestroyed: () => false,
    setTitleBarOverlay(options) {
      overlays.push(options);
    },
  }];
  const electron = {
    app: {
      getPath: () => root,
      on() {},
    },
    BrowserWindow: {
      getAllWindows: () => windows,
    },
    nativeTheme: {
      shouldUseDarkColors: false,
      on() {},
    },
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, IPC_CHANNEL);
        ipcHandler = handler;
      },
    },
  };
  const context = {
    Promise,
    console,
    globalThis: {},
    process: {
      env: { CODEX_LINUX_SETTINGS_FILE: settingsFile },
      pid: 4242,
      platform: "linux",
    },
    require(moduleName) {
      if (moduleName === "electron") return electron;
      if (moduleName === "node:fs") return fs;
      if (moduleName === "node:path") return path;
      throw new Error(`Unexpected module: ${moduleName}`);
    },
  };
  vm.runInNewContext(
    `${mainRuntimeSource()};globalThis.colorizeApi={` +
      "state:()=>codexLinuxDevColorizeState," +
      "bind:codexLinuxDevColorizeBindRepository};",
    context,
  );
  context.globalThis.colorizeApi.bind({
    set: (key, value) => published.push({ key, value }),
  });
  await Promise.resolve();
  assert.equal(context.globalThis.colorizeApi.state().active, true);
  assert.equal(context.globalThis.colorizeApi.state().color, "#dff6e8");
  assert.equal(context.globalThis.colorizeApi.state().strength, DEFAULT_STRENGTH);
  assert.deepEqual(JSON.parse(JSON.stringify(overlays.at(-1))), {
    color: "#effbf4",
    symbolColor: "#000000",
    height: 30,
  });
  await Promise.resolve();
  assert.match(inserted.at(-1)[0], /height: 30px/);
  assert.match(inserted.at(-1)[0], /background: #effbf4/);
  assert.equal(published.at(-1).key, SHARED_OBJECT_KEY);
  assert.equal(typeof ipcHandler, "function");

  const recolored = ipcHandler({}, { action: "set-color", color: "#e4f2ff" });
  assert.equal(recolored.ok, true);
  assert.equal(context.globalThis.colorizeApi.state().color, "#e4f2ff");
  assert.deepEqual(JSON.parse(JSON.stringify(overlays.at(-1))), {
    color: "#f2f9ff",
    symbolColor: "#000000",
    height: 30,
  });
  await Promise.resolve();
  assert.match(inserted.at(-1)[0], /background: #f2f9ff/);
  assert.deepEqual(removed, ["css-1"]);

  const restrained = ipcHandler({}, { action: "set-strength", strength: 35 });
  assert.equal(restrained.ok, true);
  assert.equal(context.globalThis.colorizeApi.state().strength, 35);
  assert.deepEqual(JSON.parse(JSON.stringify(overlays.at(-1))), {
    color: "#f6faff",
    symbolColor: "#000000",
    height: 30,
  });
  await Promise.resolve();
  assert.match(inserted.at(-1)[0], /background: #f6faff/);
  assert.deepEqual(removed, ["css-1", "css-2"]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, STATE_FILE_NAME), "utf8")),
    { schemaVersion: 3, active: true, color: "#e4f2ff", strength: 35 },
  );
  assert.equal(fs.statSync(path.join(root, STATE_FILE_NAME)).mode & 0o777, 0o600);

  const disabled = ipcHandler({}, { action: "set-active", active: false });
  assert.equal(disabled.ok, true);
  assert.equal(context.globalThis.colorizeApi.state().active, false);
  assert.deepEqual(JSON.parse(JSON.stringify(overlays.at(-1))), {
    color: "#ffffff",
    symbolColor: "#000000",
    height: 30,
  });
  assert.deepEqual(removed, ["css-1", "css-2", "css-3"]);
  assert.equal(published.at(-1).value.active, false);
  assert.equal(sent.at(-1).channel, STATE_CHANNEL);
  assert.equal(sent.at(-1).payload.active, false);
  assert.equal(listeners.has("did-finish-load"), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(ipcHandler({}, { action: "set-color", color: "blue" }))),
    {
      ok: false,
      error: "Colorize tint must be a six-digit hex color",
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ipcHandler({}, { action: "set-strength", strength: 101 }))),
    {
      ok: false,
      error: "Colorize strength must be an integer from 0 to 100",
    },
  );
});

test("preload patch exposes only Colorize setters and is idempotent", async (t) => {
  const root = tempDirectory("codex-dev-colorize-preload-");
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const build = path.join(root, ".vite", "build");
  fs.mkdirSync(build, { recursive: true });
  const preloadPath = path.join(build, "preload.js");
  fs.writeFileSync(
    preloadPath,
    "var teaching=!0;let e=require(\"electron\");let k={};" +
      "e.contextBridge.exposeInMainWorld(`electronBridge`,{" +
      "teachingView:{setActive(){}},getSharedObjectSnapshotValue:e=>k[e]});",
  );
  assert.deepEqual(applyPreloadBridgePatch(root), { changed: true, matched: true });
  const patched = fs.readFileSync(preloadPath, "utf8");
  assert.match(patched, new RegExp(PRELOAD_MARKER));
  assert.match(patched, /devColorize:\{getSnapshot:[^,]+,subscribe:/);
  assert.match(patched, /,setActive:/);
  assert.match(patched, /setColor:/);
  assert.match(patched, /setStrength:/);

  const invokes = [];
  let stateListener;
  let exposed;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) {
        assert.equal(name, "electronBridge");
        exposed = value;
      },
    },
    ipcRenderer: {
      on(channel, listener) {
        assert.equal(channel, STATE_CHANNEL);
        stateListener = listener;
      },
      invoke(channel, payload) {
        invokes.push({ channel, payload });
        return Promise.resolve({ ok: true });
      },
    },
  };
  vm.runInNewContext(patched, {
    require(specifier) {
      assert.equal(specifier, "electron");
      return electron;
    },
  });
  assert.deepEqual(JSON.parse(exposed.devColorize.getSnapshot()), {
    active: true,
    color: DEFAULT_COLOR,
    strength: DEFAULT_STRENGTH,
  });
  let notifications = 0;
  const unsubscribe = exposed.devColorize.subscribe(() => {
    notifications += 1;
  });
  stateListener({}, { active: false, color: "#e4f2ff", strength: 35 });
  assert.deepEqual(JSON.parse(exposed.devColorize.getSnapshot()), {
    active: false,
    color: "#e4f2ff",
    strength: 35,
  });
  assert.equal(notifications, 1);
  unsubscribe();
  stateListener({}, { active: true, color: "#f4e7ff", strength: 65 });
  assert.equal(notifications, 1);
  await exposed.devColorize.setActive(false);
  await exposed.devColorize.setColor("#e4f2ff");
  await exposed.devColorize.setStrength(35);
  assert.deepEqual(JSON.parse(JSON.stringify(invokes)), [
    { channel: IPC_CHANNEL, payload: { action: "set-active", active: false } },
    { channel: IPC_CHANNEL, payload: { action: "set-color", color: "#e4f2ff" } },
    { channel: IPC_CHANNEL, payload: { action: "set-strength", strength: 35 } },
  ]);
  assert.deepEqual(applyPreloadBridgePatch(root), { changed: false, matched: true });
});

test("renderer registers matched-type Colorize, Tint, and Strength controls", async () => {
  const source = syntheticControlsBundle();
  const patched = applyControlsPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(CONTROLS_MARKER));
  assert.match(patched, /children:"Colorize"/);
  assert.match(patched, /children:"Tint"/);
  assert.match(patched, /children:"Strength"/);
  assert.match(patched, /type:"color"/);
  assert.match(patched, /type:"range"/);
  assert.match(patched, /"aria-label":"Colorize tint"/);
  assert.match(patched, /"aria-label":"Colorize strength"/);
  assert.match(patched, /px-2 py-1\.5 text-sm/);
  assert.equal(applyControlsPatch(patched), patched);
  assert.doesNotThrow(() => new vm.Script(patched));

  const calls = [];
  const jsx = {
    jsx(type, props) {
      return { type, props };
    },
    jsxs(type, props) {
      return { type, props };
    },
  };
  const context = {
    console,
    globalThis: {
      electronBridge: {
        getSharedObjectSnapshotValue(key) {
          assert.equal(key, SHARED_OBJECT_KEY);
          return { active: true, color: "#e4f2ff", strength: 35 };
        },
        devColorize: {
          getSnapshot() {
            return JSON.stringify({ active: true, color: "#e4f2ff", strength: 35 });
          },
          subscribe() {
            return () => {};
          },
          setActive(active) {
            calls.push(["active", active]);
            return Promise.resolve({ ok: true });
          },
          setColor(color) {
            calls.push(["color", color]);
            return Promise.resolve({ ok: true });
          },
          setStrength(strength) {
            calls.push(["strength", strength]);
            return Promise.resolve({ ok: true });
          },
        },
      },
    },
  };
  vm.runInNewContext(
    `${controlsRuntimeSource()};globalThis.registered=globalThis.codexLinuxDeveloperControls`,
    context,
  );
  assert.equal(context.globalThis.registered.length, 1);
  const group = context.globalThis.registered[0]({
    jsx,
    menu: { Item: "MenuItem" },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  });
  assert.equal(group.type.name, "codexLinuxDevColorizeControlGroup");
  const [toggle, picker, strength] = group.type(group.props);
  assert.equal(toggle.type, "MenuItem");
  assert.equal(toggle.props["aria-checked"], true);
  assert.equal(picker.type, "div");
  assert.match(picker.props.className, /\btext-sm\b/);
  const input = picker.props.children[1];
  assert.equal(input.type, "input");
  assert.equal(input.props.type, "color");
  assert.equal(input.props.value, "#e4f2ff");
  assert.equal(strength.type, "div");
  assert.match(strength.props.className, /\btext-sm\b/);
  const strengthInput = strength.props.children[1].props.children[0];
  assert.equal(strengthInput.type, "input");
  assert.equal(strengthInput.props.type, "range");
  assert.equal(strengthInput.props.min, 0);
  assert.equal(strengthInput.props.max, 100);
  assert.equal(strengthInput.props.step, 5);
  assert.equal(strengthInput.props.value, 35);
  assert.equal(strength.props.children[1].props.children[1].props.children, "35%");
  toggle.props.onSelect();
  input.props.onChange({ currentTarget: { value: "#f4e7ff" } });
  strengthInput.props.onChange({ currentTarget: { value: "65" } });
  await Promise.resolve();
  assert.deepEqual(calls, [
    ["active", false],
    ["color", "#f4e7ff"],
    ["strength", 65],
  ]);
});

test("patch drift is fail-soft with actionable warnings", () => {
  const main = captureWarnings(() => applyMainProcessPatch("let stale=true"));
  assert.equal(main.result, "let stale=true");
  assert.match(main.warnings.join("\n"), /shared-object repository insertion point/);

  const controls = captureWarnings(() => applyControlsPatch("let stale=true"));
  assert.equal(controls.result, "let stale=true");
  assert.match(controls.warnings.join("\n"), /developer-controls host/);
});

test("feature is disabled by default, requires its host, and exposes three descriptors", () => {
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(FEATURE_ROOT, "features.example.json"), "utf8")).enabled,
    [],
  );
  withFeatureConfig([], () => {
    assert.equal(enabledLinuxFeatureIds({ featuresRoot: FEATURE_ROOT }).includes("dev-colorize"), false);
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURE_ROOT })
        .some((patch) => patch.featureId === "dev-colorize"),
      false,
    );
  });
  withFeatureConfig(["dev-colorize"], () => {
    assert.throws(
      () => loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURE_ROOT }),
      /requires 'teaching-sidebar-filter' to be enabled/,
    );
  });
  withFeatureConfig(["teaching-sidebar-filter", "dev-colorize"], () => {
    assert.equal(enabledLinuxFeatureIds({ featuresRoot: FEATURE_ROOT }).includes("dev-colorize"), true);
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: FEATURE_ROOT })
        .filter((patch) => patch.featureId === "dev-colorize")
        .map((patch) => [patch.id, patch.phase, patch.ciPolicy]),
      [
        ["feature:dev-colorize:dev-colorize-runtime", "main-bundle", "optional"],
        [
          "feature:dev-colorize:preload-dev-colorize-bridge",
          "extracted-app:pre-webview",
          "optional",
        ],
        ["feature:dev-colorize:dev-colorize-controls", "webview-asset", "optional"],
      ],
    );
  });
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase]),
    [
      ["dev-colorize-runtime", "main-bundle"],
      ["preload-dev-colorize-bridge", "extracted-app:pre-webview"],
      ["dev-colorize-controls", "webview-asset"],
    ],
  );
  assert.equal(
    MAIN_PAGE_ASSET_PATTERN.test("app-initial-ogh9jurw-current.js"),
    true,
  );
  assert.equal(MAIN_PAGE_ASSET_PATTERN.test("projects-index-page-current.js"), false);
});
