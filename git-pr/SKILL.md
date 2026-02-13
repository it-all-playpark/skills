---
name: git-pr
description: |
  Create GitHub Pull Request from worktree with structured description.
  Use when: creating PR after implementation, pushing changes to remote.
  Accepts args: <issue-number> [--base <branch>] [--draft] [--worktree <path>] [--lang ja|en]
allowed-tools:
  - Bash
  - Skill
---

# Create PR

Push changes and create GitHub Pull Request from worktree.

## Workflow

```
1. Stage & commit (via commit skill) → 2. Push to remote → 3. Create PR → 4. Report
```

## Execution

### Step 1: Commit (if needed)

```
Skill(skill: "commit", args: "--all --worktree <path>")
```

### Step 2: Push

```bash
git push -u origin "$BRANCH_NAME"
```

### Step 3: Create PR

```bash
$SKILLS_DIR/create-pr/scripts/create-pr.sh <issue-number> [options]
```

**Output**: JSON with `pr_url`, `title`, `branch`, `base`, `worktree`

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `<issue-number>` | required | Related GitHub issue |
| `--base` | `dev` | Base branch for PR |
| `--draft` | false | Create as draft PR |
| `--title` | auto | Override PR title |
| `--lang` | `ja` | PR body language (ja/en) |
| `--worktree` | cwd | Worktree path |

## PR Title Prefix (Auto)

| Label | Prefix |
|-------|--------|
| `bug` | 🐛 fix: |
| `enhancement` | ✨ feat: |
| `refactor` | ♻️ refactor: |
| `docs` | 📝 docs: |
| default | ✨ |

## Output Format

```
================================================================================
✅ PR Created
================================================================================
📎 URL: https://github.com/org/repo/pull/XXX
🌳 Branch: feature/issue-XXX-m → dev
🎯 Issue: #XXX
📂 Worktree: $WORKTREE_PATH

================================================================================
📋 To continue working in this worktree:
================================================================================

cd $WORKTREE_PATH

================================================================================
```

**CRITICAL**: Always display `cd` command for worktree navigation.
