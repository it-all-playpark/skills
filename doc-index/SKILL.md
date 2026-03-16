---
name: doc-index
description: |
  Generate comprehensive project documentation and knowledge base.
  Use when: (1) project documentation, (2) knowledge base generation,
  (3) keywords: index, document project, generate docs, readme, overview
  Accepts args: [target] [--type docs|api|structure|readme] [--format md|json]
---

# doc-index

Project documentation and knowledge base generation.

## Usage

```
/doc-index [target] [--type docs|api|structure|readme] [--format md|json]
```

| Arg | Description |
|-----|-------------|
| target | Scope to index |
| --type | Index type |
| --format | Output format |

## Index Types

| Type | Output |
|------|--------|
| docs | Full documentation |
| api | API reference |
| structure | Project structure overview |
| readme | README generation |

## Workflow

1. **Scan** → Analyze project structure
2. **Extract** → Gather documentation from code
3. **Organize** → Apply logical structure
4. **Generate** → Create documentation
5. **Cross-reference** → Add navigation links

## Output Location

Generated docs go to `claudedocs/` by default.

## Output

```markdown
## Index: [target]

### Project Structure
[Directory tree]

### Components
| Component | Description | Location |
|-----------|-------------|----------|
| ... | ... | ... |

### APIs
[Endpoint listing]

### Dependencies
[Key dependencies]
```

## Examples

```bash
/doc-index . --type structure
/doc-index src/api/ --type api --format md
/doc-index --type readme
```
