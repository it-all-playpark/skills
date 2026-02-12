#!/usr/bin/env bash
# detect-and-install.sh - Auto-detect and install project dependencies
# Usage: detect-and-install.sh [--path <dir>] [--dry-run] [--skip-custom]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

# ============================================================================
# Args
# ============================================================================

TARGET_PATH=""
DRY_RUN=false
SKIP_CUSTOM=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --path) TARGET_PATH="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --skip-custom) SKIP_CUSTOM=true; shift ;;
        *) die_json "Unknown option: $1" 1 ;;
    esac
done

# Default to current directory
if [[ -z "$TARGET_PATH" ]]; then
    TARGET_PATH=$(pwd)
fi

# Resolve to absolute path
TARGET_PATH=$(cd "$TARGET_PATH" && pwd) || die_json "Path does not exist: $TARGET_PATH" 1

# ============================================================================
# Detection
# ============================================================================

detect_node_pm() {
    if [[ -f "$TARGET_PATH/pnpm-lock.yaml" ]]; then
        echo "pnpm"
    elif [[ -f "$TARGET_PATH/yarn.lock" ]]; then
        echo "yarn"
    elif [[ -f "$TARGET_PATH/bun.lockb" ]]; then
        echo "bun"
    elif [[ -f "$TARGET_PATH/package-lock.json" ]]; then
        echo "npm"
    elif [[ -f "$TARGET_PATH/package.json" ]]; then
        echo "npm-no-lock"
    else
        echo ""
    fi
}

detect_python_pm() {
    if [[ -f "$TARGET_PATH/Pipfile.lock" || -f "$TARGET_PATH/Pipfile" ]]; then
        echo "pipenv"
    elif [[ -f "$TARGET_PATH/pyproject.toml" ]]; then
        # Check for poetry or uv
        if grep -q '\[tool\.poetry\]' "$TARGET_PATH/pyproject.toml" 2>/dev/null; then
            echo "poetry"
        elif command -v uv &>/dev/null; then
            echo "uv"
        else
            echo "pip-pyproject"
        fi
    elif [[ -f "$TARGET_PATH/requirements.txt" ]]; then
        echo "pip"
    else
        echo ""
    fi
}

detect_other_pm() {
    local detected=()
    [[ -f "$TARGET_PATH/go.mod" ]] && detected+=("go")
    [[ -f "$TARGET_PATH/Gemfile" || -f "$TARGET_PATH/Gemfile.lock" ]] && detected+=("bundler")
    [[ -f "$TARGET_PATH/Cargo.toml" || -f "$TARGET_PATH/Cargo.lock" ]] && detected+=("cargo")
    [[ -f "$TARGET_PATH/composer.json" || -f "$TARGET_PATH/composer.lock" ]] && detected+=("composer")
    echo "${detected[*]:-}"
}

# ============================================================================
# Install Functions
# ============================================================================

install_node() {
    local pm="$1"
    local cmd=""
    local already_installed=false

    # Check if already installed
    if [[ -d "$TARGET_PATH/node_modules" ]]; then
        already_installed=true
    fi

    case "$pm" in
        pnpm)
            cmd="pnpm install --frozen-lockfile"
            ;;
        yarn)
            cmd="yarn install --frozen-lockfile"
            ;;
        bun)
            cmd="bun install --frozen-lockfile"
            ;;
        npm)
            cmd="npm ci"
            ;;
        npm-no-lock)
            cmd="npm install"
            ;;
    esac

    if [[ "$already_installed" == true ]]; then
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"already_installed\",\"command\":\"$cmd\"}"
        return 0
    fi

    if ! command -v "${pm%%-*}" &>/dev/null; then
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"pm_not_found\",\"command\":\"$cmd\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"dry_run\",\"command\":\"$cmd\"}"
        return 0
    fi

    if (cd "$TARGET_PATH" && eval "$cmd" 2>&1); then
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"installed\",\"command\":\"$cmd\"}"
    else
        echo "{\"ecosystem\":\"node\",\"pm\":\"$pm\",\"status\":\"failed\",\"command\":\"$cmd\"}"
        return 1
    fi
}

install_python() {
    local pm="$1"
    local cmd=""

    case "$pm" in
        pip)
            cmd="pip install -r requirements.txt"
            ;;
        pipenv)
            cmd="pipenv install"
            ;;
        poetry)
            cmd="poetry install"
            ;;
        uv)
            cmd="uv sync"
            ;;
        pip-pyproject)
            cmd="pip install -e ."
            ;;
    esac

    if ! command -v "${pm}" &>/dev/null 2>&1; then
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"pm_not_found\",\"command\":\"$cmd\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"dry_run\",\"command\":\"$cmd\"}"
        return 0
    fi

    if (cd "$TARGET_PATH" && eval "$cmd" 2>&1); then
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"installed\",\"command\":\"$cmd\"}"
    else
        echo "{\"ecosystem\":\"python\",\"pm\":\"$pm\",\"status\":\"failed\",\"command\":\"$cmd\"}"
        return 1
    fi
}

install_other() {
    local pm="$1"
    local cmd=""

    case "$pm" in
        go) cmd="go mod download" ;;
        bundler) cmd="bundle install" ;;
        cargo) cmd="cargo fetch" ;;
        composer) cmd="composer install" ;;
    esac

    if ! command -v "${pm}" &>/dev/null 2>&1; then
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"pm_not_found\",\"command\":\"$cmd\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"dry_run\",\"command\":\"$cmd\"}"
        return 0
    fi

    if (cd "$TARGET_PATH" && eval "$cmd" 2>&1); then
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"installed\",\"command\":\"$cmd\"}"
    else
        echo "{\"ecosystem\":\"$pm\",\"pm\":\"$pm\",\"status\":\"failed\",\"command\":\"$cmd\"}"
        return 1
    fi
}

# ============================================================================
# Custom Setup
# ============================================================================

run_custom_setup() {
    local setup_script="$TARGET_PATH/.claude/setup.sh"

    if [[ ! -f "$setup_script" ]]; then
        echo "{\"custom_setup\":\"not_found\"}"
        return 0
    fi

    if [[ "$SKIP_CUSTOM" == true ]]; then
        echo "{\"custom_setup\":\"skipped\"}"
        return 0
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "{\"custom_setup\":\"dry_run\",\"script\":\"$setup_script\"}"
        return 0
    fi

    if (cd "$TARGET_PATH" && bash "$setup_script" 2>&1); then
        echo "{\"custom_setup\":\"executed\",\"script\":\"$setup_script\"}"
    else
        warn "Custom setup script failed (non-blocking): $setup_script"
        echo "{\"custom_setup\":\"failed\",\"script\":\"$setup_script\"}"
    fi
}

# ============================================================================
# Main
# ============================================================================

RESULTS="[]"
OVERALL_STATUS="success"

# Detect and install Node.js dependencies
NODE_PM=$(detect_node_pm)
if [[ -n "$NODE_PM" ]]; then
    result=$(install_node "$NODE_PM" 2>/dev/null) || OVERALL_STATUS="partial"
    RESULTS=$(echo "$RESULTS" | jq --argjson r "$result" '. + [$r]')
fi

# Detect and install Python dependencies
PYTHON_PM=$(detect_python_pm)
if [[ -n "$PYTHON_PM" ]]; then
    result=$(install_python "$PYTHON_PM" 2>/dev/null) || OVERALL_STATUS="partial"
    RESULTS=$(echo "$RESULTS" | jq --argjson r "$result" '. + [$r]')
fi

# Detect and install other dependencies
OTHER_PMS=$(detect_other_pm)
if [[ -n "$OTHER_PMS" ]]; then
    for pm in $OTHER_PMS; do
        result=$(install_other "$pm" 2>/dev/null) || OVERALL_STATUS="partial"
        RESULTS=$(echo "$RESULTS" | jq --argjson r "$result" '. + [$r]')
    done
fi

# Run custom setup
CUSTOM_RESULT=$(run_custom_setup 2>/dev/null)

# Check if anything was detected
if [[ $(echo "$RESULTS" | jq 'length') -eq 0 ]]; then
    echo "{\"status\":\"no_dependencies\",\"path\":\"$TARGET_PATH\",\"results\":[],\"custom\":$CUSTOM_RESULT}"
    exit 0
fi

echo "{\"status\":\"$OVERALL_STATUS\",\"path\":\"$TARGET_PATH\",\"results\":$RESULTS,\"custom\":$CUSTOM_RESULT}"
