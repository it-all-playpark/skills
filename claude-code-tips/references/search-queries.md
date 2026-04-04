# Search Queries & Sources (Claude Code Tips Deep Dive)

## Category A: Hooks & Events

検索クエリ例:
- `"Claude Code" hooks PreToolUse PostToolUse pattern OR example (この2週間)`
- `"Claude Code" hooks "permissionDecision" OR "PermissionDenied" OR "Stop" advanced`
- `"Claude Code" hooks CI/CD OR headless OR automation site:github.com`
- `site:code.claude.com hooks`
- `"Claude Code" hooks site:x.com OR site:zenn.dev OR site:dev.to`
- `anthropics/claude-code hooks OR "hook" path:CHANGELOG`

## Category B: MCP Integration

検索クエリ例:
- `"Claude Code" MCP server setup OR configuration OR custom (この2週間)`
- `"Claude Code" MCP "scopedPermissions" OR transport OR stdio OR sse`
- `"Claude Code" MCP server 自作 OR build OR create site:github.com`
- `"mcpServers" "claude" settings.json example`
- `site:modelcontextprotocol.io server OR tutorial`
- `MCP server Claude Code production OR advanced`

## Category C: Performance & Cost

検索クエリ例:
- `"Claude Code" token optimization OR cost reduction OR performance (この2週間)`
- `"Claude Code" cache OR "prompt cache" OR "context window" optimization`
- `"Claude Code" model selection haiku OR sonnet OR opus strategy`
- `"Claude Code" slow OR fast OR speed OR latency tips`
- `"Claude Code" "compact" OR "context compression" OR token usage`
- `CLAUDE_CODE environment variable OR flag undocumented`

## Category D: Workflow & Automation

検索クエリ例:
- `"Claude Code" worktree parallel agent OR subagent (この2週間)`
- `"Claude Code" headless OR "-p" OR "--print" CI/CD pipeline`
- `"Claude Code" automation OR scripting OR batch advanced`
- `"Claude Code" Agent tool parallel OR concurrent workflow`
- `"Claude Code" git worktree isolation development`
- `"claude -p" OR "claude --print" automation script example`

## Category E: Harness Design

検索クエリ例:
- `CLAUDE.md design pattern OR structure OR architecture (この2週間)`
- `AGENTS.md design OR agent definition OR custom agent`
- `"Claude Code" settings.json "allowRules" OR "denyRules" OR permissions advanced`
- `"Claude Code" skills design OR create OR build`
- `"Claude Code" ".claude" directory structure OR configuration`
- `"Claude Code" "auto mode" permissions configuration tips`

## Category F: Undocumented & Advanced

検索クエリ例:
- `"Claude Code" undocumented OR hidden OR secret feature OR flag`
- `"Claude Code" environment variable CLAUDE_ OR CC_`
- `"Claude Code" internal OR edge case OR workaround`
- `anthropics/claude-code source code OR internals site:github.com`
- `"Claude Code" tips power user OR advanced OR expert (この2週間)`
- `"Claude Code" changelog unreleased OR upcoming OR experimental`

## 信頼できるソース（優先順）

| Tier | Sources | 判断基準 |
|------|---------|----------|
| 1 (公式) | code.claude.com/docs, github.com/anthropics/claude-code, anthropic.com/blog | 一次情報。CHANGELOG, Release Notes 含む |
| 2 (公式周辺) | ClaudeCodeLog (X), Anthropic 社員のポスト | 公式に準ずる速報性 |
| 3 (実践者) | GitHub repos の .claude/ 設定例, Zenn/dev.to の実装記事, HN threads | 実際に動作確認済みの設定・パターン |
| 4 (コミュニティ) | X/Twitter, Reddit, Discord, 個人ブログ | 要検証だが先端的な tips の宝庫 |

### ソース品質判定

- コード例・設定例がある記事 > 概念だけの記事
- before/after の計測値がある記事 > 「速くなった」だけの記事
- Tier 4 の情報は**コード例が含まれている場合のみ**採用（概念だけの Tier 4 は除外）
