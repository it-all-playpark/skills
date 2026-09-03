# Product-Intro Pattern (8-12 slides)

プロダクト・サービス紹介向け。

## Structure

| # | Slide | Layout Class | Components |
|---|-------|--------------|------------|
| 1 | Cover | `cover` | - |
| 2 | What is X? | `gradient-bg` | - |
| 3 | Key Features | `gradient-bg` | `sticky-grid` + `sticky-note` (推奨) or `lab-card` x 3 |
| 4-6 | Feature Deep Dive | `gradient-bg` or `two-col` | `lab-card accent` |
| 7 | Use Cases | `gradient-bg` | `lab-card` x 3 |
| 8 | Getting Started | `gradient-bg` | `flow-container` |
| 9 | Comparison (optional) | `comparison` | `before`, `after` |
| 10 | Pricing / Availability | `gradient-bg` | - |
| 11 | Try It Now | `closing` | - |

## Recommended: Sticky Notes for Features

Slide 3 (Key Features) は `sticky-note` が視覚的に効果的:

```
sticky-grid three-col
├── sticky-note blue   → 主要機能
├── sticky-note yellow → 注目ポイント
└── sticky-note pink   → 差別化要素
```

---

**→ Class & Component Examples: [design-guidelines.md](../design-guidelines.md#-examples-reference)**
