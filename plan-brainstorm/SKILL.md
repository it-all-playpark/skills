---
name: plan-brainstorm
description: |
  Interactive requirements discovery through Socratic dialogue.
  Use when: (1) vague project ideas, (2) requirements exploration,
  (3) keywords: brainstorm, explore, figure out, not sure, maybe, possibly
  Accepts args: [topic] [--depth shallow|normal|deep] [--parallel]
---

# plan-brainstorm

Collaborative discovery for transforming vague ideas into concrete specifications.

## Usage

```
/sc:brainstorm [topic] [--depth shallow|normal|deep] [--parallel]
```

| Arg | Description |
|-----|-------------|
| topic | Subject to explore |
| --depth | shallow (quick), normal (standard), deep (comprehensive) |
| --parallel | Enable multi-persona parallel exploration |

## Workflow

1. **Clarify** → Ask 3-5 probing questions about the topic
2. **Explore** → Use Socratic dialogue to uncover hidden requirements
3. **Analyze** → Synthesize insights into structured findings
4. **Specify** → Generate actionable requirement brief

## Behavioral Principles

- **Socratic Dialogue**: Question-driven, never presumptive
- **Non-Directive**: Let user guide discovery direction
- **Progressive**: Build understanding incrementally
- **Documented**: Synthesize into structured briefs

## Question Categories

| Category | Example Questions |
|----------|------------------|
| Problem | What problem does this solve? Who experiences it? |
| Users | Who are target users? What are their workflows? |
| Scope | What's in/out of scope? MVP vs full vision? |
| Technical | Existing systems? Integration requirements? |
| Constraints | Timeline? Budget? Team capabilities? |

## Output Format

```markdown
## 🤔 Discovery Questions
- [3-5 probing questions based on topic]

## 📊 Analysis
[Key insights from exploration]

## 📋 Requirement Brief
- **Problem**: [1-sentence problem statement]
- **Users**: [Target audience]
- **Scope**: [MVP scope]
- **Technical**: [Key technical requirements]
- **Constraints**: [Known constraints]

## ✅ Next Steps
[Recommended actions]
```

## Depth Levels

| Level | Questions | Analysis | Output |
|-------|-----------|----------|--------|
| shallow | 3 | Brief | Quick brief |
| normal | 5 | Standard | Full brief |
| deep | 7+ | Comprehensive | Detailed spec |

## Examples

```
/sc:brainstorm "AI-powered todo app"
→ Asks about target users, AI features, existing solutions

/sc:brainstorm "improve authentication" --depth deep
→ Deep dive into security requirements, UX, compliance

/sc:brainstorm "new feature ideas" --parallel
→ Multi-perspective exploration with different user personas
```

## Tool Integration

- **AskUserQuestion**: For structured multi-choice clarification
- **TodoWrite**: Track exploration progress on complex topics
- **Task/Explore**: Research existing patterns when relevant
