---
name: dev-implement
description: |
  Feature implementation with strategy selection and optional worktree isolation.
  Use when: implementing features, fixing bugs, refactoring code, building components.
  Accepts args: [feature] [--testing tdd|bdd] [--design ddd] [--type component|api|service]
    [--framework react|vue|express] [--worktree <path>] [--with-tests] [--safe]
model: sonnet
---

# Implement

Execute feature implementation with configurable strategy and context.

## Usage

```
/implement [feature] [options]
```

| Arg | Description |
|-----|-------------|
| feature | What to implement |
| --testing | Implementation approach: tdd (test-first, default), bdd (behavior-first) |
| --design | Design approach: ddd (domain modeling before implementation) |
| --type | component, api, service, feature |
| --framework | react, vue, express, etc. |
| --worktree | Path to worktree (for isolated development) |
| --with-tests | Include test generation |
| --safe | Extra validation gates |

## Two-Axis Strategy Model

Implementation uses two orthogonal axes:

| Axis | Purpose | Options | Default |
|------|---------|---------|---------|
| **Testing** (`--testing`) | How to implement code | `tdd` (test-first), `bdd` (behavior-first) | `tdd` |
| **Design** (`--design`) | How to design the solution | `ddd` (domain modeling) | none |

These are independent and composable:
- `--testing tdd` → Test-first implementation (default)
- `--testing bdd` → Behavior-spec-first implementation
- `--design ddd` → Add domain modeling phase before implementation
- `--testing tdd --design ddd` → Domain modeling → Test-first implementation

## Workflow

```
1. Context & Stack Detection → 2. Design (if --design) → 3. Plan → 4. Implement → 5. Validate → 6. Review
```

### Step 1: Context & Stack Detection

Detect from codebase or args:
- Framework/tech stack
- Existing patterns
- Project conventions (CLAUDE.md)

**Best practice loading**:
If invoked from dev-kickoff workflow (dev-issue-analyze already loaded best practices
into context), skip detect-stack.sh — the context already contains framework guidelines.

If invoked standalone (no prior dev-issue-analyze):
1. Run `$SKILLS_DIR/_lib/scripts/detect-stack.sh` to detect frameworks
2. For each detected skill in `rules_paths`, Read the corresponding SKILL.md

If `--worktree` provided, all operations within that path.

### Step 2: Design Phase (if --design ddd)

When `--design ddd` is specified, execute domain modeling BEFORE implementation:

```
1. Identify domain entities and value objects
2. Define aggregates and boundaries
3. Map domain relationships
4. Design domain → infrastructure layer mapping
```

This phase produces a domain model that guides the subsequent implementation.

### Step 3: Plan Implementation

**impl-plan.md Check**: If `$WORKTREE/.claude/impl-plan.md` exists (created by dev-plan-impl),
follow that plan instead of creating your own. Do not re-plan from scratch.
If the plan has a "Notes for Retry" section, address the feedback noted there.

**Evaluator Feedback (retry mode)**: On retry, read `kickoff.json` → `phases.6_evaluate.iterations[]`
for the latest feedback. The `feedback` array contains specific issues to address.
The `feedback_level` indicates whether the issues are design-level (re-plan needed)
or implementation-level (re-implement within existing plan).

If `impl-plan.md` does NOT exist (standalone invocation), plan as before:

**Skill-Aware Planning**: 実装計画時に、インストール済みスキルの中に 実装計画時に、インストール済みスキルの中に
タスクの一部または全部を処理できるものがないか確認する。
該当するスキルがあれば、手動実装より Skill 呼び出しを優先する。
複数スキルの組み合わせや、スキル + 手動コード変更の混在も可能。

スキル活用の判断基準:
- issue の内容がスキルの description に合致するか
- スキルの出力（ファイル変更）が issue の要件を満たすか
- 手動実装より効率的か

例:
- bounce率改善の issue → `Skill: blog-seo-improve --type bounce`
- 内部リンク不足の issue → `Skill: blog-internal-links --fix`
- クラスタ立ち上げ → `Skill: blog-cluster-launch "Claude Code"`
- 複合: SEO改善 + リンク追加 → 両スキルを順番に呼び出し

Based on `--testing` (default: tdd):

| Testing | Approach |
|---------|----------|
| tdd | Write tests first → Implement → Refactor |
| bdd | Define behavior specs → Implement → Verify |

Create TodoWrite items for tracking (>3 steps).

### Step 4: Implement

**Tool Selection by Type:**

| Type | Primary Tools |
|------|--------------|
| component | Read, Write, Edit |
| api | Read, Write, Edit, MultiEdit |
| service | Write, MultiEdit, Grep |
| feature | Task delegation for complex |

**Quality Gates:**
- Follow project conventions
- Maintain existing patterns
- Add error handling
- Include imports

### Step 5: Validate

- [ ] Todos completed
- [ ] No TODO comments in code
- [ ] Types correct (TypeScript)
- [ ] Imports resolved
- [ ] Tests pass (if --with-tests)

### Step 6: Review

If `--safe`:
- Security check on auth/data handling
- Input validation review
- Error handling coverage

## Testing Strategy Details

### TDD (default)
```
1. Write failing test
2. Implement minimum to pass
3. Refactor, keep tests green
```

### BDD
```
1. Define user scenarios
2. Implement to satisfy
3. Verify behavior
```

## Design Strategy Details

### DDD (opt-in via --design ddd)
```
1. Identify domain entities
2. Define aggregates
3. Implement domain → infrastructure
```

When combined with TDD (default): Domain model first → Write tests for domain entities → Implement → Refactor

## Examples

```bash
# Basic feature (TDD by default)
/implement user authentication

# React component with tests
/implement "profile card" --type component --framework react --with-tests

# API with TDD (explicit)
/implement "payment API" --type api --testing tdd --safe

# In worktree (from kickoff workflow)
/implement --testing bdd --worktree /path/to/worktree

# DDD + TDD: domain modeling then test-first implementation
/implement "order processing" --type service --design ddd

```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-implement success \
  --issue $ISSUE --duration-turns $TURNS --worktree $WORKTREE

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-implement failure \
  --issue $ISSUE --error-category <category> --error-msg "<message>" --worktree $WORKTREE
```

## Integration

- Receives context from `dev-issue-analyze` if in kickoff workflow
- Receives `WORKTREE_PATH` from `git-prepare` if worktree mode
- Passes to `dev-validate` skill for verification
- Reads `$WORKTREE/.claude/impl-plan.md` from `dev-plan-impl` if available
- Receives Evaluator feedback via kickoff.json iterations on retry
