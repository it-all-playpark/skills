---
name: dev-lite
description: |
  Implements small GitHub issues with a lightweight Codex-first flow.
  Use when: (1) small bugfix, docs, test-only, or clearly scoped issue work,
  (2) avoiding full dev-flow cost, (3) keywords: dev-lite, lightweight issue, quick fix, issue潰し, 軽量実装
  Accepts args: <issue-number|description> [--base <branch>] [--pr] [--no-pr] [--depth minimal|standard]
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Skill
model: inherit
effort: medium
---

# Dev Lite

Lightweight Codex-first development flow for small, clearly scoped issues.

`dev-lite` is intentionally not a replacement for `dev-flow`. It skips planner/reviewer/evaluator loops and keeps the agent in the current conversation so weekly model budget is spent on implementation, not orchestration.

## Usage

```
/dev-lite <issue-number|description> [--base <branch>] [--pr] [--no-pr] [--depth minimal|standard]
```

## Args

| Arg | Default | Description |
|-----|---------|-------------|
| `<issue-number|description>` | required | GitHub issue number, issue URL, or a direct task description |
| `--base` | current branch | Base branch to compare against when validating the diff |
| `--pr` | false | Create a PR after implementation using `git-pr` when an issue number is available |
| `--no-pr` | true | Do not create a PR; report branch state and verification results |
| `--depth` | `minimal` | Issue analysis depth. Use `standard` only when the issue body is ambiguous |

## When To Use

Use `dev-lite` for:

- docs, comments, examples, config, tests, and small bugfixes
- issues with clear acceptance criteria and low blast radius
- changes expected to touch roughly 1-5 files
- quick issue burn-down where full `dev-flow` is too expensive

Use `dev-flow` instead when the work touches auth, permissions, crypto, migrations, public APIs, dependency policy, secrets, release automation, or broad architectural behavior.

## Workflow

```
1. Classify scope → 2. Gather focused context → 3. Implement minimal diff
→ 4. Run targeted checks → 5. Report or create PR
```

## Step 1: Classify Scope

If the input is an issue number or URL, fetch issue context with the cheapest useful mode:

```bash
$SKILLS_DIR/dev-issue-analyze/scripts/analyze-issue.sh <issue-number> --depth minimal
```

Escalate to `--depth standard` only if the title and labels are insufficient to identify the change. Do not use comprehensive analysis for `dev-lite`.

Before editing, quickly classify the request:

| Classification | Continue? | Rule |
|----------------|-----------|------|
| `lite` | yes | Low-risk, clear, small diff |
| `needs-clarification` | stop | Missing acceptance criteria where guessing changes behavior |
| `promote-to-dev-flow` | stop | Security, data, migration, public API, dependency, or large cross-module work |

If classification is not `lite`, report the reason and do not implement.

## Step 2: Gather Focused Context

Read only the files required to make the change. Prefer `rg` and `rg --files`; avoid broad repository scans unless targeted search fails.

Minimum context:

1. Current git status and branch
2. Relevant files and adjacent tests
3. Project test/lint commands from package metadata, Makefile, README, or existing CI config

Do not load `dev-flow` workflow internals unless the task is specifically about `dev-flow`.

## Step 3: Implement Minimal Diff

Make the smallest coherent change that satisfies the issue.

Rules:

- Preserve local style and existing helper APIs.
- Avoid opportunistic refactors.
- Do not add new dependencies unless the issue explicitly requires them.
- Do not weaken tests, validation, security checks, or type checks.
- Do not commit unless the user explicitly asks or `--pr` is used.
- Respect dirty worktrees: never revert unrelated user changes.

## Step 4: Run Targeted Checks

Run the narrowest useful checks first:

| Change Type | Preferred Checks |
|-------------|------------------|
| docs only | markdown/link/build check if present; otherwise no-op with explanation |
| shell scripts | adjacent bats test, then `bash -n` |
| JS/TS | targeted test, typecheck, lint if cheap |
| Python | targeted test, import/type/lint command if present |
| config/CI | syntax validation and relevant dry run where available |

If no targeted check exists, run the smallest relevant project-level check. If checks are too expensive or unavailable, say exactly what was skipped and why.

## Step 5: Report Or PR

If `--pr` is not set, finish with:

- changed files
- verification commands and results
- any residual risk
- next command if the user wants a PR

If `--pr` is set and an issue number is available:

1. Use `Skill: git-commit` with an appropriate scope.
2. Use `Skill: git-pr <issue-number> --base <branch> --lang ja`.
3. Keep the PR body concise and Japanese, following `git-pr` rules.

Do not run `pr-iterate` from `dev-lite`. If review/fix looping is needed, hand off explicitly to `pr-iterate` or `dev-flow`.

## Guardrails

Stop and recommend `dev-flow` for:

- auth, authorization, cryptography, secret handling, or exec/deserialization sinks
- schema or data migrations
- public API changes or breaking behavior
- dependency additions or upgrades
- changes that need multi-stage planning or cross-package coordination
- more than one failed implementation attempt

After one failed targeted fix, either ask for clarification or recommend `dev-flow`; do not create an implicit review loop.

## Journal Logging

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-lite success \
  --issue <issue-number-or-empty> --duration-turns <turns>

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-lite failure \
  --issue <issue-number-or-empty> --error-category <category> --error-msg "<message>"
```

Journal logging is best effort. Do not fail the implementation solely because journal logging is unavailable.

## References

- [dev-issue-analyze](../dev-issue-analyze/SKILL.md) - cheap issue context fetch
- [git-commit](../git-commit/SKILL.md) - optional commit step
- [git-pr](../git-pr/SKILL.md) - optional PR creation
- [Skill Creation Guide](../docs/skill-creation-guide.md) - repository skill conventions
