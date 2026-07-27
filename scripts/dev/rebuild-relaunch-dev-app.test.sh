#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$REPO_ROOT/scripts/dev/rebuild-relaunch-dev-app.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/codex-dev-rebuild-test.XXXXXX")"
DEV_PID=""
PROD_PID=""

cleanup() {
  [[ -z "$DEV_PID" ]] || kill -TERM "$DEV_PID" 2>/dev/null || true
  [[ -z "$PROD_PID" ]] || kill -TERM "$PROD_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  wait "$PROD_PID" 2>/dev/null || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

bash -n "$TARGET"
"$TARGET" --help >/dev/null

if grep -Eq '(^|[^[:alnum:]_])(ps|pgrep|pkill|killall)([^[:alnum:]_]|$)' "$TARGET"; then
  echo "rebuild workflow must not select processes by process-list text" >&2
  exit 1
fi
grep -Fq 'source "$REPO_ROOT/scripts/lib/process-detection.sh"' "$TARGET"
grep -Fq 'kill -TERM "$running_pid"' "$TARGET"
grep -Fq 'systemd-run \' "$TARGET"
grep -Fq 'make -C "$REPO_ROOT" build-combined-dev-app \' "$TARGET"
grep -Fq 'verify_promoted_build' "$TARGET"
grep -Fq 'launch_promoted_app' "$TARGET"

mkdir -p "$TEST_ROOT/dev-app" "$TEST_ROOT/prod-app" "$TEST_ROOT/durable-root"
dry_run_output="$(
  CODEX_COMBINED_DEV_ROOT="$TEST_ROOT/durable-root" "$TARGET" --dry-run
)"
[[ "$dry_run_output" == *"durable output root: $TEST_ROOT/durable-root"* ]]
[[ "$dry_run_output" == *"target app: $TEST_ROOT/durable-root/codex-desktop-linux-dev-app"* ]]
if CODEX_COMBINED_DEV_ROOT=/ "$TARGET" --dry-run >/dev/null 2>&1; then
  echo "rebuild workflow accepted the filesystem root as its output root" >&2
  exit 1
fi

cp /bin/sleep "$TEST_ROOT/dev-app/electron"
cp /bin/sleep "$TEST_ROOT/prod-app/electron"
"$TEST_ROOT/dev-app/electron" 60 &
DEV_PID=$!
"$TEST_ROOT/prod-app/electron" 60 &
PROD_PID=$!

# shellcheck source=rebuild-relaunch-dev-app.sh
source "$TARGET"
APP_DIR="$TEST_ROOT/dev-app"
APP_ELECTRON="$APP_DIR/electron"
APP_ID="codex-dev-process-test"
STOP_TIMEOUT_SECONDS=5

found_pid="$(running_dev_pid)"
[[ "$found_pid" == "$DEV_PID" ]]
stop_output="$(stop_running_dev_app 2>&1)"
if [[ "$stop_output" == *"command not found"* ]]; then
  echo "$stop_output" >&2
  exit 1
fi
if kill -0 "$DEV_PID" 2>/dev/null; then
  echo "exact dev process survived stop_running_dev_app" >&2
  exit 1
fi
DEV_PID=""
if ! kill -0 "$PROD_PID" 2>/dev/null; then
  echo "unrelated production process was terminated" >&2
  exit 1
fi

printf '%s\n' "rebuild-relaunch dev-app tests passed"
