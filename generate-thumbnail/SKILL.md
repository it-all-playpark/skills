---
name: generate-thumbnail
description: |
  Generate blog thumbnail via Codex CLI built-in image_gen (gpt-image-2).
  Use when: (1) user wants to create thumbnail for blog article,
  (2) keywords like "サムネイル生成", "thumbnail", "OGP画像", "サムネ作成",
  (3) after /blog-publish or /seed-to-blog execution.
  Accepts args: MDX_PATH [--optimize]
user-invocable: true
context: fork
model: haiku
---

# Generate Thumbnail

Generate blog thumbnail from MDX frontmatter via Codex CLI built-in `image_gen` tool (gpt-image-2). API キー不要、Codex サブスクリプションの usage limit を消費する。

```bash
~/.claude/skills/generate-thumbnail/scripts/generate_thumbnail.sh <mdx-path> [--optimize]
```

Options: `--optimize` converts to WebP and deletes original PNG.

Requires: `codex` CLI（ログイン済み）, `python3`, `jq`. `--optimize` 使用時は `vips`, `rip` も必要。

## Config

`skill-config.json` の `generate-thumbnail` セクション:

```json
{
  "output_dir": "public/blog",
  "aspect_ratio": "16:9",
  "brand_prompt_path": "",
  "codex_model": "gpt-5.4-mini",
  "codex_reasoning_effort": "low"
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `output_dir` | 画像出力先（git root 相対） | `public/blog` |
| `aspect_ratio` | アスペクト比（プロンプトに渡す） | `16:9` |
| `brand_prompt_path` | ブランドプロンプトファイル（git root 相対） | `""`（デフォルト使用） |
| `codex_model` | Codex agent model | `gpt-5.4-mini` |
| `codex_reasoning_effort` | Codex 推論深度（`low`/`medium`/`high`） | `low` |

画像モデル自体は Codex 内部で `gpt-image-2` 固定（agent モデル選択とは独立）。

### Brand Prompt

プロジェクト固有のブランドプロンプトを使用するには:
1. プロンプトファイルを作成（例: `.claude/brand-prompt.md`）
2. project `skill-config.json` で `brand_prompt_path` を設定

未設定時は `~/.claude/skills/generate-thumbnail/prompts/default-brand-prompt.md` を使用。

## 動作の補足

- Codex は画像を `$CODEX_HOME/generated_images/<session-id>/` 以下に保存後、エージェントが指定パスにコピーする
- `codex exec --skip-git-repo-check --full-auto` を内部で使用（自動承認 + sandbox-write）。書き込み範囲は `output_dir` のみを想定
- Codex usage limits は通常ターンより 3-5x 早く消費されるため、量産時は注意

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log generate-thumbnail success \
  --duration-turns $TURNS

# On failure
$SKILLS_DIR/skill-retrospective/scripts/journal.sh log generate-thumbnail failure \
  --error-category <category> --error-msg "<message>"
```
