# Output Template

```markdown
# Codex CLI Tips: YYYY-MM-DD

> 対象期間: YYYY-MM-DD 〜 YYYY-MM-DD
> Focus: all | config | mcp | performance | workflow | plugins | undocumented
> 収集件数: N 件（フィルタ後）

## Config & Profiles

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **設定例** (`~/.codex/config.toml`):
```toml
[profiles.dev]
model = "gpt-5"
sandbox_mode = "workspace-write"
approval_policy = "on-failure"
```
- **ユースケース**: どういう場面で使うか（具体的に）
- **注意点**: あれば（バージョン要件、experimental フラグ、既知の制限等）

---

## MCP Integration

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **設定例** (`~/.codex/config.toml`):
```toml
[[mcp_servers]]
name = "..."
command = "..."
args = [...]
```
- **ユースケース**: どういう場面で使うか

---

## Performance & Cost

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **Before/After**: 計測値があれば（トークン数、レスポンス時間、cost 等）
- **設定例 or コマンド例**:
```bash or toml
...
```
- **ユースケース**: 具体的な適用場面

---

## Workflow & Automation

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **コマンド例** (`codex exec` / GitHub Action 等):
```bash or yaml
codex exec --json --profile ci "..." | jq '.result'
```
- **ユースケース**: 具体的な適用場面

---

## Plugins & Skills

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **設定例** (`plugin.json` / `AGENTS.md` / skill 構造):
```json or md
...
```
- **ユースケース**: 具体的な適用場面
- **cross-platform**: Claude Code との互換性メモ（あれば）

---

## Undocumented & Advanced

### [Tip タイトル]
- **ソース**: [リンク](URL)
- **何ができるか**: 1行で結論
- **環境変数 / フラグ**:
```bash
export CODEX_...=...
codex --<flag>
```
- **検証方法**: 実機確認の手順

---

## Fact Check

| Tip | 判定 | 検証方法 |
|-----|------|----------|
| ... | 確認済み / experimental / バージョン依存 / 未確認 | CHANGELOG 照合 / `codex --help` / docs 照合 |

---

## Sources

収集に使用した全ソース URL のリスト（Tier 表記付き）。
- [T1] URL ...
- [T3] URL ...
```
