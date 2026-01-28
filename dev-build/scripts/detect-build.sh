#!/usr/bin/env bash
# detect-build.sh - Detect build system and available commands

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../../_lib/common.sh"

DIR="${1:-.}"
cd "$DIR" || die_json "Cannot access directory: $DIR"

detect_package_manager() {
    if [[ -f "pnpm-lock.yaml" ]]; then echo "pnpm"
    elif [[ -f "yarn.lock" ]]; then echo "yarn"
    elif [[ -f "bun.lockb" ]]; then echo "bun"
    else echo "npm"
    fi
}

SYSTEM="" PKG_MANAGER="" BUILD_CMD="" DEV_CMD="" PROD_CMD="" TEST_CMD="" CLEAN_CMD=""
HAS_TYPECHECK="false"

if [[ -f "package.json" ]]; then
    SYSTEM="node"
    PKG_MANAGER=$(detect_package_manager)
    grep -q '"build"' package.json 2>/dev/null && BUILD_CMD="$PKG_MANAGER run build"
    grep -q '"dev"' package.json 2>/dev/null && DEV_CMD="$PKG_MANAGER run dev"
    grep -q '"start"' package.json 2>/dev/null && PROD_CMD="$PKG_MANAGER run start"
    grep -q '"test"' package.json 2>/dev/null && TEST_CMD="$PKG_MANAGER test"
    grep -q '"clean"' package.json 2>/dev/null && CLEAN_CMD="$PKG_MANAGER run clean"
    grep -q '"typecheck"' package.json 2>/dev/null && HAS_TYPECHECK="true"
elif [[ -f "Cargo.toml" ]]; then
    SYSTEM="rust" PKG_MANAGER="cargo"
    BUILD_CMD="cargo build" DEV_CMD="cargo run" PROD_CMD="cargo build --release"
    TEST_CMD="cargo test" CLEAN_CMD="cargo clean"
elif [[ -f "go.mod" ]]; then
    SYSTEM="go" PKG_MANAGER="go"
    BUILD_CMD="go build ./..." DEV_CMD="go run ." PROD_CMD="go build -ldflags='-s -w' ./..."
    TEST_CMD="go test ./..." CLEAN_CMD="go clean"
elif [[ -f "pyproject.toml" ]]; then
    SYSTEM="python"
    if [[ -f "poetry.lock" ]]; then
        PKG_MANAGER="poetry" BUILD_CMD="poetry build" TEST_CMD="poetry run pytest"
    elif [[ -f "uv.lock" ]]; then
        PKG_MANAGER="uv" BUILD_CMD="uv build" TEST_CMD="uv run pytest"
    else
        PKG_MANAGER="pip" BUILD_CMD="pip install -e ." TEST_CMD="pytest"
    fi
elif [[ -f "Makefile" ]]; then
    SYSTEM="make" PKG_MANAGER="make"
    grep -q "^build:" Makefile && BUILD_CMD="make build"
    grep -q "^dev:" Makefile && DEV_CMD="make dev"
    grep -q "^test:" Makefile && TEST_CMD="make test"
    grep -q "^clean:" Makefile && CLEAN_CMD="make clean"
elif [[ -f "build.gradle" ]] || [[ -f "build.gradle.kts" ]]; then
    SYSTEM="gradle" PKG_MANAGER="gradle"
    BUILD_CMD="./gradlew build" TEST_CMD="./gradlew test" CLEAN_CMD="./gradlew clean"
elif [[ -f "pom.xml" ]]; then
    SYSTEM="maven" PKG_MANAGER="mvn"
    BUILD_CMD="mvn package" TEST_CMD="mvn test" CLEAN_CMD="mvn clean"
else
    die_json "No recognized build system found in $(pwd)"
fi

cat <<JSONEOF
{
  "system": "$SYSTEM",
  "package_manager": "$PKG_MANAGER",
  "commands": {
    "build": $(json_str "$BUILD_CMD"),
    "dev": $(json_str "$DEV_CMD"),
    "prod": $(json_str "$PROD_CMD"),
    "test": $(json_str "$TEST_CMD"),
    "clean": $(json_str "$CLEAN_CMD")
  },
  "has_typecheck": $HAS_TYPECHECK,
  "directory": "$(pwd)"
}
JSONEOF
