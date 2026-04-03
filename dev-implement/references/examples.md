# Usage Examples

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
