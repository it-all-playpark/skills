---
name: seed-context
description: |
  Extract project context through free-form dialogue and save to context.md.
  Use when: (1) gathering background information for blog articles,
  (2) capturing development journey, team context, or design decisions,
  (3) enriching seed directory with non-code information,
  (4) keywords like "add context", "capture background", "document story".
  Accepts args: <output-path> [--append]
---

# Seed Context Extraction

Extract project context through free-form dialogue.

## Usage

```
/seed-context <output-path> [--append]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<output-path>` | Output file path (e.g., `seed/project-name/context.md`) |
| `--append` | Append to existing file instead of overwriting |

### Examples

```bash
# Start new context extraction
/seed-context seed/kazoeru-kun/context.md

# Add to existing context
/seed-context seed/kazoeru-kun/context.md --append
```

## Workflow

1. **Start Dialogue**: Ask open-ended questions to elicit context
2. **Free Conversation**: User shares thoughts, stories, background
3. **Capture Information**: Claude notes key points during dialogue
4. **End with `/done`**: User signals completion
5. **Structure & Save**: Claude organizes into sections and saves to file

## Dialogue Flow

### Opening Questions (pick relevant ones)

- このプロジェクトを始めたきっかけは？
- 解決したかった課題は何？
- 開発中に苦労したこと、試行錯誤は？
- チームや組織の文脈で伝えたいことは？
- 技術選定で悩んだポイントは？
- このプロジェクトの「ここがすごい」ポイントは？

### During Dialogue

- 自由に話してもらう
- 深掘りしたいポイントを質問
- 記事に活かせそうな「物語」を引き出す

### Ending

User types `/done` to signal completion.

## Output Format

```markdown
# Context: {project-name}

Extracted: {date}

## 開発の背景

{なぜこのプロジェクトを始めたか}

## 解決した課題

{どんな問題を解決したか}

## 試行錯誤

{開発中の変遷、失敗と学び}

## チーム・組織

{関わったチーム、組織的文脈}

## 技術選定

{なぜこのアーキテクチャを選んだか}

## 特筆すべきポイント

{記事のハイライトになりそうな内容}

---

*Raw notes from dialogue:*

{対話中のメモ、未整理の情報}
```

## Integration with blog-publish

blog-publish skillは以下の優先順位でseedファイルを読み込む：

1. `export.md` - コード構造（必須）
2. `context.md` - 対話で得た文脈（あれば活用）
3. `pr-summary.md` - PR情報（あれば活用）
4. `issues.md` - Issue情報（あれば活用）
5. `commits.md` - Commit履歴（あれば活用）

context.mdの内容は記事の「背景」「開発ストーリー」セクションに反映される。

## Tips

- 完璧に整理されていなくてOK、生の声を大切に
- 画像がある場合は `images/` に配置して参照
- 複数回に分けて追記も可能（`--append`）
- チーム名、プロジェクト名など固有名詞は正確に記録
