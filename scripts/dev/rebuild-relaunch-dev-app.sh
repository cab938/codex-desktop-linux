#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ID="codex-desktop-linux-dev"
APP_NAME="Codex Desktop Linux Dev"
APP_DIR="$REPO_ROOT/${APP_ID}-app"
APP_ELECTRON="$APP_DIR/electron"
APP_LAUNCHER="$REPO_ROOT/bin/$APP_ID"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/$APP_ID"
LOG_FILE="$STATE_DIR/rebuild-relaunch.log"
LOCK_FILE="$STATE_DIR/rebuild-relaunch.lock"
WORKER_UNIT="${APP_ID}-rebuild-relaunch"
STOP_TIMEOUT_SECONDS="${CODEX_DEV_REBUILD_STOP_TIMEOUT_SECONDS:-30}"
WORKER_GRACE_SECONDS="${CODEX_DEV_REBUILD_GRACE_SECONDS:-2}"
WORKER_SUCCEEDED=0

usage() {
  cat <<'USAGE'
Usage: scripts/dev/rebuild-relaunch-dev-app.sh [--dry-run | --worker]

Without arguments, start a detached user-systemd worker that:
  1. stops only the running codex-desktop-linux-dev Electron executable;
  2. rebuilds and promotes the dev/combined side-by-side app; and
  3. relaunches that app only after the accepted build is verified.

Options:
  --dry-run  Inspect the exact target and prerequisites without stopping,
             rebuilding, or launching anything.
  --worker   Internal entry point used by the detached systemd unit.
  -h, --help Show this help.

The durable worker log is:
  ~/.local/state/codex-desktop-linux-dev/rebuild-relaunch.log
USAGE
}

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*"
}

notify_user() {
  local summary="$1"
  local body="$2"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --app-name="$APP_NAME" "$summary" "$body" >/dev/null 2>&1 || true
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    log "ERROR: missing required command: $1" >&2
    return 1
  }
}

append_service_environment() {
  local name
  local value
  SERVICE_ENV_ARGS=()
  for name in \
    PATH \
    DISPLAY \
    WAYLAND_DISPLAY \
    XAUTHORITY \
    XDG_RUNTIME_DIR \
    XDG_STATE_HOME \
    XDG_SESSION_TYPE \
    XDG_CURRENT_DESKTOP \
    DESKTOP_SESSION \
    DBUS_SESSION_BUS_ADDRESS \
    CODEX_CLI_PATH \
    CODEX_CA_CERTIFICATE \
    ELECTRON_HEADERS_URL \
    ELECTRON_MIRROR \
    HTTP_PROXY \
    HTTPS_PROXY \
    NO_PROXY \
    ALL_PROXY \
    http_proxy \
    https_proxy \
    no_proxy \
    all_proxy \
    NPM_CONFIG_CACHE \
    NPM_CONFIG_CAFILE \
    NPM_CONFIG_HTTP_PROXY \
    NPM_CONFIG_HTTPS_PROXY \
    NPM_CONFIG_NOPROXY \
    NODE_EXTRA_CA_CERTS \
    SSL_CERT_FILE; do
    value="${!name:-}"
    [[ -n "$value" ]] || continue
    SERVICE_ENV_ARGS+=("--setenv=${name}=${value}")
  done

  if [[ -z "${CODEX_CLI_PATH:-}" ]]; then
    value="$(command -v codex 2>/dev/null || true)"
    [[ -z "$value" ]] || SERVICE_ENV_ARGS+=("--setenv=CODEX_CLI_PATH=${value}")
  fi
}

load_process_detection() {
  CODEX_APP_ID="$APP_ID"
  INSTALL_DIR="$APP_DIR"
  export CODEX_APP_ID INSTALL_DIR
  # shellcheck source=../lib/process-detection.sh
  source "$REPO_ROOT/scripts/lib/process-detection.sh"
}

running_dev_pid() {
  load_process_detection
  find_running_install_target_pid
}

stop_running_dev_app() {
  local running_pid
  local deadline

  load_process_detection
  if ! running_pid="$(find_running_install_target_pid)"; then
    log "No running $APP_NAME process was found; continuing with the rebuild"
    return 0
  fi

  log "Stopping exact dev Electron pid=$running_pid executable=$APP_ELECTRON"
  kill -TERM "$running_pid"
  deadline=$((SECONDS + STOP_TIMEOUT_SECONDS))
  while pid_matches_install_target "$running_pid" "$APP_ELECTRON"; do
    if ((SECONDS >= deadline)); then
      log "ERROR: dev Electron pid=$running_pid did not exit within ${STOP_TIMEOUT_SECONDS}s" >&2
      return 1
    fi
    sleep 0.25
  done

  if running_pid="$(find_running_install_target_pid)"; then
    log "ERROR: another exact dev Electron process is still running as pid=$running_pid" >&2
    return 1
  fi
  log "The exact dev app stopped; production Codex and unrelated processes were not targeted"
}

require_combined_branch() {
  local branch
  branch="$(git -C "$REPO_ROOT" branch --show-current)"
  if [[ "$branch" != "dev/combined" ]]; then
    log "ERROR: rebuild-and-relaunch requires dev/combined; current branch is ${branch:-detached}" >&2
    return 1
  fi
}

verify_promoted_build() {
  local build_info="$APP_DIR/.codex-linux/build-info.json"
  local expected_commit

  [[ -x "$APP_LAUNCHER" ]] || {
    log "ERROR: expected launcher is missing or not executable: $APP_LAUNCHER" >&2
    return 1
  }
  [[ "$(readlink -f "$APP_LAUNCHER")" == "$(readlink -f "$APP_DIR/start.sh")" ]] || {
    log "ERROR: $APP_LAUNCHER does not resolve to the promoted dev app" >&2
    return 1
  }
  [[ -f "$build_info" ]] || {
    log "ERROR: promoted build info is missing: $build_info" >&2
    return 1
  }

  expected_commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  node -e '
    const fs = require("node:fs");
    const [file, expectedCommit, expectedId, expectedName] = process.argv.slice(1);
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    if (info?.source?.commit !== expectedCommit) {
      throw new Error(`build commit ${info?.source?.commit ?? "missing"} != ${expectedCommit}`);
    }
    if (info?.source?.branch !== "dev/combined") {
      throw new Error(`build branch ${info?.source?.branch ?? "missing"} != dev/combined`);
    }
    if (info?.appIdentity?.id !== expectedId || info?.appIdentity?.displayName !== expectedName) {
      throw new Error("promoted build identity does not match the dev app");
    }
  ' "$build_info" "$expected_commit" "$APP_ID" "$APP_NAME"
  log "Verified promoted build commit=$expected_commit identity=$APP_ID"
}

launch_promoted_app() {
  local launch_unit

  append_service_environment
  launch_unit="${APP_ID}-launch-$(date -u '+%Y%m%dT%H%M%S')-$$"
  log "Launching the promoted app in transient unit ${launch_unit}.service"
  systemd-run \
    --user \
    --collect \
    --unit="$launch_unit" \
    --description="$APP_NAME" \
    --property=Type=exec \
    --working-directory="$REPO_ROOT" \
    "${SERVICE_ENV_ARGS[@]}" \
    "$APP_LAUNCHER"
}

worker_exit() {
  local status=$?
  if ((status == 0 && WORKER_SUCCEEDED == 1)); then
    log "Rebuild-and-relaunch worker completed successfully"
    return
  fi
  log "Rebuild-and-relaunch worker failed with status=$status"
  notify_user "Dev rebuild failed" "See $LOG_FILE"
}

run_worker() {
  mkdir -p "$STATE_DIR"
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  exec >>"$LOG_FILE" 2>&1
  trap worker_exit EXIT

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "ERROR: another rebuild-and-relaunch worker already holds $LOCK_FILE"
    return 1
  fi

  log "Starting detached rebuild-and-relaunch worker"
  sleep "$WORKER_GRACE_SECONDS"
  require_command git
  require_command make
  require_command node
  require_command systemd-run
  require_combined_branch
  stop_running_dev_app

  log "Building and promoting $APP_NAME from dev/combined"
  make -C "$REPO_ROOT" build-dev-app \
    DEV_APP_ID="$APP_ID" \
    DEV_APP_NAME="$APP_NAME"
  verify_promoted_build
  notify_user "Dev rebuild complete" "Relaunching $APP_NAME"
  launch_promoted_app
  WORKER_SUCCEEDED=1
}

run_dry_run() {
  local branch
  local running_pid

  require_command git
  require_command make
  require_command node
  require_command systemd-run
  branch="$(git -C "$REPO_ROOT" branch --show-current)"
  printf 'repository: %s\n' "$REPO_ROOT"
  printf 'branch: %s\n' "${branch:-detached}"
  printf 'target app: %s\n' "$APP_DIR"
  printf 'target executable: %s\n' "$APP_ELECTRON"
  if running_pid="$(running_dev_pid)"; then
    printf 'running exact dev pid: %s\n' "$running_pid"
  else
    printf 'running exact dev pid: none\n'
  fi
  printf 'build: make build-dev-app DEV_APP_ID=%s DEV_APP_NAME=%q\n' "$APP_ID" "$APP_NAME"
  printf 'launcher: %s\n' "$APP_LAUNCHER"
  printf 'log: %s\n' "$LOG_FILE"
  if [[ "$branch" != "dev/combined" ]]; then
    printf 'result: worker would refuse because the current branch is not dev/combined\n'
  else
    printf 'result: prerequisites are ready; no processes or files were changed\n'
  fi
}

dispatch_worker() {
  mkdir -p "$STATE_DIR"
  require_command systemctl
  require_command systemd-run
  if systemctl --user --quiet is-active "${WORKER_UNIT}.service"; then
    notify_user "Dev rebuild already running" "See $LOG_FILE"
    log "A detached rebuild-and-relaunch worker is already active"
    return 1
  fi

  append_service_environment
  systemd-run \
    --user \
    --collect \
    --unit="$WORKER_UNIT" \
    --description="Rebuild and relaunch $APP_NAME" \
    --property=Type=exec \
    --working-directory="$REPO_ROOT" \
    "${SERVICE_ENV_ARGS[@]}" \
    "$SCRIPT_DIR/rebuild-relaunch-dev-app.sh" --worker
  notify_user "Dev rebuild started" "The window will close, rebuild, and relaunch. Log: $LOG_FILE"
}

main() {
  case "${1:-}" in
    "")
      dispatch_worker
      ;;
    --dry-run)
      [[ $# -eq 1 ]] || {
        usage >&2
        return 2
      }
      run_dry_run
      ;;
    --worker)
      [[ $# -eq 1 ]] || {
        usage >&2
        return 2
      }
      run_worker
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
