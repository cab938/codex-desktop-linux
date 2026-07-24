"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  extractedAppPatch,
  mainBundlePatch,
  webviewAssetPatch,
} = require("../../scripts/patches/descriptor.js");
const {
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");
const {
  contextRuntimeSource,
  mainProcessRuntimeSource,
} = require("./runtime.js");

const MAIN_MARKER = "codexLinuxQuickLauncherMainBridgeV1";
const PRELOAD_MARKER = "codexLinuxQuickLauncherPreloadV1";
const CONTEXT_MARKER = "codexLinuxQuickLauncherContextV1";
const REQUEST_PATCH_MARKER = "codexLinuxQuickLauncherPrepared";
const SIDEBAR_MARKER = "codexLinuxQuickLauncherSidebarV1";

const CONTEXT_ASSET_PATTERN = /^app-initial-[A-Za-z0-9_-]+\.js$/;
const SIDEBAR_ASSET_PATTERN = /^local-conversation-thread-[A-Za-z0-9_-]+\.js$/;

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping Quick launcher ${patchName}`);
}

function applyMainProcessBridgePatch(source) {
  if (typeof source !== "string") {
    warn("Main bundle source is not a string", "main-process bridge patch");
    return source;
  }
  if (source.includes(MAIN_MARKER)) {
    return source;
  }
  if (
    !source.includes("getSharedObjectSnapshot()") ||
    !source.includes("ipcMain.handle") ||
    !source.includes("BrowserWindow")
  ) {
    warn("Could not verify the current Electron IPC host bundle", "main-process bridge patch");
    return source;
  }
  return `${mainProcessRuntimeSource()}${source}`;
}

function preloadBridgeSource(electronAlias) {
  return [
    `var codexLinuxQuickLauncherPreloadMarker=${JSON.stringify(PRELOAD_MARKER)},codexLinuxQuickLauncherRequestChannel="codex_desktop:quick-launcher",codexLinuxQuickLauncherUpdateChannel="codex_desktop:quick-launcher-updated";`,
    `var codexLinuxQuickLauncherPreloadBridge={request:t=>${electronAlias}.ipcRenderer.invoke(codexLinuxQuickLauncherRequestChannel,t),subscribe:(t,n)=>{if(typeof t!=="string"||typeof n!=="function")return()=>{};let r=t,i=(e,t)=>{t?.workspaceRoot===r&&n(t)};${electronAlias}.ipcRenderer.on(codexLinuxQuickLauncherUpdateChannel,i),${electronAlias}.ipcRenderer.invoke(codexLinuxQuickLauncherRequestChannel,{action:"watch",workspaceRoot:t}).then(e=>{e?.state?.workspaceRoot&&(r=e.state.workspaceRoot),n({kind:"initial",result:e,workspaceRoot:r})}).catch(e=>n({error:e instanceof Error?e.message:String(e),kind:"watch-error",workspaceRoot:r}));return()=>{${electronAlias}.ipcRenderer.removeListener(codexLinuxQuickLauncherUpdateChannel,i),${electronAlias}.ipcRenderer.invoke(codexLinuxQuickLauncherRequestChannel,{action:"unwatch",workspaceRoot:r}).catch(()=>{})}}};`,
  ].join("");
}

function applyPreloadBridgePatch(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const candidates = fs.existsSync(buildDir)
    ? fs.readdirSync(buildDir).filter((name) => /^preload(?:-[^.]+)?\.js$/.test(name))
    : [];
  if (candidates.length !== 1) {
    warn(`Expected one current preload bundle in ${buildDir}, found ${candidates.length}`, "preload bridge patch");
    return { changed: false, matched: false, reason: "current preload bundle was not unique" };
  }

  const preloadPath = path.join(buildDir, candidates[0]);
  const source = fs.readFileSync(preloadPath, "utf8");
  if (source.includes(PRELOAD_MARKER)) {
    return { changed: false, matched: true };
  }
  const electronMatch = source.match(/^let ([A-Za-z_$][\w$]*)=require\(["'`]electron["'`]\);/);
  const bridgeAnchor = /var ([A-Za-z_$][\w$]*)=new Map,([A-Za-z_$][\w$]*)=new Map,([A-Za-z_$][\w$]*)=\{/;
  const bridgeMatch = source.match(bridgeAnchor);
  if (
    electronMatch == null ||
    bridgeMatch == null ||
    !source.includes("getSharedObjectSnapshotValue") ||
    !source.includes("exposeInMainWorld(`electronBridge`")
  ) {
    warn("Could not find the current preload electronBridge construction", "preload bridge patch");
    return { changed: false, matched: false, reason: "preload electronBridge anchor drifted" };
  }

  const patched = source.replace(
    bridgeAnchor,
    `${preloadBridgeSource(electronMatch[1])}var ${bridgeMatch[1]}=new Map,${bridgeMatch[2]}=new Map,${bridgeMatch[3]}={quickLauncher:codexLinuxQuickLauncherPreloadBridge,`,
  );
  fs.writeFileSync(preloadPath, patched, "utf8");
  return { changed: true, matched: true };
}

function applyContextDeliveryPatch(source) {
  if (typeof source !== "string") {
    warn("Webview source is not a string", "turn context patch");
    return source;
  }
  if (source.includes(CONTEXT_MARKER)) {
    return source;
  }
  if (source.includes("codexLinuxProjectWorkContextV1")) {
    return `${contextRuntimeSource()}${source}`;
  }
  if (source.includes(REQUEST_PATCH_MARKER)) {
    warn("Found a partial existing turn context patch", "turn context patch");
    return source;
  }

  const requestPattern =
    /async sendRequest\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(this\.dispatchMessage==null\)throw Error\(`AppServerRequestClient is missing a message dispatcher`\);return \1===`config\/read`\?this\.sendConfigReadRequest\(\2,\3\):this\.enqueueRequest\(\1,\2,\3\)\}/g;
  const matches = [...source.matchAll(requestPattern)];
  if (matches.length !== 1) {
    warn(`Expected one current AppServerRequestClient sendRequest method, found ${matches.length}`, "turn context patch");
    return source;
  }
  const [methodName, paramsName, optionsName] = matches[0].slice(1);
  const replacement =
    `async sendRequest(${methodName},${paramsName},${optionsName}){` +
    `if(this.dispatchMessage==null)throw Error(\`AppServerRequestClient is missing a message dispatcher\`);` +
    `let ${REQUEST_PATCH_MARKER}=await globalThis.codexLinuxQuickLauncherContext?.prepare?.(${methodName},${paramsName},this.hostId)??null;` +
    `${REQUEST_PATCH_MARKER}?.params!=null&&(${paramsName}=${REQUEST_PATCH_MARKER}.params);` +
    `try{let __codexQuickLauncherResult=await(${methodName}===\`config/read\`?this.sendConfigReadRequest(${paramsName},${optionsName}):this.enqueueRequest(${methodName},${paramsName},${optionsName}));return ${REQUEST_PATCH_MARKER}?.acknowledge?.(),__codexQuickLauncherResult}catch(__codexQuickLauncherError){throw __codexQuickLauncherError}}`;
  return `${contextRuntimeSource()}${source.replace(requestPattern, replacement)}`;
}

function codexLinuxQuickLauncherStateFromPayloadRuntime(payload) {
  const result = payload?.result ?? payload;
  if (result?.ok === false) {
    return { error: result.message ?? "Quick launcher request failed", state: result.state ?? null };
  }
  return { error: payload?.error ?? null, state: payload?.state ?? result?.state ?? null };
}

function codexLinuxQuickLauncherCardRuntime() {
  const environment = codexLinuxQuickLauncherEnvironmentHook(codexLinuxQuickLauncherEnvironmentAtom);
  const workspaceRoot = environment.cwd == null
    ? null
    : codexLinuxQuickLauncherNormalizePath(environment.cwd);
  const [state, setState] = codexLinuxQuickLauncherReact.useState(null);
  const [error, setError] = codexLinuxQuickLauncherReact.useState(null);
  const [pendingId, setPendingId] = codexLinuxQuickLauncherReact.useState(null);
  const [lastStarted, setLastStarted] = codexLinuxQuickLauncherReact.useState(null);

  codexLinuxQuickLauncherReact.useEffect(() => {
    let disposed = false;
    setState(null);
    setError(null);
    setPendingId(null);
    setLastStarted(null);
    if (workspaceRoot == null) {
      return;
    }
    const bridge = globalThis.electronBridge?.quickLauncher;
    if (bridge?.request == null) {
      setError("Quick launcher bridge is unavailable");
      return;
    }
    const applyPayload = (payload) => {
      if (disposed) {
        return;
      }
      const parsed = codexLinuxQuickLauncherStateFromPayload(payload);
      if (parsed.state != null) {
        setState(parsed.state);
      }
      if (parsed.error != null) {
        setError(parsed.error);
      } else if (payload?.kind === "changed") {
        setError(null);
        setPendingId(null);
        setLastStarted(null);
      }
    };
    const unsubscribe = bridge.subscribe?.(workspaceRoot, applyPayload);
    bridge.request({ action: "read", workspaceRoot })
      .then((result) => {
        if (!disposed) {
          applyPayload(result);
        }
      })
      .catch((readError) => {
        if (!disposed) {
          setError(readError instanceof Error ? readError.message : String(readError));
        }
      });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [workspaceRoot]);

  if (workspaceRoot == null) {
    return null;
  }
  const bridge = globalThis.electronBridge?.quickLauncher;
  const applyActionResult = (result) => {
    const parsed = codexLinuxQuickLauncherStateFromPayload(result);
    if (parsed.state != null) {
      setState(parsed.state);
    }
    if (parsed.error != null) {
      setError(parsed.error);
      return false;
    }
    setError(null);
    return true;
  };
  const openEditor = async () => {
    setError(null);
    try {
      applyActionResult(await bridge?.request({ action: "open", workspaceRoot }));
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  };
  const launch = async (button) => {
    if (bridge?.request == null || pendingId != null) {
      return;
    }
    setError(null);
    setLastStarted(null);
    setPendingId(button.id);
    try {
      const result = await bridge.request({
        action: "launch",
        id: button.id,
        label: button.label,
        revision: state?.revision,
        workspaceRoot,
      });
      if (applyActionResult(result)) {
        setLastStarted(result.label ?? button.label);
      }
    } catch (launchError) {
      setError(launchError instanceof Error ? launchError.message : String(launchError));
    } finally {
      setPendingId(null);
    }
  };

  const buttons = Array.isArray(state?.buttons) ? state.buttons : [];
  const visibleError = error ?? state?.error?.message ?? state?.watchError ?? null;
  const title = (0, codexLinuxQuickLauncherJsx.jsxs)("span", {
    className: "flex min-w-0 items-center gap-2",
    children: [
      (0, codexLinuxQuickLauncherJsx.jsx)("span", { children: "Quick launcher" }),
      (0, codexLinuxQuickLauncherJsx.jsx)("span", {
        className: "text-xs font-normal text-token-description-foreground",
        children: state == null || buttons.length === 0 ? "" : String(buttons.length),
      }),
    ],
  });
  const editAction = (0, codexLinuxQuickLauncherJsx.jsx)(
    codexLinuxQuickLauncherSummary.SectionActions,
    {
      children: (0, codexLinuxQuickLauncherJsx.jsx)(
        codexLinuxQuickLauncherSummary.IconButton,
        {
          label: state?.status === "missing"
            ? "Create and open .codex/quicklaunch.yaml"
            : "Open .codex/quicklaunch.yaml",
          "data-quick-launcher-edit": "true",
          onClick: openEditor,
          children: (0, codexLinuxQuickLauncherJsx.jsx)(
            codexLinuxQuickLauncherPlusIcon,
            {},
          ),
        },
      ),
    },
  );
  const body = (0, codexLinuxQuickLauncherJsx.jsxs)("div", {
    className: "flex flex-col gap-2 px-3 pb-3",
    "data-quick-launcher-root": workspaceRoot,
    "data-quick-launcher-revision": state?.revision ?? "loading",
    "data-quick-launcher-status": state?.status ?? "loading",
    children: [
      visibleError == null
        ? null
        : (0, codexLinuxQuickLauncherJsx.jsx)("div", {
            role: "alert",
            className: "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300",
            children: visibleError,
          }),
      state == null
        ? (0, codexLinuxQuickLauncherJsx.jsx)("div", {
            className: "text-xs text-token-description-foreground",
            children: "Loading quick launches…",
          })
        : state.status === "missing"
          ? (0, codexLinuxQuickLauncherJsx.jsx)("div", {
              className: "text-xs text-token-description-foreground",
              children: "No .codex/quicklaunch.yaml file exists for this project. Use + to create it.",
            })
          : state.status === "empty"
            ? (0, codexLinuxQuickLauncherJsx.jsx)("div", {
                className: "text-xs text-token-description-foreground",
                children: "No quick launches configured. Use + to edit quicklaunch.yaml.",
              })
            : buttons.length === 0
              ? null
              : (0, codexLinuxQuickLauncherJsx.jsx)("div", {
                  className: "flex flex-wrap gap-2",
                  children: buttons.map((button) => (0, codexLinuxQuickLauncherJsx.jsx)("button", {
                    type: "button",
                    "aria-label": "Run " + button.label,
                    title: "Run " + button.label,
                    "data-quick-launch-id": button.id,
                    disabled: pendingId != null,
                    className: "rounded-md border border-token-border bg-token-bg-primary px-3 py-1.5 text-sm text-token-foreground hover:bg-token-bg-secondary disabled:cursor-wait disabled:opacity-60",
                    onClick: () => launch(button),
                    children: pendingId === button.id ? "Starting…" : button.label,
                  }, button.id)),
                }),
      lastStarted == null
        ? null
        : (0, codexLinuxQuickLauncherJsx.jsx)("div", {
            "aria-live": "polite",
            className: "text-xs text-token-description-foreground",
            children: "Started " + lastStarted,
          }),
    ],
  });
  const section = (0, codexLinuxQuickLauncherJsx.jsx)(codexLinuxQuickLauncherSummary.Section, {
    sectionKey: "quick-launcher",
    after: editAction,
    title,
    children: body,
  });
  return section;
}

function sidebarRuntimeSource(aliases) {
  let cardSource = codexLinuxQuickLauncherCardRuntime.toString().replace(
    "codexLinuxQuickLauncherCardRuntime",
    "codexLinuxQuickLauncherCard",
  );
  const replacements = {
    codexLinuxQuickLauncherEnvironmentAtom: aliases.environmentAtom,
    codexLinuxQuickLauncherEnvironmentHook: aliases.environmentHook,
    codexLinuxQuickLauncherJsx: aliases.jsx,
    codexLinuxQuickLauncherNormalizePath: aliases.normalizePath,
    codexLinuxQuickLauncherPlusIcon: aliases.plusIcon,
    codexLinuxQuickLauncherReact: aliases.react,
    codexLinuxQuickLauncherSummary: aliases.summary,
  };
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    cardSource = cardSource.replaceAll(placeholder, replacement);
  }
  return [
    `var codexLinuxQuickLauncherSidebarMarker=${JSON.stringify(SIDEBAR_MARKER)};`,
    codexLinuxQuickLauncherStateFromPayloadRuntime.toString().replace(
      "codexLinuxQuickLauncherStateFromPayloadRuntime",
      "codexLinuxQuickLauncherStateFromPayload",
    ),
    cardSource,
  ].join("");
}

function findFunctions(source) {
  const functions = [];
  const pattern = /function ([A-Za-z_$][\w$]*)\([^)]*\)\{/g;
  let match;
  while ((match = pattern.exec(source)) != null) {
    const openBrace = match.index + match[0].length - 1;
    const closeBrace = findMatchingBrace(source, openBrace);
    if (closeBrace !== -1) {
      functions.push({
        end: closeBrace + 1,
        name: match[1],
        start: match.index,
        text: source.slice(match.index, closeBrace + 1),
      });
    }
  }
  return functions;
}

function inferSidebarAliases(source, target, jsx, summary) {
  const planFunctions = findFunctions(source).filter(({ text }) =>
    text.includes("codex.localConversation.plan.title"),
  );
  if (planFunctions.length !== 1) {
    warn(`Expected one current plan summary function, found ${planFunctions.length}`, "sidebar patch");
    return null;
  }
  const plan = planFunctions[0].text;
  const workspace = plan.match(
    /\b([A-Za-z_$][\w$]*)\.cwd==null\?null:([A-Za-z_$][\w$]*)\(\1\.cwd\)/,
  );
  if (workspace == null) {
    warn("Could not infer the current workspace alias from the plan summary", "sidebar patch");
    return null;
  }
  const environmentPattern = new RegExp(
    `\\b${workspace[1]}=([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*)\\)`,
  );
  const environment = plan.match(environmentPattern);
  if (environment == null) {
    warn("Could not infer the current environment selector aliases", "sidebar patch");
    return null;
  }
  const modulePrefix = source.slice(Math.max(0, target.start - 4000), target.start);
  const reactImports = [
    ...modulePrefix.matchAll(
      /\b([A-Za-z_$][\w$]*)=t\([A-Za-z_$][\w$]*\(\),1\)/g,
    ),
  ];
  if (reactImports.length === 0) {
    warn("Could not infer the current React namespace alias", "sidebar patch");
    return null;
  }
  const createEnvironmentFunctions = findFunctions(source).filter(({ text }) =>
    text.includes("threadPage.runAction.environment.createMenuTitle") &&
    text.includes("defaultMessage:`Create environment`") &&
    text.includes(`${summary}.IconButton`),
  );
  const nativePlusMatch = createEnvironmentFunctions.length === 1
    ? createEnvironmentFunctions[0].text.match(
      new RegExp(
        `\\b([A-Za-z_$][\\w$]*)=\\(0,([A-Za-z_$][\\w$]*)\\.jsx\\)\\(([A-Za-z_$][\\w$]*),\\{\\}\\)` +
        `[\\s\\S]{0,800}?\\(0,\\2\\.jsx\\)\\(${summary}\\.IconButton,\\{[^{}]{0,300}?children:\\1\\}\\)`,
      ),
    )
    : null;
  if (nativePlusMatch == null) {
    warn(
      `Expected one current native summary plus icon, found ${createEnvironmentFunctions.length}`,
      "sidebar patch",
    );
    return null;
  }
  return {
    environmentAtom: environment[2],
    environmentHook: environment[1],
    jsx,
    normalizePath: workspace[2],
    plusIcon: nativePlusMatch[3],
    react: reactImports.at(-1)[1],
    summary,
  };
}

function inferInlineSummary(targetText) {
  const rootPattern =
    /\(0,([A-Za-z_$][\w$]*)\.(?:jsx|jsxs)\)\(([A-Za-z_$][\w$]*)\.Root,\{shouldHideInlineImmediately:[A-Za-z_$][\w$]*,shouldShow:[A-Za-z_$][\w$]*,children:/g;
  const roots = [...targetText.matchAll(rootPattern)];
  if (roots.length !== 1) {
    return {
      reason: `Expected one current inline task summary root, found ${roots.length}`,
    };
  }
  return {
    jsx: roots[0][1],
    summary: roots[0][2],
  };
}

function applySidebarPatch(source) {
  if (typeof source !== "string") {
    warn("Webview source is not a string", "sidebar patch");
    return source;
  }
  if (source.includes(SIDEBAR_MARKER)) {
    return source;
  }
  if (
    !source.includes("codex.localConversation.environmentSummary.title") ||
    !source.includes("codex.localConversation.plan.title")
  ) {
    warn("Current local conversation summary semantic anchors were not present", "sidebar patch");
    return source;
  }
  const targets = findFunctions(source).filter(({ text }) =>
    text.includes("shouldHideInlineImmediately") &&
    text.includes("registerEnvironmentActionCommands") &&
    text.includes(".Content") &&
    text.includes(".Root"),
  );
  if (targets.length !== 1) {
    warn(`Expected one inline task summary card, found ${targets.length}`, "sidebar patch");
    return source;
  }
  const target = targets[0];
  const inline = inferInlineSummary(target.text);
  if (inline.jsx == null || inline.summary == null) {
    warn(inline.reason ?? "Could not infer the inline task summary", "sidebar patch");
    return source;
  }
  const aliases = inferSidebarAliases(source, target, inline.jsx, inline.summary);
  if (aliases == null) {
    return source;
  }

  const popoverTargets = findFunctions(source).filter(({ text }) =>
    text.includes("registerEnvironmentActionCommands:!1") &&
    text.includes(".PopoverContent") &&
    text.includes(".Content"),
  );
  if (popoverTargets.length !== 1) {
    warn(`Expected one compact task summary popover, found ${popoverTargets.length}`, "sidebar patch");
    return source;
  }
  const popoverTarget = popoverTargets[0];
  const contentAnchor = `(0,${inline.jsx}.jsx)(${inline.summary}.Content,{`;
  const contentStart = popoverTarget.text.indexOf(contentAnchor);
  if (
    contentStart === -1 ||
    popoverTarget.text.indexOf(contentAnchor, contentStart + contentAnchor.length) !== -1
  ) {
    warn("Could not find one current compact summary content wrapper", "sidebar patch");
    return source;
  }
  const contentPropsOpen = contentStart + contentAnchor.length - 1;
  const contentPropsClose = findMatchingBrace(popoverTarget.text, contentPropsOpen);
  const contentProps = contentPropsClose === -1
    ? null
    : popoverTarget.text.slice(contentPropsOpen + 1, contentPropsClose);
  if (contentProps == null || !contentProps.startsWith("children:")) {
    warn("Could not isolate current compact summary content", "sidebar patch");
    return source;
  }
  const contentChild = contentProps.slice("children:".length);
  const popoverReplacement =
    `children:(0,${inline.jsx}.jsxs)(${inline.jsx}.Fragment,{children:[` +
    `(0,${inline.jsx}.jsx)(codexLinuxQuickLauncherCard,{embedded:!0,shouldHideInlineImmediately:!1,shouldShow:!0}),` +
    `${contentChild}]})`;
  const patchedPopoverTarget =
    popoverTarget.text.slice(0, contentPropsOpen + 1) +
    popoverReplacement +
    popoverTarget.text.slice(contentPropsClose);
  const patchedSource = source.replace(popoverTarget.text, patchedPopoverTarget);
  return sidebarRuntimeSource(aliases) + patchedSource;
}

module.exports = {
  CONTEXT_ASSET_PATTERN,
  SIDEBAR_ASSET_PATTERN,
  applyContextDeliveryPatch,
  applyMainProcessBridgePatch,
  applyPreloadBridgePatch,
  applySidebarPatch,
  descriptors: [
    mainBundlePatch({
      id: "main-process-quick-launcher-bridge",
      order: 860,
      ciPolicy: "optional",
      apply: applyMainProcessBridgePatch,
    }),
    extractedAppPatch({
      id: "preload-quick-launcher-bridge",
      phase: "extracted-app:pre-webview",
      order: 860,
      ciPolicy: "optional",
      apply: applyPreloadBridgePatch,
      status: (result, warnings) => ({
        status: result?.changed
          ? "applied"
          : result?.matched
            ? "already-applied"
            : "skipped-optional",
        reason: result?.reason ?? warnings[0] ?? null,
      }),
    }),
    webviewAssetPatch({
      id: "turn-quick-launcher-context",
      order: 1655,
      ciPolicy: "optional",
      pattern: CONTEXT_ASSET_PATTERN,
      missingDescription: "current turn request webview bundle",
      skipDescription: "Quick launcher turn context patch",
      apply: applyContextDeliveryPatch,
    }),
    webviewAssetPatch({
      id: "sidebar-quick-launcher-card",
      order: 1670,
      ciPolicy: "optional",
      pattern: SIDEBAR_ASSET_PATTERN,
      missingDescription: "local conversation summary webview bundle",
      skipDescription: "Quick launcher sidebar patch",
      apply: applySidebarPatch,
    }),
  ],
};
