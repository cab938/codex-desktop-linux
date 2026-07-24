"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  mainBundlePatch,
  webviewAssetPatch,
} = require("../../scripts/patches/descriptor.js");

const MAIN_MARKER = "codexLinuxDevColorizeMainV4";
const PRELOAD_MARKER = "codexLinuxDevColorizePreloadV3";
const CONTROLS_MARKER = "codexLinuxDevColorizeControlsV3";
const TEACHING_CONTROLS_MARKER = "codexLinuxTeachingSidebarFilterControlsPatch";
const SHARED_OBJECT_KEY = "codex_linux_dev_colorize";
const IPC_CHANNEL = "codex_desktop:dev-colorize";
const STATE_CHANNEL = "codex_desktop:dev-colorize-state";
const STATE_FILE_NAME = "dev-colorize.json";
const DEFAULT_COLOR = "#fffdf8";
const DEFAULT_STRENGTH = 50;
const TITLEBAR_HEIGHT = 30;
const MAIN_PAGE_ASSET_PATTERN =
  /^app-initial-[A-Za-z0-9_-]+\.js$/;

function validColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function validStrength(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function titlebarColor(color = DEFAULT_COLOR, strength = DEFAULT_STRENGTH) {
  const source = validColor(color) ? color.toLowerCase() : DEFAULT_COLOR;
  const amount = validStrength(strength) ? strength : DEFAULT_STRENGTH;
  const channels = [1, 3, 5].map((offset) => Number.parseInt(source.slice(offset, offset + 2), 16));
  return `#${channels
    .map((channel) => Math.round(255 + ((channel - 255) * amount) / 100).toString(16).padStart(2, "0"))
    .join("")}`;
}

function titlebarCss(color = DEFAULT_COLOR, strength = DEFAULT_STRENGTH) {
  return [
    ":root.electron-light body::before, body.electron-light::before {",
    '  content: "";',
    "  position: fixed;",
    "  inset: 0 0 auto 0;",
    `  height: ${TITLEBAR_HEIGHT}px;`,
    `  background: ${titlebarColor(color, strength)};`,
    "  mix-blend-mode: multiply;",
    "  pointer-events: none;",
    "  z-index: 2147483646;",
    "}",
  ].join("\n");
}

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping dev-colorize ${patchName}`);
}

function applyTitlebarHelperPatch(source) {
  if (source.includes("typeof codexLinuxDevColorizeTitlebarColor")) {
    return source;
  }
  const helperPattern =
    /(function codexLinuxTitleBarOverlay\(e=1\)\{return\{color:([A-Za-z_$][\w$]*)\.nativeTheme\.shouldUseDarkColors\?`#111111`:)([A-Za-z_$][\w$]*)(,symbolColor:)/;
  const match = source.match(helperPattern);
  if (match == null) {
    warn("Could not find the current Linux title-bar overlay helper", "title-bar controls patch");
    return source;
  }
  const lightBackgroundAlias = match[3];
  return source.replace(
    helperPattern,
    `$1(typeof codexLinuxDevColorizeTitlebarColor==="function"&&codexLinuxDevColorizeState?.active?codexLinuxDevColorizeTitlebarColor():${lightBackgroundAlias})$4`,
  );
}

function mainRuntimeSource() {
  return [
    `var ${MAIN_MARKER}=!0,codexLinuxDevColorizeDefaultColor=${JSON.stringify(DEFAULT_COLOR)},codexLinuxDevColorizeDefaultStrength=${DEFAULT_STRENGTH},codexLinuxDevColorizeState={active:!0,color:${JSON.stringify(DEFAULT_COLOR)},strength:${DEFAULT_STRENGTH}},codexLinuxDevColorizeRepository=null,codexLinuxDevColorizeInstalledWindows=new WeakSet,codexLinuxDevColorizeCssKeys=new Map,codexLinuxDevColorizeRevision=0,codexLinuxDevColorizeIpcInstalled=!1;`,
    `function codexLinuxDevColorizeValidColor(e){return typeof e==="string"&&/^#[0-9a-f]{6}$/i.test(e)}`,
    `function codexLinuxDevColorizeValidStrength(e){return Number.isInteger(e)&&e>=0&&e<=100}`,
    `function codexLinuxDevColorizeStatePath(){try{let e=require("node:path"),t=process.env.CODEX_LINUX_SETTINGS_FILE,n=typeof t==="string"&&t.length>0?e.dirname(t):require("electron").app.getPath("userData");return e.join(n,${JSON.stringify(STATE_FILE_NAME)})}catch{return null}}`,
    `function codexLinuxDevColorizeReadState(){try{let e=codexLinuxDevColorizeStatePath();if(e==null)return{active:!0,color:codexLinuxDevColorizeDefaultColor,strength:codexLinuxDevColorizeDefaultStrength};let t=JSON.parse(require("node:fs").readFileSync(e,"utf8"));return t?.schemaVersion===1?{active:t.active!==!1,color:codexLinuxDevColorizeDefaultColor,strength:codexLinuxDevColorizeDefaultStrength}:t?.schemaVersion===2?{active:t.active!==!1,color:codexLinuxDevColorizeValidColor(t.color)?t.color.toLowerCase():codexLinuxDevColorizeDefaultColor,strength:codexLinuxDevColorizeDefaultStrength}:t?.schemaVersion===3?{active:t.active!==!1,color:codexLinuxDevColorizeValidColor(t.color)?t.color.toLowerCase():codexLinuxDevColorizeDefaultColor,strength:codexLinuxDevColorizeValidStrength(t.strength)?t.strength:codexLinuxDevColorizeDefaultStrength}:{active:!0,color:codexLinuxDevColorizeDefaultColor,strength:codexLinuxDevColorizeDefaultStrength}}catch{return{active:!0,color:codexLinuxDevColorizeDefaultColor,strength:codexLinuxDevColorizeDefaultStrength}}}`,
    `codexLinuxDevColorizeState=codexLinuxDevColorizeReadState();`,
    `function codexLinuxDevColorizeSnapshot(){return{marker:${JSON.stringify(MAIN_MARKER)},active:codexLinuxDevColorizeState.active===!0,color:codexLinuxDevColorizeState.color,strength:codexLinuxDevColorizeState.strength}}`,
    `function codexLinuxDevColorizePublish(){try{codexLinuxDevColorizeRepository?.set?.(${JSON.stringify(SHARED_OBJECT_KEY)},codexLinuxDevColorizeSnapshot())}catch{}}`,
    `function codexLinuxDevColorizeSendSnapshot(e){try{e?.isDestroyed?.()||e?.send?.(${JSON.stringify(STATE_CHANNEL)},codexLinuxDevColorizeSnapshot())}catch{}}`,
    `function codexLinuxDevColorizeWriteState(e){let t=codexLinuxDevColorizeStatePath();if(t==null)return{ok:!1,error:"Colorize settings path is unavailable"};let n=require("node:fs"),r=require("node:path"),i=t+"."+String(process.pid)+".tmp";try{return n.mkdirSync(r.dirname(t),{recursive:!0,mode:448}),n.writeFileSync(i,JSON.stringify({schemaVersion:3,active:e.active,color:e.color,strength:e.strength})+"\\n",{encoding:"utf8",mode:384}),n.renameSync(i,t),{ok:!0}}catch(e){try{n.unlinkSync(i)}catch{}return{ok:!1,error:e instanceof Error?e.message:String(e)}}}`,
    `function codexLinuxDevColorizeTitlebarColor(){let e=codexLinuxDevColorizeState.color,t=codexLinuxDevColorizeState.strength,n=[1,3,5].map(t=>Number.parseInt(e.slice(t,t+2),16));return"#"+n.map(e=>Math.round(255+(e-255)*t/100).toString(16).padStart(2,"0")).join("")}`,
    `function codexLinuxDevColorizeCss(){return${JSON.stringify(titlebarCss())}.replace(${JSON.stringify(titlebarColor())},codexLinuxDevColorizeTitlebarColor())}`,
    `function codexLinuxDevColorizeRemoveCss(e){let t=codexLinuxDevColorizeCssKeys.get(e?.id);if(t==null)return;codexLinuxDevColorizeCssKeys.delete(e.id);try{e.isDestroyed?.()||e.removeInsertedCSS?.(t)}catch{}}`,
    `function codexLinuxDevColorizeRefreshCss(e){if(e==null||e.isDestroyed?.())return;codexLinuxDevColorizeRemoveCss(e);if(!codexLinuxDevColorizeState.active||require("electron").nativeTheme.shouldUseDarkColors)return;let t=codexLinuxDevColorizeRevision;try{Promise.resolve(e.insertCSS?.(codexLinuxDevColorizeCss(),{cssOrigin:"author"})).then(n=>{if(typeof n!=="string"||n.length===0)return;if(codexLinuxDevColorizeState.active&&!require("electron").nativeTheme.shouldUseDarkColors&&t===codexLinuxDevColorizeRevision&&!e.isDestroyed?.())codexLinuxDevColorizeCssKeys.set(e.id,n);else try{e.isDestroyed?.()||e.removeInsertedCSS?.(n)}catch{}}).catch(()=>{})}catch{}}`,
    `function codexLinuxDevColorizeApplyWindow(e){if(e==null||e.isDestroyed?.())return;try{let t=require("electron").nativeTheme.shouldUseDarkColors,n=codexLinuxDevColorizeState.active&&!t?codexLinuxDevColorizeTitlebarColor():t?"#111111":"#ffffff",r=e.webContents?.getZoomFactor?.()??1;e.setTitleBarOverlay?.({color:n,symbolColor:t?"#ffffff":"#000000",height:Math.round(${TITLEBAR_HEIGHT}*r)}),codexLinuxDevColorizeRefreshCss(e.webContents)}catch{}}`,
    `function codexLinuxDevColorizeInstallWindow(e){let t=e?.webContents;if(t==null)return;if(!codexLinuxDevColorizeInstalledWindows.has(e)){codexLinuxDevColorizeInstalledWindows.add(e),t.on?.("did-finish-load",()=>{codexLinuxDevColorizeApplyWindow(e),codexLinuxDevColorizeSendSnapshot(t)})}codexLinuxDevColorizeApplyWindow(e)}`,
    `function codexLinuxDevColorizeApplyAllWindows(){codexLinuxDevColorizeRevision++;try{for(let e of require("electron").BrowserWindow.getAllWindows())codexLinuxDevColorizeInstallWindow(e),codexLinuxDevColorizeSendSnapshot(e.webContents)}catch{}}`,
    `function codexLinuxDevColorizeCommit(e){let t=codexLinuxDevColorizeWriteState(e);if(!t.ok)return t;return codexLinuxDevColorizeState=e,codexLinuxDevColorizePublish(),codexLinuxDevColorizeApplyAllWindows(),{ok:!0,state:codexLinuxDevColorizeSnapshot()}}`,
    `function codexLinuxDevColorizeSetActive(e){return typeof e!=="boolean"?{ok:!1,error:"Colorize active state must be boolean"}:codexLinuxDevColorizeCommit({...codexLinuxDevColorizeState,active:e})}`,
    `function codexLinuxDevColorizeSetColor(e){return codexLinuxDevColorizeValidColor(e)?codexLinuxDevColorizeCommit({...codexLinuxDevColorizeState,color:e.toLowerCase()}):{ok:!1,error:"Colorize tint must be a six-digit hex color"}}`,
    `function codexLinuxDevColorizeSetStrength(e){return codexLinuxDevColorizeValidStrength(e)?codexLinuxDevColorizeCommit({...codexLinuxDevColorizeState,strength:e}):{ok:!1,error:"Colorize strength must be an integer from 0 to 100"}}`,
    `function codexLinuxDevColorizeCommand(e){return e?.action==="set-active"?codexLinuxDevColorizeSetActive(e.active):e?.action==="set-color"?codexLinuxDevColorizeSetColor(e.color):e?.action==="set-strength"?codexLinuxDevColorizeSetStrength(e.strength):{ok:!1,error:"Unknown Colorize action"}}`,
    `function codexLinuxDevColorizeBindRepository(e){codexLinuxDevColorizeRepository=e,codexLinuxDevColorizePublish();if(codexLinuxDevColorizeIpcInstalled)return;let t=require("electron");t.ipcMain.handle(${JSON.stringify(IPC_CHANNEL)},(_e,t)=>codexLinuxDevColorizeCommand(t)),codexLinuxDevColorizeIpcInstalled=!0}`,
    `if(process.platform==="linux")try{let e=require("electron");e.app.on?.("browser-window-created",(_e,t)=>codexLinuxDevColorizeInstallWindow(t)),e.nativeTheme.on?.("updated",codexLinuxDevColorizeApplyAllWindows);for(let t of e.BrowserWindow.getAllWindows())codexLinuxDevColorizeInstallWindow(t)}catch{}`,
  ].join("");
}

function applyMainProcessPatch(source) {
  if (typeof source !== "string") {
    warn("Main bundle source is not a string", "main-process patch");
    return source;
  }
  if (source.includes(MAIN_MARKER)) {
    return source;
  }
  const repositoryPattern =
    /(this\.sharedObjectRepository=new [A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*,this\.sharedObjectRepository\.set\(`host_config`,[A-Za-z_$][\w$]*\),)/g;
  const matches = [...source.matchAll(repositoryPattern)];
  if (matches.length !== 1 || !source.includes(".BrowserWindow")) {
    warn(
      `Expected one current shared-object repository insertion point, found ${matches.length}`,
      "main-process patch",
    );
    return source;
  }
  const withTitlebar = applyTitlebarHelperPatch(source);
  const injection =
    `${matches[0][1]}codexLinuxDevColorizeBindRepository(this.sharedObjectRepository),`;
  return mainRuntimeSource() + withTitlebar.replace(matches[0][0], injection);
}

function preloadBridgeSource(electronAlias) {
  return (
    `devColorize:{` +
    `getSnapshot:()=>codexLinuxDevColorizePreloadState,` +
    `subscribe:codexLinuxDevColorizeListener=>{if(typeof codexLinuxDevColorizeListener!=="function")return()=>{};codexLinuxDevColorizePreloadListeners.add(codexLinuxDevColorizeListener);return()=>codexLinuxDevColorizePreloadListeners.delete(codexLinuxDevColorizeListener)},` +
    `setActive:codexLinuxDevColorizeActive=>${electronAlias}.ipcRenderer.invoke(${JSON.stringify(IPC_CHANNEL)},{action:"set-active",active:codexLinuxDevColorizeActive}),` +
    `setColor:codexLinuxDevColorizeColor=>${electronAlias}.ipcRenderer.invoke(${JSON.stringify(IPC_CHANNEL)},{action:"set-color",color:codexLinuxDevColorizeColor}),` +
    `setStrength:codexLinuxDevColorizeStrength=>${electronAlias}.ipcRenderer.invoke(${JSON.stringify(IPC_CHANNEL)},{action:"set-strength",strength:codexLinuxDevColorizeStrength})` +
    `},`
  );
}

function applyPreloadBridgePatch(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const candidates = fs.existsSync(buildDir)
    ? fs.readdirSync(buildDir).filter((name) => /^preload(?:-[^.]+)?\.js$/.test(name))
    : [];
  if (candidates.length !== 1) {
    warn(
      `Expected one current preload bundle in ${buildDir}, found ${candidates.length}`,
      "preload bridge patch",
    );
    return { changed: false, matched: false, reason: "current preload bundle was not unique" };
  }

  const preloadPath = path.join(buildDir, candidates[0]);
  const source = fs.readFileSync(preloadPath, "utf8");
  if (source.includes(PRELOAD_MARKER)) {
    return { changed: false, matched: true };
  }
  const electronMatch = source.match(
    /\blet ([A-Za-z_$][\w$]*)=require\(["'`]electron["'`]\);/,
  );
  const getterNeedle = "getSharedObjectSnapshotValue:e=>k[e]";
  if (
    electronMatch == null ||
    source.split(getterNeedle).length !== 2 ||
    !source.includes("exposeInMainWorld(`electronBridge`")
  ) {
    warn("Could not find the current preload electronBridge construction", "preload bridge patch");
    return { changed: false, matched: false, reason: "preload electronBridge anchor drifted" };
  }
  const electronAlias = electronMatch[1];
  const stateRuntime =
    `var ${PRELOAD_MARKER}=!0,codexLinuxDevColorizePreloadState=JSON.stringify({active:!0,color:${JSON.stringify(DEFAULT_COLOR)},strength:${DEFAULT_STRENGTH}}),codexLinuxDevColorizePreloadListeners=new Set;` +
    `${electronAlias}.ipcRenderer.on(${JSON.stringify(STATE_CHANNEL)},(_e,codexLinuxDevColorizeNextState)=>{if(codexLinuxDevColorizeNextState==null||typeof codexLinuxDevColorizeNextState!=="object")return;let codexLinuxDevColorizeNextSnapshot=JSON.stringify({active:codexLinuxDevColorizeNextState.active!==!1,color:typeof codexLinuxDevColorizeNextState.color==="string"&&/^#[0-9a-f]{6}$/i.test(codexLinuxDevColorizeNextState.color)?codexLinuxDevColorizeNextState.color:${JSON.stringify(DEFAULT_COLOR)},strength:Number.isInteger(codexLinuxDevColorizeNextState.strength)&&codexLinuxDevColorizeNextState.strength>=0&&codexLinuxDevColorizeNextState.strength<=100?codexLinuxDevColorizeNextState.strength:${DEFAULT_STRENGTH}});if(codexLinuxDevColorizeNextSnapshot===codexLinuxDevColorizePreloadState)return;codexLinuxDevColorizePreloadState=codexLinuxDevColorizeNextSnapshot;for(let codexLinuxDevColorizeListener of codexLinuxDevColorizePreloadListeners)try{codexLinuxDevColorizeListener()}catch{}});`;
  const withStateRuntime = source.replace(
    electronMatch[0],
    `${electronMatch[0]}${stateRuntime}`,
  );
  const patched =
    withStateRuntime.replace(
      getterNeedle,
      `${preloadBridgeSource(electronAlias)}${getterNeedle}`,
    );
  fs.writeFileSync(preloadPath, patched, "utf8");
  return { changed: true, matched: true };
}

function controlsRuntimeSource() {
  return [
    `var ${CONTROLS_MARKER}=!0;`,
    `function codexLinuxDevColorizeControlsRead(){try{return globalThis.electronBridge?.devColorize?.getSnapshot?.()??JSON.stringify({active:!0,color:${JSON.stringify(DEFAULT_COLOR)},strength:${DEFAULT_STRENGTH}})}catch{return JSON.stringify({active:!0,color:${JSON.stringify(DEFAULT_COLOR)},strength:${DEFAULT_STRENGTH}})}}`,
    `function codexLinuxDevColorizeControlsSubscribe(e){try{return globalThis.electronBridge?.devColorize?.subscribe?.(e)??(()=>{})}catch{return()=>{}}}`,
    `function codexLinuxDevColorizeControlsSnapshot(e){try{let t=typeof e==="string"?JSON.parse(e):e;return{active:t?.active!==!1,color:typeof t?.color==="string"&&/^#[0-9a-f]{6}$/i.test(t.color)?t.color:${JSON.stringify(DEFAULT_COLOR)},strength:Number.isInteger(t?.strength)&&t.strength>=0&&t.strength<=100?t.strength:${DEFAULT_STRENGTH}}}catch{return{active:!0,color:${JSON.stringify(DEFAULT_COLOR)},strength:${DEFAULT_STRENGTH}}}}`,
    `function codexLinuxDevColorizeControlGroup(e){let t=e.jsx,n=e.menu,r=codexLinuxDevColorizeControlsSnapshot(e.useSyncExternalStore(codexLinuxDevColorizeControlsSubscribe,codexLinuxDevColorizeControlsRead,codexLinuxDevColorizeControlsRead)),i=globalThis.electronBridge?.devColorize,a=(0,t.jsx)(n.Item,{key:"dev-colorize-toggle",role:"menuitemcheckbox","aria-checked":r.active,onSelect:()=>{i?.setActive?.(!r.active)?.then?.(e=>{e?.ok===!1&&console.error("Could not update Colorize",e.error)}).catch?.(e=>console.error("Could not update Colorize",e))},children:(0,t.jsxs)("div",{className:"flex w-full items-center justify-between gap-3",children:[(0,t.jsx)("span",{children:"Colorize"}),(0,t.jsx)("span",{className:"text-token-description-foreground",children:r.active?"On":"Off"})]})}),o=(0,t.jsxs)("div",{key:"dev-colorize-tint",className:"flex w-full items-center justify-between gap-3 px-2 py-1.5 text-sm",children:[(0,t.jsx)("span",{children:"Tint"}),(0,t.jsx)("input",{type:"color","aria-label":"Colorize tint",title:"Choose Colorize tint",value:r.color,className:"h-6 w-8 cursor-pointer rounded border border-token-border-light bg-transparent p-0.5",onClick:e=>e.stopPropagation(),onPointerDown:e=>e.stopPropagation(),onChange:e=>{let t=e.currentTarget.value;i?.setColor?.(t)?.then?.(e=>{e?.ok===!1&&console.error("Could not update Colorize tint",e.error)}).catch?.(e=>console.error("Could not update Colorize tint",e))}})]}),s=(0,t.jsxs)("div",{key:"dev-colorize-strength",className:"flex w-full items-center justify-between gap-3 px-2 py-1.5 text-sm",children:[(0,t.jsx)("span",{children:"Strength"}),(0,t.jsxs)("div",{className:"flex items-center gap-2",children:[(0,t.jsx)("input",{type:"range","aria-label":"Colorize strength",title:"Adjust Colorize strength",min:0,max:100,step:5,value:r.strength,style:{width:84,accentColor:"var(--color-token-text-primary)"},onClick:e=>e.stopPropagation(),onPointerDown:e=>e.stopPropagation(),onChange:e=>{let t=Number(e.currentTarget.value);i?.setStrength?.(t)?.then?.(e=>{e?.ok===!1&&console.error("Could not update Colorize strength",e.error)}).catch?.(e=>console.error("Could not update Colorize strength",e))}}),(0,t.jsx)("span",{className:"w-9 text-right tabular-nums text-token-description-foreground",children:String(r.strength)+"%"})]})]});return[a,o,s]}`,
    `function codexLinuxDevColorizeControls(e){return(0,e.jsx.jsx)(codexLinuxDevColorizeControlGroup,{key:"dev-colorize",jsx:e.jsx,menu:e.menu,useSyncExternalStore:e.useSyncExternalStore})}`,
    `globalThis.codexLinuxDeveloperControls=Array.isArray(globalThis.codexLinuxDeveloperControls)?globalThis.codexLinuxDeveloperControls:[],globalThis.codexLinuxDeveloperControls.some(e=>e?.codexLinuxControlId==="dev-colorize")||Object.assign(codexLinuxDevColorizeControls,{codexLinuxControlId:"dev-colorize"})&&globalThis.codexLinuxDeveloperControls.push(codexLinuxDevColorizeControls);`,
  ].join("");
}

function applyControlsPatch(source) {
  if (typeof source !== "string") {
    warn("Webview source is not a string", "developer-controls patch");
    return source;
  }
  if (source.includes(CONTROLS_MARKER)) {
    return source;
  }
  if (
    !source.includes(TEACHING_CONTROLS_MARKER) ||
    !source.includes("codexLinuxDeveloperControls") ||
    !source.includes("codexLinuxTeachingControlsMenu")
  ) {
    warn("Could not find the developer-controls host", "developer-controls patch");
    return source;
  }
  return controlsRuntimeSource() + source;
}

const descriptors = [
  mainBundlePatch({
    id: "dev-colorize-runtime",
    order: 20_901,
    ciPolicy: "optional",
    apply: applyMainProcessPatch,
  }),
  {
    id: "preload-dev-colorize-bridge",
    phase: "extracted-app:pre-webview",
    order: 20_906,
    ciPolicy: "optional",
    apply: applyPreloadBridgePatch,
  },
  webviewAssetPatch({
    id: "dev-colorize-controls",
    order: 20_930,
    ciPolicy: "optional",
    pattern: MAIN_PAGE_ASSET_PATTERN,
    missingDescription: "current main page developer-controls bundle",
    skipDescription: "dev-colorize developer-controls patch",
    apply: applyControlsPatch,
  }),
];

module.exports = {
  CONTROLS_MARKER,
  DEFAULT_COLOR,
  DEFAULT_STRENGTH,
  IPC_CHANNEL,
  MAIN_MARKER,
  MAIN_PAGE_ASSET_PATTERN,
  PRELOAD_MARKER,
  SHARED_OBJECT_KEY,
  STATE_CHANNEL,
  STATE_FILE_NAME,
  TITLEBAR_HEIGHT,
  applyControlsPatch,
  applyMainProcessPatch,
  applyPreloadBridgePatch,
  applyTitlebarHelperPatch,
  titlebarColor,
  titlebarCss,
  controlsRuntimeSource,
  descriptors,
  mainRuntimeSource,
  validColor,
  validStrength,
};
