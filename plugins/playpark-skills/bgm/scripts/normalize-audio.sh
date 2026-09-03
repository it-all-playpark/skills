#!/usr/bin/env bash
# ラウドネス正規化（-16 LUFS）
# Usage: normalize-audio.sh <input> [output]
set -euo pipefail

INPUT="${1:?入力ファイルパスを指定してください}"
OUTPUT="${2:-${INPUT%.*}_normalized.${INPUT##*.}}"

[[ -f "$INPUT" ]] || { echo "エラー: $INPUT が見つかりません" >&2; exit 1; }

echo "=== ラウドネス正規化 ==="
echo "入力: $INPUT"
echo "出力: $OUTPUT"
echo "ターゲット: -16 LUFS / TP: -1.5 dB / LRA: 11"
echo ""

ffmpeg -y -loglevel warning \
  -i "$INPUT" \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" \
  "$OUTPUT"

echo "完了: $OUTPUT"
