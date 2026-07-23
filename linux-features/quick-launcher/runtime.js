"use strict";

function quickLaunchError(code, message, line = null) {
  const error = new Error(line == null ? message : `Line ${line}: ${message}`);
  error.code = code;
  if (line != null) {
    error.line = line;
  }
  return error;
}

function stripYamlComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\" && quote === '"') {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseYamlScalar(value, line) {
  const trimmed = stripYamlComment(value).trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "string") {
        throw new TypeError("not a string");
      }
      return parsed;
    } catch {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_YAML",
        "double-quoted values must be valid JSON strings",
        line,
      );
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_YAML",
        "single-quoted value is not closed",
        line,
      );
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[|>][+-]?$/.test(trimmed)) {
    return trimmed;
  }
  if (/^[\[{]/.test(trimmed)) {
    throw quickLaunchError(
      "QUICK_LAUNCH_INVALID_YAML",
      "flow mappings and sequences are not supported here",
      line,
    );
  }
  return trimmed;
}

function parseQuickLaunchYaml(content) {
  if (typeof content !== "string") {
    throw new TypeError("Quick launcher content must be a string");
  }

  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const entries = [];
  const labels = new Set();
  let current = null;
  let launchesSeen = false;
  let version = null;

  function assignProperty(target, key, value, line) {
    if (!["label", "command", "cwd"].includes(key)) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_YAML",
        `unknown launch property ${JSON.stringify(key)}`,
        line,
      );
    }
    if (Object.hasOwn(target, key)) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_YAML",
        `duplicate launch property ${JSON.stringify(key)}`,
        line,
      );
    }
    target[key] = value;
  }

  function finishCurrent() {
    if (current == null) {
      return;
    }
    const label = typeof current.label === "string" ? current.label.trim() : "";
    const command = typeof current.command === "string" ? current.command.trim() : "";
    const cwd = typeof current.cwd === "string" && current.cwd.trim().length > 0
      ? current.cwd.trim()
      : ".";
    if (label.length === 0) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_ENTRY",
        "each launch needs a non-empty label",
        current.line,
      );
    }
    if (label.length > 80 || /[\r\n\0]/.test(label)) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_ENTRY",
        "launch labels must be one line and at most 80 characters",
        current.line,
      );
    }
    if (command.length === 0) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_ENTRY",
        `launch ${JSON.stringify(label)} needs a non-empty command`,
        current.line,
      );
    }
    if (command.length > 8192 || command.includes("\0")) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_ENTRY",
        `launch ${JSON.stringify(label)} command exceeds the safety limit`,
        current.line,
      );
    }
    if (cwd.length > 1024 || /[\r\n\0]/.test(cwd)) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_ENTRY",
        `launch ${JSON.stringify(label)} cwd is invalid`,
        current.line,
      );
    }
    const normalizedLabel = label.toLocaleLowerCase("en-US");
    if (labels.has(normalizedLabel)) {
      throw quickLaunchError(
        "QUICK_LAUNCH_DUPLICATE_LABEL",
        `launch label ${JSON.stringify(label)} is duplicated`,
        current.line,
      );
    }
    labels.add(normalizedLabel);
    entries.push({
      command,
      cwd,
      id: String(entries.length),
      label,
    });
    current = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = index + 1;
    if (raw.includes("\t")) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_YAML",
        "tabs are not supported; indent with spaces",
        line,
      );
    }
    if (/^\s*(?:#.*)?$/.test(raw)) {
      continue;
    }

    if (!raw.startsWith(" ")) {
      finishCurrent();
      const root = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(raw);
      if (root == null) {
        throw quickLaunchError(
          "QUICK_LAUNCH_INVALID_YAML",
          "expected a top-level key",
          line,
        );
      }
      const key = root[1];
      const rawValue = root[2] ?? "";
      if (key === "version") {
        if (version != null) {
          throw quickLaunchError(
            "QUICK_LAUNCH_INVALID_YAML",
            "version is duplicated",
            line,
          );
        }
        const value = parseYamlScalar(rawValue, line);
        if (value !== "1") {
          throw quickLaunchError(
            "QUICK_LAUNCH_UNSUPPORTED_VERSION",
            "version must be 1",
            line,
          );
        }
        version = 1;
      } else if (key === "launches") {
        if (launchesSeen) {
          throw quickLaunchError(
            "QUICK_LAUNCH_INVALID_YAML",
            "launches is duplicated",
            line,
          );
        }
        const value = stripYamlComment(rawValue).trim();
        if (value !== "" && value !== "[]") {
          throw quickLaunchError(
            "QUICK_LAUNCH_INVALID_YAML",
            "launches must be a block sequence or []",
            line,
          );
        }
        launchesSeen = true;
      } else {
        throw quickLaunchError(
          "QUICK_LAUNCH_INVALID_YAML",
          `unknown top-level key ${JSON.stringify(key)}`,
          line,
        );
      }
      continue;
    }

    if (!launchesSeen) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_YAML",
        "launch entries must follow the launches key",
        line,
      );
    }

    const entry = /^  -(?:\s+(.*))?$/.exec(raw);
    if (entry != null) {
      finishCurrent();
      current = { line };
      const inline = entry[1];
      if (inline != null && inline.trim().length > 0) {
        const property = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(inline);
        if (property == null) {
          throw quickLaunchError(
            "QUICK_LAUNCH_INVALID_YAML",
            "launch entries must contain label, command, and optional cwd properties",
            line,
          );
        }
        assignProperty(current, property[1], parseYamlScalar(property[2] ?? "", line), line);
      }
      continue;
    }

    const property = /^ {4}([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(raw);
    if (property == null || current == null) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_YAML",
        "launch properties must be indented by four spaces",
        line,
      );
    }
    const key = property[1];
    const value = parseYamlScalar(property[2] ?? "", line);
    if (/^[|>][+-]?$/.test(value)) {
      if (key !== "command") {
        throw quickLaunchError(
          "QUICK_LAUNCH_INVALID_YAML",
          "only command may use a block scalar",
          line,
        );
      }
      const block = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim().length === 0) {
          block.push("");
          index += 1;
          continue;
        }
        if (!next.startsWith("      ")) {
          break;
        }
        block.push(next.slice(6));
        index += 1;
      }
      if (block.length === 0) {
        throw quickLaunchError(
          "QUICK_LAUNCH_INVALID_ENTRY",
          "command block must not be empty",
          line,
        );
      }
      const folded = value.startsWith(">")
        ? block.join(" ").replace(/\s+/g, " ").trim()
        : block.join("\n").replace(/\n+$/, "");
      assignProperty(current, key, folded, line);
    } else {
      assignProperty(current, key, value, line);
    }
  }
  finishCurrent();

  if (version == null) {
    throw quickLaunchError(
      "QUICK_LAUNCH_INVALID_YAML",
      "missing required top-level version: 1",
    );
  }
  if (!launchesSeen) {
    throw quickLaunchError(
      "QUICK_LAUNCH_INVALID_YAML",
      "missing required top-level launches key",
    );
  }
  if (entries.length > 50) {
    throw quickLaunchError(
      "QUICK_LAUNCH_TOO_MANY_ENTRIES",
      "at most 50 quick launches are allowed",
    );
  }
  return entries;
}

function quickLaunchRevision(content, cryptoModule = require("node:crypto")) {
  return cryptoModule.createHash("sha256").update(content).digest("hex");
}

function createQuickLauncherFileService(options = {}) {
  const fs = options.fs ?? require("node:fs");
  const fsp = fs.promises;
  const path = options.path ?? require("node:path");
  const crypto = options.crypto ?? require("node:crypto");
  const spawnCommand = options.spawnCommand ??
    ((command, spawnOptions) => require("node:child_process").spawn(command, spawnOptions));
  const openPath = options.openPath ?? (async () => "");
  const watchFactory = options.watchFactory ??
    ((target, watchOptions, listener) => fs.watch(target, watchOptions, listener));
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024;
  const createContent = options.createContent ?? "version: 1\nlaunches: []\n";
  const openResponseTimeoutMs = options.openResponseTimeoutMs ?? 750;
  const watchers = new Map();

  function errorCode(error) {
    return typeof error?.code === "string" ? error.code : "QUICK_LAUNCH_ERROR";
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
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_ROOT",
        "Quick launcher workspace root must be a non-empty absolute path",
      );
    }
    const canonical = await fsp.realpath(path.resolve(workspaceRoot));
    const stat = await fsp.stat(canonical);
    if (!stat.isDirectory()) {
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_ROOT",
        "Quick launcher workspace root is not a directory",
      );
    }
    return canonical;
  }

  function projectPaths(workspaceRoot) {
    const codexDir = path.join(workspaceRoot, ".codex");
    const filePath = path.join(codexDir, "quicklaunch.yaml");
    const relative = path.relative(workspaceRoot, filePath);
    if (
      relative !== path.join(".codex", "quicklaunch.yaml") ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_PATH",
        "Resolved quick launcher path escaped the workspace root",
      );
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
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_PATH",
        "Workspace .codex path must be a real directory",
      );
    }
    if (await fsp.realpath(codexDir) !== codexDir) {
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_PATH",
        "Workspace .codex directory resolves outside its expected path",
      );
    }
    return true;
  }

  async function validateQuickLaunchFile(workspaceRoot) {
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
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_PATH",
        "quicklaunch.yaml must be a regular file, not a link or special file",
      );
    }
    return stat;
  }

  function missingState(workspaceRoot, filePath, watchError = null) {
    return {
      buttons: [],
      content: "",
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
      buttons: [],
      content: "",
      error: { code: errorCode(error), message: errorMessage(error) },
      path: filePath,
      revision: `error:${errorCode(error)}`,
      status: "error",
      watchError,
      workspaceRoot: typeof workspaceRoot === "string" ? workspaceRoot : null,
    };
  }

  function stateFromContent(workspaceRoot, filePath, content, watchError = null) {
    const revision = quickLaunchRevision(content, crypto);
    try {
      const entries = parseQuickLaunchYaml(content);
      return {
        buttons: entries.map(({ id, label }) => ({ id, label })),
        content,
        path: filePath,
        revision,
        status: entries.length === 0 ? "empty" : "ready",
        watchError,
        workspaceRoot,
      };
    } catch (error) {
      return {
        buttons: [],
        content,
        error: { code: errorCode(error), message: errorMessage(error) },
        path: filePath,
        revision,
        status: "invalid",
        watchError,
        workspaceRoot,
      };
    }
  }

  async function readCanonical(workspaceRoot) {
    const { filePath } = projectPaths(workspaceRoot);
    const watchError = watchers.get(workspaceRoot)?.watchError ?? null;
    if (!(await validateCodexDirectory(workspaceRoot, false))) {
      return missingState(workspaceRoot, filePath, watchError);
    }
    const stat = await validateQuickLaunchFile(workspaceRoot);
    if (stat == null) {
      return missingState(workspaceRoot, filePath, watchError);
    }
    if (stat.size > maxFileBytes) {
      throw quickLaunchError(
        "QUICK_LAUNCH_TOO_LARGE",
        `quicklaunch.yaml exceeds the ${maxFileBytes}-byte safety limit`,
      );
    }
    const content = await fsp.readFile(filePath, "utf8");
    return stateFromContent(workspaceRoot, filePath, content, watchError);
  }

  async function read(workspaceRoot) {
    return readCanonical(await canonicalWorkspaceRoot(workspaceRoot));
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
        // A stale renderer must not break the watcher or other subscribers.
      }
    }
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

  function recordWatchFailure(entry, error) {
    entry.watchError = errorMessage(error);
    closeWatchHandles(entry);
    scheduleBroadcast(entry);
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
            if (name == null || name === "quicklaunch.yaml") {
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
      await validateQuickLaunchFile(workspaceRoot);
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
    const result = await create(workspaceRoot);
    let timeoutId = null;
    const openResult = Promise.resolve()
      .then(() => openPath(result.state.path))
      .then(
        (value) => ({ status: "settled", value }),
        (error) => ({ status: "rejected", error }),
      );
    const outcome = await Promise.race([
      openResult,
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ status: "pending" }),
          openResponseTimeoutMs,
        );
      }),
    ]);
    if (timeoutId != null) {
      clearTimeout(timeoutId);
    }
    if (outcome.status === "rejected") {
      return fail(
        "QUICK_LAUNCH_OPEN_FAILED",
        errorMessage(outcome.error),
        result.state,
      );
    }
    if (
      outcome.status === "settled" &&
      typeof outcome.value === "string" &&
      outcome.value.length > 0
    ) {
      return fail("QUICK_LAUNCH_OPEN_FAILED", outcome.value, result.state);
    }
    return { ok: true, ...result };
  }

  async function resolveLaunchDirectory(workspaceRoot, configuredCwd) {
    if (path.isAbsolute(configuredCwd)) {
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_CWD",
        "Quick launcher cwd must be relative to the workspace",
      );
    }
    const requested = path.resolve(workspaceRoot, configuredCwd);
    const requestedRelative = path.relative(workspaceRoot, requested);
    if (
      requestedRelative.startsWith(`..${path.sep}`) ||
      requestedRelative === ".." ||
      path.isAbsolute(requestedRelative)
    ) {
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_CWD",
        "Quick launcher cwd escaped the workspace",
      );
    }
    const canonical = await fsp.realpath(requested);
    const canonicalRelative = path.relative(workspaceRoot, canonical);
    if (
      canonicalRelative.startsWith(`..${path.sep}`) ||
      canonicalRelative === ".." ||
      path.isAbsolute(canonicalRelative)
    ) {
      throw quickLaunchError(
        "QUICK_LAUNCH_UNSAFE_CWD",
        "Quick launcher cwd resolves outside the workspace",
      );
    }
    if (!(await fsp.stat(canonical)).isDirectory()) {
      throw quickLaunchError(
        "QUICK_LAUNCH_INVALID_CWD",
        "Quick launcher cwd is not a directory",
      );
    }
    return canonical;
  }

  async function launch(payload) {
    const workspaceRoot = await canonicalWorkspaceRoot(payload.workspaceRoot);
    const state = await readCanonical(workspaceRoot);
    if (state.status !== "ready") {
      return fail(
        "QUICK_LAUNCH_NOT_READY",
        "Quick launcher configuration has no runnable entries",
        state,
      );
    }
    if (payload.revision !== state.revision) {
      return fail(
        "QUICK_LAUNCH_CONFLICT",
        "quicklaunch.yaml changed. The newer buttons were reloaded; click again.",
        state,
      );
    }
    const { filePath } = projectPaths(workspaceRoot);
    const content = await fsp.readFile(filePath, "utf8");
    if (quickLaunchRevision(content, crypto) !== state.revision) {
      return fail(
        "QUICK_LAUNCH_CONFLICT",
        "quicklaunch.yaml changed before the command could start; click again.",
        await readCanonical(workspaceRoot),
      );
    }
    const entries = parseQuickLaunchYaml(content);
    const entry = entries.find((candidate) =>
      candidate.id === payload.id && candidate.label === payload.label);
    if (entry == null) {
      return fail(
        "QUICK_LAUNCH_TARGET_MISSING",
        "The selected quick launch no longer exists",
        state,
      );
    }
    const cwd = await resolveLaunchDirectory(workspaceRoot, entry.cwd);
    let child;
    try {
      child = spawnCommand(entry.command, {
        cwd,
        env: {
          ...process.env,
          CODEX_QUICK_LAUNCHER: "1",
          CODEX_QUICK_LAUNCH_LABEL: entry.label,
        },
        shell: "/bin/bash",
        stdio: "ignore",
      });
      if (child != null && typeof child.once === "function") {
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      }
      child?.unref?.();
    } catch (error) {
      return fail(
        "QUICK_LAUNCH_START_FAILED",
        `Could not start ${JSON.stringify(entry.label)}: ${errorMessage(error)}`,
        state,
      );
    }
    return {
      label: entry.label,
      ok: true,
      pid: Number.isInteger(child?.pid) ? child.pid : null,
      startedAt: new Date().toISOString(),
      state,
    };
  }

  async function handle(payload, subscriber = null) {
    try {
      if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
        return fail("QUICK_LAUNCH_BAD_REQUEST", "Quick launcher request must be an object");
      }
      switch (payload.action) {
        case "read":
          return { ok: true, state: await read(payload.workspaceRoot) };
        case "open":
          return await open(payload.workspaceRoot);
        case "launch":
          return await launch(payload);
        case "watch": {
          if (subscriber == null || typeof subscriber.send !== "function") {
            return fail(
              "QUICK_LAUNCH_BAD_REQUEST",
              "Quick launcher watch requires a renderer subscriber",
            );
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
          return fail("QUICK_LAUNCH_BAD_REQUEST", "Unknown Quick launcher action");
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
    launch,
    open,
    read,
    unsubscribeAll,
    unwatch,
    watch,
  };
}

function createQuickLauncherContextCoordinator(options) {
  const read = options.read;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? 32 * 1024;
  const tasks = new Map();

  function taskState(threadId) {
    let state = tasks.get(threadId);
    if (state == null) {
      state = {
        lastDelivered: null,
        pending: null,
        workspaceRoot: null,
      };
      tasks.set(threadId, state);
    }
    return state;
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
      throw new Error(response?.message ?? "Quick launcher state was unavailable");
    }
    const revision = String(state.revision ?? `status:${state.status ?? "unknown"}`);
    if (task.lastDelivered === revision) {
      return null;
    }
    const content = typeof state.content === "string" ? state.content : "";
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const boundedSnapshot = contentBytes > maxSnapshotBytes;
    const metadata = {
      boundedSnapshot,
      buttonCount: Array.isArray(state.buttons) ? state.buttons.length : 0,
      changedSinceLastTurn: task.lastDelivered != null && task.lastDelivered !== revision,
      instructions:
        "When the user asks to add or change a quick launch, edit this project file. Use version: 1 and a launches sequence; each launch has label, command, and optional workspace-relative cwd. Infer the command from the checked-out project. Do not execute the command merely to add the button.",
      path: state.path ?? null,
      revision,
      schemaExample:
        "version: 1\nlaunches:\n  - label: Start\n    command: make run-dev-app\n    cwd: .\n",
      status: state.status ?? "unknown",
    };
    const existing = params.additionalContext != null &&
      typeof params.additionalContext === "object" &&
      !Array.isArray(params.additionalContext)
      ? params.additionalContext
      : {};
    const yamlSnapshot = state.status === "missing"
      ? "Project quick launcher file is missing."
      : boundedSnapshot
        ? `quicklaunch.yaml is larger than ${maxSnapshotBytes} bytes. Read ${state.path} before editing it.`
        : content;
    const nextParams = {
      ...params,
      additionalContext: {
        ...existing,
        "codex.quickLauncher.metadata.v1": {
          kind: "application",
          value: JSON.stringify(metadata),
        },
        "codex.quickLauncher.yaml.v1": {
          kind: "untrusted",
          value: yamlSnapshot,
        },
      },
    };
    const pending = Symbol("quick-launcher-context");
    task.pending = pending;
    return {
      acknowledge() {
        if (task.pending === pending) {
          task.pending = null;
          task.lastDelivered = revision;
        }
      },
      metadata,
      params: nextParams,
      state,
    };
  }

  return {
    inspect(threadId) {
      const state = tasks.get(threadId);
      return state == null ? null : { ...state, pending: state.pending != null };
    },
    prepare,
  };
}

function installQuickLauncherMainBridge(electron) {
  const marker = "codexLinuxQuickLauncherMainBridgeV1";
  if (globalThis[marker] != null) {
    return globalThis[marker];
  }
  const requestChannel = "codex_desktop:quick-launcher";
  const updateChannel = "codex_desktop:quick-launcher-updated";
  const destroyed = new Set();
  const service = createQuickLauncherFileService({
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
    quickLaunchError,
    stripYamlComment,
    parseYamlScalar,
    parseQuickLaunchYaml,
    quickLaunchRevision,
    createQuickLauncherFileService,
    installQuickLauncherMainBridge,
  ].map((value) => value.toString()).join("") +
    ";installQuickLauncherMainBridge(require(\"electron\"));";
}

function contextRuntimeSource() {
  return [
    createQuickLauncherContextCoordinator.toString(),
    `;(function(){const marker="codexLinuxQuickLauncherContextV1";if(globalThis.codexLinuxQuickLauncherContext?.marker===marker)return;const bridge=globalThis.electronBridge?.quickLauncher;if(bridge?.request==null)return;const coordinator=createQuickLauncherContextCoordinator({read:workspaceRoot=>bridge.request({action:"read",workspaceRoot})});const api={marker,inspect:threadId=>coordinator.inspect(threadId),prepare:async(method,params,hostId)=>{try{return await coordinator.prepare(method,params,hostId)}catch(error){console.warn("Quick launcher context unavailable",error);return null}}};globalThis.codexLinuxQuickLauncherContext=api;queueMicrotask(()=>{const projectWork=globalThis.codexLinuxProjectWorkContext;if(projectWork?.prepare==null||projectWork.codexLinuxQuickLauncherComposed===marker)return;const previousPrepare=projectWork.prepare.bind(projectWork);projectWork.prepare=async(method,params,hostId)=>{const projectPrepared=await previousPrepare(method,params,hostId),quickPrepared=await api.prepare(method,projectPrepared?.params??params,hostId);if(projectPrepared==null)return quickPrepared;if(quickPrepared==null)return projectPrepared;return{...projectPrepared,params:quickPrepared.params,acknowledge:()=>{projectPrepared.acknowledge?.();quickPrepared.acknowledge?.()}}};projectWork.codexLinuxQuickLauncherComposed=marker})})();`,
  ].join("");
}

module.exports = {
  contextRuntimeSource,
  createQuickLauncherContextCoordinator,
  createQuickLauncherFileService,
  mainProcessRuntimeSource,
  parseQuickLaunchYaml,
  parseYamlScalar,
  quickLaunchRevision,
  stripYamlComment,
};
