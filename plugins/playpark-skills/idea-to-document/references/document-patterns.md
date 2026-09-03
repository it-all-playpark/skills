# Document Patterns by Type

Detailed structure patterns for each document type.

## case-study

Business-focused content emphasizing outcomes and metrics.

```markdown
---
title: "【{Domain}】{Solution} - {Key Metric}"
type: case-study
tags: [domain, technology, outcome]
summary: "How {solution} achieved {metric improvement} for {context}."
---

# {Title}

{Hook: Relatable problem with light context}

## 背景・課題

{Industry/company context}

### 1. {Challenge Name}

{Specific pain point with numbers}

### 2. {Challenge Name}

{Another challenge}

## 解決策

{One-sentence solution summary}

### 主要機能

| 機能 | 効果 |
|------|------|
| **{Feature}** | {Business benefit} |

## 成果・効果

### 定量的な成果

| 指標 | Before | After | 改善率 |
|------|--------|-------|--------|
| {Metric} | {value} | {value} | **{X%}削減** |

### 定性的な成果

- **{Category}**: {Improvement}

## 技術構成

| 項目 | 採用技術 |
|------|----------|
| {Layer} | {Technology} |

## まとめ

{Key achievement with bold metric}

{Takeaway for readers with similar challenges}
```

## tech-tip

Code-focused content with practical examples.

```markdown
---
title: "【{Technology}】{Topic} - {Benefit}"
type: tech-tip
tags: [technology, pattern, use-case]
summary: "Learn how to {action} with {technology} for {benefit}."
---

# {Title}

{Problem statement or use case}

## この記事で学べること

- {Learning point 1}
- {Learning point 2}

## 前提条件

- {Requirement}

## 実装方法

### {Step 1}

{Explanation}

\`\`\`{language}
{Code}
\`\`\`

### {Step 2}

{More code with explanation}

## 動作確認

{Verification steps}

## 注意点・Tips

- **{Tip}**: {Detail}

## まとめ

{Summary of what was covered}
```

## howto

Step-by-step instructional content.

```markdown
---
title: "【{Topic}】{Goal}の方法"
type: howto
tags: [topic, process, tool]
summary: "Step-by-step guide to {achieve goal}."
---

# {Title}

{What reader will achieve}

## 概要

{Brief process overview}

## 準備するもの

| 項目 | 詳細 |
|------|------|
| {Item} | {Description} |

## 手順

### Step 1: {Action}

{Instructions with details}

### Step 2: {Action}

{Continue steps}

## よくある質問

### Q: {Question}?

{Answer}

## まとめ

{Summary and next steps}
```

## tutorial

Learning-focused content for beginners.

```markdown
---
title: "【入門】{Topic}の基礎"
type: tutorial
tags: [beginner, topic, fundamentals]
summary: "Introduction to {topic} for beginners."
---

# {Title}

{Why this topic matters}

## 対象読者

- {Target audience description}

## 前提知識

- {What reader should already know}

## {Topic}とは

{Clear definition and context}

## 基本概念

### {Concept 1}

{Explanation with simple example}

### {Concept 2}

{Build on previous concept}

## 実践してみよう

{Hands-on exercise}

## よくある間違い

- **{Mistake}**: {How to avoid}

## 次のステップ

{Where to go from here}

## まとめ

{Key takeaways for beginners}
```

## Writing Guidelines

### Tone

- Professional but approachable
- Light humor in parentheses where natural
- Relatable problem framing
- No marketing superlatives

### Formatting

- **Bold** for key metrics and terms
- Tables for scannable comparisons
- 3-5 items per list (not exhaustive)
- Short paragraphs (2-3 sentences)

### Metrics Format

| Type | Format |
|------|--------|
| Time reduction | "2時間 → 5分（**96%削減**）" |
| Error elimination | "月3件 → 0件（**100%解消**）" |
| Speed improvement | "3日 → 即時（**即時化**）" |
| Rate increase | "20% → 70%（**3.5倍向上**）" |
