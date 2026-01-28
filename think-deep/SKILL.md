---
name: think-deep
description: |
  Structured analysis with configurable depth levels.
  Use when: (1) complex analysis needed, (2) architectural decisions,
  (3) keywords: analyze, debug, design, investigate, understand deeply
  Accepts args: [topic] [--level think|think-hard|ultrathink] [--focus DOMAIN]
---

# think-deep

Multi-level structured analysis for complex problem solving.

## Usage

```
/sc:think [topic] [--level think|think-hard|ultrathink] [--focus DOMAIN]
```

| Arg | Description |
|-----|-------------|
| topic | Subject to analyze |
| --level | Analysis depth (default: think) |
| --focus | Domain focus (performance, security, quality, architecture) |

## Depth Levels

| Level | Tokens | MCP Servers | Use Case |
|-------|--------|-------------|----------|
| think | ~4K | Sequential | Multi-component analysis |
| think-hard | ~10K | Sequential + Context7 | Architectural analysis |
| ultrathink | ~32K | All MCP | Critical system redesign |

## Workflow by Level

### --think (Standard)
1. Decompose problem into components
2. Analyze each component systematically
3. Synthesize findings
4. Provide recommendations

### --think-hard (Deep)
1. All of --think, plus:
2. Cross-reference with documentation (Context7)
3. Examine dependencies and ripple effects
4. Consider edge cases and failure modes

### --ultrathink (Maximum)
1. All of --think-hard, plus:
2. Multi-perspective analysis
3. Historical context and evolution
4. Long-term implications
5. Alternative approaches comparison

## Output Format

```markdown
## 🔍 Analysis: [Topic]

### Problem Decomposition
- Component 1: [analysis]
- Component 2: [analysis]

### Key Findings
| Finding | Impact | Confidence |
|---------|--------|------------|
| ... | High/Med/Low | High/Med/Low |

### Recommendations
1. [Primary recommendation]
2. [Secondary recommendation]

### Trade-offs
| Option | Pros | Cons |
|--------|------|------|
| ... | ... | ... |
```

## Focus Domains

| Domain | Emphasis |
|--------|----------|
| performance | Speed, memory, scalability |
| security | Vulnerabilities, access, data |
| quality | Organization, maintainability |
| architecture | Structure, patterns, deps |
| accessibility | WCAG, user experience |
| testing | Coverage, edge cases |

See `~/.claude/skills/_lib/analysis-domains.md` for detailed criteria.

## Transparency Markers

Use these markers in analysis output:
- 🤔 Reasoning/consideration
- 🎯 Key insight/conclusion
- ⚡ Performance consideration
- 📊 Data/evidence
- 💡 Recommendation
- ⚠️ Warning/risk

## Examples

```
/sc:think "why is this API slow?"
→ Standard analysis of performance bottlenecks

/sc:think "authentication redesign" --level think-hard
→ Deep analysis with documentation reference

/sc:think "legacy system migration" --level ultrathink --focus architecture
→ Maximum depth architectural analysis
```

## Tool Integration

| Level | Tools Used |
|-------|-----------|
| think | Sequential MCP, native reasoning |
| think-hard | + Context7 MCP |
| ultrathink | + All MCP servers as needed |
