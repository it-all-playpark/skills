# Tech-Talk Pattern (10-15 slides)

技術発表・勉強会向け。

## Structure

| # | Slide | Layout Class | Components |
|---|-------|--------------|------------|
| 1 | Cover | `cover` | - |
| 2 | Agenda | `agenda` | - |
| 3 | Background/Context | `gradient-bg` | - |
| 4-5 | Problem Statement | `gradient-bg` | `lab-card` x 2 |
| 6-8 | Solution/Approach | `gradient-bg` or `two-col` | `lab-card accent`, `lab-card` (code) |
| 9-10 | Results/Demo | `gradient-bg` | `kpi-container`, `kpi-card` |
| 11-12 | Lessons Learned | `gradient-bg` | `lab-card accent` (Tips), `lab-card` (注意点) |
| 13 | Summary | `lead` | - |
| 14 | Next Steps | `gradient-bg` | - |
| 15 | Q&A / Closing | `closing` | - |

## Code Block Pattern

コードを含むスライドは `lab-card` で囲む:

```
<div class="lab-card">

コードブロック（```言語）

</div>
```

---

**→ Class & Component Examples: [design-guidelines.md](../design-guidelines.md#-examples-reference)**
