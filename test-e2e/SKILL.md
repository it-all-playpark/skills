---
name: test-e2e
description: |
  Run end-to-end tests with browser automation.
  Use when: testing user flows, browser interactions, full stack testing.
  Accepts args: [target] [--headed] [--browser chrome|firefox|webkit]
---

# test-e2e

Run E2E tests with Playwright or Cypress.

## Execution

```bash
~/.claude/skills/test-e2e/scripts/test-e2e.sh [target] [--headed] [--browser BROWSER]
```

## Options

| Option | Description |
|--------|-------------|
| `target` | Test file or spec |
| `--headed` | Show browser window |
| `--browser` | chrome, firefox, webkit |

## Output

```json
{
  "status": "passed|failed",
  "framework": "playwright|cypress",
  "options": {"headed": false, "browser": "chrome"},
  "tests": {"passed": 10, "failed": 0}
}
```

## Detection

| Config File | Framework |
|-------------|-----------|
| playwright.config.* | Playwright |
| cypress.config.* | Cypress |

## Examples

```bash
scripts/test-e2e.sh
scripts/test-e2e.sh tests/e2e/login.spec.ts
scripts/test-e2e.sh --headed --browser chrome
```
