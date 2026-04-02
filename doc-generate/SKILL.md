---
name: doc-generate
description: |
  Generate focused documentation for components, functions, APIs.
  Use when: (1) generating JSDoc/docstrings for existing code, (2) creating API reference docs from endpoints,
  (3) writing developer guides for modules, (4) keywords: document, docs, jsdoc, docstring, API reference, guide
  Accepts args: [target] [--type inline|external|api|guide] [--style brief|detailed]
---

# doc-generate

Focused documentation generation.

## Usage

```
/doc-generate [target] [--type inline|external|api|guide] [--style brief|detailed]
```

| Arg | Description |
|-----|-------------|
| target | What to document |
| --type | Documentation type |
| --style | Detail level |

## Documentation Types

| Type | Output |
|------|--------|
| inline | JSDoc/docstrings in code |
| external | Separate .md files |
| api | API reference documentation |
| guide | User/developer guide |

## Workflow

1. **Analyze** → Examine target structure
2. **Identify** → Documentation requirements
3. **Generate** → Create documentation
4. **Format** → Apply consistent style

## Style Levels

| Style | Description |
|-------|-------------|
| brief | Essential info only |
| detailed | Full examples, edge cases |

## Output

For --type api:
```markdown
## API: [target]

### Endpoints

#### `GET /path`
**Description**: ...
**Parameters**: ...
**Response**: ...
**Example**: ...
```

For --type inline:
```typescript
/**
 * [Description]
 * @param {Type} name - Description
 * @returns {Type} Description
 * @example
 * functionName(arg)
 */
```

## Examples

```bash
/doc-generate src/api/ --type api --style detailed
/doc-generate lib/utils.ts --type inline
/doc-generate --type guide --style brief
```

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log doc-generate success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log doc-generate failure \
  --error-category <category> --error-msg "<message>"
```
