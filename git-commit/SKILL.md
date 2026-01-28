---
name: git-commit
description: |
  Intelligent git commit with automatic change analysis, Conventional Commits format, and adaptive model selection.
  Use when: committing changes, creating commit messages, or when invoked via Skill tool.
  Features: analyzes staged changes, generates commit messages, auto-escalates to stronger models for complex changes.
  Accepts args: --all, --amend, --scope <scope>, --dry-run, --worktree <path>
---

# Smart Commit

Analyze staged changes and create Conventional Commits with adaptive model selection.

## Workflow

```
1. Parse args → 2. Analyze changes → 3. Select model → 4. Generate message → 5. Commit
```

## Step 1: Parse Args

| Arg | Effect |
|-----|--------|
| `--all` | Run `git add -A` before analyzing |
| `--amend` | Use `git commit --amend` (warn if pushed) |
| `--scope <name>` | Override auto-detected scope |
| `--dry-run` | Show message only, don't commit |
| `--worktree <path>` | Execute in specified worktree |

## Step 2: Analyze Changes

```bash
~/.claude/skills/commit/scripts/analyze-changes.sh [--worktree <path>]
```

**Output**: JSON with metrics, score (0-8), recommended model, suggested scope

## Step 3: Model Selection

| Score | Model | Reason |
|-------|-------|--------|
| 0-1 | self | Simple change |
| 2-4 | Task → sonnet | Moderate complexity |
| 5-8 | Task → opus | Complex analysis needed |

## Step 4: Conventional Commits

```
<type>(<scope>): <subject>

[optional body]
```

**Types**: feat, fix, refactor, docs, style, test, chore, perf, ci, build

**Rules**:
- Subject: imperative, lowercase, no period, ≤50 chars
- Body: wrap at 72 chars, explain "what" and "why"

## Step 5: Execute

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

<body>
EOF
)"
```

## Safety Rules

1. **--amend**: Verify commit not pushed (`git status` shows "ahead")
2. **Never commit**: `.env`, credentials, secrets
3. **Warn**: If on main/master branch
4. **Block**: If merge conflict markers detected

## Integration

Receives WORKTREE_PATH from `validate` skill.
Passes context to `create-pr` skill.
