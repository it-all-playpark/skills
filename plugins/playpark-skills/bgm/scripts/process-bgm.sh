#!/usr/bin/env bash
# BGM処理 + ナレーションとのミキシング
# Usage: process-bgm.sh <bgm> <voiceover> <output> [duration] [volume] [fade]
set -euo pipefail

BGM="${1:?BGM ファイルパスを指定してください}"
VOICEOVER="${2:?ナレーションファイルパスを指定してください}"
OUTPUT="${3:?出力ファイルパスを指定してください}"
DURATION="${4:-}"
VOLUME="${5:-0.05}"
FADE="${6:-3}"

# 入力ファイル検証
for f in "$BGM" "$VOICEOVER"; do
  [[ -f "$f" ]] || { echo "エラー: $f が見つかりません" >&2; exit 1; }
done

# duration 未指定時はナレーション長を使用
if [[ -z "$DURATION" ]]; then
  DURATION=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VOICEOVER")
  DURATION=$(printf "%.0f" "$DURATION")
fi

FADE_OUT_START=$((DURATION - FADE))

echo "=== BGM ミキシング ==="
echo "BGM:        $BGM"
echo "ナレーション: $VOICEOVER"
echo "出力:        $OUTPUT"
echo "長さ:        ${DURATION}s / 音量: $VOLUME / フェード: ${FADE}s"
echo ""

# Step 1: BGM 処理（ループ + フェード + 音量調整）
TMP_BGM=$(mktemp /tmp/bgm_processed.XXXXXX.mp3)
trap 'rm -f "$TMP_BGM"' EXIT

ffmpeg -y -loglevel warning \
  -stream_loop -1 -i "$BGM" \
  -t "$DURATION" \
  -af "volume=${VOLUME},afade=t=in:st=0:d=${FADE},afade=t=out:st=${FADE_OUT_START}:d=${FADE}" \
  "$TMP_BGM"

# Step 2: ナレーションとミックス
ffmpeg -y -loglevel warning \
  -i "$VOICEOVER" -i "$TMP_BGM" \
  -filter_complex "[0:a][1:a]amix=inputs=2:duration=first[out]" \
  -map "[out]" "$OUTPUT"

echo "完了: $OUTPUT"
