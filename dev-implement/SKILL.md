---
name: dev-implement
description: |
  Feature implementation with strategy selection and optional worktree isolation.
  Use when: implementing features, fixing bugs, refactoring code, building components.
  Accepts args: [feature] [--strategy tdd|bdd|ddd] [--type component|api|service]
    [--framework react|vue|express] [--worktree <path>] [--with-tests] [--safe]
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
| --strategy | tdd (test-first), bdd (behavior-first), ddd (domain-first) |
| --type | component, api, service, feature |
| --framework | react, vue, express, etc. |
| --worktree | Path to worktree (for isolated development) |
| --with-tests | Include test generation |
| --safe | Extra validation gates |

## Workflow

```
1. Context Detection → 2. Plan → 3. Implement → 4. Validate → 5. Review
```

### Step 1: Context Detection

Detect from codebase or args:
- Framework/tech stack
- Existing patterns
- Project conventions (CLAUDE.md)

If `--worktree` provided, all operations within that path.

### Step 2: Plan Implementation

Based on `--strategy` (default: context-appropriate):

| Strategy | Approach |
|----------|----------|
| tdd | Write tests first → Implement → Refactor |
| bdd | Define behavior specs → Implement → Verify |
| ddd | Model domain → Implement entities → Infrastructure |

Create TodoWrite items for tracking (>3 steps).

### Step 3: Implement

**Tool Selection by Type:**

| Type | Primary Tools |
|------|--------------|
| component | Magic MCP (UI), Write, Edit |
| api | Write, Edit, MultiEdit |
| service | Write, MultiEdit, morphllm |
| feature | Task delegation for complex |

**Quality Gates:**
- Follow project conventions
- Maintain existing patterns
- Add error handling
- Include imports

### Step 4: Validate

- [ ] Todos completed
- [ ] No TODO comments in code
- [ ] Types correct (TypeScript)
- [ ] Imports resolved
- [ ] Tests pass (if --with-tests)

### Step 5: Review

If `--safe`:
- Security check on auth/data handling
- Input validation review
- Error handling coverage

## Strategy Details

### TDD
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

### DDD
```
1. Identify domain entities
2. Define aggregates
3. Implement domain → infrastructure
```

## MCP Integration

| MCP | When Used |
|-----|-----------|
| Context7 | Framework patterns, official docs |
| Magic | UI components (--type component) |
| morphllm | Bulk edits, pattern application |
| Sequential | Complex multi-step planning |

## Examples

```bash
# Basic feature
/implement user authentication

# React component with tests
/implement "profile card" --type component --framework react --with-tests

# API with TDD
/implement "payment API" --type api --strategy tdd --safe

# In worktree (from kickoff workflow)
/implement --strategy bdd --worktree /path/to/worktree

# DDD service
/implement "order processing" --type service --strategy ddd
```

## Integration

- Receives context from `dev-issue-analyze` if in kickoff workflow
- Receives `WORKTREE_PATH` from `git-prepare` if worktree mode
- Passes to `dev-validate` skill for verification
