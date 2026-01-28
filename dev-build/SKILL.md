---
name: dev-build
description: |
  Build, compile, and package projects with error handling and optimization.
  Use when: (1) building projects, (2) compilation needed, (3) packaging artifacts,
  (4) keywords: build, compile, bundle, package, deploy prep
  Accepts args: [--type dev|prod|test] [--clean] [--optimize]
---

# dev-build

Build projects with auto-detection and optimization.

## Scripts

### detect-build.sh

Detect build system and available commands.

```bash
~/.claude/skills/dev-build/scripts/detect-build.sh [directory]
```

Output:
```json
{
  "system": "node|rust|go|python|make|gradle|maven",
  "package_manager": "npm|yarn|pnpm|cargo|go|...",
  "commands": {
    "build": "npm run build",
    "dev": "npm run dev",
    "prod": "npm run start",
    "test": "npm test",
    "clean": "npm run clean"
  }
}
```

### build.sh

Execute build with options.

```bash
~/.claude/skills/dev-build/scripts/build.sh [--type dev|prod|test] [--clean] [--optimize]
```

Output:
```json
{
  "status": "success|failed",
  "type": "dev|prod|test",
  "system": "node",
  "duration_seconds": 12,
  "output_size": "4.2M",
  "exit_code": 0
}
```

## Supported Systems

| File | System | Package Manager |
|------|--------|-----------------|
| package.json | node | npm/yarn/pnpm/bun |
| Cargo.toml | rust | cargo |
| go.mod | go | go |
| pyproject.toml | python | poetry/uv/pip |
| Makefile | make | make |
| build.gradle | gradle | gradle |
| pom.xml | maven | mvn |

## Examples

```bash
# Detect build system
scripts/detect-build.sh

# Development build
scripts/build.sh --type dev

# Production build with clean
scripts/build.sh --type prod --clean --optimize
```
