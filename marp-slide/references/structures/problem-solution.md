# Problem-Solution Pattern (10-15 slides)

導入事例・課題解決型のプレゼン構造。**営業資料の定番パターン**。

## Structure

| # | Slide | Layout Class | Components |
|---|-------|--------------|------------|
| 1 | Cover | `cover` | - |
| 2 | Agenda | `agenda` | - |
| 3 | Problem Overview | `gradient-bg` | `lab-card` x 3 |
| 4-5 | Problem Details | `gradient-bg` or `two-col` | `lab-card` |
| 6 | Solution Overview | `gradient-bg` | `flow-container` |
| 7-8 | Solution Details | `gradient-bg` | `lab-card`, `lab-card accent` |
| 9 | Results - KPI | `gradient-bg` | `kpi-container`, `kpi-card` |
| 10 | Results - Comparison | `comparison` | `before`, `after` |
| 11 | Qualitative Results | `gradient-bg` | `lab-card` x 3 |
| 12 | Testimonial | `testimonial` | - |
| 13 | Summary | `lead` | - |
| 14 | Closing | `closing` | - |

## Alternative: Feature Grid with Sticky Notes

Slide 7-8 (Solution Details) で特徴を視覚的に見せたい場合:

| Layout Class | Components |
|--------------|------------|
| `gradient-bg` | `sticky-grid` + `sticky-note` (blue/yellow/pink/green) |

---

**→ Class & Component Examples: [design-guidelines.md](../design-guidelines.md#-examples-reference)**
