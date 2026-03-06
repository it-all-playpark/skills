# Review Sections

## Analysis Checklist

1. **Code Quality** - conventions, error handling, DRY, naming
2. **Security** - input validation, auth, injection, data exposure
3. **Architecture** - SOLID, separation of concerns, abstractions
4. **Testing** - coverage, missing cases, edge cases
5. **Performance** - N+1, unnecessary computations, memory leaks
6. **Documentation** - comments, API docs, README
7. **Best Practices** - framework-specific rules compliance (if applicable)

## Decision Criteria

| Findings | Decision |
|----------|----------|
| No issues or minor only | **LGTM** (approve) |
| Security vulnerabilities | **Request Changes** |
| Critical bugs | **Request Changes** |
| Major design issues | **Request Changes** |

## Output Format

```markdown
## PR #XXX レビュー結果

### 📋 概要
| 項目 | 内容 |
|------|------|
| **PR** | #XXX タイトル |
| **変更** | +N / -M (Xファイル) |
| **CI** | ✅ Pass / ❌ Fail |

### ✅ 判定: **LGTM** / **Request Changes**

[1-2 sentence summary]

### 🔍 詳細分析

#### コード品質
- [findings]

#### セキュリティ
- [findings]

#### テストカバレッジ
- [coverage stats and findings]

### 💡 改善提案（オプション）
| 優先度 | 項目 | 詳細 |
|--------|------|------|
| High/Medium/Low | ... | ... |

### 結論
[Final recommendation]
```
