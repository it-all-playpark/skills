---
name: dev-cleanup
description: |
  Systematically clean up code, remove dead code, and optimize structure.
  Use when: (1) code maintenance, (2) dead code removal, (3) import cleanup,
  (4) keywords: cleanup, clean, remove unused, organize, refactor
  Accepts args: [target] [--type code|imports|files|all] [--safe] [--aggressive]
---

# dev-cleanup

Systematic code cleanup and dead code removal.

## Usage

```
/sc:cleanup [target] [--type code|imports|files|all] [--safe] [--aggressive]
```

| Arg | Description |
|-----|-------------|
| target | File, directory, or scope |
| --type | Cleanup type |
| --safe | Conservative, verify each change |
| --aggressive | Remove all detected dead code |

## Cleanup Types

| Type | Actions |
|------|---------|
| code | Dead code, unused variables, unreachable |
| imports | Unused imports, organize imports |
| files | Empty files, orphaned files |
| all | All cleanup types |

## Workflow

1. **Scan** → Identify cleanup opportunities
2. **Analyze** → Assess safety of each removal
3. **Plan** → Group changes by risk level
4. **Execute** → Apply changes (--safe = interactive)
5. **Verify** → Run tests/typecheck after

## Safety Levels

| Mode | Behavior |
|------|----------|
| --safe | Ask before each change |
| (default) | Remove obvious dead code |
| --aggressive | Remove all detected unused |

## Output

```markdown
## 🧹 Cleanup: [target]

### Removed
| Type | Count | Files |
|------|-------|-------|
| Unused imports | X | Y |
| Dead code | X | Y |
| Empty files | X | Y |

### Verification
- [ ] Tests pass
- [ ] Types check
```

## Examples

```bash
/sc:cleanup src/ --type imports
/sc:cleanup --type all --safe
/sc:cleanup lib/ --aggressive
```
