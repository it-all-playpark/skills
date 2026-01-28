---
name: plan-workflow
description: |
  Generate structured implementation workflows from PRDs and requirements.
  Use when: (1) planning implementation, (2) PRD breakdown, (3) project workflow,
  (4) keywords: workflow, plan, prd, roadmap, steps, phases
  Accepts args: [source] [--strategy systematic|agile] [--depth shallow|normal|deep]
---

# plan-workflow

Implementation workflow generation.

## Usage

```
/sc:workflow [source] [--strategy systematic|agile] [--depth shallow|normal|deep]
```

| Arg | Description |
|-----|-------------|
| source | PRD file or feature description |
| --strategy | Planning approach |
| --depth | Detail level |

## Strategies

| Strategy | Approach |
|----------|----------|
| systematic | Detailed phases, dependencies |
| agile | Iterative, MVP-focused |

## Workflow

1. **Parse** → Extract requirements from source
2. **Analyze** → Identify components, dependencies
3. **Structure** → Create phased plan
4. **Detail** → Add tasks per phase
5. **Output** → Generate workflow document

## Output

```markdown
## 📋 Workflow: [source]

### Overview
[High-level summary]

### Phases

#### Phase 1: [Name]
**Goal**: [Phase goal]
**Tasks**:
- [ ] Task 1
- [ ] Task 2

**Dependencies**: [None / Phase X]

#### Phase 2: [Name]
...

### Timeline
| Phase | Effort | Dependencies |
|-------|--------|--------------|
| 1 | Xd | None |
| 2 | Yd | Phase 1 |

### Risks
- [Identified risks]
```

## Examples

```bash
/sc:workflow docs/prd.md --strategy systematic
/sc:workflow "user authentication feature" --depth deep
/sc:workflow requirements.md --strategy agile
```
