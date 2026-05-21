# SKILL.md Portability Audit — 2026-05-21T08:42:26Z

## Scope

- Total SKILL.md files scanned: **102**
- Repo root: `/Users/naramotoyuuji/ghq/github.com/it-all-playpark/skills`

## Claude Code 拡張 frontmatter 使用頻度

| Field | Count | % | Portable? |
|---|---|---|---|
| `allowed-tools` | 26 | 25% | ❌ (Claude 拡張) |
| `model` | 39 | 38% | ❌ (Claude 拡張) |
| `effort` | 24 | 24% | ❌ (Claude 拡張) |
| `context` | 21 | 21% | ❌ (Claude 拡張) |
| `agent` | 0 | 0% | ❌ (Claude 拡張) |
| `hooks` | 0 | 0% | ❌ (Claude 拡張) |
| `disable-model-invocation` | 0 | 0% | ❌ (Claude 拡張) |
| `user-invocable` | 12 | 12% | ❌ (Claude 拡張) |
| `argument-hint` | 2 | 2% | ❌ (Claude 拡張) |
| `arguments` | 0 | 0% | ❌ (Claude 拡張) |
| `paths` | 0 | 0% | ❌ (Claude 拡張) |
| `shell` | 0 | 0% | ❌ (Claude 拡張) |

## 各 field を使ってる skill 一覧

### `allowed-tools` (26 skills)


  - .agents/skills/agent-browser/SKILL.md
  - .agents/skills/playwright-cli/SKILL.md
  - .agents/skills/rust-best-practices/SKILL.md
  - bug-hunt/SKILL.md
  - code-audit-team/SKILL.md
  - dep-guardian/SKILL.md
  - dev-decompose/SKILL.md
  - dev-env-setup/SKILL.md
  - dev-evaluate/SKILL.md
  - dev-flow-doctor/SKILL.md
  - dev-flow/SKILL.md
  - dev-integrate/SKILL.md
  - dev-kickoff/SKILL.md
  - dev-plan-impl/SKILL.md
  - dev-plan-review/SKILL.md
  - git-pr/SKILL.md
  - github-issue-orchestrator/SKILL.md
  - incident-response/SKILL.md
  - night-patrol/SKILL.md
  - pr-fix/SKILL.md
  - pr-iterate/SKILL.md
  - pr-review/SKILL.md
  - skill-creator/SKILL.md
  - skill-retrospective/SKILL.md
  - sync-env/SKILL.md
  - yt-chorus-extract/SKILL.md

### `model` (39 skills)


  - blog-cross-post/SKILL.md
  - blog-fact-check/SKILL.md
  - blog-internal-links/SKILL.md
  - blog-mv-date/SKILL.md
  - blog-schedule-overview/SKILL.md
  - blog-seo-improve/SKILL.md
  - blog-swap-dates/SKILL.md
  - bug-hunt/SKILL.md
  - claude-zombie-kill/SKILL.md
  - code-audit-team/SKILL.md
  - cross-post-publish/SKILL.md
  - dev-decompose/SKILL.md
  - dev-evaluate/SKILL.md
  - dev-implement/SKILL.md
  - dev-plan-impl/SKILL.md
  - dev-plan-review/SKILL.md
  - dev-validate/SKILL.md
  - doc-generate/SKILL.md
  - generate-thumbnail/SKILL.md
  - get-publish-date/SKILL.md
  - github-issue-orchestrator/SKILL.md
  - image-convert/SKILL.md
  - image-remove-bg/SKILL.md
  - image-resize/SKILL.md
  - incident-response/SKILL.md
  - night-patrol/SKILL.md
  - pr-review/SKILL.md
  - qiita-publish/SKILL.md
  - repo-commit/SKILL.md
  - repo-export/SKILL.md
  - repo-issue/SKILL.md
  - repo-pr/SKILL.md
  - seed-refresh/SKILL.md
  - seo-strategy/SKILL.md
  - skill-creator/SKILL.md
  - skill-retrospective/SKILL.md
  - sns-announce/SKILL.md
  - suica-to-csv/SKILL.md
  - zenn-publish/SKILL.md

### `effort` (24 skills)


  - blog-schedule-overview/SKILL.md
  - bug-hunt/SKILL.md
  - claude-zombie-kill/SKILL.md
  - code-audit-team/SKILL.md
  - dev-decompose/SKILL.md
  - dev-evaluate/SKILL.md
  - dev-plan-impl/SKILL.md
  - dev-plan-review/SKILL.md
  - dev-validate/SKILL.md
  - get-publish-date/SKILL.md
  - github-issue-orchestrator/SKILL.md
  - image-convert/SKILL.md
  - image-resize/SKILL.md
  - incident-response/SKILL.md
  - night-patrol/SKILL.md
  - pr-review/SKILL.md
  - repo-commit/SKILL.md
  - repo-export/SKILL.md
  - repo-issue/SKILL.md
  - repo-pr/SKILL.md
  - seo-strategy/SKILL.md
  - skill-creator/SKILL.md
  - skill-retrospective/SKILL.md
  - suica-to-csv/SKILL.md

### `context` (21 skills)


  - blog-cross-post/SKILL.md
  - blog-fact-check/SKILL.md
  - blog-internal-links/SKILL.md
  - blog-mv-date/SKILL.md
  - blog-seo-improve/SKILL.md
  - blog-swap-dates/SKILL.md
  - cross-post-publish/SKILL.md
  - dev-evaluate/SKILL.md
  - dev-plan-impl/SKILL.md
  - dev-plan-review/SKILL.md
  - doc-generate/SKILL.md
  - generate-thumbnail/SKILL.md
  - image-remove-bg/SKILL.md
  - pr-review/SKILL.md
  - qiita-publish/SKILL.md
  - repo-commit/SKILL.md
  - repo-export/SKILL.md
  - repo-issue/SKILL.md
  - repo-pr/SKILL.md
  - sns-announce/SKILL.md
  - zenn-publish/SKILL.md

### `user-invocable` (12 skills)


  - .agents/skills/youtube-channels/SKILL.md
  - blog-cross-post/SKILL.md
  - blog-mv-date/SKILL.md
  - blog-swap-dates/SKILL.md
  - cross-post-publish/SKILL.md
  - generate-thumbnail/SKILL.md
  - get-publish-date/SKILL.md
  - idea-to-document/SKILL.md
  - marp-slide/SKILL.md
  - qiita-publish/SKILL.md
  - zenn-publish/SKILL.md
  - zernio/SKILL.md

### `argument-hint` (2 skills)


  - pr-review/SKILL.md
  - zernio/SKILL.md

## Risk Categories

- **High risk (即 portable 化必要)**: `allowed-tools`, `hooks`, `context`, `agent`, `disable-model-invocation`, `user-invocable` — Codex/agy parser が知らないフィールド
- **Medium risk**: `model`, `effort` — 機能としては portable subset 外、ただし parser は通る可能性
- **Low risk**: `argument-hint`, `arguments`, `paths`, `shell` — semantic は失われるが parse は通る

## 推奨: 移行優先度

1. 使用頻度の高いフィールド (上記表) を adapter overlay 化
2. `allowed-tools` を使う skill は **Bash 制限を AGENTS.md に転記** (`## Tool restrictions` セクション)
3. `hooks` を使う skill は **portable hook 機構を別途検討** (settings.json adapter)
4. `context: fork` / `agent: <type>` は **bash で別 process spawn 化** (CLI 経由)
