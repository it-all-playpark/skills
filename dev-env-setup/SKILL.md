---
name: dev-env-setup
description: |
  Auto-detect and install project dependencies after worktree creation.
  Use when: (1) worktree created but dependencies not installed, (2) node_modules missing,
  (3) setting up development environment, (4) keywords: env setup, install deps, npm install, worktree setup
  Accepts args: [--path <dir>] [--dry-run] [--skip-custom]
allowed-tools:
  - Bash
---

# dev-env-setup

Auto-detect project type and install dependencies for development environment.

## Usage

```
/dev-env-setup [--path <dir>] [--dry-run] [--skip-custom]
```

| Arg | Default | Description |
|-----|---------|-------------|
| `--path` | current dir | Target project directory |
| `--dry-run` | false | Show what would be installed without executing |
| `--skip-custom` | false | Skip .claude/setup.sh execution |

## Execution

```bash
$SKILLS_DIR/dev-env-setup/scripts/detect-and-install.sh [--path <dir>] [--dry-run] [--skip-custom]
```

**Output**: JSON with detected package manager, install status, and custom setup status.

## Detection Logic

### Package Manager Detection (Priority Order)

| Lockfile | Package Manager | Install Command |
|----------|----------------|-----------------|
| `pnpm-lock.yaml` | pnpm | `pnpm install --frozen-lockfile` |
| `yarn.lock` | yarn | `yarn install --frozen-lockfile` |
| `package-lock.json` | npm | `npm ci` |
| `bun.lockb` | bun | `bun install --frozen-lockfile` |
| `package.json` (no lock) | npm | `npm install` |

### Other Ecosystems

| Indicator | Ecosystem | Install Command |
|-----------|-----------|-----------------|
| `requirements.txt` | Python (pip) | `pip install -r requirements.txt` |
| `Pipfile.lock` | Python (pipenv) | `pipenv install` |
| `pyproject.toml` | Python (poetry/uv) | `poetry install` or `uv sync` |
| `go.mod` | Go | `go mod download` |
| `Gemfile.lock` | Ruby | `bundle install` |
| `Cargo.lock` | Rust | `cargo fetch` |
| `composer.lock` | PHP | `composer install` |

### Custom Setup

If `.claude/setup.sh` exists in the project root, execute it after dependency installation.
This enables project-specific setup (DB migrations, env generation, etc.).

## Workflow

```
1. Detect project type from lockfiles / config files
2. Check if dependencies already installed (node_modules exists, etc.)
3. If --dry-run: report what would be done and exit
4. Run install command
5. If .claude/setup.sh exists and --skip-custom not set: execute it
6. Report results
```

## Integration with git-prepare

After `git-prepare` creates a worktree, run dev-env-setup:

```bash
# In dev-kickoff Phase 1, after git-prepare completes:
$SKILLS_DIR/dev-env-setup/scripts/detect-and-install.sh --path $WORKTREE
```

## Error Handling

| Scenario | Action |
|----------|--------|
| No lockfile/config found | Report "no dependencies detected", exit 0 |
| Package manager not installed | Warn and skip (don't fail the workflow) |
| Install fails | Report error, exit 1 (caller decides to continue or abort) |
| Custom setup.sh fails | Warn but don't fail (non-blocking) |
| Already installed | Report "dependencies up to date", skip install |

## Examples

```bash
# Auto-detect in current directory
/dev-env-setup

# Specify worktree path
/dev-env-setup --path /path/to/worktree

# Preview only
/dev-env-setup --path /path/to/worktree --dry-run
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-env-setup success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-env-setup failure \
  --error-category <category> --error-msg "<message>"
```
