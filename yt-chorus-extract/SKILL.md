---
name: yt-chorus-extract
description: |
  Extract chorus clip from YouTube video as .opus audio with fade-out.
  Use when: (1) user wants to extract audio clip from YouTube,
  (2) keywords like "サビ", "chorus", "切り出し", "音声抽出", "YouTube audio",
  (3) user provides YouTube URL and start timestamp.
  Accepts args: <youtube-url> --start <MM:SS> [--duration <seconds>] [--fade <seconds>] [--bitrate <kbps>] [-o <output>]
allowed-tools:
  - Bash
---

# yt-chorus-extract

YouTube動画からサビ等の指定区間を.opusファイルとして切り出す。
最後にフェードアウトを適用。

## Requirements

- `yt-dlp` - YouTube動画ダウンロード
- `ffmpeg` - 音声抽出・加工

## Scripts

### extract.sh

```bash
$SKILLS_DIR/yt-chorus-extract/scripts/extract.sh <youtube-url> --start <MM:SS> [options]
```

## Options

| Option | Default | Description |
|---|---|---|
| `--start` | (required) | 切り出し開始位置 (MM:SS or seconds) |
| `--duration` | `30` | 切り出し秒数 |
| `--fade` | `5` | フェードアウト秒数 |
| `--bitrate` | `128` | Opus ビットレート (kbps) |
| `-o, --output` | auto | 出力ファイルパス (省略時: タイトルから自動生成) |

## Examples

```bash
# サビ30秒を切り出し（5秒フェードアウト）
extract.sh "https://www.youtube.com/watch?v=xxxxx" --start 1:20

# 45秒切り出し、10秒フェードアウト
extract.sh "https://youtu.be/xxxxx" --start 2:05 --duration 45 --fade 10

# 出力先指定
extract.sh "https://www.youtube.com/watch?v=xxxxx" --start 1:15 -o ~/Music/chorus.opus
```
