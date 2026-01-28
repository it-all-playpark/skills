---
name: doc-generate
description: |
  Generate focused documentation for components, functions, APIs.
  Use when: (1) documentation needed, (2) API docs, (3) code comments,
  (4) keywords: document, docs, readme, jsdoc, comment, explain
  Accepts args: [target] [--type inline|external|api|guide] [--style brief|detailed]
---

# doc-generate

Focused documentation generation.

## Usage

```
/sc:document [target] [--type inline|external|api|guide] [--style brief|detailed]
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
/sc:document src/api/ --type api --style detailed
/sc:document lib/utils.ts --type inline
/sc:document --type guide --style brief
```
