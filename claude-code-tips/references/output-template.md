# Output Template

```markdown
# Claude Code Tips: YYYY-MM-DD

> 対象期間: YYYY-MM-DD 〜 YYYY-MM-DD
> Focus: all | hooks | mcp | performance | workflow | settings
> 収集件数: N 件（フィルタ後）

## Hooks & Events

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **設定例**:
```json
{ ... }
```
- **ユースケース**: どういう場面で使うか（具体的に）
- **注意点**: あれば（バージョン要件、既知の制限等）

---

## MCP Integration

(同フォーマット)

---

## Performance & Cost

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **Before/After**: 計測値があれば（トークン数、レスポンス時間等）
- **設定例 or コマンド例**:
```bash or json
...
```
- **ユースケース**: 具体的な適用場面

---

## Workflow & Automation

(同フォーマット)

---

## Harness Design

(同フォーマット)

---

## Undocumented & Advanced

(同フォーマット)

---

## Fact Check

| Tip | 判定 | 検証方法 |
|-----|------|----------|
| ... | 確認済み / 未確認 / バージョン依存 | CHANGELOG 照合 / 実機確認 / ドキュメント照合 |

---

## Sources

収集に使用した全ソース URL のリスト（Tier 表記付き）。
- [T1] URL ...
- [T3] URL ...
```
