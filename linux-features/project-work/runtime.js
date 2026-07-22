"use strict";

function revisionForContent(content, cryptoModule = require("node:crypto")) {
  return cryptoModule.createHash("sha256").update(content).digest("hex");
}

function indentationWidth(value) {
  let width = 0;
  for (const character of value) {
    width += character === "\t" ? 4 : 1;
  }
  return width;
}

function parseChecklist(content) {
  if (typeof content !== "string") {
    throw new TypeError("Project work content must be a string");
  }

  const items = [];
  const nesting = [];
  let offset = 0;
  let lineNumber = 0;

  while (offset < content.length) {
    let lineEnd = offset;
    while (lineEnd < content.length && content[lineEnd] !== "\n" && content[lineEnd] !== "\r") {
      lineEnd += 1;
    }
    let nextOffset = lineEnd;
    if (content[nextOffset] === "\r" && content[nextOffset + 1] === "\n") {
      nextOffset += 2;
    } else if (content[nextOffset] === "\r" || content[nextOffset] === "\n") {
      nextOffset += 1;
    }

    const line = content.slice(offset, lineEnd);
    const match = /^([ \t]*)([-*])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/.exec(line);
    if (match != null) {
      const indent = indentationWidth(match[1]);
      while (nesting.length > 0 && indent < nesting.at(-1).indent) {
        nesting.pop();
      }
      if (nesting.length === 0 || indent > nesting.at(-1).indent) {
        nesting.push({ indent, lineNumber });
      } else {
        nesting[nesting.length - 1] = { indent, lineNumber };
      }
      const depth = Math.max(0, nesting.length - 1);
      const markerIndex = offset + match[1].length + match[2].length + match[3].length + 1;
      items.push({
        checked: match[4] !== " ",
        depth,
        indent,
        line: lineNumber,
        marker: match[4],
        markerIndex,
        parentLine: depth === 0 ? null : nesting[depth - 1].lineNumber,
        text: match[6],
      });
    }

    if (nextOffset === offset) {
      break;
    }
    offset = nextOffset;
    lineNumber += 1;
  }

  return items;
}

function mutateCheckboxContent(content, target) {
  const item = parseChecklist(content).find((candidate) => candidate.line === target?.line);
  if (item == null) {
    const error = new Error("The selected checklist item no longer exists");
    error.code = "PROJECT_WORK_TARGET_MISSING";
    throw error;
  }
  if (target.expectedText != null && item.text !== target.expectedText) {
    const error = new Error("The selected checklist item text changed");
    error.code = "PROJECT_WORK_TARGET_CHANGED";
    throw error;
  }
  if (target.expectedChecked != null && item.checked !== target.expectedChecked) {
    const error = new Error("The selected checklist item state changed");
    error.code = "PROJECT_WORK_TARGET_CHANGED";
    throw error;
  }
  const marker = target.checked === true ? "x" : " ";
  if (content[item.markerIndex] === marker) {
    return content;
  }
  return content.slice(0, item.markerIndex) + marker + content.slice(item.markerIndex + 1);
}

function createProjectWorkFileService(options = {}) {
  const fs = options.fs ?? require("node:fs");
  const fsp = fs.promises;
  const path = options.path ?? require("node:path");
  const crypto = options.crypto ?? require("node:crypto");
  const openPath = options.openPath ?? (async () => "");
  const watchFactory = options.watchFactory ?? ((target, watchOptions, listener) => fs.watch(target, watchOptions, listener));
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  const createContent = options.createContent ?? "# Project work\n\n";
  const watchers = new Map();

  function errorCode(error) {
    return typeof error?.code === "string" ? error.code : "PROJECT_WORK_ERROR";
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function fail(code, message, state = null) {
    return { ok: false, code, message, ...(state == null ? {} : { state }) };
  }

  async function canonicalWorkspaceRoot(workspaceRoot) {
    if (
      typeof workspaceRoot !== "string" ||
      workspaceRoot.length === 0 ||
      workspaceRoot.includes("\0") ||
      !path.isAbsolute(workspaceRoot)
    ) {
      const error = new Error("Project workspace root must be a non-empty absolute path");
      error.code = "PROJECT_WORK_UNSAFE_ROOT";
      throw error;
    }
    const resolved = path.resolve(workspaceRoot);
    const canonical = await fsp.realpath(resolved);
    const stat = await fsp.stat(canonical);
    if (!stat.isDirectory()) {
      const error = new Error("Project workspace root is not a directory");
      error.code = "PROJECT_WORK_UNSAFE_ROOT";
      throw error;
    }
    return canonical;
  }

  function projectPaths(workspaceRoot) {
    const codexDir = path.join(workspaceRoot, ".codex");
    const filePath = path.join(codexDir, "work-packages.md");
    const relative = path.relative(workspaceRoot, filePath);
    if (relative !== path.join(".codex", "work-packages.md") || relative.startsWith("..") || path.isAbsolute(relative)) {
      const error = new Error("Resolved Project work path escaped the workspace root");
      error.code = "PROJECT_WORK_UNSAFE_PATH";
      throw error;
    }
    return { codexDir, filePath };
  }

  async function validateCodexDirectory(workspaceRoot, create = false) {
    const { codexDir } = projectPaths(workspaceRoot);
    if (create) {
      try {
        await fsp.mkdir(codexDir, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }
    }
    let stat;
    try {
      stat = await fsp.lstat(codexDir);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      const error = new Error("Workspace .codex path must be a real directory");
      error.code = "PROJECT_WORK_UNSAFE_PATH";
      throw error;
    }
    const canonical = await fsp.realpath(codexDir);
    if (canonical !== codexDir) {
      const error = new Error("Workspace .codex directory resolves outside its expected path");
      error.code = "PROJECT_WORK_UNSAFE_PATH";
      throw error;
    }
    return true;
  }

  async function validateProjectFile(workspaceRoot) {
    const { filePath } = projectPaths(workspaceRoot);
    let stat;
    try {
      stat = await fsp.lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      const error = new Error("Project work file must be a regular file, not a link or special file");
      error.code = "PROJECT_WORK_UNSAFE_PATH";
      throw error;
    }
    return stat;
  }

  function stateFromContent(workspaceRoot, filePath, content, watchError = null) {
    const items = parseChecklist(content);
    const completedCount = items.filter((item) => item.checked).length;
    return {
      completedCount,
      content,
      itemCount: items.length,
      items,
      openCount: items.length - completedCount,
      path: filePath,
      revision: revisionForContent(content, crypto),
      status: items.length === 0 ? "empty" : "ready",
      watchError,
      workspaceRoot,
    };
  }

  function missingState(workspaceRoot, filePath, watchError = null) {
    return {
      completedCount: 0,
      content: "",
      itemCount: 0,
      items: [],
      openCount: 0,
      path: filePath,
      revision: "missing",
      status: "missing",
      watchError,
      workspaceRoot,
    };
  }

  function errorState(workspaceRoot, error, watchError = null) {
    let filePath = null;
    try {
      filePath = typeof workspaceRoot === "string" && path.isAbsolute(workspaceRoot)
        ? projectPaths(path.resolve(workspaceRoot)).filePath
        : null;
    } catch {
      filePath = null;
    }
    return {
      completedCount: 0,
      content: "",
      error: { code: errorCode(error), message: errorMessage(error) },
      itemCount: 0,
      items: [],
      openCount: 0,
      path: filePath,
      revision: `error:${errorCode(error)}`,
      status: "error",
      watchError,
      workspaceRoot: typeof workspaceRoot === "string" ? workspaceRoot : null,
    };
  }

  async function readCanonical(workspaceRoot) {
    const { filePath } = projectPaths(workspaceRoot);
    const entry = watchers.get(workspaceRoot);
    const watchError = entry?.watchError ?? null;
    if (!(await validateCodexDirectory(workspaceRoot, false))) {
      return missingState(workspaceRoot, filePath, watchError);
    }
    const stat = await validateProjectFile(workspaceRoot);
    if (stat == null) {
      return missingState(workspaceRoot, filePath, watchError);
    }
    if (stat.size > maxFileBytes) {
      const error = new Error(`Project work file exceeds the ${maxFileBytes}-byte safety limit`);
      error.code = "PROJECT_WORK_TOO_LARGE";
      throw error;
    }
    const content = await fsp.readFile(filePath, "utf8");
    return stateFromContent(workspaceRoot, filePath, content, watchError);
  }

  async function read(workspaceRoot) {
    const canonical = await canonicalWorkspaceRoot(workspaceRoot);
    return readCanonical(canonical);
  }

  async function syncDirectory(directory) {
    let handle = null;
    try {
      handle = await fsp.open(directory, "r");
      await handle.sync();
    } catch {
      // Directory fsync is best-effort on filesystems that do not support it.
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function atomicReplace(workspaceRoot, expectedRevision, content, mode) {
    const { codexDir, filePath } = projectPaths(workspaceRoot);
    const tempPath = path.join(
      codexDir,
      `.work-packages.md.tmp-${process.pid}-${crypto.randomUUID()}`,
    );
    let handle = null;
    try {
      handle = await fsp.open(tempPath, "wx", mode);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;

      await validateCodexDirectory(workspaceRoot, false);
      await validateProjectFile(workspaceRoot);
      const latest = await fsp.readFile(filePath, "utf8");
      if (revisionForContent(latest, crypto) !== expectedRevision) {
        const error = new Error("Project work file changed before the toggle could be committed");
        error.code = "PROJECT_WORK_CONFLICT";
        throw error;
      }
      await fsp.rename(tempPath, filePath);
      await syncDirectory(codexDir);
    } finally {
      await handle?.close().catch(() => {});
      await fsp.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async function broadcastCanonical(workspaceRoot) {
    const entry = watchers.get(workspaceRoot);
    if (entry == null || entry.subscribers.size === 0) {
      return;
    }
    let state;
    try {
      state = await readCanonical(workspaceRoot);
    } catch (error) {
      state = errorState(workspaceRoot, error, entry.watchError);
    }
    const payload = { kind: "changed", state, workspaceRoot };
    for (const subscriber of entry.subscribers.values()) {
      try {
        subscriber(payload);
      } catch {
        // A stale renderer must not break other subscribers or the watcher.
      }
    }
  }

  function scheduleBroadcast(entry, rearm = false) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (rearm) {
        await armWatchers(entry);
      }
      await broadcastCanonical(entry.workspaceRoot);
    }, 60);
    entry.timer.unref?.();
  }

  function closeWatchHandles(entry) {
    for (const handle of entry.handles) {
      try {
        handle.close();
      } catch {
        // Already-closed fs.watch handles are harmless.
      }
    }
    entry.handles = [];
  }

  function recordWatchFailure(entry, error) {
    entry.watchError = errorMessage(error);
    closeWatchHandles(entry);
    scheduleBroadcast(entry, false);
    clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(async () => {
      entry.retryTimer = null;
      await armWatchers(entry);
      await broadcastCanonical(entry.workspaceRoot);
    }, 1000);
    entry.retryTimer.unref?.();
  }

  async function armWatchers(entry) {
    if (watchers.get(entry.workspaceRoot) !== entry || entry.subscribers.size === 0) {
      return;
    }
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    closeWatchHandles(entry);
    entry.watchError = null;
    const { codexDir } = projectPaths(entry.workspaceRoot);
    try {
      const rootWatcher = watchFactory(
        entry.workspaceRoot,
        { persistent: false },
        (eventType, fileName) => {
          const name = fileName == null ? null : String(fileName);
          if (name == null || name === ".codex") {
            scheduleBroadcast(entry, true);
          }
        },
      );
      rootWatcher.on?.("error", (error) => recordWatchFailure(entry, error));
      entry.handles.push(rootWatcher);
    } catch (error) {
      recordWatchFailure(entry, error);
      return;
    }

    try {
      if (await validateCodexDirectory(entry.workspaceRoot, false)) {
        const directoryWatcher = watchFactory(
          codexDir,
          { persistent: false },
          (eventType, fileName) => {
            const name = fileName == null ? null : String(fileName);
            if (name == null || name === "work-packages.md") {
              scheduleBroadcast(entry, eventType === "rename");
            }
          },
        );
        directoryWatcher.on?.("error", (error) => recordWatchFailure(entry, error));
        entry.handles.push(directoryWatcher);
      }
    } catch (error) {
      recordWatchFailure(entry, error);
    }
  }

  async function watch(workspaceRoot, subscriberId, subscriber) {
    const canonical = await canonicalWorkspaceRoot(workspaceRoot);
    let entry = watchers.get(canonical);
    if (entry == null) {
      entry = {
        handles: [],
        retryTimer: null,
        subscribers: new Map(),
        timer: null,
        watchError: null,
        workspaceRoot: canonical,
      };
      watchers.set(canonical, entry);
    }
    entry.subscribers.set(subscriberId, subscriber);
    await armWatchers(entry);
    return readCanonical(canonical);
  }

  async function unwatch(workspaceRoot, subscriberId) {
    let canonical;
    try {
      canonical = await canonicalWorkspaceRoot(workspaceRoot);
    } catch {
      return;
    }
    const entry = watchers.get(canonical);
    if (entry == null) {
      return;
    }
    entry.subscribers.delete(subscriberId);
    if (entry.subscribers.size === 0) {
      clearTimeout(entry.timer);
      clearTimeout(entry.retryTimer);
      closeWatchHandles(entry);
      watchers.delete(canonical);
    }
  }

  function unsubscribeAll(subscriberId) {
    for (const entry of watchers.values()) {
      entry.subscribers.delete(subscriberId);
      if (entry.subscribers.size === 0) {
        clearTimeout(entry.timer);
        clearTimeout(entry.retryTimer);
        closeWatchHandles(entry);
        watchers.delete(entry.workspaceRoot);
      }
    }
  }

  async function toggle(payload) {
    const workspaceRoot = await canonicalWorkspaceRoot(payload.workspaceRoot);
    let current;
    try {
      current = await readCanonical(workspaceRoot);
    } catch (error) {
      return fail(errorCode(error), errorMessage(error), errorState(workspaceRoot, error));
    }
    if (current.revision !== payload.revision) {
      return fail(
        "PROJECT_WORK_CONFLICT",
        "Project work changed outside Codex. The newer file was reloaded; retry the toggle.",
        current,
      );
    }

    let content;
    try {
      content = mutateCheckboxContent(current.content, {
        checked: payload.checked,
        expectedChecked: payload.expectedChecked,
        expectedText: payload.expectedText,
        line: payload.line,
      });
    } catch (error) {
      return fail("PROJECT_WORK_CONFLICT", errorMessage(error), current);
    }
    if (content === current.content) {
      return { ok: true, state: current };
    }

    try {
      const stat = await validateProjectFile(workspaceRoot);
      if (stat == null) {
        return fail("PROJECT_WORK_CONFLICT", "Project work file was removed", await readCanonical(workspaceRoot));
      }
      await atomicReplace(workspaceRoot, current.revision, content, stat.mode & 0o777);
      const state = await readCanonical(workspaceRoot);
      await broadcastCanonical(workspaceRoot);
      return { ok: true, state };
    } catch (error) {
      const state = await readCanonical(workspaceRoot).catch(() => errorState(workspaceRoot, error));
      return fail(
        error?.code === "PROJECT_WORK_CONFLICT" ? "PROJECT_WORK_CONFLICT" : errorCode(error),
        error?.code === "PROJECT_WORK_CONFLICT"
          ? "Project work changed outside Codex. The newer file was reloaded; retry the toggle."
          : errorMessage(error),
        state,
      );
    }
  }

  async function create(workspaceRootInput) {
    const workspaceRoot = await canonicalWorkspaceRoot(workspaceRootInput);
    const { codexDir, filePath } = projectPaths(workspaceRoot);
    await validateCodexDirectory(workspaceRoot, true);
    let handle = null;
    let created = false;
    try {
      handle = await fsp.open(filePath, "wx", 0o644);
      await handle.writeFile(createContent, "utf8");
      await handle.sync();
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      await validateProjectFile(workspaceRoot);
    } finally {
      await handle?.close().catch(() => {});
    }
    if (created) {
      await syncDirectory(codexDir);
    }
    const state = await readCanonical(workspaceRoot);
    await broadcastCanonical(workspaceRoot);
    return { created, state };
  }

  async function open(workspaceRootInput) {
    const workspaceRoot = await canonicalWorkspaceRoot(workspaceRootInput);
    const state = await readCanonical(workspaceRoot);
    if (state.status === "missing") {
      return fail("PROJECT_WORK_MISSING", "Create the Project work file before opening it", state);
    }
    const result = await openPath(state.path);
    if (typeof result === "string" && result.length > 0) {
      return fail("PROJECT_WORK_OPEN_FAILED", result, state);
    }
    return { ok: true, state };
  }

  async function handle(payload, subscriber = null) {
    try {
      if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
        return fail("PROJECT_WORK_BAD_REQUEST", "Project work request must be an object");
      }
      switch (payload.action) {
        case "read":
          return { ok: true, state: await read(payload.workspaceRoot) };
        case "create": {
          const result = await create(payload.workspaceRoot);
          return { ok: true, ...result };
        }
        case "open":
          return open(payload.workspaceRoot);
        case "toggle":
          return toggle(payload);
        case "watch": {
          if (subscriber == null || typeof subscriber.send !== "function") {
            return fail("PROJECT_WORK_BAD_REQUEST", "Project work watch requires a renderer subscriber");
          }
          const state = await watch(payload.workspaceRoot, subscriber.id, subscriber.send);
          return { ok: true, state };
        }
        case "unwatch":
          if (subscriber != null) {
            await unwatch(payload.workspaceRoot, subscriber.id);
          }
          return { ok: true };
        default:
          return fail("PROJECT_WORK_BAD_REQUEST", "Unknown Project work action");
      }
    } catch (error) {
      return fail(errorCode(error), errorMessage(error), errorState(payload?.workspaceRoot, error));
    }
  }

  function dispose() {
    for (const entry of watchers.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.retryTimer);
      closeWatchHandles(entry);
    }
    watchers.clear();
  }

  return {
    create,
    dispose,
    handle,
    open,
    parseChecklist,
    read,
    toggle,
    unsubscribeAll,
    unwatch,
    watch,
  };
}

function createProjectWorkContextCoordinator(options) {
  const read = options.read;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024;
  const tasks = new Map();

  function taskState(threadId) {
    let state = tasks.get(threadId);
    if (state == null) {
      state = {
        dirty: false,
        dirtyRevision: null,
        lastDelivered: null,
        pending: null,
        workspaceRoot: null,
      };
      tasks.set(threadId, state);
    }
    return state;
  }

  function snapshotForState(state) {
    if (state.status === "missing") {
      return { bounded: false, value: "Project work file is missing." };
    }
    const content = typeof state.content === "string" ? state.content : "";
    if (new TextEncoder().encode(content).byteLength <= maxSnapshotBytes) {
      return { bounded: false, value: content };
    }
    const topLevel = (Array.isArray(state.items) ? state.items : [])
      .filter((item) => item.depth === 0)
      .slice(0, 100)
      .map((item) => `- [${item.checked ? "x" : " "}] ${String(item.text ?? "").trim().slice(0, 240)}`);
    return {
      bounded: true,
      value: [
        `Project work is larger than ${maxSnapshotBytes} bytes. This is a bounded top-level summary; read the file for full details.`,
        "",
        ...topLevel,
      ].join("\n"),
    };
  }

  async function prepare(method, params, hostId = "local") {
    if (
      hostId !== "local" ||
      (method !== "turn/start" && method !== "turn/steer") ||
      params == null ||
      typeof params !== "object" ||
      typeof params.threadId !== "string"
    ) {
      return null;
    }
    const task = taskState(params.threadId);
    if (method === "turn/start" && typeof params.cwd === "string" && params.cwd.length > 0) {
      task.workspaceRoot = params.cwd;
    }
    if (task.workspaceRoot == null) {
      return null;
    }

    const response = await read(task.workspaceRoot);
    const state = response?.state ?? response;
    if (response?.ok === false || state == null) {
      throw new Error(response?.message ?? "Project work state was unavailable");
    }
    const revision = String(state.revision ?? `status:${state.status ?? "unknown"}`);
    if (task.lastDelivered === revision) {
      task.dirty = false;
      task.dirtyRevision = null;
      return null;
    }

    const snapshot = snapshotForState(state);
    const metadata = {
      boundedSnapshot: snapshot.bounded,
      changedSinceLastTurn: task.lastDelivered != null && task.lastDelivered !== revision,
      completedCount: Number(state.completedCount ?? 0),
      openCount: Number(state.openCount ?? 0),
      path: state.path ?? null,
      revision,
      status: state.status ?? "unknown",
    };
    const existing = params.additionalContext != null && typeof params.additionalContext === "object" && !Array.isArray(params.additionalContext)
      ? params.additionalContext
      : {};
    const nextParams = {
      ...params,
      additionalContext: {
        ...existing,
        "codex.projectWork.markdown.v1": { kind: "untrusted", value: snapshot.value },
        "codex.projectWork.metadata.v1": { kind: "application", value: JSON.stringify(metadata) },
      },
    };
    const pending = Symbol("project-work-context");
    task.pending = pending;

    return {
      acknowledge() {
        if (task.pending !== pending) {
          return;
        }
        task.pending = null;
        task.lastDelivered = revision;
        if (task.dirtyRevision == null || task.dirtyRevision === revision) {
          task.dirty = false;
          task.dirtyRevision = null;
        } else {
          task.dirty = true;
        }
      },
      metadata,
      params: nextParams,
      state,
    };
  }

  function markDirty(workspaceRoot, revision = null) {
    for (const task of tasks.values()) {
      if (task.workspaceRoot === workspaceRoot) {
        task.dirty = true;
        task.dirtyRevision = revision == null ? null : String(revision);
      }
    }
  }

  function associate(threadId, workspaceRoot) {
    if (
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      typeof workspaceRoot !== "string" ||
      workspaceRoot.length === 0
    ) {
      return;
    }
    taskState(threadId).workspaceRoot = workspaceRoot;
  }

  return {
    associate,
    inspect(threadId) {
      const state = tasks.get(threadId);
      return state == null ? null : { ...state, pending: state.pending != null };
    },
    markDirty,
    prepare,
  };
}

function installProjectWorkMainBridge(electron) {
  const marker = "codexLinuxProjectWorkMainBridgeV1";
  if (globalThis[marker] != null) {
    return globalThis[marker];
  }
  const requestChannel = "codex_desktop:project-work";
  const updateChannel = "codex_desktop:project-work-updated";
  const destroyed = new Set();
  const service = createProjectWorkFileService({
    openPath: (filePath) => electron.shell.openPath(filePath),
  });
  electron.ipcMain.handle(requestChannel, async (event, payload) => {
    const sender = event.sender;
    const subscriber = {
      id: sender.id,
      send: (message) => {
        if (!sender.isDestroyed()) {
          sender.send(updateChannel, message);
        }
      },
    };
    if (!destroyed.has(sender.id)) {
      destroyed.add(sender.id);
      sender.once("destroyed", () => {
        destroyed.delete(sender.id);
        service.unsubscribeAll(sender.id);
      });
    }
    return service.handle(payload, subscriber);
  });
  electron.app.once("before-quit", () => service.dispose());
  const installed = { marker, service };
  globalThis[marker] = installed;
  return installed;
}

function mainProcessRuntimeSource() {
  return [
    revisionForContent,
    indentationWidth,
    parseChecklist,
    mutateCheckboxContent,
    createProjectWorkFileService,
    installProjectWorkMainBridge,
  ].map((value) => value.toString()).join("") +
    ";installProjectWorkMainBridge(require(\"electron\"));";
}

function contextRuntimeSource() {
  return [
    createProjectWorkContextCoordinator.toString(),
    `;(function(){const marker="codexLinuxProjectWorkContextV1";if(globalThis.codexLinuxProjectWorkContext?.marker===marker)return;const bridge=globalThis.electronBridge?.projectWork;if(bridge?.request==null)return;const coordinator=createProjectWorkContextCoordinator({read:workspaceRoot=>bridge.request({action:"read",workspaceRoot})});globalThis.codexLinuxProjectWorkContext={marker,associate:(threadId,workspaceRoot)=>coordinator.associate(threadId,workspaceRoot),inspect:threadId=>coordinator.inspect(threadId),markDirty:(workspaceRoot,revision)=>coordinator.markDirty(workspaceRoot,revision),prepare:async(method,params,hostId)=>{try{return await coordinator.prepare(method,params,hostId)}catch(error){console.warn("Project work context unavailable",error);return null}}}})();`,
  ].join("");
}

module.exports = {
  contextRuntimeSource,
  createProjectWorkContextCoordinator,
  createProjectWorkFileService,
  indentationWidth,
  mainProcessRuntimeSource,
  mutateCheckboxContent,
  parseChecklist,
  revisionForContent,
};
