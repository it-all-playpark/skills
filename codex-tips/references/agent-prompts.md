# Agent Prompts

## Search Agent (model: haiku / sonnet)

Categories A-D は `model: "haiku"`、E-F は `model: "sonnet"` で起動する。

```
カテゴリ「{CATEGORY_NAME}」について、以下の検索クエリで WebSearch を実行してください。

検索クエリ:
{QUERIES}

日付範囲: {DATE_RANGE}

【重要】WebFetch は実行しない。WebSearch の結果のみを以下のフォーマットで返却すること。
要約・分析・評価は一切不要。検索結果の生データを構造化して返すだけ。

返却フォーマット（JSON）:
{
  "category": "{CATEGORY_ID}",
  "results": [
    {
      "title": "記事タイトル",
      "url": "https://...",
      "snippet": "検索結果のスニペット（そのまま）",
      "source_tier": 1-4,
      "has_code_example": true/false,
      "is_codex_specific": true/false
    }
  ]
}

source_tier の判定基準:
- 1: github.com/openai/codex, openai.com/blog, platform.openai.com/docs
- 2: OpenAI 社員のポスト, openai/codex メンテナの発信 (X)
- 3: GitHub repos, Zenn, dev.to, Qiita, HN threads（実装記事）
- 4: X/Twitter, Reddit, 個人ブログ（Tier 4 はコード例がある場合のみ含める）

is_codex_specific の判定:
- Codex CLI（OpenAI）に固有の内容なら true
- Claude Code 等の他ツールの記事を流用しただけのものは false（除外候補）
```

## Fetch Agent (model: haiku)

Step 4 の詳細取得用。URL リストを受け取り、WebFetch して生テキストを返す。

```
以下の URL リストに対して WebFetch を実行し、各ページの関連部分を抽出してください。

URL リスト:
{URLS}

【重要】分析・要約は不要。以下のフォーマットで生データを返すこと。

返却フォーマット:
## {URL}
**タイトル**: {ページタイトル}
**関連引用**:
{Codex CLI に関連する部分のみを引用。最大500語/URL}
**コードブロック**:
{TOML / bash / yaml の生コードブロックをそのまま}
```

## Fact Check Agent (model: opus)

```
以下の Codex CLI tips を公式ソースと照合し、正確性を検証してください。
検証対象: [Step 2-4 で収集した tips リスト]

検証方法:
- WebFetch で github.com/openai/codex の CHANGELOG.md / Releases を取得し、該当バージョン・機能の存在を確認
- WebFetch で github.com/openai/codex/tree/main/docs または README を取得し、設定キー・オプションの正確性を確認
- WebFetch で `codex --help` 相当のソース（CLI ヘルプの公開ドキュメント）と照合
- config.toml のキー名（`model_provider`, `sandbox_mode`, `approval_policy`, `[[mcp_servers]]` 等）が正確か照合
- バージョン要件がある場合、最低必要バージョン（例: codex >= X.Y.Z）を特定

各項目について以下を判定:
- 確認済み: 公式ソースで裏付けあり
- バージョン依存: 特定バージョン以降でのみ有効（バージョン番号を明記）
- experimental: `experimental_*` プレフィックス、または README で experimental と明記されているもの
- 未確認: 公式ソースで裏付けが取れないがコミュニティで報告あり
- 誤り: 公式ソースと矛盾（正しい情報を記載）

特に TOML 設定のキー名・構造、CLI フラグ名は1文字でも間違うと動作しないため、厳密に照合すること。
Claude Code の tips を Codex 向けと誤認しているケース（settings.json を config.toml に書き換えただけ等）も検出すること。
```

## Implementation Agent (model: opus)

```
以下の Codex CLI tips について、コピペで即座に使える実装例を構築してください。
対象: [Step 2-4 で見つかった tips リスト]

各 tip について:

1. **`~/.codex/config.toml` の設定例**（該当する場合）
   - 完全な TOML パス（どこに追加するか明確に: top-level / `[profiles.<name>]` / `[[mcp_servers]]` 等）
   - 必須キーと任意キーを区別
   - 実際の値の例（プレースホルダーではなく動くもの）
   - profile 切替が前提なら `codex --profile <name>` の使用例も併記

2. **CLI コマンド/headless スクリプト例**（該当する場合）
   - 環境変数の設定方法（fish / bash / zsh）
   - `codex exec` フラグの完全な使用例（`--json`, `--cd`, `--profile`, `--ask-for-approval`, `--sandbox` 等）
   - 出力のパース例（`jq` 連携など）

3. **GitHub Action / CI/CD workflow 例**（該当する場合）
   - `openai/codex-action` の YAML 例
   - secrets の設定（`OPENAI_API_KEY` 等）
   - 実用的な job 構成（PR review / nightly task 等）

4. **AGENTS.md / plugin.json / skills 設計例**（該当する場合）
   - 効果的な書き方のパターン
   - アンチパターン（やりがちだが効果がない書き方）
   - cross-platform（Claude Code/Codex 両対応）にする際の注意点

5. **組み合わせパターン**
   - 単体ではなく、他の設定と組み合わせると効果が高まるケース
   - 例: profile + sandbox_mode + MCP の連携、`codex exec --json` + GitHub Action の連携 等

概念の説明は最小限に。「この TOML を ~/.codex/config.toml に追加すると Y ができる」レベルの具体性で。
公式ドキュメント（github.com/openai/codex, openai.com/blog, platform.openai.com/docs）を最優先ソースとすること。
```
