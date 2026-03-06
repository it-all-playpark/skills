# Error Categories

Classification taxonomy for skill execution failures.

## Categories

| Category | Description | Typical Errors | Affected Skills |
|----------|-------------|----------------|-----------------|
| `lint` | Code style / static analysis | ESLint, Prettier, Biome violations | dev-validate |
| `test` | Test execution failures | Jest, Vitest, Pytest assertion errors | dev-validate |
| `build` | Compilation / bundle errors | TypeScript tsc, webpack, esbuild failures | dev-validate, dev-build |
| `runtime` | Runtime execution errors | Node.js crashes, Python exceptions | dev-implement |
| `config` | Configuration issues | Missing config files, invalid settings | dev-kickoff |
| `env` | Environment setup issues | Missing deps, wrong Node version, .env missing | git-prepare, dev-kickoff |
| `merge` | Git merge conflicts | Branch conflicts, rebase failures | dev-integrate |
| `type-check` | Type system errors | TypeScript strict errors, mypy violations | dev-validate |

## Classification Decision Tree

```
Error occurred
├─ During git operation?
│   └─ YES → merge
├─ During npm install / pip install / dependency resolution?
│   └─ YES → env
├─ During tsc --noEmit / mypy / type checking only?
│   └─ YES → type-check
├─ During build / compile / bundle?
│   └─ YES → build
├─ During lint / format check?
│   └─ YES → lint
├─ During test execution?
│   └─ YES → test
├─ During actual code execution / startup?
│   └─ YES → runtime
└─ Configuration / setup / missing file?
    └─ YES → config
```

## Severity Mapping

| Category | Typical Severity | Blocking? |
|----------|-----------------|-----------|
| `env` | High | Yes - prevents all subsequent work |
| `build` | High | Yes - code cannot compile |
| `type-check` | High | Yes - type safety violated |
| `merge` | High | Yes - cannot integrate code |
| `test` | Medium | Partial - code works but tests fail |
| `lint` | Low | No - fixable with auto-format |
| `runtime` | Medium-High | Depends on scope |
| `config` | Medium | Usually fixable with correct values |

## Pattern Indicators

Use these patterns to auto-classify error messages:

```
lint:       /eslint|prettier|biome|stylelint|lint.*error/i
test:       /test.*fail|assert|expect.*to|FAIL.*test/i
build:      /build.*fail|compile.*error|esbuild|webpack.*error|vite.*error/i
runtime:    /Error:|TypeError:|ReferenceError:|ENOENT|EACCES|segfault/i
config:     /config.*not found|invalid.*config|missing.*setting/i
env:        /node_modules|ENOENT.*package|pip.*not found|command not found|version.*mismatch/i
merge:      /CONFLICT|merge.*fail|rebase.*conflict|cannot.*merge/i
type-check: /TS[0-9]+:|type.*error|mypy.*error|no.*overload/i
```
