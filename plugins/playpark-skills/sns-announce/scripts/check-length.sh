#!/bin/bash
# Check generated post text against each platform's real length cap.
#
# X does not count codepoints: East Asian wide/fullwidth (W/F) chars weigh 2, everything else 1,
# and every URL is a flat 23 (t.co). A JA post that `wc -m` / `jq length` reports as 275 can be
# 287 on X. Bluesky is a plain 300-char cap.
#
# Usage:
#   check-length.sh <zernio-array.json>            # every item whose platforms include x/bluesky
#   check-length.sh --platform x  "<text>"         # one text
#   check-length.sh --platform x  < text.txt
#
# Output: one line per checked text: "<platform>\t<len>\t<limit>\t<ok|over>"; exit 1 if any over.

set -euo pipefail

platform=""
file=""
text=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --platform) platform="$2"; shift 2 ;;
    -*) echo "check-length.sh: unknown arg: $1" >&2; exit 2 ;;
    *) if [[ -n "$platform" ]]; then text="$1"; else file="$1"; fi; shift ;;
  esac
done

if [[ -n "$platform" && -z "$text" ]]; then
  text="$(cat)"
fi

python3 - "$platform" "$file" "$text" <<'PY'
import json, re, sys, unicodedata

URL_RE = re.compile(r"https?://\S+")
CAPS = {"x": 280, "bluesky": 300}

def x_len(s):
    s = URL_RE.sub("x" * 23, s)
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in s)

MEASURE = {"x": x_len, "bluesky": len}

platform, file, text = sys.argv[1], sys.argv[2], sys.argv[3]
pairs = []
if platform:
    if platform not in CAPS:
        sys.exit(f"check-length.sh: unsupported platform '{platform}' (x|bluesky)")
    pairs.append((platform, text))
elif file:
    with open(file, encoding="utf-8") as fh:
        data = json.load(fh)
    items = data if isinstance(data, list) else [
        {"content": v, "platforms": [k]} for k, v in (data.get("posts") or {}).items()
    ]
    for item in items:
        for p in item.get("platforms") or []:
            if p in CAPS:
                pairs.append((p, item.get("content") or ""))
else:
    sys.exit("check-length.sh: give a JSON file or --platform <x|bluesky> with text")

over = False
for p, s in pairs:
    n = MEASURE[p](s)
    status = "over" if n > CAPS[p] else "ok"
    over |= status == "over"
    print(f"{p}\t{n}\t{CAPS[p]}\t{status}")
sys.exit(1 if over else 0)
PY
