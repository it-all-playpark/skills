# Decomposition Guide

Reference document for file-boundary decomposition strategy in parallel subtask orchestration.

## File-Boundary Decomposition Strategy

The core principle is simple: each source file belongs to exactly one subtask. This guarantees that parallel implementation across worktrees will never produce merge conflicts at the file level.

### Why File Boundaries

- **Conflict-free merges** -- When each subtask owns distinct files, merging task branches into the integration branch produces no textual conflicts.
- **Clear ownership** -- Each developer (or agent) knows exactly which files they are responsible for.
- **Simple validation** -- Checking for file overlap is a trivial set-intersection operation.

### Building the Dependency Graph

Before grouping files, build a dependency graph:

1. Parse imports/requires in each affected file.
2. Identify which affected files reference other affected files.
3. Mark bidirectional (mutual) dependencies as "tightly coupled."
4. Mark unidirectional dependencies as "loosely coupled."

Tightly coupled files must stay in the same subtask. Loosely coupled files can be separated if the dependency flows through a contract interface.

## Good vs Bad Decomposition

### Good Decomposition

```
Issue: Add user authentication with JWT

Subtask 1: User model and database
  - src/models/user.ts
  - src/models/user.test.ts
  - src/db/migrations/add-users.ts
  Checklist:
    - Define User schema with email, password_hash, created_at
    - Add migration for users table

Subtask 2: Auth endpoints
  - src/routes/auth.ts
  - src/routes/auth.test.ts
  - src/middleware/jwt.ts
  - src/middleware/jwt.test.ts
  Checklist:
    - Implement POST /auth/login
    - Implement POST /auth/register
    - Add JWT verification middleware

Contract:
  - src/types/auth.ts (UserDTO, AuthRequest, AuthResponse, JWTPayload)
```

Why this is good:
- No file overlap between subtasks.
- Test files are co-located with their implementation.
- Shared types are extracted into the contract.
- Subtask 2 depends on subtask 1 (needs User model), expressed via `depends_on`.
- Each subtask has concrete, verifiable checklist items.

### Bad Decomposition

```
Issue: Add user authentication with JWT

Subtask 1: Backend logic
  - src/models/user.ts
  - src/routes/auth.ts      <-- OVERLAP
  - src/middleware/jwt.ts

Subtask 2: Tests and validation
  - src/routes/auth.ts      <-- OVERLAP (same file in two subtasks)
  - src/models/user.test.ts
  - src/routes/auth.test.ts
```

Why this is bad:
- `src/routes/auth.ts` appears in two subtasks, guaranteeing merge conflicts.
- Tests are separated from their implementation, losing context.
- No contract for shared types.
- Checklist items are missing.

### Another Bad Pattern: Over-Splitting

```
Subtask 1: src/models/user.ts
Subtask 2: src/models/user.test.ts
Subtask 3: src/routes/auth.ts
Subtask 4: src/routes/auth.test.ts
Subtask 5: src/middleware/jwt.ts
Subtask 6: src/middleware/jwt.test.ts
```

Why this is bad:
- Each test file is separated from its implementation.
- Six subtasks for what could be two creates unnecessary coordination overhead.
- No meaningful grouping by feature or responsibility.

## Edge Cases

### Tightly Coupled Files

When two files have mutual imports (A imports B, B imports A):

**Resolution:** Keep them in the same subtask. Mutual dependencies indicate they are part of the same logical unit and cannot be developed independently.

```
# Detected mutual dependency:
#   src/services/order.ts <--> src/services/inventory.ts

# Correct: group together
Subtask 1:
  - src/services/order.ts
  - src/services/order.test.ts
  - src/services/inventory.ts
  - src/services/inventory.test.ts
```

### Shared Utility Files

When a utility file is used by multiple subtasks:

**Resolution:** Move the utility changes to the contract branch if it defines interfaces or types. If it contains implementation logic, assign it to the subtask that modifies it most heavily, and have other subtasks treat it as read-only (already present from the contract branch).

```
# src/utils/validator.ts used by both subtask 1 and subtask 2

# Option A: changes are type-only -> contract
Contract:
  - src/utils/validator.ts (adds new validation type)

# Option B: implementation changes needed -> assign to primary subtask
Subtask 1 (primary owner):
  - src/utils/validator.ts
  - src/utils/validator.test.ts
Subtask 2 (consumes, does not modify):
  depends_on: [task1]
```

### Configuration Files

Files like `package.json`, `tsconfig.json`, or `.env`:

**Resolution:** If multiple subtasks need to modify the same config file (e.g., adding different dependencies to `package.json`), assign it to a single subtask and have others record their needed changes in their checklist. The integration step handles consolidation.

### Database Migrations

Migrations that must run in a specific order:

**Resolution:** Assign all migrations to a single subtask, or ensure the `depends_on` chain enforces the correct ordering. Migration files should never be split across independent (non-dependent) subtasks.

### Single Large File

When most changes concentrate in one large file:

**Resolution:** This file becomes its own subtask. If other files are simple enough, they can be grouped with it. This is a natural case where decomposition may yield fewer subtasks than expected.

## Contract Generation Guidelines

### When to Generate a Contract

Generate a contract when:
- Two or more subtasks share a type definition (DTO, interface, enum).
- Subtasks communicate through a defined API boundary (function signatures, event shapes).
- A new module introduces types consumed by existing code in other subtasks.

Do not generate a contract when:
- All affected files are in a single subtask (single-mode fallback).
- Changes are purely internal to each subtask with no shared types.
- The only shared dependency is an existing, unmodified library type.

### Contract Content

Contracts should contain only:
- Type/interface definitions
- Enum declarations
- Constants that define the API boundary
- Abstract class signatures (if applicable)

Contracts should not contain:
- Implementation logic
- Test code
- Configuration
- Business rules

### Contract File Naming

Place contract files where they naturally belong in the project structure:

```
# TypeScript/JavaScript
src/types/{feature}.ts
src/interfaces/{feature}.ts

# Python
src/{feature}/types.py
src/{feature}/interfaces.py

# Go
internal/{feature}/types.go
```

### Contract Commit Message

```
feat(contract): define shared types for issue #{N}

- Add {TypeA}, {TypeB} interfaces
- Define {EnumC} for subtask coordination
```

## When to Fall Back to Single Mode

Return `single_fallback` status when any of these conditions hold:

1. **One subtask** -- After grouping, only one subtask remains. Splitting is not beneficial.
2. **All files tightly coupled** -- The dependency graph shows that all affected files have mutual dependencies and cannot be separated.
3. **Fewer than 4 affected files** -- The overhead of contract branch, multiple worktrees, and flow.json is not justified for a small change set.
4. **Single-component change** -- All files belong to the same component with no natural boundary to split on.

In fallback mode, the caller should route to a standard `dev-kickoff` instead of parallel orchestration.

## Decomposition Checklist

Before finalizing the decomposition, verify:

- [ ] No file appears in more than one subtask
- [ ] Every test file is in the same subtask as its implementation file
- [ ] Shared types are in the contract, not in subtasks
- [ ] Every subtask has at least 1 checklist item
- [ ] `depends_on` references are valid subtask IDs
- [ ] Tightly coupled files are grouped together
- [ ] Contract branch name follows `feature/issue-{N}-contract` pattern
- [ ] Task branch names follow `feature/issue-{N}-taskN` pattern
- [ ] flow.json is valid JSON and passes schema validation
