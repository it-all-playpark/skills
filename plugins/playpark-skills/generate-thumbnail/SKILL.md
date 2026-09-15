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
bash /Users/naramotoyuuji/ghq/github.com/it-all-playpark/skills/plugins/playpark-skills/generate-thumbnail/scripts/generate_thumbnail.sh content/blog/<file>.mdx --optimize
```

Options: `--optimize` converts to WebP and deletes original PNG.

## 絶対に守る制約

**スクリプトは必ず literal な絶対パスを先頭トークンにした bare 形（`bash /abs/path/generate_thumbnail.sh …`）で呼ぶ。**
sandbox 除外は呼び出しコマンドの先頭トークンのテキスト一致で判定される。
`SKILL_DIR=…; bash "$SKILL_DIR/scripts/generate_thumbnail.sh"`、`cd "$ROOT" && bash …`、
`bash "$(dirname …)/generate_thumbnail.sh"` のように変数・`cd`・`$( )` で包むと一致せず sandbox 内実行に落ち、
内部の `codex exec` が app-server 初期化で `Operation not permitted` になって死ぬ。

- パスは本 SKILL.md のロード元ディレクトリを**文字列として書き下す**（上の例がその形）。シェル変数に入れて展開しない
- cwd は対象 project の git root でよい（`<mdx-path>` は git root 相対で渡せる）。`cd` を前置しない
- 素の `codex exec "echo hi"` が通ることは、この skill が動く証拠にならない（`codex:*` は先頭トークンが `codex` のときだけ除外される）

Requires: `codex` CLI（ログイン済み）, `python3`, `jq`. `--optimize` 使用時は `vips`, `rip` も必要。

## Config

`skill-config.json` の `generate-thumbnail` セクション:

```json
{
  "output_dir": "public/blog",
  "aspect_ratio": "16:9",
  "brand_prompt_path": "",
  "codex_model": "gpt-5.5",
  "codex_reasoning_effort": "low"
}
```

| Key | Description | Default |
|-----|-------------|---------|
| `output_dir` | 画像出力先（git root 相対） | `public/blog` |
| `aspect_ratio` | アスペクト比（プロンプトに渡す） | `16:9` |
| `brand_prompt_path` | ブランドプロンプトファイル（git root 相対） | `""`（デフォルト使用） |
| `codex_model` | Codex agent model | `gpt-5.5` |
| `codex_reasoning_effort` | Codex 推論深度（`low`/`medium`/`high`） | `low` |

画像モデル自体は Codex 内部で `gpt-image-2` 固定（agent モデル選択とは独立）。

### Brand Prompt

プロジェクト固有のブランドプロンプトを使用するには:
1. プロンプトファイルを作成（例: `.claude/brand-prompt.md`）
2. project `skill-config.json` で `brand_prompt_path` を設定

未設定時は `prompts/default-brand-prompt.md`（本 skill ディレクトリ内）を使用。

## 動作の補足

- Codex は画像を `$CODEX_HOME/generated_images/<session-id>/` 以下に保存後、エージェントが指定パスにコピーする
- `codex exec --skip-git-repo-check` を内部で使用。自動承認フラグは codex のバージョンで異なるため実行時に判定する（`--approve-for-me` = 0.147.0 以降 / `--full-auto` = それ以前）。どちらも sandbox-write を維持したままの自動承認で、書き込み範囲は `output_dir` のみを想定。sandbox を外す `--dangerously-bypass-approvals-and-sandbox` は使わない
- Codex usage limits は通常ターンより 3-5x 早く消費されるため、量産時は注意

## 失敗の見分け方

| 症状 | 意味と対処 |
| --- | --- |
| `could not create PATH aliases: Operation not permitted` / `failed to initialize in-process app-server client: Operation not permitted` | sandbox 内から実行している。呼び出し形が bare 形になっていない（変数展開・`cd … &&`・`$( )` の前置が付いている）。**環境ブロッカーと断定せず、literal 絶対パスの bare 形で呼び直す**。素の `codex exec` が通ることは反証にならない |
| `codex model '<name>' is not available for this account.` | ChatGPT アカウントの Codex が提供終了モデルを 400 で拒否した。`skill-config.json` の `codex_model` を利用可能なモデルにする。未設定なら script の既定値が古いので既定値を更新する。一覧は `jq -r '.. \| .slug? // empty' ~/.codex/models_cache.json \| sort -u` |
| `Codex completed but output file not found` | codex は完走したが画像を書かなかった。codex 0.140.0–0.144.3 の image_gen 不具合（#28422）か、agent がコピーを省いた。ログ末尾 30 行を確認し、version が該当窓なら更新する |
| `codex exec failed` + usage limit 系のメッセージ | Codex サブスクリプションの quota 切れ。時間を置いて再試行する |

## Journal Logging

On completion, log execution to skill-retrospective journal:

```bash
# On success
journal log generate-thumbnail success \
  --duration-turns $TURNS

# On failure
journal log generate-thumbnail failure \
  --error-category <category> --error-msg "<message>"
```
