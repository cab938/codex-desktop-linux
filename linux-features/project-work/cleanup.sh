#!/usr/bin/env bash
set -Eeuo pipefail

warn() {
    echo "WARN: $*" >&2
}

codex_home="${CODEX_HOME:-}"
if [ -z "$codex_home" ]; then
    [ -n "${HOME:-}" ] || exit 0
    codex_home="$HOME/.codex"
fi

target_dir="$codex_home/skills/project-work"
marker_file="$target_dir/.codex-linux-project-work-managed"
skill_file="$target_dir/SKILL.md"
metadata_file="$target_dir/agents/openai.yaml"
[ -f "$marker_file" ] || exit 0

file_sha256() {
    sha256sum "$1" | awk '{print $1}'
}

marker_value() {
    local key="$1"
    sed -n "s/^${key}=//p" "$marker_file" | head -n 1
}

if [ "$(marker_value managed-by)" != "codex-desktop-linux-project-work" ]; then
    warn "Project work skill marker is not owned by this feature; leaving $target_dir untouched"
    exit 0
fi

recorded_skill_sha="$(marker_value skill-sha256)"
recorded_metadata_sha="$(marker_value metadata-sha256)"
if [ -z "$recorded_skill_sha" ] || [ -z "$recorded_metadata_sha" ] || \
    [ ! -f "$skill_file" ] || [ ! -f "$metadata_file" ] || \
    [ "$(file_sha256 "$skill_file")" != "$recorded_skill_sha" ] || \
    [ "$(file_sha256 "$metadata_file")" != "$recorded_metadata_sha" ]; then
    warn "Project work skill has user changes; leaving $target_dir untouched"
    exit 0
fi

rm -f "$skill_file" "$metadata_file" "$marker_file"
rmdir "$target_dir/agents" 2>/dev/null || true
rmdir "$target_dir" 2>/dev/null || true
echo "Removed the managed Project work skill from $target_dir" >&2
