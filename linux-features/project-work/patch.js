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

const MAIN_MARKER = "codexLinuxProjectWorkMainBridgeV1";
const PRELOAD_MARKER = "codexLinuxProjectWorkPreloadV1";
const CONTEXT_MARKER = "codexLinuxProjectWorkContextV1";
const REQUEST_PATCH_MARKER = "codexLinuxProjectWorkPrepared";
const SIDEBAR_MARKER = "codexLinuxProjectWorkSidebarV1";

const CONTEXT_ASSET_PATTERN = /^app-initial-[A-Za-z0-9_-]+\.js$/;
const SIDEBAR_ASSET_PATTERN = /^local-conversation-thread-[A-Za-z0-9_-]+\.js$/;

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping Project work ${patchName}`);
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
    `var codexLinuxProjectWorkPreloadMarker=${JSON.stringify(PRELOAD_MARKER)},codexLinuxProjectWorkRequestChannel="codex_desktop:project-work",codexLinuxProjectWorkUpdateChannel="codex_desktop:project-work-updated";`,
    `var codexLinuxProjectWorkPreloadBridge={request:t=>${electronAlias}.ipcRenderer.invoke(codexLinuxProjectWorkRequestChannel,t),subscribe:(t,n)=>{if(typeof t!=="string"||typeof n!=="function")return()=>{};let r=t,i=(e,t)=>{t?.workspaceRoot===r&&n(t)};${electronAlias}.ipcRenderer.on(codexLinuxProjectWorkUpdateChannel,i),${electronAlias}.ipcRenderer.invoke(codexLinuxProjectWorkRequestChannel,{action:"watch",workspaceRoot:t}).then(e=>{e?.state?.workspaceRoot&&(r=e.state.workspaceRoot),n({kind:"initial",result:e,workspaceRoot:r})}).catch(e=>n({error:e instanceof Error?e.message:String(e),kind:"watch-error",workspaceRoot:r}));return()=>{${electronAlias}.ipcRenderer.removeListener(codexLinuxProjectWorkUpdateChannel,i),${electronAlias}.ipcRenderer.invoke(codexLinuxProjectWorkRequestChannel,{action:"unwatch",workspaceRoot:r}).catch(()=>{})}}};`,
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
    `${preloadBridgeSource(electronMatch[1])}var ${bridgeMatch[1]}=new Map,${bridgeMatch[2]}=new Map,${bridgeMatch[3]}={projectWork:codexLinuxProjectWorkPreloadBridge,`,
  );
  fs.writeFileSync(preloadPath, patched, "utf8");
  return { changed: true, matched: true };
}

function applyContextDeliveryPatch(source) {
  if (typeof source !== "string") {
    warn("Webview source is not a string", "turn context patch");
    return source;
  }
  const hasRuntime = source.includes(CONTEXT_MARKER);
  const hasRequestPatch = source.includes(REQUEST_PATCH_MARKER);
  if (hasRuntime && hasRequestPatch) {
    return source;
  }
  if (hasRuntime || hasRequestPatch) {
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
    `let ${REQUEST_PATCH_MARKER}=await globalThis.codexLinuxProjectWorkContext?.prepare?.(${methodName},${paramsName},this.hostId)??null;` +
    `${REQUEST_PATCH_MARKER}?.params!=null&&(${paramsName}=${REQUEST_PATCH_MARKER}.params);` +
    `try{let __codexProjectWorkResult=await(${methodName}===\`config/read\`?this.sendConfigReadRequest(${paramsName},${optionsName}):this.enqueueRequest(${methodName},${paramsName},${optionsName}));return ${REQUEST_PATCH_MARKER}?.acknowledge?.(),__codexProjectWorkResult}catch(__codexProjectWorkError){throw __codexProjectWorkError}}`;
  return `${contextRuntimeSource()}${source.replace(requestPattern, replacement)}`;
}

function codexLinuxProjectWorkStateFromPayloadRuntime(payload) {
  const result = payload?.result ?? payload;
  if (result?.ok === false) {
    return { error: result.message ?? "Project work request failed", state: result.state ?? null };
  }
  return { error: payload?.error ?? null, state: payload?.state ?? result?.state ?? null };
}

function codexLinuxProjectWorkCardRuntime(props) {
  const {
    embedded = false,
    shouldHideInlineImmediately,
    shouldShow,
  } = props;
  const route = codexLinuxProjectWorkRouteHook(codexLinuxProjectWorkRouteAtom);
  const threadId = route.value.routeKind === "local-thread"
    ? route.value.conversationId
    : null;
  const environment = codexLinuxProjectWorkEnvironmentHook(codexLinuxProjectWorkEnvironmentAtom);
  const workspaceRoot = environment.cwd == null
    ? null
    : codexLinuxProjectWorkNormalizePath(environment.cwd);
  const [state, setState] = codexLinuxProjectWorkReact.useState(null);
  const [error, setError] = codexLinuxProjectWorkReact.useState(null);
  const [pendingLine, setPendingLine] = codexLinuxProjectWorkReact.useState(null);
  const [hideCompleted, setHideCompleted] = codexLinuxProjectWorkReact.useState(false);

  codexLinuxProjectWorkReact.useEffect(() => {
    let disposed = false;
    setState(null);
    setError(null);
    setPendingLine(null);
    if (workspaceRoot == null) {
      return;
    }
    const bridge = globalThis.electronBridge?.projectWork;
    if (bridge?.request == null) {
      setError("Project work bridge is unavailable");
      return;
    }
    const applyPayload = (payload) => {
      if (disposed) {
        return;
      }
      const parsed = codexLinuxProjectWorkStateFromPayload(payload);
      if (parsed.state != null) {
        setState(parsed.state);
        if (payload.kind === "changed") {
          globalThis.codexLinuxProjectWorkContext?.markDirty?.(
            workspaceRoot,
            parsed.state.revision,
          );
        }
      }
      if (parsed.error != null) {
        setError(parsed.error);
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

  codexLinuxProjectWorkReact.useEffect(() => {
    if (threadId != null && workspaceRoot != null) {
      globalThis.codexLinuxProjectWorkContext?.associate?.(threadId, workspaceRoot);
    }
  }, [threadId, workspaceRoot]);

  if (workspaceRoot == null) {
    return null;
  }
  const bridge = globalThis.electronBridge?.projectWork;
  const applyActionResult = (result) => {
    const parsed = codexLinuxProjectWorkStateFromPayload(result);
    if (parsed.state != null) {
      setState(parsed.state);
      globalThis.codexLinuxProjectWorkContext?.markDirty?.(
        workspaceRoot,
        parsed.state.revision,
      );
    }
    if (parsed.error != null) {
      setError(parsed.error);
    }
  };
  const toggle = async (item) => {
    if (bridge?.request == null) {
      return;
    }
    setError(null);
    setPendingLine(item.line);
    try {
      applyActionResult(await bridge.request({
        action: "toggle",
        checked: !item.checked,
        expectedChecked: item.checked,
        expectedText: item.text,
        line: item.line,
        revision: state?.revision,
        workspaceRoot,
      }));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setPendingLine(null);
    }
  };
  const createFile = async () => {
    setError(null);
    try {
      applyActionResult(await bridge?.request({ action: "create", workspaceRoot }));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };
  const items = Array.isArray(state?.items) ? state.items : [];
  const visibleItems = hideCompleted ? items.filter((item) => !item.checked) : items;
  const visibleError = error ?? state?.error?.message ?? state?.watchError ?? null;
  const title = (0, codexLinuxProjectWorkJsx.jsxs)("span", {
    className: "flex min-w-0 items-center gap-2",
    children: [
      (0, codexLinuxProjectWorkJsx.jsx)("span", { children: "Project work" }),
      (0, codexLinuxProjectWorkJsx.jsx)("span", {
        className: "text-xs font-normal text-token-description-foreground",
        children: state == null
          ? ""
          : String(state.openCount) + " open · " + String(state.completedCount) + " done",
      }),
    ],
  });
  const createAction = state?.status === "missing"
    ? (0, codexLinuxProjectWorkJsx.jsx)(codexLinuxProjectWorkSummary.SectionActions, {
        children: (0, codexLinuxProjectWorkJsx.jsx)(
          codexLinuxProjectWorkSummary.IconButton,
          {
            label: "Create Project work file",
            "data-project-work-create": "true",
            onClick: createFile,
            children: (0, codexLinuxProjectWorkJsx.jsx)(
              codexLinuxProjectWorkPlusIcon,
              {},
            ),
          },
        ),
      })
    : null;
  const body = (0, codexLinuxProjectWorkJsx.jsxs)("div", {
    className: "flex flex-col gap-2 px-3 pb-3",
    "data-project-work-root": workspaceRoot,
    "data-project-work-revision": state?.revision ?? "loading",
    "data-project-work-status": state?.status ?? "loading",
    children: [
      items.some((item) => item.checked)
        ? (0, codexLinuxProjectWorkJsx.jsx)("div", {
            className: "flex flex-wrap items-center gap-2",
            children: (0, codexLinuxProjectWorkJsx.jsx)("button", {
              type: "button",
              className: "rounded-md px-2 py-1 text-xs text-token-description-foreground hover:bg-token-bg-secondary",
              onClick: () => setHideCompleted(!hideCompleted),
              children: hideCompleted ? "Show completed" : "Hide completed",
            }),
          })
        : null,
      visibleError == null
        ? null
        : (0, codexLinuxProjectWorkJsx.jsx)("div", {
            role: "alert",
            className: "rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300",
            children: visibleError,
          }),
      state == null
        ? (0, codexLinuxProjectWorkJsx.jsx)("div", {
            className: "text-xs text-token-description-foreground",
            children: "Loading Project work…",
          })
        : state.status === "missing"
          ? (0, codexLinuxProjectWorkJsx.jsx)("div", {
              className: "text-xs text-token-description-foreground",
              children: "No .codex/work-packages.md file exists for this project.",
            })
          : items.length === 0
            ? (0, codexLinuxProjectWorkJsx.jsx)("div", {
                className: "text-xs text-token-description-foreground",
                children: "No Markdown checklist items found.",
              })
            : (0, codexLinuxProjectWorkJsx.jsx)("div", {
                className: "flex flex-col gap-1",
                children: visibleItems.map((item) => (0, codexLinuxProjectWorkJsx.jsxs)("label", {
                  className: "flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 hover:bg-token-bg-secondary",
                  style: { paddingLeft: String(Math.min(8 + item.depth * 16, 72)) + "px" },
                  children: [
                    (0, codexLinuxProjectWorkJsx.jsx)("input", {
                      type: "checkbox",
                      checked: item.checked,
                      disabled: pendingLine != null,
                      onChange: () => toggle(item),
                      className: "mt-0.5 shrink-0",
                      "aria-label": item.text,
                    }),
                    (0, codexLinuxProjectWorkJsx.jsx)("span", {
                      className: item.checked
                        ? "min-w-0 break-words text-sm text-token-description-foreground line-through"
                        : "min-w-0 break-words text-sm text-token-foreground",
                      children: String(item.text ?? "").trim(),
                    }),
                  ],
                }, item.line)),
              }),
    ],
  });
  const section = (0, codexLinuxProjectWorkJsx.jsx)(codexLinuxProjectWorkSummary.Section, {
    sectionKey: "project-work",
    after: createAction,
    title,
    children: body,
  });
  if (embedded) {
    return section;
  }
  return (0, codexLinuxProjectWorkJsx.jsx)(codexLinuxProjectWorkSummary.Root, {
    shouldHideInlineImmediately,
    shouldShow,
    children: (0, codexLinuxProjectWorkJsx.jsx)(codexLinuxProjectWorkSummary.Content, { children: section }),
  });
}

function sidebarRuntimeSource(aliases) {
  let cardSource = codexLinuxProjectWorkCardRuntime.toString().replace(
    "codexLinuxProjectWorkCardRuntime",
    "codexLinuxProjectWorkCard",
  );
  const replacements = {
    codexLinuxProjectWorkEnvironmentAtom: aliases.environmentAtom,
    codexLinuxProjectWorkEnvironmentHook: aliases.environmentHook,
    codexLinuxProjectWorkJsx: aliases.jsx,
    codexLinuxProjectWorkNormalizePath: aliases.normalizePath,
    codexLinuxProjectWorkPlusIcon: aliases.plusIcon,
    codexLinuxProjectWorkReact: aliases.react,
    codexLinuxProjectWorkRouteAtom: aliases.routeAtom,
    codexLinuxProjectWorkRouteHook: aliases.routeHook,
    codexLinuxProjectWorkSummary: aliases.summary,
  };
  for (const [placeholder, replacement] of Object.entries(replacements)) {
    cardSource = cardSource.replaceAll(placeholder, replacement);
  }
  return [
    `var codexLinuxProjectWorkSidebarMarker=${JSON.stringify(SIDEBAR_MARKER)};`,
    codexLinuxProjectWorkStateFromPayloadRuntime.toString().replace(
      "codexLinuxProjectWorkStateFromPayloadRuntime",
      "codexLinuxProjectWorkStateFromPayload",
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

function findMatchingDelimiter(source, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === openCharacter) {
      depth += 1;
    } else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
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
  const route = plan.match(
    /\b([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\1\.value\.routeKind===[`'"]local-thread[`'"]\?\1\.value\.conversationId:null/,
  );
  const workspace = plan.match(
    /\b([A-Za-z_$][\w$]*)\.cwd==null\?null:([A-Za-z_$][\w$]*)\(\1\.cwd\)/,
  );
  if (route == null || workspace == null) {
    warn("Could not infer current route or workspace aliases from the plan summary", "sidebar patch");
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
    routeAtom: route[3],
    routeHook: route[2],
    summary,
  };
}

function appendInlineCard(targetText) {
  const currentRootPattern =
    /([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.jsxs\)\(([A-Za-z_$][\w$]*)\.Root,\{shouldHideInlineImmediately:([A-Za-z_$][\w$]*),shouldShow:([A-Za-z_$][\w$]*),children:\[/g;
  const currentRoots = [...targetText.matchAll(currentRootPattern)];
  if (currentRoots.length === 1) {
    const [prefix, resultName, jsx, summary, hideName, showName] = currentRoots[0];
    const arrayOpen = currentRoots[0].index + prefix.length - 1;
    const arrayClose = findMatchingDelimiter(targetText, arrayOpen, "[", "]");
    if (arrayClose === -1 || targetText.slice(arrayClose, arrayClose + 3) !== "]})") {
      return { reason: "Could not isolate the current inline task summary root" };
    }
    const rootEnd = arrayClose + 3;
    const rootExpression = targetText.slice(
      currentRoots[0].index + prefix.indexOf("=") + 1,
      rootEnd,
    );
    return {
      hideName,
      jsx,
      showName,
      summary,
      text:
        targetText.slice(0, currentRoots[0].index) +
        `${resultName}=(0,${jsx}.jsxs)(${jsx}.Fragment,{children:[${rootExpression},` +
        `(0,${jsx}.jsx)(codexLinuxProjectWorkCard,{shouldHideInlineImmediately:${hideName},shouldShow:${showName}})]})` +
        targetText.slice(rootEnd),
    };
  }
  if (currentRoots.length > 1) {
    return { reason: `Expected one current inline task summary root, found ${currentRoots.length}` };
  }

  const directRootPattern = /([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*)\.Root,\{shouldHideInlineImmediately:([A-Za-z_$][\w$]*),shouldShow:([A-Za-z_$][\w$]*),children:([A-Za-z_$][\w$]*)\}\)/g;
  const directRoots = [...targetText.matchAll(directRootPattern)];
  if (directRoots.length === 1) {
    const [full, resultName, jsx, summary, hideName, showName, childrenName] =
      directRoots[0];
    return {
      hideName,
      jsx,
      showName,
      summary,
      text: targetText.replace(
        full,
        `${resultName}=(0,${jsx}.jsxs)(${jsx}.Fragment,{children:[` +
          `(0,${jsx}.jsx)(${summary}.Root,{shouldHideInlineImmediately:${hideName},shouldShow:${showName},children:${childrenName}}),` +
          `(0,${jsx}.jsx)(codexLinuxProjectWorkCard,{shouldHideInlineImmediately:${hideName},shouldShow:${showName}})]})`,
      ),
    };
  }
  if (directRoots.length > 1) {
    return { reason: `Expected one inline task summary root, found ${directRoots.length}` };
  }

  const rootCallPattern =
    /\(0,([A-Za-z_$][\w$]*)\.(?:jsx|jsxs)\)\(([A-Za-z_$][\w$]*)\.Root,\{shouldHideInlineImmediately:([A-Za-z_$][\w$]*),shouldShow:([A-Za-z_$][\w$]*),children:(?:[A-Za-z_$][\w$]*|\[)/g;
  const rootCalls = [...targetText.matchAll(rootCallPattern)];
  if (rootCalls.length !== 1) {
    return { reason: `Expected one current inline task summary root call, found ${rootCalls.length}` };
  }
  const [rootCall, jsx, summary, hideName, showName] = rootCalls[0];
  const fragments = [
    ...targetText.matchAll(
      new RegExp(
        `([A-Za-z_$][\\w$]*)=\\(0,${jsx}\\.jsxs\\)\\(${jsx}\\.Fragment,\\{children:\\[`,
        "g",
      ),
    ),
  ];
  const containing = fragments.filter((fragment) => {
    const arrayOpen = fragment.index + fragment[0].length - 1;
    const arrayClose = findMatchingDelimiter(targetText, arrayOpen, "[", "]");
    const resultName = fragment[1];
    const returnsResult =
      targetText.includes(`return ${resultName}`) ||
      new RegExp(`(?:[:,])${resultName}(?:[=,;}])`).test(targetText);
    return (
      arrayClose !== -1 &&
      rootCalls[0].index >= arrayOpen &&
      rootCalls[0].index + rootCall.length <= arrayClose &&
      returnsResult
    );
  });
  if (containing.length !== 1) {
    return { reason: `Expected one composable inline summary fragment, found ${containing.length}` };
  }
  const fragment = containing[0];
  const arrayOpen = fragment.index + fragment[0].length - 1;
  const arrayClose = findMatchingDelimiter(targetText, arrayOpen, "[", "]");
  return {
    hideName,
    jsx,
    showName,
    summary,
    text:
      targetText.slice(0, arrayClose) +
      `,(0,${jsx}.jsx)(codexLinuxProjectWorkCard,{shouldHideInlineImmediately:${hideName},shouldShow:${showName}})` +
      targetText.slice(arrayClose),
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
  const inline = appendInlineCard(target.text);
  if (inline.text == null) {
    warn(inline.reason ?? "Could not extend the inline task summary", "sidebar patch");
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
    `(0,${inline.jsx}.jsx)(codexLinuxProjectWorkCard,{embedded:!0,shouldHideInlineImmediately:!1,shouldShow:!0}),` +
    `${contentChild}]})`;
  const patchedPopoverTarget =
    popoverTarget.text.slice(0, contentPropsOpen + 1) +
    popoverReplacement +
    popoverTarget.text.slice(contentPropsClose);
  const patchedSource = source
    .replace(target.text, inline.text)
    .replace(popoverTarget.text, patchedPopoverTarget);
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
      id: "main-process-project-work-bridge",
      order: 850,
      ciPolicy: "optional",
      apply: applyMainProcessBridgePatch,
    }),
    extractedAppPatch({
      id: "preload-project-work-bridge",
      phase: "extracted-app:pre-webview",
      order: 850,
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
      id: "turn-project-work-context",
      order: 1650,
      ciPolicy: "optional",
      pattern: CONTEXT_ASSET_PATTERN,
      missingDescription: "current turn request webview bundle",
      skipDescription: "Project work turn context patch",
      apply: applyContextDeliveryPatch,
    }),
    webviewAssetPatch({
      id: "sidebar-project-work-card",
      order: 1660,
      ciPolicy: "optional",
      pattern: SIDEBAR_ASSET_PATTERN,
      missingDescription: "local conversation summary webview bundle",
      skipDescription: "Project work sidebar patch",
      apply: applySidebarPatch,
    }),
  ],
};
