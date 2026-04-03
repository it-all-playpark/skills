# Two-Axis Strategy Model

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
