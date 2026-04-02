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
/dev-cleanup [target] [--type code|imports|files|all] [--safe] [--aggressive]
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
/dev-cleanup src/ --type imports
/dev-cleanup --type all --safe
/dev-cleanup lib/ --aggressive
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-cleanup success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log dev-cleanup failure \
  --error-category <category> --error-msg "<message>"
```
