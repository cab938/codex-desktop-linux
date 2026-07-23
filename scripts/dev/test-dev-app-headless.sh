#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/dev/test-dev-app-headless.sh [options] [-- APP_ARGS...]

Launch a generated Codex dev app on a headless Xvfb desktop. The default smoke
mode waits for the app window, captures a screenshot and window metadata, probes
the virtual pointer, and then stops every process it started. Xvfb creates no
host window and has no connection to the physical desktop pointer.

Options:
  --app PATH             Generated app launcher (default: bin/codex-desktop-dev)
  --window-class CLASS   X11 WM_CLASS to wait for (default: launcher basename)
  --display :N           Headless display number (default: first free :90-:119)
  --screen WIDTHxHEIGHT  Xvfb screen size (default: 1600x1000)
  --timeout SECONDS      App-window startup timeout (default: 90)
  --settle SECONDS       Wait after mapping before capture (default: 5)
  --artifact-dir PATH    Keep screenshots and logs here (default: /tmp/...)
  --interactive          Keep the headless session open until Ctrl-C or app exit
  -h, --help             Show this help

Arguments after -- are passed to the generated app launcher. The harness always
adds --new-instance so it can run beside an existing day-to-day or dev process.

Examples:
  make test-dev-app-headless DEV_APP_ID=codex-desktop-dev
  make run-dev-app-headless DEV_APP_ID=codex-desktop-dev
  DISPLAY=:90 xdotool search --onlyvisible --class codex-desktop-dev
  DISPLAY=:90 import -window root /tmp/headless-desktop.png
USAGE
}

die() {
  echo "[headless] ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_nonnegative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

display_number() {
  printf '%s\n' "${1#:}"
}

display_is_available() {
  local number
  number="$(display_number "$1")"
  [[ ! -e "/tmp/.X11-unix/X${number}" && ! -e "/tmp/.X${number}-lock" ]]
}

find_free_display() {
  local number
  for number in $(seq 90 119); do
    if display_is_available ":${number}"; then
      printf ':%s\n' "$number"
      return 0
    fi
  done
  return 1
}

pointer_position() {
  local target_display=$1
  env DISPLAY="$target_display" xdotool getmouselocation --shell 2>/dev/null \
    | awk -F= '/^(X|Y)=/ { values = values $1 "=" $2 ";" } END { print values }'
}

stop_process_group() {
  local pid=${1:-}
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  wait "$pid" 2>/dev/null || true
}

app_path="bin/codex-desktop-dev"
window_class=""
headless_display=""
screen_size="1600x1000"
startup_timeout=90
settle_seconds=5
artifact_dir=""
interactive=0
app_args=()

while (($#)); do
  case "$1" in
    --app)
      app_path="${2:?missing --app value}"
      shift 2
      ;;
    --window-class)
      window_class="${2:?missing --window-class value}"
      shift 2
      ;;
    --display)
      headless_display="${2:?missing --display value}"
      shift 2
      ;;
    --screen)
      screen_size="${2:?missing --screen value}"
      shift 2
      ;;
    --timeout)
      startup_timeout="${2:?missing --timeout value}"
      shift 2
      ;;
    --settle)
      settle_seconds="${2:?missing --settle value}"
      shift 2
      ;;
    --artifact-dir)
      artifact_dir="${2:?missing --artifact-dir value}"
      shift 2
      ;;
    --interactive)
      interactive=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      app_args=("$@")
      break
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$headless_display" =~ ^:[0-9]+$ || -z "$headless_display" ]] \
  || die "--display must look like :90"
[[ "$screen_size" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]] \
  || die "--screen must look like 1600x1000"
is_positive_integer "$startup_timeout" \
  || die "--timeout must be a positive integer"
is_nonnegative_integer "$settle_seconds" \
  || die "--settle must be a nonnegative integer"

command -v Xvfb >/dev/null 2>&1 \
  || die "missing required command: Xvfb (install the xvfb package)"
require_command xfwm4
require_command xdotool
require_command xwininfo
require_command import
require_command xdpyinfo
require_command dbus-run-session
require_command setsid

if [[ "$app_path" != /* ]]; then
  app_path="$(pwd)/$app_path"
fi
[[ -x "$app_path" ]] || die "app launcher is not executable: $app_path"

if [[ -z "$window_class" ]]; then
  window_class="$(basename "$app_path")"
fi

if [[ -z "$headless_display" ]]; then
  headless_display="$(find_free_display)" \
    || die "no free headless display found in :90-:119"
elif ! display_is_available "$headless_display"; then
  die "display is already in use: $headless_display"
fi

session_root="$(mktemp -d "${TMPDIR:-/tmp}/codex-desktop-headless-session.XXXXXX")"
if [[ -z "$artifact_dir" ]]; then
  artifact_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-desktop-headless-artifacts.XXXXXX")"
else
  mkdir -p "$artifact_dir"
  artifact_dir="$(realpath "$artifact_dir")"
fi

mkdir -p \
  "$session_root/xdg/config" \
  "$session_root/xdg/state" \
  "$session_root/xdg/cache" \
  "$session_root/xdg/data" \
  "$session_root/xdg/runtime"
chmod 700 "$session_root/xdg/runtime"

xvfb_pid=""
wm_pid=""
app_pid=""

cleanup() {
  local exit_status=$?
  local launcher_log
  local launcher_logs=()
  trap - EXIT INT TERM
  shopt -s nullglob
  launcher_logs=("$session_root/xdg/cache/$window_class"/launcher*.log)
  shopt -u nullglob
  for launcher_log in "${launcher_logs[@]}"; do
    cp "$launcher_log" "$artifact_dir/$(basename "$launcher_log")" 2>/dev/null || true
  done
  stop_process_group "$app_pid"
  stop_process_group "$wm_pid"
  stop_process_group "$xvfb_pid"
  case "$session_root" in
    "${TMPDIR:-/tmp}"/codex-desktop-headless-session.*)
      rm -rf -- "$session_root"
      ;;
    *)
      echo "[headless] Refusing to remove unexpected session path: $session_root" >&2
      ;;
  esac
  exit "$exit_status"
}

on_signal() {
  exit 130
}

trap cleanup EXIT
trap on_signal INT TERM

echo "[headless] Starting private Xvfb desktop on $headless_display ($screen_size)"
setsid Xvfb "$headless_display" \
  -screen 0 "${screen_size}x24" \
  -ac \
  -noreset \
  -nolisten tcp \
  >"$artifact_dir/xvfb.log" 2>&1 &
xvfb_pid=$!

display_ready=0
for _ in {1..100}; do
  if env DISPLAY="$headless_display" xdpyinfo >/dev/null 2>&1; then
    display_ready=1
    break
  fi
  kill -0 "$xvfb_pid" 2>/dev/null \
    || die "Xvfb exited early; see $artifact_dir/xvfb.log"
  sleep 0.1
done
(( display_ready == 1 )) \
  || die "Xvfb did not become ready; see $artifact_dir/xvfb.log"

setsid env \
  DISPLAY="$headless_display" \
  XDG_CONFIG_HOME="$session_root/xdg/config" \
  XDG_STATE_HOME="$session_root/xdg/state" \
  XDG_CACHE_HOME="$session_root/xdg/cache" \
  XDG_DATA_HOME="$session_root/xdg/data" \
  XDG_RUNTIME_DIR="$session_root/xdg/runtime" \
  dbus-run-session -- xfwm4 --replace --compositor=off \
  >"$artifact_dir/xfwm4.log" 2>&1 &
wm_pid=$!

sleep 0.5
kill -0 "$wm_pid" 2>/dev/null \
  || die "xfwm4 exited early; see $artifact_dir/xfwm4.log"

echo "[headless] Launching $app_path as an isolated new instance"
setsid env \
  -u WAYLAND_DISPLAY \
  DISPLAY="$headless_display" \
  XDG_CONFIG_HOME="$session_root/xdg/config" \
  XDG_STATE_HOME="$session_root/xdg/state" \
  XDG_CACHE_HOME="$session_root/xdg/cache" \
  XDG_DATA_HOME="$session_root/xdg/data" \
  XDG_RUNTIME_DIR="$session_root/xdg/runtime" \
  XDG_SESSION_TYPE=x11 \
  CODEX_OZONE_PLATFORM=x11 \
  dbus-run-session -- "$app_path" --new-instance "${app_args[@]}" \
  >"$artifact_dir/app.log" 2>&1 &
app_pid=$!

window_id=""
deadline=$((SECONDS + startup_timeout))
while ((SECONDS < deadline)); do
  window_id="$(
    env DISPLAY="$headless_display" \
      xdotool search --onlyvisible --class "$window_class" 2>/dev/null \
      | tail -n 1 \
      || true
  )"
  [[ -z "$window_id" ]] || break
  kill -0 "$app_pid" 2>/dev/null \
    || die "app exited before opening a window; see $artifact_dir/app.log"
  sleep 0.25
done

if [[ -z "$window_id" ]]; then
  env DISPLAY="$headless_display" xwininfo -root -tree \
    >"$artifact_dir/root-window-tree.txt" 2>&1 || true
  die "no visible $window_class window after ${startup_timeout}s; see $artifact_dir/app.log"
fi

if (( settle_seconds > 0 )); then
  echo "[headless] Waiting ${settle_seconds}s for the renderer to paint"
  sleep "$settle_seconds"
  kill -0 "$app_pid" 2>/dev/null \
    || die "app exited while its renderer was settling; see $artifact_dir/app.log"
fi

env DISPLAY="$headless_display" xwininfo -id "$window_id" \
  >"$artifact_dir/app-window.txt"
env DISPLAY="$headless_display" import -window "$window_id" \
  "$artifact_dir/app-window.png"

virtual_pointer_before="$(pointer_position "$headless_display")"
env DISPLAY="$headless_display" xdotool mousemove 12 12
virtual_pointer_after="$(pointer_position "$headless_display")"

cat <<RESULTS
[headless] PASS: dev app opened in a host-invisible Xvfb desktop
DISPLAY=$headless_display
APP_WINDOW_ID=$window_id
WINDOW_CLASS=$window_class
ARTIFACT_DIR=$artifact_dir
APP_SCREENSHOT=$artifact_dir/app-window.png
VIRTUAL_POINTER_BEFORE=$virtual_pointer_before
VIRTUAL_POINTER_AFTER=$virtual_pointer_after
RESULTS

if (( interactive )); then
  cat <<INSTRUCTIONS

[headless] Session is running. Automation must target $headless_display:
  DISPLAY=$headless_display xdotool search --onlyvisible --class '$window_class'
  DISPLAY=$headless_display import -window root '$artifact_dir/headless-desktop.png'
Press Ctrl-C to stop the app, window manager, and Xvfb.
INSTRUCTIONS
  wait "$app_pid"
fi
