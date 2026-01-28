---
name: idea-to-document
description: |
  Transform raw ideas, memos, code snippets, repo exports into structured documents.
  Use when: (1) converting unstructured content to organized documentation,
  (2) keywords like "ドキュメント化", "文書化", "記事化", "document from", "structured doc",
  (3) user has a markdown file (repo-export, memo, idea, code snippet) and wants structured output.
  Supports types: case-study, tech-tip, howto, tutorial.
user-invocable: true
---

# Idea to Document

Transform unstructured content into structured documents.

## Usage

```
/idea-to-document <source-file> [--type X] [--date YYYY-MM-DD] [--output path]
```

## Workflow

```
[1] Detect type
    bash scripts/detect_type.sh <source> → JSON {recommended, scores}
    Use --type if provided, otherwise use recommended

[2] Extract content (based on source type from references/types.json)
    - repo-export: project_name, description, features, tech_stack
    - memo: problem, solution, insights, context
    - code: technologies, patterns, integrations

[3] Generate document
    Apply template from references/document-patterns.md
    - case-study: Business outcomes, metrics, Before/After
    - tech-tip: Code examples, implementation steps
    - howto: Step-by-step instructions
    - tutorial: Learning-focused, beginner-friendly

[4] Output
    Display or write to --output path
```

## Scripts

| Script | Input | Output |
|--------|-------|--------|
| `detect_type.sh <file>` | Source MD | `{recommended, scores}` |

## References

- `references/types.json` - Type definitions & keywords
- `references/document-patterns.md` - Output templates by type

## Examples

```bash
/idea-to-document ~/exports/my-project.md
/idea-to-document ./notes.md --type case-study
/idea-to-document ./idea.md --output ./docs/article.md
```
