# Workflow Detail

video-announce ワークフローの詳細実装ガイド。

## Thumbnail Generation

**条件**: `--format json` かつ source が動画ファイル かつ `platformDefaults.thumbOffset` が設定されている場合に実行。Markdown出力時はスキップ。

**手順**:

1. config から `platformDefaults.thumbOffset`（ミリ秒）と `output.dir` を取得
2. 各プラットフォームごとにサムネイルを生成:

```bash
# Instagram用
$SKILLS_DIR/video-announce/scripts/extract-thumbnail.sh <video-path> \
  --offset-ms <thumbOffset> \
  --output <output.dir>/thumbnails/instagram/<slug>.jpg

# YouTube用
$SKILLS_DIR/video-announce/scripts/extract-thumbnail.sh <video-path> \
  --offset-ms <thumbOffset> \
  --output <output.dir>/thumbnails/youtube/<slug>.jpg
```

3. 生成されたパスをJSON出力に埋め込む:

| Platform | Field | Value |
|----------|-------|-------|
| **Instagram** | `platforms[].platformSpecificData.instagramThumbnail` | `<output.dir>/thumbnails/instagram/<slug>.jpg` |
| **YouTube** | `mediaItems[].thumbnail.url` | `<output.dir>/thumbnails/youtube/<slug>.jpg` |
| **TikTok** | `tiktokSettings.video_cover_timestamp_ms` | `<thumbOffset>` の値をそのまま設定（サムネファイル不要） |

**重要**: サムネイル生成は JSON 出力の構築**前**に実行し、パスを JSON に埋め込むこと。後から追加では zernio post / zernio sync がサムネイルを認識できない。

## Auto-Detect Content Type

`detect-media.sh` applies these rules automatically:

| Condition | Instagram | YouTube | TikTok |
|-----------|-----------|---------|--------|
| Video, 9:16 (縦長), <= 90s | `reels` | `shorts` | `standard` |
| Video, 16:9 (横長) or other | `feed` | `standard` | `standard` |
| Video, > 90s | `feed` | `standard` | `standard` |
| Single image | `feed` | — | — |

`--type` で明示指定された場合はそちらを優先する。

## Backward Compatibility

- `--platforms` 省略時 → `all-video`（全プラットフォーム生成）
- `--platforms instagram` → Instagram単体（従来の動作）
- config に `platforms` キーなし → 全プラットフォームにフォールバック
- 旧形式の config（`hashtag` がトップレベル）→ Instagram設定として解釈
