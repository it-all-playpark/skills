# Search Queries & Sources (Codex CLI Tips Deep Dive)

## Category A: Config & Profiles

検索クエリ例:
- `"Codex CLI" config.toml profile OR sandbox_mode OR approval_policy (この2週間)`
- `"~/.codex/config.toml" example OR pattern site:github.com`
- `"codex" "model_provider" OR "wire_api" OR "base_url" configuration`
- `"openai/codex" config.toml path:CHANGELOG OR path:docs`
- `site:github.com/openai/codex config OR profile`
- `"Codex" "approval_policy" "on-failure" OR "untrusted" OR "never" tips`

## Category B: MCP Integration

検索クエリ例:
- `"Codex" "[[mcp_servers]]" OR "mcp_servers" config example (この2週間)`
- `"Codex CLI" MCP server stdio OR transport OR streamable_http`
- `"openai/codex" MCP "command" OR "args" OR "env" pattern`
- `Codex MCP server build OR self-host OR custom site:github.com`
- `site:modelcontextprotocol.io Codex OR OpenAI`
- `"Codex" "experimental_use_rmcp_client" OR rmcp tips`

## Category C: Performance & Cost

検索クエリ例:
- `"Codex CLI" "model_reasoning_effort" OR reasoning effort tips (この2週間)`
- `"Codex" model selection o3 OR o4-mini OR gpt-5 strategy`
- `"Codex" context window OR "compact" OR "/compact" tips`
- `"Codex" token usage OR cost reduction OR cache`
- `"Codex CLI" slow OR fast OR latency optimization`
- `OPENAI_API_KEY OR CODEX_ env variable performance`

## Category D: Workflow & Automation

検索クエリ例:
- `"codex exec" headless OR CI/CD OR automation example (この2週間)`
- `"Codex" "spawn_agent" OR "multi_agent" OR parallel agent`
- `"openai/codex-action" GitHub Action workflow example`
- `"Codex CLI" git worktree OR isolation OR sandbox`
- `"codex --json" OR "codex exec --output" scripting tip`
- `"Codex" GitHub Action review OR pr OR codereview`

## Category E: Plugins & Skills

検索クエリ例:
- `"Codex" plugin manifest OR plugin.json OR plugins directory (この2週間)`
- `"Codex" skills auto-discovery OR "activate_skill" OR skill tool`
- `"AGENTS.md" Codex OR OpenAI design pattern`
- `"Codex" subagent OR named agent OR worker explorer default`
- `site:github.com Codex plugin OR skill repository`
- `"~/.codex/plugins" OR "~/.codex/skills" structure`

## Category F: Undocumented & Advanced

検索クエリ例:
- `"Codex CLI" undocumented OR hidden OR experimental flag`
- `"Codex" environment variable CODEX_ OR OPENAI_`
- `"Codex" internal OR edge case OR workaround sandbox`
- `openai/codex source code OR internals site:github.com`
- `"Codex" tips power user OR advanced OR expert (この2週間)`
- `"openai/codex" CHANGELOG unreleased OR upcoming OR experimental`

## 信頼できるソース（優先順）

| Tier | Sources | 判断基準 |
|------|---------|----------|
| 1 (公式) | github.com/openai/codex, openai.com/blog, platform.openai.com/docs | 一次情報。CHANGELOG, Release Notes 含む |
| 2 (公式周辺) | OpenAI 社員のポスト (X), openai/codex メンテナの発信 | 公式に準ずる速報性 |
| 3 (実践者) | GitHub repos の `~/.codex/` 設定例, Zenn/dev.to/Qiita の実装記事, HN threads | 実際に動作確認済みの設定・パターン |
| 4 (コミュニティ) | X/Twitter, Reddit, Discord, 個人ブログ | 要検証だが先端的な tips の宝庫 |

### ソース品質判定

- TOML/CLI 例がある記事 > 概念だけの記事
- before/after の計測値がある記事 > 「速くなった」だけの記事
- Tier 4 の情報は**コード例が含まれている場合のみ**採用（概念だけの Tier 4 は除外）
- 同じ tip が Claude Code 向けに書かれているものをそのまま流用していないか確認（Codex は config 形式・サブエージェント API が異なるため）
