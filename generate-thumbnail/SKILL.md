---
name: generate-thumbnail
description: |
  Generate blog thumbnail using Gemini API with configurable brand guidelines.
  Use when: (1) user wants to create thumbnail for blog article,
  (2) keywords like "サムネイル生成", "thumbnail", "OGP画像", "サムネ作成",
  (3) after /blog-publish or /seed-to-blog execution.
  Accepts args: MDX_PATH [--optimize]
user-invocable: true
---

# Generate Thumbnail

Generate blog thumbnail from MDX frontmatter using Gemini API.

```bash
~/.claude/skills/generate-thumbnail/scripts/generate_thumbnail.sh <mdx-path> [--optimize]
```

Options: `--optimize` converts to WebP and deletes original PNG.

Requires: `GEMINI_API_KEY` in `.env.local`

## Config

`skill-config.json` の `generate-thumbnail` セクション:

```json
{
  "output_dir": "public/blog",
  "gemini_model": "gemini-3-pro-image-preview",
  "aspect_ratio": "16:9",
  "brand_prompt_path": ""
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `output_dir` | 画像出力先（git root相対） | `public/blog` |
| `gemini_model` | Gemini モデル名 | `gemini-3-pro-image-preview` |
| `aspect_ratio` | アスペクト比 | `16:9` |
| `brand_prompt_path` | ブランドプロンプトファイル（git root相対） | `""` (デフォルトプロンプト使用) |

### Brand Prompt

プロジェクト固有のブランドプロンプトを使用するには:
1. プロンプトファイルを作成（例: `.claude/brand-prompt.md`）
2. project `skill-config.json` で `brand_prompt_path` を設定

未設定時は `~/.claude/skills/generate-thumbnail/prompts/default-brand-prompt.md` を使用。
