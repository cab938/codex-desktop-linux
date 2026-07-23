"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const DEFAULT_PROJECT_PATTERN = "^teaching-";
const DEFAULT_FLAGS = "i";
const MAX_PATTERN_LENGTH = 256;
const SHARED_OBJECT_KEY = "codex_linux_teaching_sidebar_filter";
const IPC_CHANNEL = "codex_desktop:teaching-view";
const STATE_FILE_NAME = "teaching-view.json";
const MAIN_PROCESS_MARKER = "codexLinuxTeachingSidebarFilterMainProcess";
const PRELOAD_MARKER = "codexLinuxTeachingSidebarFilterPreload";
const WINDOW_PATCH_MARKER = "codexLinuxTeachingWindowActive";
const RUNTIME_MARKER = "codexLinuxTeachingSidebarFilterRuntime";
const PROJECTS_PATCH_MARKER = "codexLinuxTeachingSidebarFilterProjectsPatch";
const MAIN_PAGE_PATCH_MARKER = "codexLinuxTeachingSidebarFilterMainPagePatch";
const CONTROLS_PATCH_MARKER = "codexLinuxTeachingSidebarFilterControlsPatch";

const PROJECTS_SIDEBAR_ASSET_PATTERN =
  /^app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~[A-Za-z0-9_-]+\.js$/;
const MAIN_PAGE_ASSET_PATTERN =
  /^app-initial~app-main~appgen-settings-page~page~appgen-library-page~appgen-page~appgen-setti~[A-Za-z0-9_-]+\.js$/;

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping teaching-sidebar-filter ${patchName}`);
}

function objectValue(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function rawFilterSettings(context) {
  return {
    ...objectValue(context?.feature?.manifest?.filter),
    ...objectValue(context?.feature?.settings),
  };
}

function validFlags(value) {
  if (typeof value !== "string" || !/^[imsu]*$/.test(value)) {
    return false;
  }
  return new Set(value).size === value.length;
}

function normalizedFilterSettings(context = {}) {
  const config = rawFilterSettings(context);
  let projectPattern = config.projectPattern;
  let flags = config.flags;
  let invalid = false;

  if (
    typeof projectPattern !== "string" ||
    projectPattern.trim().length === 0 ||
    projectPattern.length > MAX_PATTERN_LENGTH
  ) {
    console.warn(
      `WARN: teaching-sidebar-filter projectPattern must be a non-empty string of at most ${MAX_PATTERN_LENGTH} characters - using ${JSON.stringify(DEFAULT_PROJECT_PATTERN)}`,
    );
    invalid = true;
  }

  if (!validFlags(flags)) {
    console.warn(
      `WARN: teaching-sidebar-filter flags may contain unique i, m, s, and u flags - using ${JSON.stringify(DEFAULT_FLAGS)}`,
    );
    invalid = true;
  }

  if (invalid) {
    return { projectPattern: DEFAULT_PROJECT_PATTERN, flags: DEFAULT_FLAGS };
  }

  try {
    new RegExp(projectPattern, flags);
  } catch (error) {
    console.warn(
      `WARN: teaching-sidebar-filter projectPattern is not a valid regular expression (${error.message}) - using ${JSON.stringify(DEFAULT_PROJECT_PATTERN)}`,
    );
    projectPattern = DEFAULT_PROJECT_PATTERN;
    flags = DEFAULT_FLAGS;
  }

  return { projectPattern, flags };
}

function applyPreloadBridgePatch(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const candidates = fs.existsSync(buildDir)
    ? fs.readdirSync(buildDir).filter((name) => /^preload(?:-[^.]+)?\.js$/.test(name))
    : [];
  if (candidates.length !== 1) {
    console.warn(
      `WARN: Could not find exactly one current preload bundle in ${buildDir} - teaching-sidebar-filter cannot install its control bridge`,
    );
    return { changed: false, matched: false, reason: "current preload bundle was not unique" };
  }

  const preloadPath = path.join(buildDir, candidates[0]);
  const source = fs.readFileSync(preloadPath, "utf8");
  if (source.includes(PRELOAD_MARKER)) {
    return { changed: false, matched: true };
  }
  const electronMatch = source.match(/^let ([A-Za-z_$][\w$]*)=require\(["'`]electron["'`]\);/);
  const getterNeedle = "getSharedObjectSnapshotValue:e=>k[e]";
  if (
    electronMatch == null ||
    source.split(getterNeedle).length !== 2 ||
    !source.includes("getSharedObjectSnapshotValue") ||
    !source.includes("get-shared-object-snapshot") ||
    !source.includes("exposeInMainWorld(`electronBridge`")
  ) {
    console.warn(
      "WARN: Current preload electronBridge shape drifted - teaching-sidebar-filter cannot install its control bridge",
    );
    return { changed: false, matched: false, reason: "current preload electronBridge anchor drifted" };
  }
  const electronAlias = electronMatch[1];
  const bridge =
    `teachingView:{setActive:codexLinuxTeachingViewActive=>${electronAlias}.ipcRenderer.invoke(${JSON.stringify(IPC_CHANNEL)},{active:codexLinuxTeachingViewActive})},`;
  const patched =
    `var ${PRELOAD_MARKER}=!0;` +
    source.replace(getterNeedle, `${bridge}${getterNeedle}`);
  fs.writeFileSync(preloadPath, patched, "utf8");
  return { changed: true, matched: true };
}

function mainRuntimeSource({ projectPattern, flags }) {
  return [
    `var ${MAIN_PROCESS_MARKER}=!0,codexLinuxTeachingViewState={active:!1,projectPattern:${JSON.stringify(projectPattern)},flags:${JSON.stringify(flags)}},codexLinuxTeachingViewRepository=null,codexLinuxTeachingViewNormalTitles=new WeakMap,codexLinuxTeachingViewIpcInstalled=!1;`,
    `function codexLinuxTeachingViewStatePath(){try{let e=require(\"node:path\"),t=process.env.CODEX_LINUX_SETTINGS_FILE,n=typeof t===\"string\"&&t.length>0?e.dirname(t):require(\"electron\").app.getPath(\"userData\");return e.join(n,${JSON.stringify(STATE_FILE_NAME)})}catch{return null}}`,
    `function codexLinuxTeachingViewReadState(){try{let e=codexLinuxTeachingViewStatePath();if(e==null)return!1;let t=JSON.parse(require(\"node:fs\").readFileSync(e,\"utf8\"));return t?.schemaVersion===1&&t.active===!0}catch{return!1}}`,
    `codexLinuxTeachingViewState.active=codexLinuxTeachingViewReadState();`,
    `function codexLinuxTeachingViewSnapshot(){return{marker:${JSON.stringify(MAIN_PROCESS_MARKER)},active:codexLinuxTeachingViewState.active===!0,projectPattern:codexLinuxTeachingViewState.projectPattern,flags:codexLinuxTeachingViewState.flags}}`,
    `function codexLinuxTeachingViewPublish(){try{codexLinuxTeachingViewRepository?.set?.(${JSON.stringify(SHARED_OBJECT_KEY)},codexLinuxTeachingViewSnapshot())}catch{}}`,
    `function codexLinuxTeachingViewWriteState(e){let t=codexLinuxTeachingViewStatePath();if(t==null)return{ok:!1,error:\"Teaching view settings path is unavailable\"};let n=require(\"node:fs\"),r=require(\"node:path\"),i=t+\".\"+String(process.pid)+\".tmp\";try{return n.mkdirSync(r.dirname(t),{recursive:!0,mode:448}),n.writeFileSync(i,JSON.stringify({schemaVersion:1,active:e})+\"\\n\",{encoding:\"utf8\",mode:384}),n.renameSync(i,t),{ok:!0}}catch(e){try{n.unlinkSync(i)}catch{}return{ok:!1,error:e instanceof Error?e.message:String(e)}}}`,
    `function codexLinuxTeachingViewApplyWindow(e,t){if(e==null||e.isDestroyed?.())return;let n=require(\"electron\");if(t){codexLinuxTeachingViewNormalTitles.has(e)||codexLinuxTeachingViewNormalTitles.set(e,e.getTitle?.()??n.app.getName());try{e.isMaximized?.()&&e.unmaximize?.();let t=e.getBounds?.();t!=null&&e.setBounds?.({...t,width:1920,height:1080})}catch{}}try{e.setTitle?.(t?\"Codex (teaching mode)\":codexLinuxTeachingViewNormalTitles.get(e)??n.app.getName())}catch{}}`,
    `function codexLinuxTeachingViewSetActive(e,t){if(typeof e!==\"boolean\")return{ok:!1,error:\"Teaching view active state must be boolean\"};let n=codexLinuxTeachingViewWriteState(e);if(!n.ok)return n;codexLinuxTeachingViewState.active=e,codexLinuxTeachingViewPublish();let r=require(\"electron\").BrowserWindow.fromWebContents?.(t)??null;codexLinuxTeachingViewApplyWindow(r,e),setTimeout(()=>{try{r!=null&&!r.isDestroyed?.()&&r.webContents?.reload?.()}catch{}},75);return{ok:!0,state:codexLinuxTeachingViewSnapshot()}}`,
    `function codexLinuxTeachingViewBindRepository(e){codexLinuxTeachingViewRepository=e,codexLinuxTeachingViewPublish();if(codexLinuxTeachingViewIpcInstalled)return;let t=require(\"electron\");t.ipcMain.handle(${JSON.stringify(IPC_CHANNEL)},(e,t)=>codexLinuxTeachingViewSetActive(t?.active,e.sender)),codexLinuxTeachingViewIpcInstalled=!0}`,
  ].join("");
}

function runtimeSource() {
  return [
    `var ${RUNTIME_MARKER}=!0,codexLinuxTeachingSidebarFilterRegexKey=null,codexLinuxTeachingSidebarFilterRegex=null;`,
    `function codexLinuxTeachingSidebarFilterConfig(){try{return globalThis.electronBridge?.getSharedObjectSnapshotValue?.(${JSON.stringify(SHARED_OBJECT_KEY)})??null}catch{return null}}`,
    `function codexLinuxTeachingSidebarFilterActive(){return codexLinuxTeachingSidebarFilterConfig()?.active===!0}`,
    `function codexLinuxTeachingSidebarFilterMatcher(){let e=codexLinuxTeachingSidebarFilterConfig();if(e?.active!==!0)return null;let t=String(e.projectPattern??\`\`)+\`\\0\`+String(e.flags??\`\`);if(t===codexLinuxTeachingSidebarFilterRegexKey)return codexLinuxTeachingSidebarFilterRegex;codexLinuxTeachingSidebarFilterRegexKey=t;try{codexLinuxTeachingSidebarFilterRegex=new RegExp(e.projectPattern,e.flags)}catch{codexLinuxTeachingSidebarFilterRegex=!1}return codexLinuxTeachingSidebarFilterRegex}`,
    `function codexLinuxTeachingSidebarFilterDisplayName(e){if(typeof e===\`string\`)return e.trim();if(e==null||typeof e!==\`object\`)return\`\`;let t=e.label??e.name??e.project?.gizmo?.display?.name??e.gizmo?.display?.name??e.conversation?.title??e.title??e.pendingWorktree?.label??e.path??e.workspaceRoot??\`\`;if(typeof t!==\`string\`)return\`\`;if(e.label==null&&e.name==null&&(t===e.path||t===e.workspaceRoot)){let e=t.split(/[\\\\/]+/).filter(Boolean);return(e.at(-1)??t).trim()}return t.trim()}`,
    `function codexLinuxTeachingSidebarFilterMatches(e){let t=codexLinuxTeachingSidebarFilterMatcher();return t instanceof RegExp&&t.test(codexLinuxTeachingSidebarFilterDisplayName(e))}`,
    `function codexLinuxTeachingSidebarFilterGroups(e){if(!codexLinuxTeachingSidebarFilterActive())return e;return(Array.isArray(e)?e:[]).filter(codexLinuxTeachingSidebarFilterMatches)}`,
    `function codexLinuxTeachingSidebarFilterPinnedThreadKeys(e,t){if(!codexLinuxTeachingSidebarFilterActive())return e;let n=new Set(codexLinuxTeachingSidebarFilterGroups(t).flatMap(e=>Array.isArray(e?.threadKeys)?e.threadKeys:[]));return(Array.isArray(e)?e:[]).filter(e=>n.has(e))}`,
    `function codexLinuxTeachingSidebarFilterPinnedItems(e){if(!codexLinuxTeachingSidebarFilterActive())return e;return(Array.isArray(e)?e:[]).filter(codexLinuxTeachingSidebarFilterMatches)}`,
    `function codexLinuxTeachingSidebarFilterChatGptSource(e){if(!codexLinuxTeachingSidebarFilterActive())return e;return e==null||typeof e!==\`object\`?e:{...e,pinnedTargets:codexLinuxTeachingSidebarFilterPinnedItems(e.pinnedTargets),pinnedProjects:codexLinuxTeachingSidebarFilterPinnedItems(e.pinnedProjects)}}`,
    `function codexLinuxTeachingSidebarFilterApplyDocumentState(){if(typeof document===\`undefined\`)return;let e=()=>{let t=codexLinuxTeachingSidebarFilterActive(),n=document.documentElement;t?n?.setAttribute(\`data-codex-linux-teaching-view\`,\`active\`):n?.removeAttribute(\`data-codex-linux-teaching-view\`)};document.readyState===\`loading\`&&document.addEventListener(\`DOMContentLoaded\`,e,{once:!0}),e()}codexLinuxTeachingSidebarFilterApplyDocumentState();`,
  ].join("");
}

function findFunctions(source) {
  const functions = [];
  const pattern = /function ([A-Za-z_$][\w$]*)\(([^)]*)\)\{/g;
  let match;
  while ((match = pattern.exec(source)) != null) {
    const openBrace = match.index + match[0].length - 1;
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace === -1) {
      continue;
    }
    functions.push({
      name: match[1],
      start: match.index,
      end: closeBrace + 1,
      text: source.slice(match.index, closeBrace + 1),
    });
  }
  return functions;
}

function findUniqueFunction(source, markers) {
  const matches = findFunctions(source).filter(({ text }) =>
    markers.every((marker) => text.includes(marker)),
  );
  return matches.length === 1 ? matches[0] : null;
}

function replaceFunction(source, target, replacement) {
  return source.slice(0, target.start) + replacement + source.slice(target.end);
}

function findPrimaryWindowMethod(source) {
  const signaturePattern =
    /async createWindow\(([A-Za-z_$][\w$]*)=\{\}\)\{let\{title:([A-Za-z_$][\w$]*),width:([A-Za-z_$][\w$]*)=1280,height:([A-Za-z_$][\w$]*)=820,appearance:([A-Za-z_$][\w$]*)=`primary`,/g;
  const candidates = [];
  let match;
  while ((match = signaturePattern.exec(source)) != null) {
    const openBrace = source.indexOf("{let{", match.index);
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace === -1) {
      continue;
    }
    const text = source.slice(match.index, closeBrace + 1);
    if (
      text.includes("restorePrimaryWindowBounds()") &&
      text.includes(".BrowserWindow({") &&
      text.includes("page-title-updated") &&
      text.includes("persistPrimaryWindowBounds(")
    ) {
      candidates.push({
        start: match.index,
        end: closeBrace + 1,
        text,
        titleAlias: match[2],
        widthAlias: match[3],
        heightAlias: match[4],
        appearanceAlias: match[5],
      });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function patchPrimaryWindowMethod(target) {
  const {
    appearanceAlias,
    heightAlias,
    text,
    titleAlias,
    widthAlias,
  } = target;
  const boundsPattern = new RegExp(
    `,([A-Za-z_$][\\w$]*)=${escapeRegExp(appearanceAlias)}===\\\`primary\\\`,` +
      `([A-Za-z_$][\\w$]*)=\\1\\?this\\.restorePrimaryWindowBounds\\(\\):null,` +
      `([A-Za-z_$][\\w$]*)=\\2\\?\\.width\\?\\?${escapeRegExp(widthAlias)},` +
      `([A-Za-z_$][\\w$]*)=\\2\\?\\.height\\?\\?${escapeRegExp(heightAlias)},` +
      `([A-Za-z_$][\\w$]*)=\\2\\?\\.x,([A-Za-z_$][\\w$]*)=\\2\\?\\.y,` +
      `([A-Za-z_$][\\w$]*)=\\2\\?\\.isMaximized===!0,`,
  );
  const boundsMatch = text.match(boundsPattern);
  const browserWindowMatch = text.match(
    /new ([A-Za-z_$][\w$]*)\.BrowserWindow\(\{width:([A-Za-z_$][\w$]*),height:([A-Za-z_$][\w$]*),/,
  );
  if (boundsMatch == null || browserWindowMatch == null) {
    return null;
  }

  const [
    boundsNeedle,
    isPrimaryAlias,
    savedBoundsAlias,
    browserWidthAlias,
    browserHeightAlias,
    xAlias,
    yAlias,
    maximizedAlias,
  ] = boundsMatch;
  if (
    browserWindowMatch[2] !== browserWidthAlias ||
    browserWindowMatch[3] !== browserHeightAlias
  ) {
    return null;
  }

  const electronAlias = browserWindowMatch[1];
  const titleNeedle = `title:${titleAlias}??${electronAlias}.app.getName()`;
  if (text.split(titleNeedle).length !== 2) {
    return null;
  }

  const boundsReplacement =
    `,${isPrimaryAlias}=${appearanceAlias}===\`primary\`,` +
    `${WINDOW_PATCH_MARKER}=codexLinuxTeachingViewState.active===!0&&${isPrimaryAlias},` +
    `${savedBoundsAlias}=${isPrimaryAlias}?this.restorePrimaryWindowBounds():null,` +
    `${browserWidthAlias}=${WINDOW_PATCH_MARKER}?1920:${savedBoundsAlias}?.width??${widthAlias},` +
    `${browserHeightAlias}=${WINDOW_PATCH_MARKER}?1080:${savedBoundsAlias}?.height??${heightAlias},` +
    `${xAlias}=${savedBoundsAlias}?.x,${yAlias}=${savedBoundsAlias}?.y,` +
    `${maximizedAlias}=!${WINDOW_PATCH_MARKER}&&${savedBoundsAlias}?.isMaximized===!0,`;
  const titleReplacement =
    `title:${WINDOW_PATCH_MARKER}?\`Codex (teaching mode)\`:` +
    `${titleAlias}??${electronAlias}.app.getName()`;
  return text.replace(boundsNeedle, boundsReplacement).replace(titleNeedle, titleReplacement);
}

function applyMainProcessPatch(source, context = {}) {
  if (typeof source !== "string") {
    warn("Main bundle source is not a string", "main-process patch");
    return source;
  }
  const hasMainMarker = source.includes(MAIN_PROCESS_MARKER);
  const hasWindowMarker = source.includes(WINDOW_PATCH_MARKER);
  if (hasMainMarker && hasWindowMarker) {
    return source;
  }
  if (hasMainMarker || hasWindowMarker || source.includes(SHARED_OBJECT_KEY)) {
    warn("Found a partial existing teaching main-process patch", "main-process patch");
    return source;
  }

  const markerPattern =
    /(this\.sharedObjectRepository=new [A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*,this\.sharedObjectRepository\.set\(`host_config`,[A-Za-z_$][\w$]*\),)/g;
  const matches = [...source.matchAll(markerPattern)];
  if (matches.length !== 1) {
    warn("Could not find exactly one current shared-object repository insertion point", "main-process patch");
    return source;
  }

  const primaryWindowMethod = findPrimaryWindowMethod(source);
  const patchedPrimaryWindowMethod =
    primaryWindowMethod == null ? null : patchPrimaryWindowMethod(primaryWindowMethod);
  if (primaryWindowMethod == null || patchedPrimaryWindowMethod == null) {
    warn("Could not find the current primary-window startup path", "main-process patch");
    return source;
  }

  const { projectPattern, flags } = normalizedFilterSettings(context);
  const injection =
    `${matches[0][1]}` +
    `codexLinuxTeachingViewBindRepository(this.sharedObjectRepository),`;
  const withWindow = replaceFunction(source, primaryWindowMethod, patchedPrimaryWindowMethod);
  const sharedObjectIndex = withWindow.indexOf(matches[0][0]);
  if (sharedObjectIndex === -1) {
    warn("Could not retain the shared-object insertion point", "main-process patch");
    return source;
  }
  return (
    mainRuntimeSource({ projectPattern, flags }) +
    withWindow.slice(0, sharedObjectIndex) +
    injection +
    withWindow.slice(sharedObjectIndex + matches[0][0].length)
  );
}

function patchProjectGroupRenderer(functionText) {
  const destructure = functionText.match(
    /\{pendingStableWorktrees:([A-Za-z_$][\w$]*),[^{}]*\.\.\.([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*),/,
  );
  if (destructure == null) {
    return null;
  }
  const [, pendingInput, propsVar] = destructure;
  const pendingPattern = new RegExp(
    `,([A-Za-z_$][\\w$]*)=${escapeRegExp(pendingInput)}===void 0\\?[^,:;]+:${escapeRegExp(pendingInput)},`,
  );
  const pendingMatch = functionText.match(pendingPattern);
  if (pendingMatch == null) {
    return null;
  }
  const pendingVar = pendingMatch[1];
  const listPattern = new RegExp(
    `,([A-Za-z_$][\\w$]*)=${escapeRegExp(propsVar)}\\.organizeMode===\\\`connection\\\`\\?`,
  );
  const listMatches = [...functionText.matchAll(new RegExp(listPattern.source, "g"))];
  if (listMatches.length !== 1) {
    return null;
  }
  const listVar = listMatches[0][1];
  const replacement =
    `;if(codexLinuxTeachingSidebarFilterActive()){${pendingVar}=codexLinuxTeachingSidebarFilterGroups(${pendingVar}),` +
    `${propsVar}=${propsVar}.organizeMode===\`connection\`?{...${propsVar},connectionGroups:codexLinuxTeachingSidebarFilterGroups(${propsVar}.connectionGroups)}:{...${propsVar},groups:codexLinuxTeachingSidebarFilterGroups(${propsVar}.groups)}}` +
    `let ${listVar}=${propsVar}.organizeMode===\`connection\`?`;
  return (
    functionText.slice(0, listMatches[0].index) +
    replacement +
    functionText.slice(listMatches[0].index + listMatches[0][0].length)
  );
}

function applyProjectsSidebarPatch(source) {
  if (typeof source !== "string") {
    warn("Asset source is not a string", "projects renderer patch");
    return source;
  }
  const alreadyRuntime = source.includes(RUNTIME_MARKER);
  const alreadyPatch = source.includes(PROJECTS_PATCH_MARKER);
  if (alreadyRuntime && alreadyPatch) {
    return source;
  }
  if (alreadyRuntime || alreadyPatch) {
    warn("Found a partial existing projects renderer patch", "projects renderer patch");
    return source;
  }

  const target = findUniqueFunction(source, [
    "pendingStableWorktrees",
    "showProjectHoverCard",
    "showProjectPinAction",
    ".groups.filter(",
    "organizeMode===`connection`",
  ]);
  if (target == null) {
    warn("Could not find exactly one current project-group renderer", "projects renderer patch");
    return source;
  }
  const patchedFunction = patchProjectGroupRenderer(target.text);
  if (patchedFunction == null || patchedFunction === target.text) {
    warn("Could not find the current project-group data insertion point", "projects renderer patch");
    return source;
  }

  const patched = replaceFunction(source, target, patchedFunction);
  return `${runtimeSource()}var ${PROJECTS_PATCH_MARKER}=!0;${patched}`;
}

function patchPinnedSection(functionText, source) {
  const selectorMatch = source.match(
    /\{allProjectGroups:[A-Za-z_$][\w$]*,allSidebarItems:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{canStartProjectlessChat:/,
  );
  if (selectorMatch == null) {
    return null;
  }
  const [, selectorHook, allProjectsSelector] = selectorMatch;
  const statePattern = new RegExp(
    `let\\{isWorkspaceRootOptionsLoading:([A-Za-z_$][\\w$]*),pinnedProjectGroups:([A-Za-z_$][\\w$]*),pinnedThreadKeys:([A-Za-z_$][\\w$]*)\\}=${escapeRegExp(selectorHook)}\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\),([A-Za-z_$][\\w$]*)=`,
  );
  const matches = [...functionText.matchAll(new RegExp(statePattern.source, "g"))];
  if (matches.length !== 1) {
    return null;
  }
  const [match, loadingVar, groupsVar, keysVar, pinnedSelector, configVar, nextVar] = matches[0];
  const replacement =
    `let{isWorkspaceRootOptionsLoading:${loadingVar},pinnedProjectGroups:${groupsVar},pinnedThreadKeys:${keysVar}}=${selectorHook}(${pinnedSelector},${configVar}),` +
    `{allProjectGroups:codexLinuxTeachingSidebarFilterAllProjectGroups}=${selectorHook}(${allProjectsSelector},${configVar});` +
    `if(codexLinuxTeachingSidebarFilterActive()){${groupsVar}=codexLinuxTeachingSidebarFilterGroups(${groupsVar}),${keysVar}=codexLinuxTeachingSidebarFilterPinnedThreadKeys(${keysVar},codexLinuxTeachingSidebarFilterAllProjectGroups)}` +
    `let ${nextVar}=`;
  return functionText.slice(0, matches[0].index) + replacement + functionText.slice(matches[0].index + match.length);
}

function patchUnifiedSidebar(functionText, source) {
  const selectorMatch = source.match(
    /\{allProjectGroups:[A-Za-z_$][\w$]*,allSidebarItems:[A-Za-z_$][\w$]*\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{canStartProjectlessChat:/,
  );
  if (selectorMatch == null) {
    return null;
  }
  const [, selectorHook, allProjectsSelector] = selectorMatch;

  const projectSourcePattern =
    /,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),`chatgpt`\),\{chatSortMode:/g;
  const projectSourceMatches = [...functionText.matchAll(projectSourcePattern)];
  if (projectSourceMatches.length !== 1) {
    return null;
  }
  const [
    projectSourceMatch,
    projectSourceVar,
    projectSourceHook,
    projectSourceSelector,
  ] = projectSourceMatches[0];
  if (projectSourceHook !== selectorHook) {
    return null;
  }

  let patched =
    functionText.slice(0, projectSourceMatches[0].index) +
    `,${projectSourceVar}=${projectSourceHook}(${projectSourceSelector},\`chatgpt\`);` +
    `if(codexLinuxTeachingSidebarFilterActive())${projectSourceVar}={...${projectSourceVar},projectGroups:codexLinuxTeachingSidebarFilterGroups(${projectSourceVar}.projectGroups),connectionGroups:codexLinuxTeachingSidebarFilterGroups(${projectSourceVar}.connectionGroups)};` +
    `let{chatSortMode:` +
    functionText.slice(
      projectSourceMatches[0].index + projectSourceMatch.length,
    );

  const pinnedPattern =
    /\{pinnedProjectGroups:([A-Za-z_$][\w$]*),pinnedThreadKeys:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),(\{canStartProjectlessChat:[A-Za-z_$][\w$]*,localProjectActionsEnabled:[A-Za-z_$][\w$]*,sidebarMode:`chatgpt`\})\),([A-Za-z_$][\w$]*)=\3\(([A-Za-z_$][\w$]*),\2\),/g;
  const pinnedMatches = [...patched.matchAll(pinnedPattern)];
  if (pinnedMatches.length !== 1) {
    return null;
  }
  const [
    pinnedMatch,
    groupsVar,
    keysVar,
    hookVar,
    selectorVar,
    configExpression,
    nextVar,
    nextSelector,
  ] = pinnedMatches[0];
  if (hookVar !== selectorHook) {
    return null;
  }
  patched =
    patched.slice(0, pinnedMatches[0].index) +
    `{pinnedProjectGroups:${groupsVar},pinnedThreadKeys:${keysVar}}=${hookVar}(${selectorVar},${configExpression}),` +
    `{allProjectGroups:codexLinuxTeachingSidebarFilterUnifiedAllProjectGroups}=${hookVar}(${allProjectsSelector},${configExpression});` +
    `if(codexLinuxTeachingSidebarFilterActive()){${groupsVar}=codexLinuxTeachingSidebarFilterGroups(${groupsVar}),${keysVar}=codexLinuxTeachingSidebarFilterPinnedThreadKeys(${keysVar},codexLinuxTeachingSidebarFilterUnifiedAllProjectGroups)}` +
    `let ${nextVar}=${hookVar}(${nextSelector},${keysVar}),` +
    patched.slice(pinnedMatches[0].index + pinnedMatch.length);

  const chatGptPattern =
    /,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\((\{conversationFilter:[^{};]+?\})\),\{data:/g;
  const chatGptMatches = [...patched.matchAll(chatGptPattern)];
  if (chatGptMatches.length !== 1) {
    return null;
  }
  const [chatGptMatch, sourceVar, sourceHook, sourceConfig] = chatGptMatches[0];
  const chatReplacement =
    `,${sourceVar}=${sourceHook}(${sourceConfig});` +
    `if(codexLinuxTeachingSidebarFilterActive())${sourceVar}=codexLinuxTeachingSidebarFilterChatGptSource(${sourceVar});` +
    `let{data:`;
  patched =
    patched.slice(0, chatGptMatches[0].index) +
    chatReplacement +
    patched.slice(chatGptMatches[0].index + chatGptMatch.length);
  return patched;
}

function inferTeachingControlsUi(source) {
  const helpMenu = findUniqueFunction(source, [
    "sidebarHelp.openAriaLabel",
    "sidebarHelp.keyboardShortcuts",
    "contentWidth:`menu`",
  ]);
  const desktopHelp = findUniqueFunction(source, [
    "CODEX_MOBILE_SETUP_COMPLETED",
    "showChromeExtensionSetup",
    "showMobileSetup",
    "showRemoteSetup",
  ]);
  const sidebarFooter = findUniqueFunction(source, [
    "flex h-toolbar items-center gap-2 px-row-x",
    "variant:`sidebarFooter`",
    "browser:!0",
  ]);
  if (helpMenu == null || desktopHelp == null || sidebarFooter == null) {
    return null;
  }

  const buttonMatch = helpMenu.text.match(
    /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*),\{"aria-label":[A-Za-z_$][\w$]*,className:`size-8 shrink-0`,color:`ghost`,size:`icon`,uniform:!0,children:/,
  );
  if (buttonMatch == null) {
    return null;
  }
  const [, jsxAlias, buttonAlias] = buttonMatch;
  const helpIconMatches = [
    ...helpMenu.text.matchAll(
      new RegExp(
        `\\(0,${escapeRegExp(jsxAlias)}\\.jsx\\)\\(([A-Za-z_$][\\w$]*),\\{className:\`icon-sm\`\\}\\)`,
        "g",
      ),
    ),
  ];
  const menuMatches = [
    ...helpMenu.text.matchAll(
      new RegExp(`\\(0,${escapeRegExp(jsxAlias)}\\.jsx\\)\\(([A-Za-z_$][\\w$]*)\\.Item,\\{`, "g"),
    ),
  ];
  const popoverMatches = [
    ...helpMenu.text.matchAll(
      new RegExp(
        `\\(0,${escapeRegExp(jsxAlias)}\\.jsxs\\)\\(([A-Za-z_$][\\w$]*),\\{align:\`start\`,contentWidth:\`menu\``,
        "g",
      ),
    ),
  ];
  const helpCallPattern = new RegExp(
    `\\(0,([A-Za-z_$][\\w$]*)\\.jsx\\)\\(${escapeRegExp(desktopHelp.name)},\\{\\}\\)`,
    "g",
  );
  const helpCallMatches = [...sidebarFooter.text.matchAll(helpCallPattern)];
  const externalStoreMatch = source.match(
    /\(0,([A-Za-z_$][\w$]*)\.useSyncExternalStore\)\(/,
  );
  if (
    helpIconMatches.length !== 1 ||
    menuMatches.length === 0 ||
    popoverMatches.length !== 1 ||
    helpCallMatches.length !== 1 ||
    externalStoreMatch == null
  ) {
    return null;
  }
  const menuAliases = new Set(menuMatches.map((match) => match[1]));
  if (menuAliases.size !== 1) {
    return null;
  }

  return {
    buttonAlias,
    desktopHelp,
    footerJsxAlias: helpCallMatches[0][1],
    helpIconAlias: helpIconMatches[0][1],
    helpCall: helpCallMatches[0],
    jsxAlias,
    menuAlias: [...menuAliases][0],
    popoverAlias: popoverMatches[0][1],
    sidebarFooter,
    useSyncExternalStoreAlias: externalStoreMatch[1],
  };
}

function teachingControlsSource({
  buttonAlias,
  helpIconAlias,
  jsxAlias,
  menuAlias,
  popoverAlias,
  useSyncExternalStoreAlias,
}) {
  return [
    `function codexLinuxTeachingControlsMenu(){let e=codexLinuxTeachingSidebarFilterActive(),t=(0,${jsxAlias}.jsx)(${buttonAlias},{"aria-label":"Open developer controls",title:"Open developer controls",className:"size-8 shrink-0",color:"ghost",size:"icon",uniform:!0,children:(0,${jsxAlias}.jsx)(${helpIconAlias},{className:"icon-sm",style:{transform:"rotate(180deg)"}})}),n=(0,${jsxAlias}.jsx)(${menuAlias}.Item,{key:"teaching-view",role:"menuitemcheckbox","aria-checked":e,onSelect:()=>{let t=globalThis.electronBridge?.teachingView;t?.setActive?.(!e)?.catch?.(e=>console.error("Could not update Teaching view",e))},children:(0,${jsxAlias}.jsxs)("div",{className:"flex w-full items-center justify-between gap-3",children:[(0,${jsxAlias}.jsx)("span",{children:"Teaching view"}),(0,${jsxAlias}.jsx)("span",{className:"text-token-description-foreground",children:e?"On":"Off"})]})}),r=(Array.isArray(globalThis.codexLinuxDeveloperControls)?globalThis.codexLinuxDeveloperControls:[]).flatMap(e=>{try{let t=e({jsx:${jsxAlias},menu:${menuAlias},useSyncExternalStore:${useSyncExternalStoreAlias}.useSyncExternalStore});return Array.isArray(t)?t:t==null?[]:[t]}catch(e){return console.error("Could not render developer control",e),[]}});return(0,${jsxAlias}.jsx)(${popoverAlias},{align:"start",contentWidth:"menu",side:"top",sideOffset:6,triggerButton:t,children:[n,...r]})}`,
  ].join("");
}

function applyMainPagePatch(source) {
  if (typeof source !== "string") {
    warn("Asset source is not a string", "main-page pinned patch");
    return source;
  }
  const alreadyRuntime = source.includes(RUNTIME_MARKER);
  const alreadyPatch = source.includes(MAIN_PAGE_PATCH_MARKER);
  const alreadyControls = source.includes(CONTROLS_PATCH_MARKER);
  if (alreadyRuntime && alreadyPatch && alreadyControls) {
    return source;
  }
  if (alreadyRuntime || alreadyPatch || alreadyControls) {
    warn("Found a partial existing main-page patch", "main-page pinned patch");
    return source;
  }

  const pinnedTarget = findUniqueFunction(source, [
    "isWorkspaceRootOptionsLoading",
    "pinnedProjectGroups",
    "pinnedThreadKeys",
    "locationIdPrefix:`pinned-project`",
  ]);
  const unifiedTarget = findUniqueFunction(source, [
    "pinnedProjectGroups",
    "pinnedThreadKeys",
    "conversationByKey",
    "projectByKey",
    "threadContainerId:`pinned`",
  ]);
  const controlsUi = inferTeachingControlsUi(source);
  if (
    pinnedTarget == null ||
    unifiedTarget == null ||
    pinnedTarget.start === unifiedTarget.start ||
    controlsUi == null
  ) {
    warn(
      "Could not find the current pinned, unified sidebar, and Help control functions",
      "main-page pinned patch",
    );
    return source;
  }

  const patchedPinned = patchPinnedSection(pinnedTarget.text, source);
  const patchedUnified = patchUnifiedSidebar(unifiedTarget.text, source);
  if (patchedPinned == null || patchedUnified == null) {
    warn("Could not find all current pinned sidebar data insertion points", "main-page pinned patch");
    return source;
  }

  const replacements = [
    { ...pinnedTarget, text: patchedPinned },
    { ...unifiedTarget, text: patchedUnified },
    {
      ...controlsUi.sidebarFooter,
      text:
        controlsUi.sidebarFooter.text.slice(0, controlsUi.helpCall.index) +
        `(0,${controlsUi.footerJsxAlias}.jsxs)(${controlsUi.footerJsxAlias}.Fragment,{children:[(0,${controlsUi.footerJsxAlias}.jsx)(codexLinuxTeachingControlsMenu,{}),${controlsUi.helpCall[0]}]})` +
        controlsUi.sidebarFooter.text.slice(
          controlsUi.helpCall.index + controlsUi.helpCall[0].length,
        ),
    },
  ].sort((left, right) => right.start - left.start);
  let patched = source;
  for (const replacement of replacements) {
    patched = replaceFunction(patched, replacement, replacement.text);
  }
  return (
    `${runtimeSource()}${teachingControlsSource(controlsUi)}` +
    `var ${MAIN_PAGE_PATCH_MARKER}=!0,${CONTROLS_PATCH_MARKER}=!0;${patched}`
  );
}

const descriptors = [
  {
    id: "startup-mode",
    phase: "main-bundle",
    order: 20_900,
    ciPolicy: "optional",
    apply: applyMainProcessPatch,
  },
  {
    id: "preload-bridge",
    phase: "extracted-app:pre-webview",
    order: 20_905,
    ciPolicy: "optional",
    apply: applyPreloadBridgePatch,
  },
  {
    id: "project-groups",
    phase: "webview-asset",
    order: 20_910,
    ciPolicy: "optional",
    pattern: PROJECTS_SIDEBAR_ASSET_PATTERN,
    missingDescription: "current projects sidebar bundle",
    skipDescription: "teaching sidebar project-group patch",
    apply: applyProjectsSidebarPatch,
  },
  {
    id: "pinned-items",
    phase: "webview-asset",
    order: 20_920,
    ciPolicy: "optional",
    pattern: MAIN_PAGE_ASSET_PATTERN,
    missingDescription: "current main page sidebar bundle",
    skipDescription: "teaching sidebar pinned-item patch",
    apply: applyMainPagePatch,
  },
];

module.exports = {
  DEFAULT_FLAGS,
  DEFAULT_PROJECT_PATTERN,
  CONTROLS_PATCH_MARKER,
  IPC_CHANNEL,
  MAIN_PAGE_ASSET_PATTERN,
  MAIN_PAGE_PATCH_MARKER,
  MAIN_PROCESS_MARKER,
  PRELOAD_MARKER,
  PROJECTS_PATCH_MARKER,
  PROJECTS_SIDEBAR_ASSET_PATTERN,
  RUNTIME_MARKER,
  SHARED_OBJECT_KEY,
  STATE_FILE_NAME,
  WINDOW_PATCH_MARKER,
  applyMainPagePatch,
  applyMainProcessPatch,
  applyPreloadBridgePatch,
  applyProjectsSidebarPatch,
  descriptors,
  normalizedFilterSettings,
  mainRuntimeSource,
  runtimeSource,
};
