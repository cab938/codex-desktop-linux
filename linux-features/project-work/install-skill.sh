#!/usr/bin/env bash
set -Eeuo pipefail

warn() {
    echo "WARN: $*" >&2
}

if [ -z "${CODEX_LINUX_FEATURES_DIR:-}" ]; then
    warn "CODEX_LINUX_FEATURES_DIR is not set; skipping Project work skill install"
    exit 0
fi

skill_source="$CODEX_LINUX_FEATURES_DIR/project-work/skills/project-work"
if [ ! -f "$skill_source/SKILL.md" ]; then
    warn "Project work skill source not found at $skill_source/SKILL.md; skipping skill install"
    exit 0
fi

codex_home="${CODEX_HOME:-}"
if [ -z "$codex_home" ]; then
    if [ -z "${HOME:-}" ]; then
        warn "CODEX_HOME is not set and HOME is unavailable; skipping Project work skill install"
        exit 0
    fi
    codex_home="$HOME/.codex"
fi

target_dir="$codex_home/skills/project-work"
marker_file="$target_dir/.codex-linux-project-work-managed"
skill_target="$target_dir/SKILL.md"
metadata_target="$target_dir/agents/openai.yaml"
skill_source_file="$skill_source/SKILL.md"
metadata_source_file="$skill_source/agents/openai.yaml"

file_sha256() {
    sha256sum "$1" | awk '{print $1}'
}

marker_value() {
    local key="$1"
    sed -n "s/^${key}=//p" "$marker_file" | head -n 1
}

if [ -f "$marker_file" ]; then
    recorded_skill_sha="$(marker_value skill-sha256)"
    recorded_metadata_sha="$(marker_value metadata-sha256)"
    if [ -z "$recorded_skill_sha" ] || [ -z "$recorded_metadata_sha" ] || \
        [ ! -f "$skill_target" ] || [ ! -f "$metadata_target" ] || \
        [ "$(file_sha256 "$skill_target")" != "$recorded_skill_sha" ] || \
        [ "$(file_sha256 "$metadata_target")" != "$recorded_metadata_sha" ]; then
        warn "Project work skill has user changes; leaving $target_dir untouched"
        exit 0
    fi
elif [ -e "$target_dir" ]; then
    # Adopt the marker-free layout written by early versions of this feature,
    # but never replace an unrelated skill that happens to use the same name.
    if [ ! -f "$skill_target" ] || [ ! -f "$metadata_target" ] || \
        ! cmp -s "$skill_source_file" "$skill_target" || \
        ! cmp -s "$metadata_source_file" "$metadata_target"; then
        warn "An unmanaged Project work skill already exists at $target_dir; leaving it untouched"
        exit 0
    fi
fi

if ! mkdir -p "$target_dir/agents"; then
    warn "Could not create Project work skill directory at $target_dir"
    exit 0
fi

install_if_changed() {
    local source_path="$1"
    local target_path="$2"
    if [ -f "$target_path" ] && cmp -s "$source_path" "$target_path"; then
        return 0
    fi
    install -m 0644 "$source_path" "$target_path"
}

if ! install_if_changed "$skill_source_file" "$skill_target"; then
    warn "Could not install Project work skill at $skill_target"
    exit 0
fi

if [ -f "$metadata_source_file" ]; then
    if ! install_if_changed "$metadata_source_file" "$metadata_target"; then
        warn "Could not install Project work skill metadata at $metadata_target"
        exit 0
    fi
fi

marker_temp="$(mktemp "$target_dir/.codex-linux-project-work-managed.XXXXXX")"
{
    echo "managed-by=codex-desktop-linux-project-work"
    echo "skill-sha256=$(file_sha256 "$skill_target")"
    echo "metadata-sha256=$(file_sha256 "$metadata_target")"
} >"$marker_temp"
chmod 0644 "$marker_temp"
mv -f "$marker_temp" "$marker_file"

echo "Installed Project work skill to $target_dir" >&2
