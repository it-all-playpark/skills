#!/usr/bin/env bash
# ai-pulse: parse CLI args and emit resolved values as KEY=VALUE lines.
#
# Usage:
#   eval "$(./scripts/parse-args.sh --days 1 --output ./claudedocs/pulse/ --sources all)"
#
# Sets:
#   AI_PULSE_DAYS, AI_PULSE_OUTPUT_DIR, AI_PULSE_OUTPUT_FILE, AI_PULSE_SOURCES

set -euo pipefail

DAYS=1
OUTPUT_DIR="./claudedocs/pulse"
SOURCES="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)
      DAYS="$2"; shift 2 ;;
    --output)
      OUTPUT_DIR="$2"; shift 2 ;;
    --sources)
      SOURCES="$2"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
Usage: parse-args.sh [--days N] [--output PATH] [--sources LIST]

  --days N          Days to look back (default: 1)
  --output PATH     Output directory (default: ./claudedocs/pulse/)
  --sources LIST    Comma-separated source IDs or "all" (default: all)
                    IDs: smol, willison, latent, hfpapers
EOF
      exit 0 ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2 ;;
  esac
done

# Validate --days
if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "invalid --days value: $DAYS (must be positive integer)" >&2
  exit 2
fi

# Resolve sources
if [[ "$SOURCES" == "all" ]]; then
  RESOLVED="smol,willison,latent,hfpapers"
else
  # Validate each token
  IFS=',' read -ra TOKENS <<< "$SOURCES"
  for t in "${TOKENS[@]}"; do
    case "$t" in
      smol|willison|latent|hfpapers) ;;
      *)
        echo "invalid source id: $t (allowed: smol,willison,latent,hfpapers)" >&2
        exit 2 ;;
    esac
  done
  RESOLVED="$SOURCES"
fi

TODAY="$(date +%Y-%m-%d)"
OUTPUT_FILE="${OUTPUT_DIR%/}/pulse-${TODAY}.md"

# Conflict suffix
if [[ -e "$OUTPUT_FILE" ]]; then
  i=2
  while [[ -e "${OUTPUT_DIR%/}/pulse-${TODAY}-${i}.md" ]]; do
    i=$((i + 1))
  done
  OUTPUT_FILE="${OUTPUT_DIR%/}/pulse-${TODAY}-${i}.md"
fi

cat <<EOF
AI_PULSE_DAYS=$DAYS
AI_PULSE_OUTPUT_DIR=$OUTPUT_DIR
AI_PULSE_OUTPUT_FILE=$OUTPUT_FILE
AI_PULSE_SOURCES=$RESOLVED
EOF
